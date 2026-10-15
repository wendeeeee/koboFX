# KoboFX — FX Trading Backend

A NestJS backend for a multi-currency wallet: users register, fund in NGN, convert or trade between
NGN, USD, EUR and GBP at live rates, withdraw, and see full transaction history.

## The design thinking

I approached this task using three principles to decide every trade-off:

- **No invented data.** Money is never created by rounding, clamping or guessing. Every minor unit
  has a source.
- **No lost data.** Every fact is kept: rejected rates, forged webhooks, failed payments. A
  correction is a new record. Nothing is edited in place.
- **No trust.** Webhooks, providers, clients and internal processes may assume, repeat or crash. Hence, each activity is checked against an authoritative source.

### A balance is a ledger, not a column

I thought critically about how to model multi-currency wallet balances. Thw best way to approach this is double-entry bookkeeping (just like in a typical financial accounting domain). To that effect, the flow in this system is as follows:

- Each user holds one account per currency, and that account is a **liability**: money we owe
  the user.
- Every movement is a balanced transaction of debits and credits **per currency**. NGN and USD
  legs never offset each other.
- A conversion debits the user's source account and credits an `FX_POSITION` account in the source
  currency. It then debits `FX_POSITION` in the target currency at the mid rate and credits the
  user's target account. The **spread** is credited explicitly to `REVENUE:FX_SPREAD`. It is never
  hidden in a rounding residual.
- `accounts.balance_minor` is a cache. The source of truth is `ledger_entries`: an append-only
  table protected by a trigger, revoked grants and a SHA-256 hash chain.
- **There is one write path to money:** `LedgerService.post()`. Funding, conversion, chargeback,
  correction and write-off all go through it.

### A non-negative balance is policy, not a constraint

There is no `CHECK (balance >= 0)`. A chargeback that arrives after the money is spent still
happened. Refusing to record it loses a fact, and clamping the balance at zero creates money which is aginst the established system's policy.
Spends are authorized against `available = balance − reserved`, and overdrafts are recorded,
detected and reported.

### Money representation

- Storage uses `BIGINT` minor units. Computation uses `decimal.js`. Amounts travel on the wire as
  **strings**. There are no floats in the money path, including JSON parsing, which uses
  `lossless-json`.
- Each currency's minor unit comes from the database. Nothing hardcodes 100: JPY has 0 decimal
  places and KWD has 3.
- Rounding happens once, at the boundary, through an explicit `RoundingPolicy`. User credits round
  down, and revenue rounds half-even.

### Concurrency and double spending

- One database transaction per money operation, at `READ COMMITTED`, with pessimistic
  `SELECT … FOR UPDATE ORDER BY id`. There is one global lock order, and a runtime guard rejects
  out-of-order locking.
- Lock and statement timeouts (3 s and 10 s) turn contention into `503 RESOURCE_BUSY` instead of
  a hang.
- Conversions and withdrawals use **reserve, then settle**. A hold is placed through the
  authorization gate and then captured in the same unit of work.
- The required test, 100 parallel conversions against one balance, exists and runs on real
  Postgres.

### Idempotency

Every money-moving `POST` needs an `Idempotency-Key`. The key is claimed and the handler runs in a
single transaction under an advisory lock. The exact response bytes are stored and replayed.
Permanent failures are stored too, and transient failures leave no key behind. Keys never expire.

### Trust the outside world? No, it's unreliable so we always verify

- **No database transaction stays open across a network call.** The API writes intent and the
  worker calls providers after the commit.
- **Webhooks are hints.** The signature is verified over the raw bytes and the payload is stored
  before a fast `202`. The provider's API is then queried for the authoritative state.
- **Every flow can die between any two steps.** Funding and withdrawals are durable state machines
  with leases and fencing tokens. They are mirrored in SQL by transition triggers and resumed by an
  independent worker.
- Notifications use a **transactional outbox**, written in the same transaction as the change they
  announce.

### FX rates

- Rates come from ExchangeRate-API (for this demo), behind a `RateProvider` port, so adding a provider requires no
  changes in callers.
- Rates are cached in three tiers: the process, Redis, then Postgres. Provider traffic therefore
  never scales with user traffic, and a per-month request budget is enforced across all instances.
- Every fetch passes sanity checks: bounds, completeness, monotonic time and a jump limit. A
  rejected fetch is stored as evidence and never served.
- **A stale rate may be displayed but never executed against.** Freshness is measured from the
  provider's publication time.
- The client rate is `mid × (1 − spread)`. A quote locks its amounts and provenance for 30 s and
  can be used once. A trade posts the quote's amounts exactly as quoted.

### Proving the books

- Read-only checks run every day: trial balance per currency, the accounting equation, cached
  balance = Σ entries, continuity, the hash chain and reservations.
- External reconciliation matches PSP settlement reports by the provider's ids only. A mismatch
  becomes a tracked break and is never auto-fixed by guessing.

### Controls

- RBAC with three roles: `USER`, `ADMIN` and `SECURITY`.
- Four-eyes approval for corrections, write-offs, rate overrides, spread changes, suspensions,
  period closes and role changes. The rule is enforced by database `CHECK`s and triggers as well
  as code.
- Withdrawals and conversions are confirmed with a transaction PIN. Each withdrawal also needs a
  one-time code sent by email.

## Stack

| Choice | Why |
|---|---|
| NestJS 11, TypeScript strict | The brief's framework. Modules map to bounded contexts. |
| PostgreSQL 16 + TypeORM | Row locks, advisory locks, triggers, partial indexes and exact `NUMERIC`. Most invariants run as raw SQL on an ambient unit of work. |
| Redis 7 | Ephemeral state only: rate cache, rate limits, OTP challenges, fetch coordination. It fails fast, and each use decides whether to fail closed or open. |
| Separate worker process | Outbox, flow resumer, webhook processor, reservation sweeper, FX poller, reconciliation. |
| Jest + fast-check + testcontainers | Property tests use invariants as the oracle. Integration and concurrency tests run on real Postgres and Redis. |

Two database roles keep the runtime honest. `fx_owner` runs migrations. `fx_app` has column-level
grants and no `DELETE` on money or evidence tables.

## Layout

```
src/common         money, errors, guards, idempotency interceptor, provider HTTP client, clock
src/database       datasource, migrations, UnitOfWork
src/modules        ledger · reservations · auth · users · wallets · flows · payments · fx · trading
                   transactions · withdrawals · stashes · reconciliation · admin · outbox · audit · health
src/mock-*         simulated PSP, Paystack and ExchangeRate-API servers (dev and tests only)
ui/                a small customer web UI that proxies to the API
test/              integration, e2e and concurrency suites; shared harness
```

## Running locally

```bash
cp .env.example .env
npm run --silent secrets:generate >> .env   # JWT keys, OTP pepper, etc.
docker compose up -d                        # Postgres, Redis, MailHog
npm install
npm run migration:run
npm run start:dev                           # API on :3000
npm run start:worker:dev                    # worker
npm run start:mock-psp:dev                  # optional: simulated card PSP
npm run start:mock-fx:dev                   # optional: simulated FX API (set FX_RATE_BASE_URL)
```

Emails land in MailHog at http://localhost:8025.

Tests: `npm test` runs unit and property tests. `npm run test:int` and `npm run test:e2e` need
Docker for testcontainers.

## API documentation

With the API running, Swagger UI is at **http://localhost:3000/api/v1/docs** and the JSON at
`/api/v1/docs-json`. The committed spec is [`docs/openapi.json`](docs/openapi.json). A contract
test fails when the spec and the router drift apart.

## Key assumptions and deviations

- The system works in **test or sandbox mode only**. Card funding goes through a simulated PSP or
  Paystack test mode, and withdrawals refuse a live key.
- The supported currencies are NGN, USD, EUR and GBP. Adding one is a database row, a rate bound
  and limits. No code changes.
- There is **one FX provider**. This is an accepted risk in place of the design's two-provider
  cross-check. A move of more than 20% halts trading in that currency until an approved override.
- `/auth/*` routes take no `Idempotency-Key`. Each one is safe to retry on its own terms.
- Verification takes `{email, password, oneTimePassword}` to prevent pre-registration account
  takeover.
- A demo NGN credit at verification is configurable and is refused in production.

## License

See [LICENSE](LICENSE).
