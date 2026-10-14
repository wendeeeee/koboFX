# Deploying the public demo on Render

KoboFX runs on Render as a **test-mode sandbox**:
- funding goes through Paystack's real test checkout;
- withdrawals pay out through the simulated Paystack;
- every new account gets demo money;
- visitors can also look around as a guest with a sample wallet;
- no real money ever moves.

```
Visitor ──https──▶ Render ──▶ ┌───────── one web service: node dist/demo.js ─────────┐
                              │ UI :10000 ──(customer routes, docs, Paystack webhook)──▶ API 127.0.0.1:3000 │
                              │ worker loops (emails, flows, FX, reconciliation)                            │
                              │ simulated Paystack 127.0.0.1:4030 · simulated card PSP 127.0.0.1:4010       │
                              └─────────────────────────────────────────────────────────────────────────────┘
                                         │ private network                │
                                   Render Postgres 16             Render Key Value (Redis)
```

**Why one service:** Render's free web services can send private-network traffic but cannot receive it. A separate UI,
API and mocks could not reach each other privately, so `src/demo.ts` runs them all in one process, and only the UI
listens publicly. On every start it:
1. creates the database's runtime role if it is missing;
2. runs the pending migrations;
3. starts the API, the worker, the two simulated providers and the UI, in that order.

**Why development mode:** `NODE_ENV=production` deliberately refuses test keys, simulated withdrawals and the demo credit.
A public sandbox needs all three.

The files are `render.yaml` (the Blueprint), `Dockerfile` and `src/demo.ts`.

**Cost:** all three resources start on free plans. Free Postgres **expires 30 days after creation**, so upgrade it
(Basic, about $6/month) to keep the demo running past that. Upgrading the web service to Starter (about $7/month) keeps
it from sleeping.

---

## 1. Before you start

1. **The code is on GitHub**, on the branch you'll deploy (e.g. `main`, after merging `develop`).
2. **A Paystack test secret key** (`sk_test_…`): Paystack dashboard, Test mode, Settings → API Keys & Webhooks.
3. **A Brevo account for email** (free, 300 emails/day):
   - **Senders, Domains & Dedicated IPs → Senders**: add and verify the sender address you'll use.
   - **SMTP & API → SMTP**: generate an SMTP key, and note the SMTP login shown there.
4. **Generate the key material on your laptop**, in the repository:
   ```bash
   npm run --silent secrets:generate
   ```
   Keep the output open. You'll paste six of its lines into Render, and they must never be committed. Render generates
   the other secrets itself.

## 2. Create the Blueprint

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub. Then **New → Blueprint**, pick the
   repository and the branch.
2. Render reads `render.yaml` and lists three resources:
   - **kobofx**: the web service;
   - **kobofx-redis**: Key Value;
   - **kobofx-db**: Postgres.
3. It asks for the values the file leaves to you:

| Key | What to paste |
|---|---|
| `SMTP_HOST` | Brevo: `smtp-relay.brevo.com` · Gmail: `smtp.gmail.com` |
| `SMTP_PORT` | Brevo: `2525` · Gmail: `465` (needs a paid instance: free ones cannot reach 465 or 587) |
| `SMTP_SECURE` | Brevo: `false` · Gmail: `true` |
| `SMTP_USER` | Brevo's SMTP login · your Gmail address |
| `SMTP_PASSWORD` | Brevo's SMTP key · a Gmail app password (16 letters, without the spaces) |
| `MAIL_FROM` | Brevo: `KoboFX Demo <the-sender-you-verified@…>` · Gmail: `KoboFX Demo <your Gmail address>` (Gmail sends as the account anyway) |
| `PAYSTACK_SECRET_KEY` | your `sk_test_…` key |
| `PAYSTACK_CALLBACK_URL` | `https://kobofx.onrender.com/funding/return`. If Render gives the service another URL (step 3), fix it there. |
| `JWT_SIGNING_KEY_ID` | from the `secrets:generate` output |
| `JWT_PRIVATE_KEY` | from the `secrets:generate` output |
| `JWT_PUBLIC_KEYS` | from the `secrets:generate` output |
| `WITHDRAWAL_KEY_ENCRYPTION_KEYS` | from the output, the whole JSON, e.g. `{"dev-kek-1":"…"}` |
| `WITHDRAWAL_FINGERPRINT_KEYS` | from the output, the whole JSON |
| `IDEMPOTENCY_REQUEST_HASH_KEYS` | from the output, the whole JSON |

   Paste only what follows the `=` on each line. Or skip the prompts and, once the service exists, use **Environment →
   Edit → Add from .env** and paste all of them at once.

4. **Apply.** The first build takes about 5–10 minutes. Then open the **kobofx** service's **Logs**. A healthy first
   start ends with:
   ```
   [demo] migrations: 55 applied        (every migration on the first start; 0 on later ones)
   [demo] API on 127.0.0.1:3000
   [demo] worker loops started
   [demo] simulated PSP on :4010, simulated Paystack on :4030
   [demo] UI on 0.0.0.0:10000: ready
   ```
   If a setting is wrong, the service stops at boot with `Invalid configuration:` followed by every problem by name.
   Fix them under **Environment** and redeploy.

## 3. Finish the wiring

1. **The URL:** the service's page shows it, e.g. `https://kobofx.onrender.com`. If it differs from what you entered,
   set `PAYSTACK_CALLBACK_URL` to `https://<your-url>/funding/return` under **Environment** (saving redeploys).
2. **The Paystack webhook:** Paystack dashboard (Test mode) → Settings → API Keys & Webhooks → **Test Webhook URL**:
   `https://<your-url>/api/v1/webhooks/paystack`.
3. **Check it:**
   ```bash
   curl -s https://<your-url>/api/v1/health/ready   # {"status":"ok", … "gitSha": "<the deployed commit>"}
   ```

## 4. Try it as a reviewer would

1. **Look around as a guest first:** "Take a look around" on the home page, or "Explore with sample money" on the sign-in
   page. It's a sample wallet in the browser, with no account and no email needed.
2. **Sign up** with a real email address and enter the emailed code (check spam the first time). The wallet starts with
   ₦100,000 of demo money.
3. **Create your transaction PIN** from the dashboard notice.
4. **Add money** through the Paystack test checkout. Use the test card `4084 0840 8408 4081`, any future expiry, CVV `408`.
5. **Exchange** NGN to USD, confirming with your PIN.
6. **Withdraw:** add one of the simulated bank accounts, tap **Send code**, then enter the code and your PIN.

   | Bank | Account number | Name |
   |---|---|---|
   | GTBank (058) | 0123456789 | ADA LOVELACE |
   | Access Bank (044) | 0000000001 | GRACE HOPPER |
   | Zenith Bank (057) | 1234567890 | ALAN TURING |

7. API documentation: `https://<your-url>/api/v1/docs`.

Put this list in the README or on your portfolio page, with "test mode: no real money" and "the first visit can take
about a minute (free hosting wakes up)" at the top.

---

## How the free plans behave

- **The web service sleeps after 15 idle minutes.** The next visit wakes it in about a minute. The worker sleeps with
  it, so emails, fundings and withdrawals carry on as soon as it is awake: nothing queued is lost. A Paystack webhook
  also wakes it. Reconciliation runs that fall due while it sleeps are recorded as missed and caught up on the next run.
- **Postgres expires 30 days after creation.** Upgrade it before then, from **kobofx-db → Upgrade**; the data stays.
- **Key Value keeps nothing across restarts.** That's fine: Redis holds only rate-limit counters, codes in flight and
  the FX cache, never money. A restart only invalidates codes sent in the last 10 minutes.
- **SMTP:** free instances cannot reach ports 25, 465 or 587. Brevo on port 2525 works on the free plan; Gmail needs a
  paid instance (set `plan: starter` in `render.yaml`).

## Updating

Pushing to the deployed branch redeploys automatically. Pending migrations run on start, before the API and the
worker come up.

To wipe every account and start over (this DELETES ALL DATA): delete **kobofx-db**, then **Blueprints → kobofx →
Sync**. Render recreates the database, and the next start creates the role and runs every migration.

## Troubleshooting

- **The service stops with "may not create the runtime role":** Render's database user couldn't run `CREATE ROLE`. Use a
  Postgres whose user can create roles, e.g. a free [Neon](https://neon.tech) project (its default role has CREATEROLE;
  pick the Frankfurt region):
  1. In Neon, copy the **direct** connection string (not the pooled one).
  2. Under the service's **Environment**, replace `DATABASE_URL` with it, and add `PGSSLMODE=require`. Neon accepts only
     TLS, and every database connection reads that setting.
  3. Delete **kobofx-db** from `render.yaml` (and from Render).
- **No emails arrive:**
  - check spam;
  - look in Brevo's **Transactional → Logs**;
  - check the service logs for SMTP errors;
  - check that the port is 2525 and `MAIL_FROM` is a verified sender.
- **The page shows "The wallet service is unavailable":** the API is starting or was restarted. Look at the logs.
- **Rate limits feel shared between visitors:** the UI proxy takes the client address from the first
  `X-Forwarded-For` entry (`UI_TRUST_FORWARDED_FOR=first`), as Render's support describes. If logs show one address for
  everyone, try `last`.

## What protects the public demo

- Only the UI is public. The API, the worker and the simulated providers listen on 127.0.0.1 inside the container. The
  database and Key Value accept only Render's private network (`ipAllowList: []`).
- The UI proxy forwards customer routes, health, the API docs and Paystack's webhook. `/admin/*` is not reachable
  through it, and every admin route also needs an ADMIN or SECURITY role.
- Paystack's webhooks are authenticated by their HMAC signature over the raw body, which the proxy passes through
  byte for byte. The IP allowlist is left unset on Render because the visitor address it would check is not trustworthy
  enough there.
- Other protections: per-visitor rate limits, email verification, refused disposable email domains, and a transaction PIN
  plus an emailed code on withdrawals.
- Paystack runs on a test key only. The configuration refuses a live key outside production, and the simulated Paystack
  refuses one too.
