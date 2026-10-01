# Testing the KoboFX backend

How to check that the backend works: the automated suites first, then the API by hand in Swagger UI or with `curl`. The
API contract is `docs/openapi.json`; a running dev server serves the same document at `/api/v1/docs`.

Rules every request follows (see the spec's introduction for the rest):

- **Amounts are strings of minor units.** `"150000"` NGN is ₦1,500.00. A JSON number is refused with `400`.
- **Mutating money and admin routes need `Idempotency-Key`** (16–128 characters of `[A-Za-z0-9_-]`). Use one key per
  operation and reuse it on every retry. `/auth/*` takes no key.
- **Errors** always look like `{ statusCode, code, message, details?, correlationId, timestamp }`. Branch on `code`.

---

## 1. Prerequisites

- Node 20+, Docker (running), `curl`, and `jq` (optional, for the shell examples).
- The automated tests need Docker only: they start their own Postgres and Redis with testcontainers.

## 2. Automated tests

```bash
npm ci
npm run typecheck        # TypeScript strict
npm test                 # unit + property tests (fast-check); no Docker
npm run test:int         # integration: real Postgres 16 + Redis 7 via testcontainers (slow, about 30–40 min)
npm run test:e2e         # the whole app booted against testcontainers
npm run build            # compiles to dist/ and stamps the git SHA
```

To run one suite, match on part of its path. The worktree path contains the phase name, so don't match on words like
`fx` or `history`:

```bash
npx jest --selectProjects integration --testPathPattern 'integration/trading\.int'
npx jest --selectProjects unit --testPathPattern 'src/openapi/error-codes'
```

### The API contract test

`test/integration/openapi-contract.int-spec.ts` boots the full app and checks the spec against what the app actually
does:

- the documented routes are exactly the routes the router serves;
- a request with no token gets `401` on exactly the routes documented as bearer-protected;
- a request with no `Idempotency-Key` gets `400 IDEMPOTENCY_KEY_REQUIRED` on exactly the routes documented as
  idempotent;
- for each role, `403 FORBIDDEN` comes back on exactly the `/admin` routes that role is not listed for;
- real response bodies match their schemas, with no undocumented fields and no missing ones;
- every documented request example passes the route's own validation;
- `docs/openapi.json` matches the running app.

```bash
npx jest --selectProjects integration --testPathPattern integration/openapi-contract
# After changing a route, DTO or response class, regenerate the committed spec:
UPDATE_OPENAPI=1 npx jest --selectProjects integration --testPathPattern integration/openapi-contract
```

Other checks worth knowing about:

- `npm run test:cov` runs coverage, with a ≥ 90% target on the money modules. Its latest full run is deferred: the
  Phase 10 top-up for `admin/` and `reconciliation/` is pending.
- `python3 scripts/mutation-check.py …` proves a given test can fail: it breaks the code, expects red, then restores
  it.

---

## 3. Run the backend locally

```bash
cp .env.example .env
npm run --silent secrets:generate >> .env   # JWT keys, one-time-password pepper, PSP secrets
docker compose up -d                        # Postgres :5432, Redis :6379, MailHog (SMTP :1025, UI http://localhost:8025)
npm run migration:run

# One terminal each:
npm run start:dev             # API on http://localhost:3000
npm run start:worker:dev      # worker: emails, funding flows, webhooks, FX poller, reconciliation
npm run start:mock-psp:dev    # simulated card processor on :4010 (signs and sends webhooks to the API)
```

FX rates come from `FX_RATE_BASE_URL`. To work offline with the simulated rate provider, run
`npm run start:mock-fx:dev` and set `FX_RATE_BASE_URL=http://localhost:4020/v6/latest` in `.env`.

Check it is up:

```bash
curl -s localhost:3000/api/v1/health/live
curl -s localhost:3000/api/v1/health/ready     # 200 when Postgres and Redis are up (503 with the same body otherwise)
```

## 4. Explore in Swagger UI

Open **http://localhost:3000/api/v1/docs**. The raw JSON is at `/api/v1/docs-json`.

1. Call `POST /auth/login` (or `/auth/verify`) and copy `tokens.access.token`.
2. Click **Authorize** and paste the token, without the word `Bearer`.
3. For routes marked idempotent, fill in the `Idempotency-Key` field. Any UUID works.

Each operation lists its access rule, roles, rate limits and every error `code` it can return, with examples.

The docs are off in production unless `API_DOCS_ENABLED=true`.

---

## 5. End-to-end walkthrough with curl

```bash
API=http://localhost:3000/api/v1
key() { uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; }   # a fresh Idempotency-Key
EMAIL=ada.$RANDOM@example.com
PASSWORD='correct horse battery staple'
```

### 5.1 Register, verify, log in

```bash
curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"              # 201 (same answer for every email)
```

The worker emails a 6-digit code. Read it in MailHog at http://localhost:8025.

```bash
OTP=123456   # the code from the email
TOKEN=$(curl -s -X POST $API/auth/verify -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"oneTimePassword\":\"$OTP\"}" | jq -r .tokens.access.token)
AUTH="Authorization: Bearer $TOKEN"
curl -s $API/users/me -H "$AUTH"
```

- Later sessions: `POST /auth/login` with `{email, password}`.
- Refresh tokens: `POST /auth/refresh` with `{refreshToken}`. They are single-use; presenting one twice revokes the
  whole session.
- Log out: `POST /auth/logout` returns `204`.

### 5.2 Wallet and card funding

In development, verification credits a demo ₦100,000 (`DEMO_CREDIT_NGN_MINOR`).

```bash
curl -s $API/wallet -H "$AUTH"      # balances per currency: total, reserved, available (strings)

FUNDING=$(curl -s -X POST $API/wallet/fund -H "$AUTH" -H "Idempotency-Key: $(key)" -H 'Content-Type: application/json' \
  -d '{"amount":"150000","currency":"NGN","paymentMethodToken":"tok_example_visa"}' | jq -r .fundingId)   # 202 PENDING
curl -s $API/wallet/fund/$FUNDING -H "$AUTH"   # PENDING, then COMPLETED once the mock PSP captures (about 2 s)
```

The payment token picks a mock-PSP outcome:

| Token | Outcome |
|---|---|
| `tok_decline_insufficient_funds` (any `tok_decline_<code>`) | `FAILED`, with `failureCode` `DECLINED:<code>` |
| `tok_expire_…` | `FAILED`: the authorisation expired |
| `tok_capture_fail_…` | `FAILED`: the capture failed |
| anything else valid | `COMPLETED` |

### 5.3 Rates, quotes, trades, conversions

```bash
curl -s $API/fx/rates -H "$AUTH"   # display rates; if stale is true, quotes and conversions answer 503 FX_RATE_STALE

QUOTE=$(curl -s -X POST $API/fx/quotes -H "$AUTH" -H "Idempotency-Key: $(key)" -H 'Content-Type: application/json' \
  -d '{"from":"NGN","to":"USD","sourceAmount":"500000"}' | jq -r .quoteId)        # 201, valid 30 s, single use
curl -s -X POST $API/wallet/trade -H "$AUTH" -H "Idempotency-Key: $(key)" -H 'Content-Type: application/json' \
  -d "{\"quoteId\":\"$QUOTE\"}"                                                    # 201: the quote's amounts, posted

curl -s -X POST $API/wallet/convert -H "$AUTH" -H "Idempotency-Key: $(key)" -H 'Content-Type: application/json' \
  -d '{"from":"NGN","to":"USD","targetAmount":"5000","maximumSourceAmount":"9000000"}'   # buy $50; refuse above ₦90,000
```

- Give exactly one of `sourceAmount` (what you sell) or `targetAmount` (what you receive).
- Price protection: `minimumTargetAmount` goes with `sourceAmount`, `maximumSourceAmount` with `targetAmount`. If the
  price breaches it, the answer is `409 PRICE_LIMIT_EXCEEDED`.

### 5.4 History

```bash
curl -s "$API/transactions?limit=20" -H "$AUTH"                      # newest first; pass nextCursor to page
curl -s "$API/transactions?type=CONVERSION&currency=USD" -H "$AUTH"
curl -s "$API/transactions/funding:$FUNDING" -H "$AUTH"              # one item: your legs, balances after, links
```

### 5.5 Idempotency and error behaviour

| Try | Expect |
|---|---|
| Repeat a convert with the **same key and body** | Same `201` body, byte for byte, with header `Idempotent-Replayed: true`. No second conversion. |
| Same key, **different body** | `409 IDEMPOTENCY_KEY_REUSE` |
| Omit `Idempotency-Key` on fund/quote/convert/trade | `400 IDEMPOTENCY_KEY_REQUIRED` |
| `"amount": 150000` (a number) | `400 VALIDATION_FAILED`, with `details.violations` |
| Convert more than you hold | `409 INSUFFICIENT_FUNDS` (top up). Funds held by an operation in flight give `409 FUNDS_RESERVED` instead. |
| Trade the same quote twice | `409 QUOTE_ALREADY_USED`. After 30 s: `409 QUOTE_EXPIRED`. |
| Another user's funding, quote or transaction | `404`, the same as one that doesn't exist |
| No token / an expired token | `401 UNAUTHENTICATED` |
| Too many requests | `429 RATE_LIMITED` with `Retry-After` |

Every response carries `X-Correlation-Id`, and the same id appears in every error body.

---

## 6. Admin and four-eyes approvals

Make the first administrators once. They are two verified users who will be ADMIN and SECURITY.

```bash
npm run admin:bootstrap -- --admin <adminUserId> --security <securityUserId>
```

Log in as each of them to get their tokens (`$ADMIN`, `$SECURITY`).

```bash
# An ADMIN requests; a DIFFERENT eligible person decides (SECURITY decides ROLE_CHANGE).
APPROVAL=$(curl -s -X POST $API/admin/approvals -H "Authorization: Bearer $ADMIN" -H "Idempotency-Key: $(key)" \
  -H 'Content-Type: application/json' \
  -d '{"actionType":"ROLE_CHANGE","payload":{"userId":"<userId>","role":"ADMIN","operation":"GRANT"},"reason":"new hire"}' \
  | jq -r .approvalId)                                                           # 201 PENDING
curl -s -X POST $API/admin/approvals/$APPROVAL/approve -H "Authorization: Bearer $SECURITY" -H "Idempotency-Key: $(key)"
# 200 EXECUTED. If execution is refused, the answer is still 200, with status EXECUTION_FAILED and executionFailureCode.
```

Things to check:

- **Self-approval:** approving your own request gives `403 SELF_APPROVAL_FORBIDDEN`.
- **Roles:** a plain user gets `403 FORBIDDEN` on every `/admin` route.
- **Break-glass:** `"breakGlass": true` on `SUSPEND_USER` or a `RATE_OVERRIDE` with `MANUAL_RATE` executes in the
  request itself. SECURITY then reviews it with `POST /admin/approvals/{id}/review`.
- **Read routes:**
  - `GET /admin/positions`, `/admin/breaks`, `/admin/reconciliation-runs`;
  - `/admin/users/{id}` and `/admin/users/{id}/transactions`;
  - `/admin/recertification` (SECURITY only).

Swagger UI shows a request example for every action type.

## 7. Webhooks

The mock PSP signs its webhooks and delivers them to `POST /api/v1/webhooks/psp`. An unsigned or forged event is still
stored, but answered with `401`:

```bash
curl -s -X POST $API/webhooks/psp -H 'Content-Type: application/json' -d '{"id":"evt_1","type":"payment.captured"}'   # 401
```

Webhooks are hints: the worker asks the PSP for the authoritative state before anything changes.
