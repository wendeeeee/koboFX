# Deploying the public demo

KoboFX runs as a **test-mode sandbox** on one small server: funding goes through Paystack's real test checkout, withdrawals
pay out through the simulated Paystack, every new account gets demo money, and no real money ever moves.

```
Internet ──443──▶ Caddy (HTTPS) ─┬─▶ ui:5173 ──(customer routes only)──▶ api:3000 ─▶ postgres, redis
                                 └─▶ api:3000  (/api/v1/webhooks/*, /api/v1/docs*)
worker ─▶ postgres, redis, SMTP, Paystack test API, mock-paystack:4030, mock-psp:4010, FX provider
```

Files: `Dockerfile` (one image for every process), `compose.demo.yml`, `Caddyfile`, `.env.demo.example`.

Why development mode: `NODE_ENV=production` deliberately refuses test keys, simulated withdrawals and the demo credit.
Those are exactly what a public sandbox needs.

---

## 1. Create the server (DigitalOcean)

1. **Create → Droplets.**
   - **Image:** Ubuntu 24.04 LTS.
   - **Size:** Basic, Regular, **2 GB RAM / 1 vCPU / 50 GB** (about $12/month). It runs Postgres, Redis, Caddy and five
     small Node processes in about 1 GB. 1 GB of RAM is too little to build the image.
   - **Region:** London (LON1) or Frankfurt (FRA1), the closest to Nigeria.
   - **Authentication:** SSH key (add your public key, `~/.ssh/id_ed25519.pub`). Not a password.
   - Optional: weekly backups (+20%).
2. Note the droplet's public IPv4 address.

## 2. Point a domain at it

Create a DNS **A record**, e.g. `kobofx.yourdomain.com` → the droplet's IP. Wait until `ping kobofx.yourdomain.com` shows
that IP: Caddy can only get the HTTPS certificate once the name resolves to the server.

No domain? `<ip-with-dashes>.sslip.io` (e.g. `203-0-113-9.sslip.io`) resolves to that IP with no setup and works with
Caddy's certificates.

## 3. Prepare the server

```bash
ssh root@<droplet-ip>

# A normal user with sudo, using the same SSH key
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Firewall: SSH and the web only (Docker publishes nothing else in compose.demo.yml)
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable

# 2 GB of swap: the TypeScript build peaks above what 2 GB of RAM leaves free
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Docker Engine + Compose
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
exit
```

Log in again as `deploy` (`ssh deploy@<droplet-ip>`). From here on, nothing runs as root.

## 4. Get the code

```bash
git clone -b develop https://github.com/<you>/kobo-fx.git
cd kobo-fx
```

If the repository is private, add a read-only deploy key (GitHub → the repo → Settings → Deploy keys) and clone over SSH.

## 5. Configure `.env.demo` (on the server, never committed)

```bash
cp .env.demo.example .env.demo
chmod 600 .env.demo

# Generated secrets: JWT keys, peppers, the simulated PSP's keys, the withdrawal key rings
docker build --target build -t kobofx:tools .
docker run --rm kobofx:tools npm run --silent secrets:generate >> .env.demo

# Three database passwords
for name in DB_APP_PASSWORD DB_MIGRATION_PASSWORD POSTGRES_SUPERUSER_PASSWORD; do
  sed -i "s/^$name=$/$name=$(openssl rand -hex 24)/" .env.demo
done

nano .env.demo
```

In the editor, fill in:

| Key | Value |
|---|---|
| `DEMO_DOMAIN` | `kobofx.yourdomain.com` |
| `PAYSTACK_CALLBACK_URL` | `https://kobofx.yourdomain.com/funding/return` |
| `PAYSTACK_SECRET_KEY` | your **test** secret key (`sk_test_…`, Paystack dashboard → Settings → API Keys & Webhooks) |
| `SMTP_USER`, `SMTP_PASSWORD` | your SMTP provider's login and key (step 6) |
| `MAIL_FROM` | `KoboFX Demo <the-sender-you-verified@…>` |

Never put a `$` in any value (Docker Compose would read it as a variable). Never copy your laptop's `.env`.

## 6. Email that reaches reviewers

Reviewers need the sign-up, withdrawal and PIN-reset codes in their own inbox, and MailHog won't do that. Brevo's free plan
(300 emails/day) works:

1. Create an account at brevo.com.
2. **Senders, Domains & Dedicated IPs → Senders**: add and verify the address you use in `MAIL_FROM`. Authenticating your
   domain (the DKIM/SPF records it shows) keeps the codes out of spam.
3. **SMTP & API → SMTP**: generate an SMTP key. `SMTP_USER` = the login shown there, `SMTP_PASSWORD` = the key. Host
   `smtp-relay.brevo.com`, port 587, `SMTP_SECURE=false` (it upgrades with STARTTLS) are already in the template.

## 7. Build and start

```bash
alias demo='docker compose -f compose.demo.yml --env-file .env.demo'
echo "alias demo='docker compose -f compose.demo.yml --env-file .env.demo'" >> ~/.bashrc

BUILD_GIT_SHA=$(git rev-parse HEAD) demo up -d --build
demo ps
```

The first build takes about 5–10 minutes on 1 vCPU. Then:
- `migrate` shows `Exited (0)`: every migration ran.
- `api` shows `healthy`.
- the other services show `Up`.

Caddy gets the certificate within a minute.

Check:

```bash
curl -s https://kobofx.yourdomain.com/api/v1/health/ready      # {"status":"ok", ... "gitSha": "<your commit>"}
demo logs -f worker                                               # Ctrl-C to stop following
```

## 8. Paystack webhooks

Paystack dashboard (Test mode) → Settings → API Keys & Webhooks → **Test Webhook URL**:
`https://kobofx.yourdomain.com/api/v1/webhooks/paystack`.

`PAYSTACK_WEBHOOK_IP_ALLOWLIST` already admits Paystack's published webhook IPs and the simulated Paystack's fixed address
inside the Docker network (`10.231.47.30`, set in `compose.demo.yml`). The worker also asks Paystack directly, so a funding
completes even when a webhook is late.

## 9. Try it as a reviewer would

1. Open `https://kobofx.yourdomain.com` and sign up with a real email address. Enter the emailed code. The wallet starts
   with ₦100,000 of demo money (`DEMO_CREDIT_NGN_MINOR`).
2. **Create your transaction PIN** from the dashboard notice.
3. **Add money:** the Paystack test checkout. Use the test card `4084 0840 8408 4081`, any future expiry, CVV `408`. It
   needs no PIN or OTP; Paystack's "Test payments" docs list more cards.
4. **Exchange** NGN to USD (enter your PIN to confirm).
5. **Withdraw:** add one of the simulated bank accounts, send the code, enter it and your PIN:

   | Bank | Account number | Name |
   |---|---|---|
   | GTBank (058) | 0123456789 | ADA LOVELACE |
   | Access Bank (044) | 0000000001 | GRACE HOPPER |
   | Zenith Bank (057) | 1234567890 | ALAN TURING |

6. API documentation: `https://kobofx.yourdomain.com/api/v1/docs`.

Put this list (minus the server steps) in the README or on your portfolio page, with "test mode: no real money" up top.

---

## Operating it

```bash
demo logs -f api worker                 # follow logs
demo restart worker                     # restart one service

# Update to the latest develop (migrations run automatically before the API and worker start)
git pull && BUILD_GIT_SHA=$(git rev-parse HEAD) demo up -d --build

# Backup (add to `crontab -e` as a nightly job if you care about the demo's data)
demo exec -T postgres pg_dump -U postgres kobofx | gzip > ~/kobofx-$(date +%F).sql.gz

# Wipe every account and start over (DELETES ALL DATA)
demo down -v && BUILD_GIT_SHA=$(git rev-parse HEAD) demo up -d --build
```

Disk: `docker system prune -f` now and then removes old image layers left by updates.

## What protects the public demo

- Only ports 80 and 443 are open. Postgres, Redis, the API and the mocks are reachable only inside the Docker network.
- The UI proxy forwards customer routes only. `/admin/*` is not reachable through it, and every admin route also needs an
  ADMIN or SECURITY role.
- Rate limits are per client address: Caddy passes the real address, the UI proxy forwards it (`UI_TRUST_FORWARDED_FOR`),
  and the API trusts exactly that one hop (`TRUST_PROXY_HOPS=1`). Other protections: email verification, refused disposable
  email domains, and a transaction PIN plus an emailed code on withdrawals.
- Paystack runs on a test key, and the code refuses to run the simulated Paystack with a live key.
