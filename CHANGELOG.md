# Changelog

## 1.3.0 — online demo deployment (Railway)
- **Railway auto-configuration** from Railway's own variables:
  - listen on `0.0.0.0`;
  - `PUBLIC_ORIGIN` from `RAILWAY_PUBLIC_DOMAIN`;
  - database on `RAILWAY_VOLUME_MOUNT_PATH`;
  - `TRUST_PROXY` on, with the visitor IP from `x-real-ip`;
  - HSTS on.
  Everything can still be overridden with explicit variables.
- **Missing volume:** a loud warning appears in the log and in `/admin` if the database isn't on a persistent volume.
- **Demo separation** (schema v3, migrated automatically):
  - bookings made with `DEMO_MODE=1` are tagged `demo`;
  - with `DEMO_MODE=0` they never block slots or count toward per-phone limits;
  - they're marked DEMO in admin, with a warning and a **delete demo bookings** button.
- **Admin diagnostic:** the page shows the IP the server sees and whether the database is persistent.
- **Railway setup files:** `railway.json` (start command, `/healthz` health check, restart policy) and `.nvmrc` (Node 22).
- **Dockerfile moved** to `deploy/Dockerfile`. Railway always uses a root Dockerfile, and its non-root user breaks volumes.
- **Backups:** `npm run backup` defaults to the volume on Railway.
- **New deploy guide:** `DEPLOY-RAILWAY.md`.
- **Tests:** 31 → 36 (demo separation, v2→v3 migration, Railway origin/volume/HSTS, missing-volume warning, proxy-IP rate limiting).

## 1.2.0 — date/time selection in the local preview
- **Fixed:** opening `public/index.html` directly blocked the date and time step, because the file check stopped availability loading. It now runs a **local preview**: SAMPLE dates and times generated from the configured hours, slot step, lead time and service duration (Chișinău time, past times excluded), clearly labelled "samples". The complete journey can be clicked through.
- The preview shows "DEMO — no real booking is created" on every step and "DEMO — no real booking created" at the end. It sends no network request: availability, config and booking are all skipped, the page's API helper refuses to send, no `MB-` reference is shown and nothing says "confirmed".
- Preview runs only when the file is opened directly, or on localhost with `?preview=sample`. On a real domain the server API is always used, and API failures show an error with Retry (never sample slots).
- **Fixed:** the Retry button passed the click event in as a message key, which broke the error text.
- **Tests:** new `tests/browser.test.js` with 8 Playwright browser tests for local preview, `?preview=sample`, server mode, an unavailable API and booking submission. `playwright` is a dev-only dependency.

## 1.1.0 — client-demo / production preparation

**Admin**
- Replaced HTTP Basic auth with a login page and an scrypt-hashed password (`ADMIN_PASSWORD_HASH`, created with `npm run hash-password`).
  There is no default password, and plaintext `ADMIN_PASSWORD` is ignored.
- Server-side sessions: an HttpOnly, Secure, SameSite=Strict `__Host-` cookie, with only a hash of it stored on the server. Sessions time out after 2 h idle or 12 h total. Logout added.
- A CSRF token plus an Origin check on every admin action. Login lockout per IP and globally.
- New **reject** action. Status changes follow fixed rules:
  - pending → confirmed / rejected / cancelled
  - confirmed → cancelled
  - other changes are refused with 409.
- Audit log of every status change (`booking_events`).
- Filters (upcoming / past / all, by status), pending counter, mobile layout.
- Warning box listing unconfirmed business details, missing prices, missing notifications and production misconfiguration.

**Bookings**
- Pending requests are labelled as awaiting confirmation; the customer is told the shop will contact them.
- Opaque `Origin: null` requests are refused.

**Notifications**
- Each booking records whether its Telegram alert was sent, or the error; both are shown in admin.
- **Test Telegram** button.

**Reliability**
- Database schema versioning, with automatic migration of first-release databases.
- `npm run backup`: online, integrity-checked backup with rotation. It no longer needs the `sqlite3` program.
- Database and backups are created readable only by the service user (umask 077).
- Rate-limiter memory is capped. The health check also tests the database.

**Demo mode**
- `DEMO_MODE=1` shows a "DEMO · test bookings" ribbon on the site.
- Booking results and Telegram alerts are marked as demo.

**Fixes found in testing**
- `Referrer-Policy: no-referrer` made browsers send `Origin: null` on form posts, which broke admin forms in real browsers and weakened the booking origin check. Changed to `same-origin` (outside sites still get no referrer).
- The Dockerfile's `/data` volume wasn't writable by the non-root user.

**Tests and docs**
- Tests: 12 → 31, covering capacity, closed days, the Chișinău time zone and DST, SQL injection, admin authorization, CSRF, status changes, restart persistence, migration, backup, a Telegram mock and demo mode.
- README rewritten: deployment with release folders, rollback, backups and restore, environment table, pre-launch checklist, verification status.

## 1.0.0
- On-site booking (Node + SQLite), admin list with Basic auth, optional Telegram, page CSP computed by the server.
