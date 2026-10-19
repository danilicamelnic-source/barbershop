# Put the My Barber demo online (Railway) — step by step

Result: a public HTTPS link like `https://mybarber-xxxx.up.railway.app` that works on phones and computers.
Bookings are saved in a database on a persistent volume, so they survive restarts and redeploys.
The site runs in **DEMO mode**: it shows a "DEMO · test bookings" ribbon, and every booking is tagged DEMO.

## Why Railway

| Need | Railway | Render free | Static hosting (GitHub Pages, Netlify static) |
|---|---|---|---|
| Runs the Node.js booking server | ✅ | ✅ | ❌ |
| Database survives restarts/redeploys | ✅ volume (0.5 GB on Trial/Free) | ❌ files are wiped on every restart, redeploy or spin-down; no disks on free | ❌ |
| Stays awake | ✅ while credit remains | ❌ sleeps after 15 min idle, ~1 min to wake | n/a |
| Cost for a demo | Trial: one-time **$5** credit for up to 30 days, then Free ($1 credit/month) or Hobby **$5/month** | $0 (unsuitable), or $7/month + $0.25/GB disk | — |

Railway facts, from Railway's docs on 19 Oct 2026:
- **Trial:** a one-time $5 credit for up to 30 days; 1 GB RAM and a shared CPU per service; a 0.5 GB volume.
- **Card:** the docs don't say a card is needed for the Trial.
- **GitHub:** connecting GitHub verifies the account (**Full Trial**). Without it you get the **Limited Trial**, which restricts outbound network access, so Telegram alerts may not work there.
- **After the trial:**
  - the Free plan gives $1 of credit a month; whether that's enough for this app is unconfirmed, so check **Usage**;
  - Hobby is $5/month with a 5 GB volume;
  - extra volume storage costs $0.15/GB per month;
  - if credit runs out, the service stops.
- **Redeploys:** each one causes a few seconds of downtime, because the volume can be attached to only one deployment at a time.
- **Volume data:** deleted 30 days after a trial or free account's credit expires.

## What the server configures by itself on Railway

- **Listening:** `HOST=0.0.0.0`; the port comes from Railway.
- **Public address:** `PUBLIC_ORIGIN` = `https://` + `RAILWAY_PUBLIC_DOMAIN`. It's used for the CSRF/origin checks; the admin cookie is HTTPS-only.
- **Database:** on the volume, at `RAILWAY_VOLUME_MOUNT_PATH/bookings.db`. If no volume is attached, `/admin` and the log show a red warning.
- **Proxy:** `TRUST_PROXY=1`, `CLIENT_IP_HEADER=x-real-ip` (visitor IP for the anti-spam limits), and `HSTS=1`.
- **Build:** `railway.json` sets the start command and a `/healthz` health check. There is no Dockerfile in the project root, so Railway's standard Node build is used.

## Step 1 — Put the code on GitHub (pick ONE way)

**A. Let Claude push it.** Fastest for you.
1. claude.ai → **Settings → Connectors → GitHub → Connect**, and allow access.
2. On github.com: **New repository** → name `mybarber` → **Private** → *don't* add a README → **Create**.
3. Tell Claude: "pushed? owner/repo = <your-user>/mybarber". Claude uploads the project.

**B. Upload it yourself in the browser.** No installs needed.
1. Unzip `mybarber-booking.zip`.
2. github.com → **New repository** → `mybarber` → **Private** → tick **Add a README** → **Create**.
3. **Add file → Upload files** → drag *everything inside* the `mybarber` folder:
   - folders: `server`, `public`, `tools`, `tests`, `deploy`
   - files: `package.json`, `package-lock.json`, `railway.json`, `.nvmrc`, `README.md`, and the rest
4. Click **Commit changes**.
   The repository may be public or private: it contains **no passwords or keys**. `.env` is never included.

## Step 2 — Create the Railway service

1. Go to https://railway.com → **Login** → **Continue with GitHub** (this also gives you the Full Trial).
2. **New Project → Deploy from GitHub repo** → choose `mybarber`. Railway starts building.
3. **Add the volume (required):** in the project canvas, right-click (or use **+ Create / ⌘K**) → **Volume** → attach it to the `mybarber` service → mount path **`/data`**.
4. **Variables:** open the `mybarber` service → **Variables → Raw Editor** → paste the block below → **Update Variables**.
   ```
   NODE_ENV=production
   DEMO_MODE=1
   ADMIN_USER=owner
   ADMIN_PASSWORD_HASH=<the hash Claude gave you, or your own from npm run hash-password>
   RL_BOOK=20
   ```
   Optional, for Telegram alerts: `TELEGRAM_BOT_TOKEN=…` and `TELEGRAM_CHAT_ID=…` (see README §6).
   Do **not** set `DB_PATH`, `PORT`, `HOST` or `PUBLIC_ORIGIN`: the server derives them.
5. **Public link:** service → **Settings → Networking → Public Networking → Generate Domain**. If asked for a port, use the one shown in the deploy logs (`"url":"http://0.0.0.0:<port>"`; usually 8080).
6. Railway redeploys. Open **Deployments → View logs**. You should see:
   - `"event":"started"`, `"platform":"railway"`, `"persistentDb":true`, `"demo":true`, `"admin":"enabled"`;
   - a list of `"warning"` lines (unconfirmed prices, hours and so on). They're expected for a demo.

## Step 3 — Check it (or send Claude the link to check)

1. Open `https://<your-domain>/healthz`. It should say `{"ok":true}`.
2. Open `https://<your-domain>/` on your phone and computer. The DEMO ribbon shows bottom-left.
   Book something: service → date → time → name/phone → send → **"Cerere primită"** with an `MB-…` code and a DEMO note.
3. Open `https://<your-domain>/admin` and log in as `owner` with your password.
   The booking is there, marked **DEMO**. Confirm it, reject or cancel. The diagnostic line at the bottom should say **bază de date persistentă** (persistent database).
4. **Persistence:** service → **⋯ → Redeploy**. After it's back, the booking must still be in `/admin`.

## Before real customers use it (not now)

Keep `DEMO_MODE=1` until the owner has confirmed prices, services, hours, capacity and notifications (README §10). Then:
1. Set `DEMO_MODE=0` and redeploy. Demo bookings stop blocking any time slots right away.
2. In `/admin`, press **Șterge … programări demo** (delete demo bookings).
3. Optionally add the shop's own domain: **Networking → Custom Domain**, then the CNAME + TXT records at the domain registrar.

## Backups on Railway

- **Railway's own backups:** volume backups (manual or automated) are in the volume's settings. Use them.
- **Manual copy:** with the Railway CLI, `railway ssh` into the service, then run `node tools/backup.js`. Backups go to `/data/backups`.
- **Keep a copy off Railway:** download it with `railway volume files`, or by sftp/scp.
