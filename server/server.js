'use strict';
/*
 * My Barber — booking server (Node.js ≥ 22.13, no npm dependencies).
 * Serves the website (public/index.html) and the booking API from the same origin.
 *
 *   GET  /                          website
 *   GET  /api/config                services, durations, prices, hours (public)
 *   GET  /api/availability          free start times per day for a service (public)
 *   POST /api/bookings              create a booking (validated, rate-limited, idempotent)
 *   GET  /admin/login, POST /admin/login, POST /admin/logout
 *   GET  /admin                     bookings list (session cookie)
 *   POST /admin/bookings/:ref       confirm / reject / cancel (session + CSRF token + same-origin)
 *   POST /admin/test-notification   send a test Telegram alert (session + CSRF + same-origin)
 *   GET  /healthz                   health check (also checks the database)
 *
 * Secrets (admin password hash, Telegram token) come only from environment variables / .env.
 * Run exactly ONE instance per database file: slot checks rely on a single process.
 */
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const auth = require('./auth');

process.umask(0o077); // database, WAL and backup files are readable by this service user only

/* ---------------- environment ---------------- */
const ROOT = path.resolve(__dirname, '..');
const env = process.env;
const config = require(env.CONFIG_PATH ? path.resolve(ROOT, env.CONFIG_PATH) : './config');
const PROD = env.NODE_ENV === 'production';
const PORT = Number(env.PORT || 3000);
// Railway (railway.com) injects RAILWAY_* variables: use them for sensible defaults so a deploy needs few manual settings.
const ON_RAILWAY = !!(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID);
const VOLUME = env.RAILWAY_VOLUME_MOUNT_PATH || '';
const HOST = env.HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
const DB_PATH = path.resolve(ROOT, env.DB_PATH || (VOLUME ? path.join(VOLUME, 'bookings.db') : 'data/bookings.db'));
const PAGE_PATH = path.resolve(ROOT, env.PAGE_PATH || 'public/index.html');
const TRUST_PROXY = env.TRUST_PROXY ? env.TRUST_PROXY === '1' : ON_RAILWAY;
// Header set by the hosting proxy with the visitor's IP (Railway: x-real-ip). Only used when TRUST_PROXY is on.
const CLIENT_IP_HEADER = (env.CLIENT_IP_HEADER || (ON_RAILWAY ? 'x-real-ip' : '')).toLowerCase();
const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/+$/, '');
const HSTS = env.HSTS ? env.HSTS === '1' : ON_RAILWAY;   // Railway always serves HTTPS
const COOKIE_SECURE = env.COOKIE_SECURE !== '0';
const COOKIE = COOKIE_SECURE ? '__Host-mb_admin' : 'mb_admin';
const DEMO = env.DEMO_MODE === '1';
const DB_PERSISTENT = !ON_RAILWAY || (!!VOLUME && DB_PATH.startsWith(path.resolve(VOLUME) + path.sep));
const ADMIN_USER = env.ADMIN_USER || '';
const ADMIN_HASH = auth.parseHash(env.ADMIN_PASSWORD_HASH || '');
const ADMIN_ENABLED = !!(ADMIN_USER && ADMIN_HASH);
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = env.TELEGRAM_CHAT_ID || '';
const TG_API = (env.NODE_ENV === 'test' && env.TELEGRAM_API_BASE) || 'https://api.telegram.org';
const TG_ON = !!(TG_TOKEN && TG_CHAT);
const TEST_NOW = env.NODE_ENV === 'test' ? env.TEST_NOW || '' : ''; // tests only, e.g. "2026-10-20T08:00:00Z"

/* ---------------- config validation ---------------- */
const TZ = config.timezone;
const SERVICES = new Map();
(function validateConfig() {
  const bad = (m) => { throw new Error('config.js: ' + m); };
  if (TZ !== 'Europe/Chisinau') console.warn('config.js: timezone is ' + TZ + ' (expected Europe/Chisinau)');
  if (!Number.isInteger(config.chairs) || config.chairs < 1) bad('chairs must be an integer ≥ 1');
  if (!Number.isInteger(config.slotStepMin) || config.slotStepMin < 5) bad('slotStepMin must be ≥ 5');
  if (!Number.isInteger(config.bookingDays) || config.bookingDays < 1 || config.bookingDays > 90) bad('bookingDays must be 1–90');
  if (!Number.isInteger(config.minLeadMin) || config.minLeadMin < 0) bad('minLeadMin must be ≥ 0');
  for (const s of config.services) {
    if (!/^[a-z0-9-]{1,32}$/.test(s.id)) bad('bad service id ' + s.id);
    if (SERVICES.has(s.id)) bad('duplicate service id ' + s.id);
    if (!Number.isInteger(s.duration) || s.duration < 5) bad('bad duration for ' + s.id);
    if (s.price !== null && !(typeof s.price === 'number' && s.price >= 0)) bad('price must be null or a number for ' + s.id);
    SERVICES.set(s.id, s);
  }
  for (let d = 0; d < 7; d++) {
    const h = config.hours[d];
    if (h === null) continue;
    if (!Array.isArray(h) || !/^\d\d:\d\d$/.test(h[0]) || !/^\d\d:\d\d$/.test(h[1]) || toMin(h[0]) >= toMin(h[1])) bad('bad hours for weekday ' + d);
  }
  for (const d of config.closedDates || []) if (!isRealDate(d)) bad('bad closedDates entry ' + d);
})();

// Everything that is unverified or not production-ready. Shown at the top of /admin and in the server log.
const WARNINGS = (() => {
  const w = [], c = config.confirmedByOwner || {};
  const label = { services: 'lista de servicii și duratele', hours: 'programul de lucru și zilele libere', chairs: `numărul de locuri simultane (chairs = ${config.chairs})`, bookingRules: 'regulile de programare (pas, fereastră, confirmare automată)' };
  for (const k of Object.keys(label)) if (c[k] !== true) w.push(`Neconfirmat de proprietar: ${label[k]} (config.js → confirmedByOwner.${k}).`);
  const noPrice = config.services.filter((s) => s.price === null).map((s) => s.name);
  if (noPrice.length) w.push(`Prețuri lipsă (afișat „Preț de confirmat”): ${noPrice.join(', ')}.`);
  if (!TG_ON) w.push('Notificările Telegram nu sunt configurate (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID). Verificați /admin des sau configurați-le.');
  if (!DB_PERSISTENT) w.push('ATENȚIE: baza de date NU este pe un volum persistent Railway — programările se pierd la fiecare redeploy/restart. Atașați un Volume (Settings → Volumes) și nu setați DB_PATH în afara lui.');
  if (DEMO) w.push('MOD DEMO activ (DEMO_MODE=1): site-ul arată că programările sunt de test. Dezactivați înainte de lansare.');
  if (PROD && !/^https:\/\//.test(PUBLIC_ORIGIN)) w.push('PUBLIC_ORIGIN nu este setat la adresa https:// a site-ului.');
  if (PROD && !HSTS) w.push('HSTS=1 nu este activ (setați-l după ce HTTPS funcționează).');
  if (PROD && !COOKIE_SECURE) w.push('COOKIE_SECURE=0 în producție: cookie-ul de admin poate fi trimis fără HTTPS.');
  return w;
})();

/* ---------------- time helpers (shop-local time) ---------------- */
function toMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
function hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nowLocal() {
  const p = Object.fromEntries(dtf.formatToParts(TEST_NOW ? new Date(TEST_NOW) : new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function weekday(d) { return new Date(d + 'T00:00:00Z').getUTCDay(); }
function isRealDate(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d; }

/* ---------------- database ---------------- */
// In live mode, bookings made while DEMO_MODE was on never block real slots or count toward per-phone limits.
const ACTIVE = DEMO ? `status IN ('pending','confirmed')` : `status IN ('pending','confirmed') AND demo = 0`;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;`);
const SCHEMA_VERSION = 3;
function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id           INTEGER PRIMARY KEY,
      ref          TEXT NOT NULL UNIQUE,
      idem_key     TEXT UNIQUE,
      service_id   TEXT NOT NULL,
      date         TEXT NOT NULL,
      start_min    INTEGER NOT NULL,
      end_min      INTEGER NOT NULL,
      name         TEXT NOT NULL,
      phone        TEXT NOT NULL,
      lang         TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','cancelled')),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      notified_at  TEXT,
      notify_error TEXT,
      demo         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date, status);
    CREATE INDEX IF NOT EXISTS bookings_phone ON bookings(phone, date);
    CREATE TABLE IF NOT EXISTS booking_events (
      id          INTEGER PRIMARY KEY,
      booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      actor       TEXT NOT NULL,
      at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS booking_events_b ON booking_events(booking_id);
  `);
}
(function migrate() {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v >= SCHEMA_VERSION) return createTables();
  const old = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookings'`).get();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (old && v === 2) { // v2: add the demo flag
      db.exec(`ALTER TABLE bookings ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;`);
      createTables();
    } else if (old) { // v1 (first release): no 'rejected' status, no notification columns, no event log
      db.exec(`DROP INDEX IF EXISTS bookings_date; DROP INDEX IF EXISTS bookings_phone; ALTER TABLE bookings RENAME TO bookings_v1;`);
      createTables();
      db.exec(`INSERT INTO bookings (id, ref, idem_key, service_id, date, start_min, end_min, name, phone, lang, status, created_at, updated_at)
               SELECT id, ref, idem_key, service_id, date, start_min, end_min, name, phone, lang, status, created_at, updated_at FROM bookings_v1;
               DROP TABLE bookings_v1;`);
    } else createTables();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
    if (old) console.log(JSON.stringify({ t: new Date().toISOString(), event: 'migrated', from: v, to: SCHEMA_VERSION }));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
})();
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* not fatal (e.g. Windows) */ }

const q = {
  activeInRange: db.prepare(`SELECT date, start_min, end_min FROM bookings WHERE date BETWEEN ? AND ? AND ${ACTIVE}`),
  activeOnDate: db.prepare(`SELECT start_min, end_min FROM bookings WHERE date = ? AND ${ACTIVE}`),
  byKey: db.prepare(`SELECT * FROM bookings WHERE idem_key = ?`),
  byRef: db.prepare(`SELECT * FROM bookings WHERE ref = ?`),
  phoneSameDay: db.prepare(`SELECT ref FROM bookings WHERE phone = ? AND date = ? AND ${ACTIVE} LIMIT 1`),
  phoneUpcoming: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE phone = ? AND date >= ? AND ${ACTIVE}`),
  insert: db.prepare(`INSERT INTO bookings (ref, idem_key, service_id, date, start_min, end_min, name, phone, lang, status, created_at, updated_at, demo)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  demoCount: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE demo = 1`),
  demoDelete: db.prepare(`DELETE FROM bookings WHERE demo = 1`),
  event: db.prepare(`INSERT INTO booking_events (booking_id, from_status, to_status, actor, at) VALUES (?, ?, ?, ?, ?)`),
  setStatus: db.prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ? AND status = ?`),
  notifiedOk: db.prepare(`UPDATE bookings SET notified_at = ?, notify_error = NULL WHERE id = ?`),
  notifiedErr: db.prepare(`UPDATE bookings SET notify_error = ? WHERE id = ?`),
  purge: db.prepare(`DELETE FROM bookings WHERE date < ?`),
  ping: db.prepare(`SELECT 1 AS ok`),
};

/* ---------------- availability ---------------- */
function fits(list, s, e) {
  const ov = list.filter((b) => b.start_min < e && b.end_min > s);
  if (ov.length < config.chairs) return true;
  const points = [s, ...ov.map((b) => b.start_min).filter((x) => x > s && x < e)];
  return points.every((p) => ov.filter((b) => b.start_min <= p && b.end_min > p).length < config.chairs);
}
function daySlots(date, svc, list, now) {
  if (date < now.date || date > addDays(now.date, config.bookingDays - 1)) return [];
  if ((config.closedDates || []).includes(date)) return [];
  const h = config.hours[weekday(date)];
  if (!h) return [];
  const open = toMin(h[0]), close = toMin(h[1]);
  const earliest = date === now.date ? Math.max(open, now.min + config.minLeadMin) : open;
  const out = [];
  for (let s = open; s + svc.duration <= close; s += config.slotStepMin) {
    if (s >= earliest && fits(list, s, s + svc.duration)) out.push(hm(s));
  }
  return out;
}

/* ---------------- validation helpers ---------------- */
function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF<>]/g, '')
    .replace(/\s+/g, ' ').trim();
}
function normPhone(v) {
  if (typeof v !== 'string') return null;
  const p = v.replace(/[\s().\-\u00A0]/g, '');
  if (/^0\d{8}$/.test(p)) return '+373' + p.slice(1);        // Moldovan local format 0XXXXXXXX
  if (/^373\d{8}$/.test(p)) return '+' + p;
  if (/^00\d{8,15}$/.test(p)) return '+' + p.slice(2);
  if (/^\+\d{8,15}$/.test(p)) return p;
  return null;
}
function newRef() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(6);
  let s = 'MB-';
  for (const x of b) s += A[x % A.length];
  return s;
}

/* ---------------- HTTP helpers ---------------- */
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // same-origin: our own pages send Origin on form posts (needed for the CSRF/origin checks); other sites get no referrer
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
function headers(extra) {
  const h = { ...BASE_HEADERS, ...extra };
  if (HSTS) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}
function sendJson(res, status, obj, extra) {
  res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...extra }));
  res.end(JSON.stringify(obj));
}
function sendText(res, status, text, extra) {
  res.writeHead(status, headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }));
  res.end(text);
}
function redirect(res, to, extra) { res.writeHead(303, headers({ Location: to, 'Cache-Control': 'no-store', ...extra })); res.end(); }
function clientIp(req) {
  if (TRUST_PROXY && CLIENT_IP_HEADER) {
    const v = String(req.headers[CLIENT_IP_HEADER] || '').split(',')[0].trim();
    if (net.isIP(v)) return v;
  }
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // right-most = added by our own reverse proxy
  }
  return req.socket.remoteAddress || 'unknown';
}
function sameOrigin(req, { required }) {
  const origin = req.headers.origin;
  if (!origin) return !required;           // non-browser clients; browsers always send Origin on POST
  if (origin === 'null') return false;     // sandboxed/opaque contexts are never trusted
  if (PUBLIC_ORIGIN) return origin === PUBLIC_ORIGIN;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('too large'), { code: 413 });
    if (Number(req.headers['content-length'] || 0) > limit) { req.resume(); return reject(tooLarge()); }
    let size = 0, over = false; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; if (size > 64 * 1024) req.destroy(); } // discard; hard stop on abuse
      else if (!over) chunks.push(c);
    });
    req.on('end', () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function limiter(max, windowMs) {
  const m = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of m) if (now > v.reset) m.delete(k); }, 60_000).unref();
  return (key) => {
    const now = Date.now(); let e = m.get(key);
    if (!e || now > e.reset) { if (m.size > 50_000) m.clear(); e = { n: 0, reset: now + windowMs }; m.set(key, e); } // bounded memory
    e.n++;
    return e.n <= max ? 0 : Math.ceil((e.reset - now) / 1000);
  };
}
const rl = {
  read: limiter(Number(env.RL_READ || 120), 60_000),          // GET API: 120 / minute / IP
  book: limiter(Number(env.RL_BOOK || 8), 15 * 60_000),       // POST booking: 8 / 15 min / IP
  loginIp: limiter(10, 15 * 60_000),                           // failed admin logins: 10 / 15 min / IP
  loginAll: limiter(50, 15 * 60_000),                          // failed admin logins, all IPs together
};
function log(event, data) { console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data })); } // never log names/phones

/* ---------------- the website page (CSP hashes computed from the file) ---------------- */
let pageCache = { mtime: 0, html: '', csp: '' };
const DEMO_RIBBON = '<p class="demo-ribbon" role="note">DEMO · programările sunt de test · записи тестовые · test bookings only</p>';
function sha(s) { return "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'"; }
function loadPage() {
  const st = fs.statSync(PAGE_PATH);
  if (st.mtimeMs === pageCache.mtime) return pageCache;
  let html = fs.readFileSync(PAGE_PATH, 'utf8');
  const metaRe = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">\n?/;
  const m = html.match(metaRe);
  let policy = m ? m[1] : "default-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'";
  html = html.replace(metaRe, ''); // the header below replaces the meta tag, so edits to the page never leave a stale hash
  if (DEMO) html = html.replace('<body>', '<body>\n' + DEMO_RIBBON);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => sha(x[1]));
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((x) => sha(x[1]));
  const dirs = policy.split(';').map((s) => s.trim()).filter(Boolean);
  const extra = (name) => ((dirs.find((d) => d.startsWith(name + ' ')) || '').split(/\s+/).slice(1).filter((t) => !t.startsWith("'sha256-")));
  const set = (name, value) => { const i = dirs.findIndex((d) => d === name || d.startsWith(name + ' ')); if (i >= 0) dirs.splice(i, 1); dirs.push(value); };
  set('script-src', ['script-src', ...scripts, ...extra('script-src')].join(' '));
  set('style-src', ['style-src', ...styles, ...extra('style-src')].join(' '));
  set('connect-src', "connect-src 'self'");
  set('frame-ancestors', "frame-ancestors 'none'");
  pageCache = { mtime: st.mtimeMs, html, csp: dirs.join('; ') };
  return pageCache;
}

/* ---------------- Telegram notification (optional) ---------------- */
async function sendTelegram(text) {
  if (!TG_ON) return { ok: false, error: 'not configured' };
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { ok: true };
    let desc = ''; try { desc = String((await r.json()).description || '').slice(0, 120); } catch { /* ignore */ }
    return { ok: false, error: `HTTP ${r.status}${desc ? ': ' + desc : ''}` };
  } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : 'network error' }; }
}
async function notifyBooking(b, svc) {
  if (!TG_ON) return;
  const text = [
    `${DEMO ? '[DEMO] ' : ''}💈 ${b.status === 'confirmed' ? 'Programare nouă (confirmată)' : 'Cerere nouă de programare'} — ${b.ref}`,
    `${svc.name} (${svc.duration} min)`,
    `${b.date} ${hm(b.start_min)}–${hm(b.end_min)}`,
    `${b.name} · ${b.phone}`,
    b.status === 'pending' ? 'Confirmați sau respingeți în /admin și anunțați clientul.' : '',
  ].filter(Boolean).join('\n');
  const r = await sendTelegram(text);
  if (r.ok) q.notifiedOk.run(new Date().toISOString(), b.id);
  else { q.notifiedErr.run(r.error, b.id); log('telegram_failed', { ref: b.ref, error: r.error }); }
}

/* ---------------- API handlers ---------------- */
function apiConfig(req, res) {
  sendJson(res, 200, {
    shopName: config.shopName, currency: config.currency, timezone: TZ, slotStepMin: config.slotStepMin, demo: DEMO,
    bookingDays: config.bookingDays, autoConfirm: config.autoConfirm, retentionDays: config.retentionDays, hours: config.hours,
    services: config.services.map((s) => ({ id: s.id, name: s.name, duration: s.duration, price: s.price, fromPrice: !!s.fromPrice })),
  });
}

function apiAvailability(req, res, url) {
  const svc = SERVICES.get(url.searchParams.get('service') || '');
  if (!svc) return sendJson(res, 400, { error: 'invalid', field: 'service' });
  const now = nowLocal();
  const last = addDays(now.date, config.bookingDays - 1);
  const byDate = new Map();
  for (const b of q.activeInRange.all(now.date, last)) { if (!byDate.has(b.date)) byDate.set(b.date, []); byDate.get(b.date).push(b); }
  const days = [];
  for (let i = 0; i < config.bookingDays; i++) {
    const date = addDays(now.date, i);
    days.push({ date, slots: daySlots(date, svc, byDate.get(date) || [], now) });
  }
  sendJson(res, 200, { today: now.date, service: svc.id, duration: svc.duration, days });
}

async function apiCreateBooking(req, res) {
  const ip = clientIp(req);
  if (!sameOrigin(req, { required: false })) return sendJson(res, 403, { error: 'origin' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'content_type' });
  const wait = rl.book(ip);
  if (wait) return sendJson(res, 429, { error: 'rate_limited', retryAfter: wait }, { 'Retry-After': String(wait) });

  let body;
  try { body = JSON.parse(await readBody(req, 4096)); } catch (e) { return e.code === 413 ? sendJson(res, 413, { error: 'too_large' }, { Connection: 'close' }) : sendJson(res, 400, { error: 'invalid_json' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid_json' });

  // honeypot: a hidden field real visitors never fill in
  if (typeof body.website === 'string' && body.website.trim() !== '') { log('honeypot', {}); return sendJson(res, 400, { error: 'invalid' }); }

  const key = typeof body.key === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(body.key) ? body.key : null;
  if (!key) return sendJson(res, 400, { error: 'invalid', field: 'key' });
  const svc = typeof body.service === 'string' ? SERVICES.get(body.service) : null;
  if (!svc) return sendJson(res, 400, { error: 'invalid', field: 'service' });
  if (!isRealDate(body.date)) return sendJson(res, 400, { error: 'invalid', field: 'date' });
  if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) return sendJson(res, 400, { error: 'invalid', field: 'time' });
  const name = cleanName(body.name);
  if ([...name].length < 2 || [...name].length > 40 || !/\p{L}/u.test(name)) return sendJson(res, 400, { error: 'invalid', field: 'name' });
  const phone = normPhone(body.phone);
  if (!phone) return sendJson(res, 400, { error: 'invalid', field: 'phone' });
  const lang = ['ro', 'ru', 'en'].includes(body.lang) ? body.lang : 'ro';
  const start = toMin(body.time), end = start + svc.duration;

  // Idempotency: a retried request (same key) returns the booking already stored instead of creating a second one.
  const prev = q.byKey.get(key);
  if (prev) {
    if (prev.service_id === svc.id && prev.date === body.date && prev.start_min === start && prev.phone === phone)
      return sendJson(res, 200, publicBooking(prev, svc));
    return sendJson(res, 409, { error: 'key_reused' });
  }

  const now = nowLocal();
  let row, conflict = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!daySlots(body.date, svc, q.activeOnDate.all(body.date), now).includes(body.time)) conflict = 'slot_taken';
    else if (q.phoneSameDay.get(phone, body.date)) conflict = 'duplicate';
    else if (q.phoneUpcoming.get(phone, now.date).n >= config.maxActivePerPhone) conflict = 'limit';
    else {
      const ts = new Date().toISOString();
      const status = config.autoConfirm ? 'confirmed' : 'pending';
      let ref;
      for (let i = 0; i < 5; i++) { ref = newRef(); if (!q.byRef.get(ref)) break; }
      const r = q.insert.run(ref, key, svc.id, body.date, start, end, name, phone, lang, status, ts, ts, DEMO ? 1 : 0);
      q.event.run(Number(r.lastInsertRowid), null, status, 'customer', ts);
      row = q.byRef.get(ref);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (conflict) { log('booking_rejected', { reason: conflict, service: svc.id, date: body.date, time: body.time }); return sendJson(res, 409, { error: conflict }); }
  log('booking_created', { ref: row.ref, status: row.status, service: svc.id, date: row.date, time: body.time });
  notifyBooking(row, svc).catch((e) => log('telegram_failed', { ref: row.ref, error: e.message }));
  sendJson(res, 201, publicBooking(row, svc));
}
function publicBooking(b, svc) {
  return { ref: b.ref, status: b.status, service: b.service_id, date: b.date, time: hm(b.start_min), end: hm(b.end_min), duration: svc ? svc.duration : b.end_min - b.start_min, demo: DEMO };
}

/* ---------------- admin ---------------- */
const sessions = new auth.Sessions();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_RO = { pending: 'în așteptare', confirmed: 'confirmată', rejected: 'respinsă', cancelled: 'anulată' };
// Allowed status changes: action -> { from status -> to status }
const TRANSITIONS = { confirm: { pending: 'confirmed' }, reject: { pending: 'rejected' }, cancel: { pending: 'cancelled', confirmed: 'cancelled' } };
const ACTION_RO = { confirm: 'Confirmă', reject: 'Respinge', cancel: 'Anulează' };
const MSG_RO = { confirmed: 'Programarea a fost confirmată. Anunțați clientul.', rejected: 'Cererea a fost respinsă. Anunțați clientul.', cancelled: 'Programarea a fost anulată. Anunțați clientul.',
  tg_ok: 'Mesajul de test a fost trimis în Telegram. Verificați că a ajuns.', tg_fail: 'Trimiterea mesajului de test a eșuat', tg_off: 'Telegram nu este configurat.', conflict: 'Starea programării s-a schimbat între timp; nu s-a modificat nimic.', demo_deleted: 'Toate programările demo au fost șterse.' };
let lastTgTest = null;

function adminPage(res, title, body, status = 200, extraHeaders = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = `<!DOCTYPE html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — ${esc(config.shopName)}</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#1c0a0e;color:#efe6d6;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{padding:24px 16px;max-width:1240px;margin:auto}
h1{font:600 28px Georgia,serif;margin:0 0 6px}a{color:#e6c581}p.sub{color:#bfae9a;margin:0 0 16px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.warn{border:1px solid #c9a25a;background:rgba(201,162,90,.1);border-radius:12px;padding:10px 16px;margin:0 0 16px}.warn li{margin:2px 0}.warn b{color:#e6c581}
.msg{border-radius:12px;padding:10px 16px;margin:0 0 16px;background:#2f4a2a}.msg.bad{background:#5a1e24}.demo{background:#5a1e24;border-radius:12px;padding:8px 16px;margin:0 0 16px;font-weight:700}
nav.f{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}nav.f a{padding:6px 12px;border:1px solid rgba(201,162,90,.4);border-radius:999px;text-decoration:none;font-size:13px}nav.f a.on{background:#c9a25a;color:#1c0a0e}
table{width:100%;border-collapse:collapse}th,td{padding:9px 8px;border-bottom:1px solid rgba(201,162,90,.25);text-align:left;vertical-align:middle}th{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#c9a25a}
tr.cancelled td,tr.rejected td{opacity:.5}.dm{display:inline-block;padding:0 8px;border-radius:999px;background:#8a2a3a;color:#fff;font-size:11px;font-weight:700}tr.pending td.s{color:#ffd27a;font-weight:700}tr.confirmed td.s{color:#9be29b;font-weight:700}td.n{font-size:12px;color:#bfae9a}td.n.err{color:#ffb4a8}
td.a{display:flex;gap:6px;flex-wrap:wrap}form{margin:0}button{min-height:36px;padding:0 14px;border-radius:999px;border:1px solid #c9a25a;background:#c9a25a;color:#1c0a0e;font-weight:700;cursor:pointer;font-size:13px}
button.o{background:transparent;color:#efe6d6}label{display:block;margin:14px 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#c9a25a}
input{width:100%;min-height:46px;padding:0 14px;border-radius:10px;border:1px solid rgba(201,162,90,.5);background:rgba(0,0,0,.3);color:#efe6d6;font-size:16px}.login{max-width:380px;margin:10vh auto}.login button{width:100%;margin-top:20px;min-height:46px}
@media(max-width:820px){table,tbody,tr,td{display:block}thead{display:none}tr{border:1px solid rgba(201,162,90,.3);border-radius:12px;margin:0 0 12px;padding:6px}td{border:0;padding:3px 8px}}
</style></head><body><main>${body}</main></body></html>`;
  res.writeHead(status, headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, ...extraHeaders }));
  res.end(html);
}
function disabledPage(res) {
  adminPage(res, 'Admin dezactivat', `<h1>Admin dezactivat</h1><p class="sub">Setați <code>ADMIN_USER</code> și <code>ADMIN_PASSWORD_HASH</code> în <code>.env</code> (creați hash-ul cu <code>npm run hash-password</code>), apoi reporniți serverul.</p>`, 503);
}
function currentSession(req) { return sessions.get(cookies(req)[COOKIE]); }
function sessionCookie(id, maxAge) { return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`; }

function loginForm(res, error, status = 200) {
  adminPage(res, 'Autentificare', `<div class="login"><h1>${esc(config.shopName)} · admin</h1>${error ? `<p class="msg bad">${esc(error)}</p>` : ''}
<form method="post" action="/admin/login"><label for="u">Utilizator</label><input id="u" name="user" autocomplete="username" required maxlength="64" autofocus>
<label for="p">Parolă</label><input id="p" name="password" type="password" autocomplete="current-password" required maxlength="200"><button>Intră</button></form></div>`, status);
}
async function loginPost(req, res) {
  if (!sameOrigin(req, { required: true })) return sendText(res, 403, 'Forbidden (origin check).');
  const ip = clientIp(req);
  let form;
  try { form = new URLSearchParams(await readBody(req, 1024)); } catch { return sendText(res, 400, 'Bad request.'); }
  const user = form.get('user') || '', pw = form.get('password') || '';
  const passOk = await auth.verifyPassword(pw, ADMIN_HASH);       // always computed, also for a wrong user name
  if (passOk && auth.safeEqual(user, ADMIN_USER)) {
    const id = sessions.create(ADMIN_USER);
    log('admin_login', {});
    return redirect(res, '/admin', { 'Set-Cookie': sessionCookie(id, 12 * 3600) });
  }
  const wait = rl.loginIp(ip) || rl.loginAll('all');
  log('admin_login_failed', {});
  if (wait) return loginForm(res, `Prea multe încercări. Reîncercați peste ${Math.ceil(wait / 60)} min.`, 429);
  return loginForm(res, 'Utilizator sau parolă greșită.', 401);
}
function checkCsrf(req, s, form) {
  return sameOrigin(req, { required: true }) && auth.safeEqual(form.get('csrf') || '', s.csrf);
}
function safeBack(v) { return /^\/admin(\?[a-z=&]{0,60})?$/.test(v || '') ? v : '/admin'; }

function listPage(req, res, url, s) {
  const view = ['upcoming', 'past', 'all'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'upcoming';
  const st = ['pending', 'confirmed', 'rejected', 'cancelled'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
  const today = nowLocal().date;
  const where = [], params = [];
  if (view === 'upcoming') { where.push('date >= ?'); params.push(today); }
  if (view === 'past') { where.push('date < ?'); params.push(today); }
  if (st !== 'all') { where.push('status = ?'); params.push(st); }
  const sql = `SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date ${view === 'past' ? 'DESC' : 'ASC'}, start_min, id LIMIT 500`;
  const rows = db.prepare(sql).all(...params);
  const pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status='pending' AND date >= ?`).get(today).n;
  const back = `/admin?view=${view}&status=${st}`;
  const flt = (k, v, label, cur) => `<a class="${cur === v ? 'on' : ''}" href="/admin?${k === 'view' ? `view=${v}&status=${st}` : `view=${view}&status=${v}`}">${label}</a>`;
  const msgKey = url.searchParams.get('msg');
  let msg = '';
  if (msgKey && MSG_RO[msgKey]) msg = `<p class="msg${['tg_fail', 'tg_off', 'conflict'].includes(msgKey) ? ' bad' : ''}">${esc(MSG_RO[msgKey])}${msgKey === 'tg_fail' && lastTgTest ? ': ' + esc(lastTgTest.error) : ''}</p>`;
  const tr = rows.map((b) => {
    const svc = SERVICES.get(b.service_id);
    const acts = Object.keys(TRANSITIONS).filter((a) => TRANSITIONS[a][b.status]).map((a) =>
      `<form method="post" action="/admin/bookings/${esc(b.ref)}"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="action" value="${a}"><input type="hidden" name="back" value="${esc(back)}"><button class="${a === 'confirm' ? '' : 'o'}">${ACTION_RO[a]}</button></form>`).join('');
    const note = !TG_ON ? '<td class="n">—</td>' : b.notified_at ? '<td class="n">✓ trimis</td>' : b.notify_error ? `<td class="n err">✗ ${esc(b.notify_error)}</td>` : '<td class="n">…</td>';
    return `<tr class="${esc(b.status)}"><td>${esc(b.date)}</td><td>${hm(b.start_min)}–${hm(b.end_min)}</td><td>${esc(svc ? svc.name : b.service_id)}</td>` +
      `<td>${esc(b.name)}</td><td><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></td><td class="s">${STATUS_RO[b.status]}${b.demo ? ' <span class="dm">DEMO</span>' : ''}</td><td><code>${esc(b.ref)}</code></td>${note}<td class="a">${acts}</td></tr>`;
  }).join('');
  const demoN = q.demoCount.get().n;
  const allWarn = WARNINGS.concat(!DEMO && demoN ? [`Există ${demoN} programări demo rămase din testare. Nu blochează orele reale, dar ștergeți-le înainte de lansare.`] : []);
  const warn = allWarn.length ? `<div class="warn"><b>De verificat înainte de lansare:</b><ul>${allWarn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  adminPage(res, 'Programări', `${DEMO ? '<p class="demo">MOD DEMO — programările sunt de test</p>' : ''}<div class="top"><div><h1>Programări</h1>
<p class="sub">${rows.length} afișate · ${pendingCount} cereri în așteptare · ora Chișinăului (${esc(today)}) · ${config.autoConfirm ? 'confirmare automată' : 'cererile se confirmă manual'}</p></div>
<div class="top">${demoN ? `<form method="post" action="/admin/demo-delete"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="o">Șterge ${demoN} programări demo</button></form>` : ''}<form method="post" action="/admin/test-notification"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="o">Test Telegram</button></form>
<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="o">Ieșire</button></form></div></div>
${msg}${warn}<nav class="f">${flt('view', 'upcoming', 'Azi și viitoare', view)}${flt('view', 'past', 'Trecute', view)}${flt('view', 'all', 'Toate', view)}</nav>
<nav class="f">${flt('status', 'all', 'Orice stare', st)}${flt('status', 'pending', 'În așteptare', st)}${flt('status', 'confirmed', 'Confirmate', st)}${flt('status', 'rejected', 'Respinse', st)}${flt('status', 'cancelled', 'Anulate', st)}</nav>
<table><thead><tr><th>Data</th><th>Ora</th><th>Serviciu</th><th>Nume</th><th>Telefon</th><th>Stare</th><th>Cod</th><th>Telegram</th><th>Acțiuni</th></tr></thead>
<tbody>${tr || '<tr><td colspan="9">Nicio programare.</td></tr>'}</tbody></table>
<p class="sub">Clientul nu primește automat SMS: după confirmare, respingere sau anulare, sunați-l la numărul din listă.</p>
<p class="sub">Diagnostic: IP-ul dvs. văzut de server: <code>${esc(clientIp(req))}</code> (folosit pentru limitele anti-spam) · bază de date ${DB_PERSISTENT ? 'persistentă' : '<b>NEPERSISTENTĂ</b>'}.</p>`);
}
async function statusAction(req, res, s, ref) {
  let form;
  try { form = new URLSearchParams(await readBody(req, 2048)); } catch { return sendText(res, 400, 'Bad request.'); }
  if (!checkCsrf(req, s, form)) return sendText(res, 403, 'Forbidden (CSRF check failed). Reload the admin page and try again.');
  const action = form.get('action'), back = safeBack(form.get('back'));
  const b = q.byRef.get(ref);
  if (!b) return sendText(res, 404, 'Not found.');
  const to = TRANSITIONS[action] && TRANSITIONS[action][b.status];
  if (!to) return sendText(res, 409, `Action "${String(action).slice(0, 20)}" is not allowed for a booking that is ${b.status}.`);
  const ts = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  let changed;
  try {
    changed = q.setStatus.run(to, ts, b.id, b.status).changes;
    if (changed) q.event.run(b.id, b.status, to, 'admin:' + s.user, ts);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (!changed) return redirect(res, back + (back.includes('?') ? '&' : '?') + 'msg=conflict');
  log('admin_status', { ref, from: b.status, to });
  redirect(res, back + (back.includes('?') ? '&' : '?') + 'msg=' + to);
}
async function handleAdmin(req, res, url) {
  const p = url.pathname, method = req.method;
  if (!ADMIN_ENABLED) return disabledPage(res);
  if (p === '/admin/login') {
    if (method === 'GET') return currentSession(req) ? redirect(res, '/admin') : loginForm(res);
    if (method === 'POST') return loginPost(req, res);
    return sendText(res, 405, 'Method not allowed.');
  }
  const s = currentSession(req);
  if (!s) return method === 'GET' ? redirect(res, '/admin/login') : sendText(res, 401, 'Not logged in.');
  if (p === '/admin' && method === 'GET') return listPage(req, res, url, s);
  if (method !== 'POST') return sendText(res, 404, 'Not found.');
  if (p === '/admin/logout') {
    let form; try { form = new URLSearchParams(await readBody(req, 1024)); } catch { return sendText(res, 400, 'Bad request.'); }
    if (!checkCsrf(req, s, form)) return sendText(res, 403, 'Forbidden (CSRF check failed).');
    sessions.destroy(cookies(req)[COOKIE]);
    return redirect(res, '/admin/login', { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p === '/admin/demo-delete') {
    let form; try { form = new URLSearchParams(await readBody(req, 1024)); } catch { return sendText(res, 400, 'Bad request.'); }
    if (!checkCsrf(req, s, form)) return sendText(res, 403, 'Forbidden (CSRF check failed).');
    const n = Number(q.demoDelete.run().changes);
    log('demo_deleted', { count: n });
    return redirect(res, '/admin?msg=demo_deleted');
  }
  if (p === '/admin/test-notification') {
    let form; try { form = new URLSearchParams(await readBody(req, 1024)); } catch { return sendText(res, 400, 'Bad request.'); }
    if (!checkCsrf(req, s, form)) return sendText(res, 403, 'Forbidden (CSRF check failed).');
    if (!TG_ON) return redirect(res, '/admin?msg=tg_off');
    lastTgTest = await sendTelegram(`${DEMO ? '[DEMO] ' : ''}✅ Test ${config.shopName}: notificările de programare funcționează.`);
    log('telegram_test', { ok: lastTgTest.ok, error: lastTgTest.error });
    return redirect(res, '/admin?msg=' + (lastTgTest.ok ? 'tg_ok' : 'tg_fail'));
  }
  const am = /^\/admin\/bookings\/(MB-[A-Z0-9]{6})$/.exec(p);
  if (am) return statusAction(req, res, s, am[1]);
  return sendText(res, 404, 'Not found.');
}

/* ---------------- router ---------------- */
async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendText(res, 400, 'Bad request.'); }
  const p = url.pathname, method = req.method;
  try {
    if (p.startsWith('/api/')) {
      if (method === 'GET' || method === 'HEAD') {
        const wait = rl.read(clientIp(req));
        if (wait) return sendJson(res, 429, { error: 'rate_limited', retryAfter: wait }, { 'Retry-After': String(wait) });
        if (p === '/api/config') return apiConfig(req, res);
        if (p === '/api/availability') return apiAvailability(req, res, url);
      }
      if (method === 'POST' && p === '/api/bookings') return await apiCreateBooking(req, res);
      return sendJson(res, ['/api/bookings', '/api/config', '/api/availability'].includes(p) ? 405 : 404, { error: 'not_found' });
    }
    if (p === '/admin' || p.startsWith('/admin/')) return await handleAdmin(req, res, url);
    if ((p === '/' || p === '/index.html') && (method === 'GET' || method === 'HEAD')) {
      const pg = loadPage();
      res.writeHead(200, headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': pg.csp }));
      return res.end(method === 'HEAD' ? undefined : pg.html);
    }
    if (p === '/healthz') { q.ping.get(); return sendJson(res, 200, { ok: true }); }
    if (p === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /api/\n', { 'Cache-Control': 'public, max-age=86400' });
    return sendText(res, 404, 'Not found.');
  } catch (e) {
    log('server_error', { path: p, error: e.message });
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.end();
  }
}

/* ---------------- retention & start ---------------- */
function purgeOld() {
  const cutoff = addDays(nowLocal().date, -config.retentionDays);
  const r = q.purge.run(cutoff);
  if (r.changes) log('purged', { count: Number(r.changes), before: cutoff });
}
purgeOld();
setInterval(purgeOld, 6 * 3600_000).unref();

const server = http.createServer(handle);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(PORT, HOST, () => {
  log('started', { url: `http://${HOST}:${PORT}`, db: path.relative(ROOT, DB_PATH), schema: SCHEMA_VERSION,
    admin: ADMIN_ENABLED ? 'enabled' : env.ADMIN_PASSWORD ? 'disabled (ADMIN_PASSWORD is no longer used: set ADMIN_PASSWORD_HASH via npm run hash-password)' : 'disabled (set ADMIN_USER and ADMIN_PASSWORD_HASH)',
    platform: ON_RAILWAY ? 'railway' : 'generic', publicOrigin: PUBLIC_ORIGIN || '(from Host header)', persistentDb: DB_PERSISTENT,
    telegram: TG_ON ? 'configured (not yet verified — use "Test Telegram" in /admin)' : 'off', demo: DEMO, autoConfirm: config.autoConfirm, chairs: config.chairs });
  for (const w of WARNINGS) log('warning', { message: w });
  try { loadPage(); } catch (e) { log('page_missing', { path: PAGE_PATH, error: e.message }); }
});
function shutdown() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
