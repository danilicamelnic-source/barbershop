# My Barber — website + on-site booking (v1.3)

The new website for **My Barber, str. Vasile Lupu 61/5, Chișinău**, with booking built in.
Customers choose a service, a free day and time, enter their name and phone, and send the booking. The server
checks the slot again, saves the booking, and the shop manages it at `/admin`. Nobody is sent to Fresha.

- **Frontend:** `public/index.html`. One file, the existing burgundy/gold design, RU / RO / EN.
- **Backend:** `server/server.js`. Node.js 22.13+, **no npm dependencies**, SQLite database (Node's built-in `node:sqlite`).
- **Admin panel:** `/admin`. Login with a hashed password, session cookie, CSRF protection; confirm / reject / cancel.
- **Alerts:** optional Telegram message for every new booking, plus a "Test Telegram" button.

---

## 1. Why a server is needed (static hosting is not enough)

A static host (GitHub Pages, Netlify/Vercel static, plain shared hosting with only HTML) can only send files.
It cannot:
- store bookings,
- know which times are already taken,
- stop two people from booking the same slot at the same moment,
- keep an admin password secret.

Anything a static page "books" would exist only in that visitor's browser, which would be a fake booking.
So the page talks to `server/server.js`, which keeps bookings in a database file and enforces the rules on the server.

```
Browser ─HTTPS─> Caddy (certificate, port 443) ─> Node server 127.0.0.1:3000 ─> data/bookings.db (SQLite)
                                                        └─> Telegram (optional alert to the shop)
```

## 2. Run it locally (≈5 minutes)

Requires **Node.js 22.13 or newer** (`node -v`).

```bash
cd mybarber
cp .env.example .env
npm run hash-password          # type a password (12+ chars); copy the printed ADMIN_PASSWORD_HASH=… line
```
Edit `.env` for local use:
```
NODE_ENV=development
PUBLIC_ORIGIN=
TRUST_PROXY=0
HSTS=0
ADMIN_USER=owner
ADMIN_PASSWORD_HASH=scrypt:65536:8:1:…   (the line you copied)
DEMO_MODE=1                      (optional: shows the "DEMO · test bookings" ribbon)
```
Then:
```bash
npm start
```
- Website: http://localhost:3000. Make a test booking.
- Admin: http://localhost:3000/admin. Log in, confirm or reject it.
- Start over: stop the server and delete the `data/` folder.

Notes:
- **Local preview without the server:** open `public/index.html` directly (double-click), or use `http://localhost:3000/?preview=sample`. You can click through the whole booking (service → date → time → details → review → send) with **SAMPLE** dates and times. They're calculated from the opening hours, slot step, lead time and service duration in the page's fallback `CONFIG`, in Chișinău time, so past times are excluded.
  Every step shows **"DEMO — no real booking is created"**, and the last screen says **"DEMO — no real booking created"**. The preview sends **no network request at all**: no availability call, no booking. Nothing is stored and nothing is reported as confirmed.
  `?preview=sample` only works on `localhost` / `127.0.0.1`; on a real domain it is ignored.
- **On the server**, free times always come from the booking API. If the API can't be reached, customers see an error with **Retry** and no dates or times. The site never invents availability or silently switches to the preview.
- To open the demo from a phone on the same Wi-Fi (`http://<your-PC-IP>:3000`), set `HOST=0.0.0.0` and, for admin login over plain http, `COOKIE_SECURE=0`.
  Never use `COOKIE_SECURE=0` in production.

## 3. Tests

```bash
npm test                         # 31 server/API tests, no extra installs needed
npm install                      # once: installs the dev-only test dependency (playwright)
npx playwright install chromium  # once: downloads the test browser
npm run test:browser             # 8 browser tests (real Chromium)
npm run test:all                 # both
```
The production server has **no runtime dependencies**. Playwright is only a `devDependency` for the browser tests, so on the server you can skip `npm install` or use `npm install --omit=dev`.

Browser tests (`tests/browser.test.js`, browser and server clocks fixed to 16:10 Chișinău time):
- **Local preview (file opened directly):**
  - full journey with sample slots; selecting a date refreshes the times; changing the service changes the duration and last slot (40 min → 18:00, 90 min → 17:30);
  - past times excluded; can't continue without a service, date or time; name and phone validation;
  - DEMO message at start and end; **zero network requests**; no console or CSP errors;
  - RU/EN labels; mobile layout.
- **`localhost/?preview=sample` with the server running:** no API request; even a direct call to the page's API helper is refused; the database row count is unchanged. On a non-localhost domain the parameter is ignored.
- **Server mode:**
  - slots shown equal the API's slots; a real booking is saved as `pending` with an `MB-` reference;
  - API unreachable → error + Retry, no slots, no demo mode; Retry works once the API is back; HTTP 500 → server-error message.

Server/API tests (`npm test`):
This runs 31 automated tests. Each test starts its own throw-away server on a temporary database and never touches `data/`.

What they check:
- **Slots:** availability, lead time, closing time; overlaps across services; 12 simultaneous requests for one slot (exactly one wins).
- **Retries and duplicates:** retrying with the same key never duplicates; one booking per phone per day; per-phone limit.
- **Invalid input:** bad fields; past, closed, off-grid and too-late times; SQL-injection text stored as plain text.
- **Business rules:** closed dates and weekdays; capacity with 2 chairs; Chișinău midnight and both daylight-saving changes.
- **Admin security:** no access without login; wrong user or password; Origin and CSRF checks; brute-force lockout; cookie flags; HTML escaping.
- **Admin status changes:** confirm, reject, cancel; illegal changes blocked; audit log written; slots freed.
- **Data safety:** bookings survive a restart; migration from the first release; online backup.
- **Telegram:** run against a **local mock** of the Telegram API (success, failure shown in admin, test button). This does not prove the real Telegram works with your bot; see §6.
- **Demo mode.**

## 4. Business settings: `server/config.js` (what the owner must confirm)

Everything about the shop is in one file:

| Setting | Current value | Status |
|---|---|---|
| Services + durations | Haircut 40, Beard 30, Hair+Beard 60, Father+Son 90, Cosmetic 15 min | From the public Fresha listing. **Owner must confirm.** |
| Prices | `price: null` for all → site shows "Price to be confirmed" | **Missing.** Fresha showed 3/2/4/2/10 MDL, which look like placeholders, so they are not used. |
| Opening hours | Daily 10:00–19:00 | From Fresha. **Owner must confirm**, plus holidays (`closedDates`). |
| `chairs` (customers served at once) | 1 | **Assumption.** Fresha says "1+" practitioners. |
| `autoConfirm` | `false` = bookings are *requests* until confirmed in /admin | Owner's choice. |
| Slot step / booking window / lead time | 30 min / 14 days / 60 min | Defaults. **Owner should confirm.** |
| Per-phone limits | 1 per day, 3 upcoming | Defaults. |
| Data retention | 90 days after the appointment | Owner/legal decision. |
| Time zone | `Europe/Chisinau` (DST handled; tested) | Done. |

When the owner confirms a part, set it to `true` in `confirmedByOwner` at the top of the file. Until then, every
unconfirmed item and every missing price is listed in a yellow box at the top of `/admin` and in the server log.
Restart the server after any change (`sudo systemctl restart mybarber`).

## 5. Admin setup and daily use

1. `npm run hash-password` prints `ADMIN_PASSWORD_HASH=…`. Put it and `ADMIN_USER=…` in `.env`, then restart.
   Without both, `/admin` is **disabled** (there is no default password). The old `ADMIN_PASSWORD` variable is ignored.
2. Go to `https://<domain>/admin` and log in. Sessions end after 2 h idle or 12 h total, or on **Ieșire** (log out).
   After 10 wrong passwords from one address (50 from all addresses), logins pause for 15 minutes.
3. **Bookings and actions:**
   - **pending** (a request): **Confirmă** / **Respinge** / **Anulează**;
   - **confirmed**: **Anulează**;
   - rejected and cancelled bookings free the slot immediately.
   Every change is recorded with time and user in the `booking_events` table.
4. **Customers get no automatic SMS.** After confirming, rejecting or cancelling, call the customer. The phone number is a tap-to-call link.
   The website tells pending customers that the shop will contact them.

## 6. Telegram notifications: not active until you configure *and test* them

Telegram alerts are **not configured** in this package: no bot token and no chat id are included, and they never should be.
The code was tested only against a local mock server. To turn alerts on:
1. In Telegram, open **@BotFather** → `/newbot` and copy the token.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id":…}`.
3. Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`, then restart.
4. In `/admin`, press **Test Telegram**. You should get "✅ Test My Barber…" in Telegram. If it fails, the error shows in admin.

After that, every booking row in admin shows **✓ trimis** (sent) or **✗ error**. A failed alert never loses the booking.

## 7. Deploying

**Online demo (public link, quickest): see [`DEPLOY-RAILWAY.md`](DEPLOY-RAILWAY.md).** Railway runs the Node server with a persistent volume, and the server configures itself there (origin, database on the volume, proxy IP, HSTS). The demo runs with `DEMO_MODE=1`.

**Own server (VPS) for the final production site:** the steps below.

### Replacing the old website — do not touch the live site without the owner's approval

**Hosting needed:** a server that runs a Node.js process 24/7 **with a persistent disk**.
Recommended: a small Linux VPS (Ubuntu 24.04, 1 vCPU / 1 GB is plenty, ≈ €4–6/month).
Examples: Hetzner, DigitalOcean, or a Moldovan provider.
Platforms that wipe the disk on redeploy (free Render, Heroku-style dynos, serverless functions) will **lose bookings**. Use one only with a mounted persistent volume.

### 7.1 Environment variables (`/opt/mybarber/.env`, `chmod 600`)

| Variable | Production value | Required |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | yes |
| `PUBLIC_ORIGIN` | `https://www.<domain>`, exactly as in the browser | yes |
| `TRUST_PROXY` | `1` (behind Caddy) | yes |
| `HSTS` | `1` once HTTPS works | yes |
| `COOKIE_SECURE` | `1` | yes |
| `ADMIN_USER`, `ADMIN_PASSWORD_HASH` | from `npm run hash-password` | yes (else admin is disabled) |
| `DB_PATH` | `/opt/mybarber/data/bookings.db` (absolute, outside the release folder) | yes |
| `BACKUP_DIR` / `BACKUP_KEEP` | `/opt/mybarber/backups` / `30` | recommended |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | from BotFather | recommended |
| `DEMO_MODE` | `0` for launch (`1` only for a demo server) | yes |

### 7.2 First install (Ubuntu VPS)

```bash
# Node 22 and Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo apt-get install -y caddy        # if not found: https://caddyserver.com/docs/install#debian-ubuntu-raspbian

# Folders: releases/ (code), current -> active release, data/ (database), backups/
sudo useradd --system --home /opt/mybarber --shell /usr/sbin/nologin mybarber
sudo mkdir -p /opt/mybarber/releases /opt/mybarber/data /opt/mybarber/backups
sudo unzip mybarber-booking.zip -d /tmp/mb && sudo mv /tmp/mb/mybarber /opt/mybarber/releases/1.1.0
sudo ln -sfn /opt/mybarber/releases/1.1.0 /opt/mybarber/current
sudo cp /opt/mybarber/current/.env.example /opt/mybarber/.env && sudo nano /opt/mybarber/.env   # values from 7.1
cd /opt/mybarber/current && sudo -u mybarber npm run hash-password                            # paste the result into .env
sudo chown -R mybarber: /opt/mybarber && sudo chmod 600 /opt/mybarber/.env

# Service
sudo cp /opt/mybarber/current/deploy/mybarber.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mybarber
sudo journalctl -u mybarber -n 30     # expect {"event":"started",...} and the list of warnings
curl -s http://127.0.0.1:3000/healthz # {"ok":true}

# HTTPS (Caddy gets and renews the certificate automatically)
sudo cp /opt/mybarber/current/deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile  # your domain
sudo systemctl reload caddy

# Daily backups at 03:15
sudo -u mybarber crontab -e   # add: 15 3 * * * /opt/mybarber/current/deploy/backup.sh >> /opt/mybarber/backups/backup.log 2>&1
```

The database is created automatically on first start (schema version 2). Older databases are migrated automatically.
Open ports 80 and 443 only (`sudo ufw allow 22,80,443/tcp && sudo ufw enable`). Port 3000 stays local.

### 7.3 Switching the domain (the actual replacement of the old site)

1. A day before, lower the DNS TTL of the domain's A/AAAA records to 300 s. Note the current values: they are your rollback.
2. Test the new server first via its IP or a temporary subdomain (e.g. `new.<domain>`, added to the Caddyfile).
3. Make one real booking and confirm, reject and cancel it in admin. Check the Telegram alert arrives.
4. Point the A/AAAA records to the VPS. Caddy issues the certificate within a minute of DNS resolving.
5. Keep the old website/hosting untouched for at least 2 weeks.

### 7.4 Updating, rollback and backups

- **Update:**
  1. `npm run backup`.
  2. Unzip the new version to `releases/<new>` and keep the same `/opt/mybarber/.env`.
  3. `ln -sfn` `current` to it.
  4. `systemctl restart mybarber`.
- **Roll back the code:** point `current` back to the previous release and restart.
  If the new version migrated the database (the log shows `"event":"migrated"`), also restore the backup made right before the update (see below). Older code doesn't know newer statuses.
- **Roll back the whole site:** set the DNS records back to the old values noted in 7.3.
- **Backups:** `deploy/backup.sh` runs `tools/backup.js` (SQLite `VACUUM INTO`, safe while running). It checks the copy's integrity and keeps the newest 30 in `/opt/mybarber/backups`.
  **Also copy that folder off the server**, e.g. a weekly `scp` or `rclone` to the owner's cloud drive, or enable the VPS provider's snapshots. A backup on the same disk doesn't survive losing the server.
- **Restore:**
  1. `sudo systemctl stop mybarber`.
  2. `cp backups/bookings-<date>.db data/bookings.db`.
  3. `rm -f data/bookings.db-wal data/bookings.db-shm`.
  4. `chown mybarber: data/bookings.db`.
  5. `sudo systemctl start mybarber`.

### 7.5 Docker (alternative — not tested)

The Dockerfile lives in `deploy/Dockerfile`, so Railway doesn't pick it up. It could not be built where this package was prepared (no Docker daemon available). Build and test it before relying on it:
```bash
docker build -f deploy/Dockerfile -t mybarber .
docker run -d --name mybarber --restart=always -p 127.0.0.1:3000:3000 -v mybarber-data:/data --env-file .env mybarber
```
Inside the container use `HOST=0.0.0.0` and `DB_PATH=/data/bookings.db`. Put Caddy in front for HTTPS. Back up the `mybarber-data` volume.

Run **exactly one** instance per database: the no-double-booking guarantee relies on a single server process.

## 8. Security summary

- **No secrets in the frontend or the ZIP.** The admin password is stored only as a scrypt hash, and the Telegram token only in `.env` (git-ignored).
- **Admin:**
  - session cookie `__Host-mb_admin` (HttpOnly, Secure, SameSite=Strict); only a hash of it is kept on the server;
  - a CSRF token plus an Origin check on every action;
  - login rate limits, constant-time checks, `no-store`, and its own strict CSP.
- **Bookings:**
  - every field validated on the server, parameterized SQL only, JSON only, 4 KB body limit;
  - same-origin check, rate limit (8 per 15 min per IP), hidden bot-trap field;
  - idempotency key; slot re-checked inside a database transaction.
- **Headers:** CSP with hashes (computed by the server from the page on every change), `frame-ancestors 'none'`, HSTS (when enabled), nosniff, `Referrer-Policy: same-origin`, Permissions-Policy.
- **Privacy:**
  - logs never contain names or phone numbers;
  - the database and backups are readable only by the service user;
  - bookings are deleted 90 days after the appointment.
  - **Before launch, add the business's legal name and a data-protection contact to the site footer** (Moldova, Law 133/2011 on personal data protection).
- `node:sqlite` is marked *experimental* by Node.js (stable in practice, warning hidden). Pin Node 22 LTS on the server and run `npm test` after Node upgrades.

## 9. Verification status

| Check | Status |
|---|---|
| 31 automated API/server tests (`npm test`) | ✅ run, all pass |
| Mutation check (CSRF disabled / slot re-check removed / pending not blocking): tests fail as they should | ✅ run |
| `npm run test:browser`: 8 browser tests for local preview, `?preview=sample`, server mode, unavailable API and booking submission | ✅ run, all pass (Chromium) |
| Mutation check for the preview: silent fallback to samples, preview submit reaching the real path, network guard removed → each makes a browser test fail | ✅ run |
| Wider browser end-to-end run (admin login/confirm/reject/logout, double-click, slot taken mid-booking, network retry, mobile; 41 checks) | ✅ run, all pass (internal script, not shipped) |
| Real Telegram delivery with the owner's bot | ❌ not possible here (no credentials, no network to Telegram); press **Test Telegram** after setup |
| Docker image build/run | ❌ not run (no Docker daemon available) |
| Real deployment, DNS, HTTPS certificate | ❌ not done (needs a server, the domain and the owner's approval) |
| Safari / Firefox / real phones | ❌ not run (Chromium only); check on an iPhone and an Android phone before launch |
| Load testing | ❌ not run (expected traffic for one barbershop is very low) |

## 10. Pre-launch checklist

**Owner must provide or confirm**
- [ ] Real prices for each service (or explicit "price on request").
- [ ] Service list and durations are correct, and nothing is missing.
- [ ] Opening hours per weekday and holidays/days off (`closedDates`).
- [ ] How many customers can be served at once (`chairs`).
- [ ] `autoConfirm`: confirm every request manually, or confirm instantly?
- [ ] Who checks `/admin` and calls customers, and how quickly.
- [ ] Legal business name + contact for the privacy note; agreement to the 90-day retention.
- [ ] Permission to use the shop's name, address, reviews and rating (the reviews are excerpts from Fresha and are labelled as such).
- [ ] Domain name and access to its DNS; where the old website is hosted.
- [ ] Telegram account for alerts.

**Technical**
- [ ] All `confirmedByOwner` flags set to `true`; no warnings left at the top of `/admin` except intended ones.
- [ ] `.env` filled in per 7.1; `DEMO_MODE=0`; `chmod 600 .env`.
- [ ] HTTPS works and `HSTS=1` is set; `curl -I https://<domain>` shows the security headers.
- [ ] **Test Telegram** succeeds; a real test booking arrives in Telegram.
- [ ] A test booking confirmed, rejected and cancelled in admin. Delete or cancel the test bookings afterwards.
- [ ] `npm run backup` works, the cron entry exists, and backups are copied off the server.
- [ ] Booking tested on an iPhone (Safari) and an Android phone.
- [ ] Old website kept available for rollback; DNS TTL lowered beforehand.

## 11. API reference

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | services, durations, prices, hours, `demo` |
| GET | `/api/availability?service=haircut` | `{today, days:[{date, slots:["10:00",…]}]}` in Chișinău time |
| POST | `/api/bookings` | `{service,date,time,name,phone,lang,key,website:""}` → `201 {ref,status,demo,…}`; `409 slot_taken / duplicate / limit / key_reused`; `400 {field}`; `429` |
| GET | `/healthz` | `{"ok":true}` when the server and database respond |

## Files

```
public/index.html        website (same as index21.html)
server/config.js         business settings (edit this)
server/server.js         website + API + admin
server/auth.js           password hashing, sessions
tools/hash-password.js   npm run hash-password
tools/backup.js          npm run backup
tools/update-csp.js      npm run csp (re-hash the page's meta CSP after editing it)
tests/api.test.js        npm test
tests/browser.test.js    npm run test:browser (needs: npm install && npx playwright install chromium)
deploy/                  Caddyfile, systemd unit, backup.sh
deploy/Dockerfile, railway.json, .nvmrc, .env.example, DEPLOY-RAILWAY.md, CHANGELOG.md
```
