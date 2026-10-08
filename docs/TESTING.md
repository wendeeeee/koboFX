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

## 8. Paystack funding (test mode)

Paystack is a second provider. `POST /wallet/fund` continues to use the simulated PSP;
`POST /wallet/fund/paystack` accepts only `{ amount, currency }`. The worker reads the authenticated
user's stored email and sends it to Paystack to initialize checkout. Neither endpoint accepts card details.
The committed OpenAPI document includes Paystack; a running server with `PAYSTACK_ENABLED=false`
omits both Paystack routes from its document and returns 404 for them.

### Configuration and local mock

Use the existing development setup and migrations from section 3. Set these entries in your ignored `.env`:

```dotenv
PAYSTACK_ENABLED=true
PAYSTACK_SECRET_KEY=sk_test_replace_with_your_test_secret
PAYSTACK_BASE_URL=http://localhost:4030
PAYSTACK_CALLBACK_URL=http://localhost:5173/funding/return
PAYSTACK_FUNDING_CURRENCIES=NGN
PAYSTACK_CHECKOUT_WINDOW_MINUTES=30
MOCK_PAYSTACK_WEBHOOK_URL=http://localhost:3000/api/v1/webhooks/paystack
```

Keep the key private. For the mock, any synthetic `sk_test_` key accepted by config works; the API
and mock must use the same key. Keep `PSP_NAME` as configured for the simulated PSP. NGN needs an entry
in `FUNDING_LIMITS` and `SETTLEMENT_WINDOWS`. Remove `PAYSTACK_WEBHOOK_URL`: the loader refuses this
obsolete name. Set the browser return page explicitly as `PAYSTACK_CALLBACK_URL`; the webhook
address belongs in the dashboard, not in that variable.

Run `npm run start:dev`, `npm run start:worker:dev`, and `npm run start:mock-paystack:dev` in separate
terminals. The mock checkout has Pay and Decline buttons. Tests use an ephemeral mock port and synthetic
keys; other test harnesses default to `http://127.0.0.1:9`, never the real API.

### Real test-mode smoke and checkout

Switch `PAYSTACK_BASE_URL` to `https://api.paystack.co`, use your dashboard's **test** secret, and
restart the API and worker. Configure the Paystack account so the merchant bears fees: verify's
amount must equal the requested amount, otherwise funding is held. Use a dedicated test account;
unrelated successful payments produce reconciliation breaks.

1. Register, verify, and log in as in section 4. Obtain your user id from `GET /users/me`.
2. Run `npm run paystack:smoke -- <active-user-uuid>` manually. This reads that user's stored email,
   initializes one test transaction, verifies it, checks an unknown reference and parses a transaction
   list through the real adapter. It prints statuses only. A freshly initialized transaction may
   be unpaid or not yet visible. This diagnostic creates no funding flow and does not complete checkout;
   it refuses CI, `NODE_ENV=test`, disabled Paystack, live keys and a non-official API URL.
3. Start a tunnel, for example `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`.
   In the Paystack dashboard's **test-mode webhook settings**, save
   `https://<tunnel-host>/api/v1/webhooks/paystack`. This setting is separate from the browser callback.
   See [Paystack's webhook documentation](https://paystack.com/docs/payments/webhooks/).
4. Create a funding using your bearer token, then poll the shared status endpoint:

   ```bash
   API=http://localhost:3000/api/v1
   FUNDING_KEY=$(node -e 'console.log(require("node:crypto").randomUUID())')
   FUNDING=$(curl -fsS -X POST "$API/wallet/fund/paystack" \
     -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $FUNDING_KEY" \
     -H 'Content-Type: application/json' -d '{"amount":"150000","currency":"NGN"}')
   FUNDING_ID=$(printf '%s' "$FUNDING" | jq -r .fundingId)
   curl -fsS "$API/wallet/fund/$FUNDING_ID" -H "Authorization: Bearer $TOKEN"
   ```

   The first response is `202 PENDING`. Poll until `checkout.authorizationUrl` appears; open that
   URL in your browser. `expiresAt` is KoboFX's checkout window, not an expiry promised by Paystack.
   Retry the POST with the same key to verify identical response bytes and a single funding id.
5. Complete checkout with a test card. Paystack documents these values (use any future expiry):

   | Outcome | Card | CVV | Extra validation |
   |---|---|---|---|
   | Success | `4084 0840 8408 4081` | `408` | None |
   | PIN | `5078 5078 5078 5078 12` | `081` | PIN `1111` |
   | PIN and OTP | `5060 6666 6666 6666 666` | `123` | PIN `1234`, OTP `123456` |
   | Declined | `4084 0800 0000 5408` | `001` | None |

   Source: [Paystack test payments](https://paystack.com/docs/payments/test-payments/).
6. Poll until `COMPLETED`, with `provider: "paystack"` and `checkout: null`. The callback's
   `?reference=` is not proof of payment. Confirm `GET /wallet` increased by exactly `150000` minor
   units and `GET /transactions/funding:<fundingId>` shows one `CARD_DEPOSIT`. Replaying the request
   or webhook must not add another credit. Repeat without a webhook to check resumer completion.
7. Check internal reconciliation via `GET /admin/reconciliation-runs` using an administrator token
   after the next scheduled run: the internal run should be `CLEAN`. Check `/admin/breaks` as well.
   The automated tests additionally call `expectCleanBooks()` to prove the accounting invariants.

An unsigned webhook returns 401 and is stored. If `PAYSTACK_WEBHOOK_IP_ALLOWLIST` is set, only
allowed `req.ip` values pass; configure `TRUST_PROXY_HOPS` for your actual proxy chain before using
the allowlist behind a tunnel. Do not trust an arbitrary forwarded header. Disable the allowlist
for the local mock. Declines and abandonment remain pending within the checkout window; money still
in flight remains pending beyond it. `CHECKOUT_UNRECOVERABLE` means the initialize response was lost
and Paystack cannot return the checkout URL: create another funding with a new idempotency key.

### Automated acceptance checks

Use a path fragment including `integration/`: the worktree name itself contains `paystack`, so
`--testPathPattern=paystack` selects unrelated suites too.

```bash
npm run test:int -- --testPathPattern='integration/paystack-'
npm run docs:generate
npm run test:int -- --testPathPattern='integration/openapi-contract'
npm run test:e2e -- --testPathPattern='e2e/auth.e2e'
npm run typecheck
npm run build
```

`docs:generate` exports `docs/openapi.json` from the real module/controller graph with both providers
enabled, synthetic config and disconnected database/Redis substitutes. It does not run app lifecycle
hooks or test HTTP behavior. The contract suite independently builds the document from the running
app and checks it byte for byte; `UPDATE_OPENAPI=1` also lets that suite regenerate it.
Review the generated diff. The mock suites cover signature evidence, verify-only credit, retries,
replay, disputes, schema guards and reconciliation. Crash, race and property tests exercise recovery
and exactly-once posting. Use `scripts/mutation-check.py` for the seven mutations listed in
`PAYSTACK_PROMPT.md` §6; each must fail a test that passes without the mutation. Mutation execution
and the ≥90% coverage acceptance gate must be recorded separately, not inferred from test presence.

Settlement ingestion remains deferred: `PAYSTACK_RECEIVABLE` is not discharged into BANK/fees and
Paystack settlement-window checks are skipped. Late-success and HELD breaks are detected, but the
existing correction executor still requires simulated-provider settlement lines; completing their
approved-credit recovery path remains a functional follow-up, not a verified acceptance claim.
Record the manual smoke and checkout outcome separately; automated mock tests do not prove it.
