'use strict';
// Run: npm test   — starts throw-away servers on temporary databases; never touches data/bookings.db.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../server/auth');

const ROOT = path.resolve(__dirname, '..');
const NOW = '2026-10-20T07:00:00Z';            // 10:00 in Chișinău (EEST, UTC+3)
const USER = 'owner', PASS = 'test-admin-password-123';
const HASH = hashPassword(PASS);
const servers = [];

function startServer(extraEnv = {}, dbPath) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));
    const db = dbPath || path.join(dir, 'db.sqlite');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
      cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: 'test', TEST_NOW: NOW, PORT: String(port), HOST: '127.0.0.1', DB_PATH: db,
        ADMIN_USER: USER, ADMIN_PASSWORD_HASH: HASH, RL_BOOK: '1000', ...extraEnv } });
    let out = '';
    const s = { p, base: `http://127.0.0.1:${port}`, db, log: () => out };
    p.stdout.on('data', (d) => { out += d; if (out.includes('"started"')) resolve(s); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('server exited ' + c + '\n' + out)));
    servers.push(s);
  });
}
function stop(s) { return new Promise((r) => { if (s.p.exitCode !== null) return r(); s.p.removeAllListeners('exit'); s.p.on('exit', r); s.p.kill('SIGTERM'); }); }
after(async () => { for (const s of servers) await stop(s); });

const key = () => crypto.randomUUID();
const post = (base, body, headers = {}) => fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ok = (o) => ({ service: 'haircut', date: '2026-10-21', time: '10:00', name: 'Ion Popescu', phone: '068 123 456', lang: 'ro', website: '', key: key(), ...o });
const avail = async (base, service = 'haircut') => (await fetch(base + '/api/availability?service=' + service)).json();
let phoneN = 0; const uniqPhone = () => '0690' + String(10000 + phoneN++).padStart(5, '0');
function dbRead(file, sql, ...params) { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare(sql).all(...params); } finally { d.close(); } }

// ---------- admin helpers (cookie session + CSRF token) ----------
async function login(base, user = USER, pass = PASS, origin = base) {
  const h = { 'Content-Type': 'application/x-www-form-urlencoded' }; if (origin) h.Origin = origin;
  return fetch(base + '/admin/login', { method: 'POST', redirect: 'manual', headers: h, body: new URLSearchParams({ user, password: pass }).toString() });
}
async function session(base) {
  const r = await login(base);
  assert.equal(r.status, 303);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(base + '/admin', { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  return { cookie, csrf, html };
}
function adminPost(base, s, pathname, fields, origin = base) {
  const h = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: s.cookie }; if (origin) h.Origin = origin;
  return fetch(base + pathname, { method: 'POST', redirect: 'manual', headers: h, body: new URLSearchParams(fields).toString() });
}

describe('customer booking API', () => {
  let S;
  before(async () => { S = await startServer(); });

  test('page is served with a computed CSP header and security headers', async () => {
    const r = await fetch(S.base + '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy'), html = await r.text();
    assert.match(csp, /default-src 'none'/); assert.match(csp, /connect-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
    const js = html.match(/<script>([\s\S]*?)<\/script>/)[1], css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.ok(csp.includes(crypto.createHash('sha256').update(js).digest('base64')), 'script hash');
    assert.ok(csp.includes(crypto.createHash('sha256').update(css).digest('base64')), 'style hash');
    assert.ok(!html.includes('http-equiv="Content-Security-Policy"'));
    assert.ok(!html.includes('demo-ribbon" role'), 'no demo ribbon unless DEMO_MODE=1');
    for (const [h, v] of [['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'same-origin']]) assert.equal(r.headers.get(h), v);
  });

  test('config exposes services with placeholder prices (no invented prices)', async () => {
    const c = await (await fetch(S.base + '/api/config')).json();
    assert.equal(c.services.length, 5); assert.ok(c.services.every((s) => s.price === null));
    assert.deepEqual(c.services.map((s) => s.duration), [40, 30, 60, 90, 15]);
    assert.equal(c.timezone, 'Europe/Chisinau');
  });

  test('availability: lead time, closing time, window, unknown service', async () => {
    const a = await avail(S.base);
    assert.equal(a.today, '2026-10-20'); assert.equal(a.days.length, 14);
    assert.equal(a.days[0].slots[0], '11:00');               // now 10:00 + 60 min lead
    assert.equal(a.days[1].slots[0], '10:00');
    assert.equal(a.days[1].slots.at(-1), '18:00');            // 40 min must end by 19:00
    assert.equal((await fetch(S.base + '/api/availability?service=nope')).status, 400);
  });

  test('a saved booking removes overlapping slots for every service', async () => {
    const r = await post(S.base, ok({}));
    assert.equal(r.status, 201);
    const b = await r.json();
    assert.match(b.ref, /^MB-[A-Z0-9]{6}$/); assert.equal(b.status, 'pending'); assert.equal(b.time, '10:00'); assert.equal(b.demo, false);
    const combo = (await avail(S.base, 'combo')).days[1].slots, beard = (await avail(S.base, 'beard')).days[1].slots;
    assert.ok(!combo.includes('10:00') && !combo.includes('10:30') && combo.includes('11:00'));
    assert.ok(!beard.includes('10:30') && beard.includes('11:00'));
  });

  test('12 simultaneous requests for one slot: exactly one wins', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => post(S.base, ok({ time: '15:00', date: '2026-10-22', phone: uniqPhone() }))));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 1);
    assert.equal(codes.filter((c) => c === 409).length, 11);
  });

  test('retry with the same key returns the same booking; reused key with new details is refused', async () => {
    const body = ok({ date: '2026-10-23', time: '12:00', phone: '079 000 111' });
    const a = await (await post(S.base, body)).json();
    const r2 = await post(S.base, body); assert.equal(r2.status, 200); assert.equal((await r2.json()).ref, a.ref);
    const r3 = await post(S.base, { ...body, time: '13:00' }); assert.equal(r3.status, 409); assert.equal((await r3.json()).error, 'key_reused');
    assert.equal(dbRead(S.db, 'SELECT COUNT(*) AS n FROM bookings WHERE phone = ?', '+37379000111')[0].n, 1);
  });

  test('one booking per phone per day (any phone format) and max upcoming per phone', async () => {
    assert.equal((await post(S.base, ok({ date: '2026-10-24', time: '10:00', phone: '060 555 777' }))).status, 201);
    const r = await post(S.base, ok({ date: '2026-10-24', time: '14:00', phone: '+373 60 555 777' }));
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'duplicate');
    for (const d of ['2026-10-25', '2026-10-26', '2026-10-27']) assert.equal((await post(S.base, ok({ date: d, time: '16:00', phone: '067 222 333' }))).status, 201);
    assert.equal((await (await post(S.base, ok({ date: '2026-10-28', time: '16:00', phone: '067 222 333' }))).json()).error, 'limit');
  });

  test('invalid input is rejected with the offending field', async () => {
    const bad = async (o, field) => { const r = await post(S.base, ok(o)); assert.equal(r.status, 400, JSON.stringify(o)); if (field) assert.equal((await r.json()).field, field); };
    await bad({ name: 'x' }, 'name'); await bad({ name: '<<>>' }, 'name'); await bad({ name: '1234' }, 'name'); await bad({ name: 'a'.repeat(41) }, 'name'); await bad({ name: 42 }, 'name');
    await bad({ phone: '12' }, 'phone'); await bad({ phone: 'abc' }, 'phone'); await bad({ phone: ['068123456'] }, 'phone');
    await bad({ service: 'massage' }, 'service'); await bad({ service: { $ne: 1 } }, 'service');
    await bad({ date: '2026-02-30' }, 'date'); await bad({ date: '20261021' }, 'date'); await bad({ time: '9am' }, 'time'); await bad({ time: '25:00' }, 'time');
    await bad({ key: 'short' }, 'key'); await bad({ website: 'http://spam' });
    assert.equal((await post(S.base, '[1,2]')).status, 400);
    assert.equal((await fetch(S.base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await post(S.base, '{"a":"' + 'x'.repeat(5000) + '"}')).status, 413);
    assert.equal((await post(S.base, 'not json')).status, 400);
    assert.equal((await post(S.base, ok({ time: '17:00' }), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(S.base, ok({ time: '17:00' }), { Origin: 'null' })).status, 403, 'opaque origin');
    assert.equal((await fetch(S.base + '/api/bookings')).status, 405);
  });

  test('unavailable times are refused by the server: past, outside window, off-grid, after closing, inside lead time', async () => {
    for (const o of [{ date: '2026-10-19' }, { date: '2026-11-30' }, { time: '10:15' }, { time: '18:30' }, { time: '07:00' }, { date: '2026-10-20', time: '10:30' }]) {
      const r = await post(S.base, ok({ phone: uniqPhone(), ...o }));
      assert.equal(r.status, 409, JSON.stringify(o)); assert.equal((await r.json()).error, 'slot_taken');
    }
  });

  test('SQL injection payloads are stored as plain text; database intact', async () => {
    const evil = "Robert'); DROP TABLE bookings;--";
    const r = await post(S.base, ok({ date: '2026-10-29', time: '13:00', phone: uniqPhone(), name: evil }));
    assert.equal(r.status, 201);
    const row = dbRead(S.db, 'SELECT name FROM bookings WHERE ref = ?', (await r.json()).ref)[0];
    assert.equal(row.name, "Robert'); DROP TABLE bookings;--");
    assert.ok(dbRead(S.db, 'SELECT COUNT(*) AS n FROM bookings')[0].n > 3);
    assert.equal((await fetch(S.base + "/api/availability?service=haircut' OR '1'='1")).status, 400);
  });
});

describe('business rules from config (closed days, capacity)', () => {
  let S;
  before(async () => {
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbcfg-')), 'config.js');
    const base = require('../server/config');
    const custom = { ...base, chairs: 2, closedDates: ['2026-10-22'], hours: { ...base.hours, 0: null } }; // Sundays closed
    fs.writeFileSync(cfg, 'module.exports = ' + JSON.stringify(custom, null, 2));
    S = await startServer({ CONFIG_PATH: cfg });
  });
  test('closed date and closed weekday have no slots and refuse bookings', async () => {
    const a = await avail(S.base);
    assert.deepEqual(a.days.find((d) => d.date === '2026-10-22').slots, []);
    assert.deepEqual(a.days.find((d) => d.date === '2026-10-25').slots, []);   // Sunday
    assert.equal((await post(S.base, ok({ date: '2026-10-22', phone: uniqPhone() }))).status, 409);
    assert.equal((await post(S.base, ok({ date: '2026-10-25', phone: uniqPhone() }))).status, 409);
  });
  test('chairs = 2: two overlapping bookings allowed, the third refused', async () => {
    assert.equal((await post(S.base, ok({ time: '12:00', phone: uniqPhone() }))).status, 201);
    assert.equal((await post(S.base, ok({ time: '12:00', phone: uniqPhone(), service: 'beard' }))).status, 201);
    const r = await post(S.base, ok({ time: '12:00', phone: uniqPhone(), service: 'cosmetic' }));
    assert.equal(r.status, 409);
    assert.ok(!(await avail(S.base, 'cosmetic')).days[1].slots.includes('12:00'));
    assert.ok((await avail(S.base, 'cosmetic')).days[1].slots.includes('12:30'));   // beard ended, one chair free
  });
});

describe('Chișinău time zone', () => {
  for (const [utc, expected, note] of [
    ['2026-10-20T21:30:00Z', '2026-10-21', '00:30 EEST: already the next day in Chișinău'],
    ['2026-10-26T21:30:00Z', '2026-10-26', '23:30 EET after the DST change: still the same day'],
    ['2026-03-29T21:30:00Z', '2026-03-30', '00:30 EEST after the spring change'],
  ]) {
    test(note, async () => {
      const s = await startServer({ TEST_NOW: utc });
      try { assert.equal((await avail(s.base)).today, expected); } finally { await stop(s); }
    });
  }
});

describe('admin panel', () => {
  let S;
  before(async () => { S = await startServer(); });

  test('no access without logging in', async () => {
    const r = await fetch(S.base + '/admin', { redirect: 'manual' });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/admin/login');
    for (const p of ['/admin/bookings/MB-AAAAAA', '/admin/logout', '/admin/test-notification'])
      assert.equal((await fetch(S.base + p, { method: 'POST', redirect: 'manual' })).status, 401, p);
    assert.equal((await fetch(S.base + '/admin', { redirect: 'manual', headers: { Cookie: '__Host-mb_admin=forged' } })).status, 303);
    assert.equal((await fetch(S.base + '/admin', { redirect: 'manual', headers: { Authorization: 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64') } })).status, 303, 'old Basic auth no longer works');
  });

  test('login: wrong password, wrong user, missing Origin all refused', async () => {
    assert.equal((await login(S.base, USER, 'wrong-password-xyz')).status, 401);
    assert.equal((await login(S.base, 'admin', PASS)).status, 401);
    assert.equal((await login(S.base, USER, PASS, null)).status, 403);
    assert.equal((await login(S.base, USER, PASS, 'https://evil.example')).status, 403);
    assert.equal((await login(S.base, USER, PASS, 'null')).status, 403);
  });

  test('login sets a hardened session cookie; page lists bookings with names escaped', async () => {
    const r = await login(S.base);
    assert.equal(r.status, 303);
    const c = r.headers.get('set-cookie');
    assert.match(c, /^__Host-mb_admin=[A-Za-z0-9_-]{40,};/); for (const f of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(c.includes(f), f);
    const b = await (await post(S.base, ok({ date: '2026-10-29', time: '11:00', phone: '068 999 000', name: '<script>alert(1)</script>Ana' }))).json();
    const s = await session(S.base);
    assert.ok(s.html.includes(b.ref)); assert.ok(s.html.includes('+37368999000')); assert.ok(!s.html.includes('<script>alert'));
    const pg = await fetch(S.base + '/admin', { headers: { Cookie: s.cookie } });
    assert.match(pg.headers.get('content-security-policy'), /default-src 'none'; style-src 'nonce-/); assert.equal(pg.headers.get('cache-control'), 'no-store');
  });

  test('status changes: CSRF + origin required, allowed transitions only, events recorded, slots freed', async () => {
    const s = await session(S.base);
    const mk = async (time) => (await (await post(S.base, ok({ date: '2026-10-30', time, phone: uniqPhone() }))).json()).ref;
    const [a, b, c] = [await mk('10:00'), await mk('12:00'), await mk('14:00')];
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm' })).status, 403, 'missing CSRF');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm', csrf: 'x'.repeat(32) })).status, 403, 'wrong CSRF');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm', csrf: s.csrf }, null)).status, 403, 'no Origin');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm', csrf: s.csrf }, 'https://evil.example')).status, 403);
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'delete', csrf: s.csrf })).status, 409);
    assert.equal((await adminPost(S.base, s, '/admin/bookings/MB-ZZZZZZ', { action: 'confirm', csrf: s.csrf })).status, 404);
    const r = await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm', csrf: s.csrf, back: 'https://evil.example/' });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/admin?msg=confirmed', 'open redirect blocked');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm', csrf: s.csrf })).status, 409, 'confirm twice');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'reject', csrf: s.csrf })).status, 409, 'cannot reject a confirmed booking');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'cancel', csrf: s.csrf })).status, 303);
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + a, { action: 'confirm', csrf: s.csrf })).status, 409, 'cancelled is final');
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + b, { action: 'reject', csrf: s.csrf })).status, 303);
    assert.equal((await adminPost(S.base, s, '/admin/bookings/' + c, { action: 'cancel', csrf: s.csrf })).status, 303);
    const st = Object.fromEntries(dbRead(S.db, 'SELECT ref, status FROM bookings WHERE ref IN (?,?,?)', a, b, c).map((x) => [x.ref, x.status]));
    assert.deepEqual(st, { [a]: 'cancelled', [b]: 'rejected', [c]: 'cancelled' });
    const ev = dbRead(S.db, 'SELECT e.from_status AS f, e.to_status AS t, e.actor FROM booking_events e JOIN bookings b ON b.id = e.booking_id WHERE b.ref = ? ORDER BY e.id', a);
    assert.deepEqual(ev.map((e) => `${e.f}>${e.t}:${e.actor}`), ['null>pending:customer', 'pending>confirmed:admin:owner', 'confirmed>cancelled:admin:owner']);
    const slots = (await avail(S.base)).days[10].slots;
    for (const tm of ['10:00', '12:00', '14:00']) assert.ok(slots.includes(tm), tm + ' free again');
  });

  test('logout ends the session', async () => {
    const s = await session(S.base);
    assert.equal((await adminPost(S.base, s, '/admin/logout', { csrf: 'nope' })).status, 403);
    assert.equal((await adminPost(S.base, s, '/admin/logout', { csrf: s.csrf })).status, 303);
    assert.equal((await fetch(S.base + '/admin', { redirect: 'manual', headers: { Cookie: s.cookie } })).status, 303);
  });

  test('admin page warns about unconfirmed details and missing notifications', async () => {
    const s = await session(S.base);
    for (const t of ['confirmedByOwner.chairs', 'confirmedByOwner.hours', 'Prețuri lipsă', 'Telegram nu sunt configurate']) assert.ok(s.html.includes(t), t);
  });

  test('test-notification without Telegram configured says so', async () => {
    const s = await session(S.base);
    const r = await adminPost(S.base, s, '/admin/test-notification', { csrf: s.csrf });
    assert.equal(r.headers.get('location'), '/admin?msg=tg_off');
  });

  test('brute force: 10 wrong passwords per IP, then locked', async () => {
    const s2 = await startServer();
    try {
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await login(s2.base, USER, 'wrong-' + i)).status);
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(401)); assert.equal(codes[10], 429);
    } finally { await stop(s2); }
  });

  test('admin stays disabled without a password hash (old plaintext ADMIN_PASSWORD is ignored)', async () => {
    const s3 = await startServer({ ADMIN_PASSWORD_HASH: '', ADMIN_PASSWORD: 'some-long-password-1234' });
    try {
      assert.equal((await fetch(s3.base + '/admin')).status, 503);
      assert.equal((await login(s3.base)).status, 503);
    } finally { await stop(s3); }
  });
});

describe('persistence, migration and backups', () => {
  test('bookings survive a server restart and still block the slot', async () => {
    const s1 = await startServer();
    const b = await (await post(s1.base, ok({ date: '2026-10-27', time: '15:00' }))).json();
    await stop(s1);
    const s2 = await startServer({}, s1.db);
    try {
      assert.ok(!(await avail(s2.base)).days[7].slots.includes('15:00'));
      assert.equal((await post(s2.base, ok({ date: '2026-10-27', time: '15:00', phone: uniqPhone() }))).status, 409);
      assert.ok((await session(s2.base)).html.includes(b.ref));
    } finally { await stop(s2); }
  });

  test('a database from the first release (schema v1) is migrated without data loss', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbv1-')), 'old.db');
    const d = new DatabaseSync(file);
    d.exec(`CREATE TABLE bookings (id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, idem_key TEXT UNIQUE, service_id TEXT NOT NULL, date TEXT NOT NULL,
      start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, lang TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX bookings_date ON bookings(date, status); CREATE INDEX bookings_phone ON bookings(phone, date);
      INSERT INTO bookings VALUES (1,'MB-OLD111','k-old-1111111111111','haircut','2026-10-28',600,640,'Vechi','+37368000111','ro','pending','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');`);
    d.close();
    const s = await startServer({}, file);
    try {
      assert.match(s.log(), /"event":"migrated"/);
      assert.equal(dbRead(file, 'PRAGMA user_version')[0].user_version, 3);
      assert.ok(!(await avail(s.base)).days[8].slots.includes('10:00'), 'old booking still blocks its slot');
      const ses = await session(s.base);
      assert.equal((await adminPost(s.base, ses, '/admin/bookings/MB-OLD111', { action: 'reject', csrf: ses.csrf })).status, 303);
      assert.equal(dbRead(file, 'SELECT status FROM bookings WHERE ref = ?', 'MB-OLD111')[0].status, 'rejected');
    } finally { await stop(s); }
  });

  test('npm run backup makes a consistent, verified copy while the server runs', async () => {
    const s = await startServer();
    try {
      await post(s.base, ok({ date: '2026-10-28', time: '11:00' }));
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbbk-')), 'b.db');
      const txt = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/backup.js', out], { cwd: ROOT, env: { PATH: process.env.PATH, DB_PATH: s.db }, encoding: 'utf8' });
      assert.match(txt, /Backup OK: .*\(1 bookings\)/);
      assert.equal(dbRead(out, 'SELECT COUNT(*) AS n FROM bookings')[0].n, 1);
    } finally { await stop(s); }
  });
});

describe('Telegram notifications (against a local mock of the Telegram API)', () => {
  let mock, calls = [], failNext = false, S;
  before(async () => {
    mock = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        calls.push({ url: req.url, body: JSON.parse(b) });
        if (failNext) { failNext = false; res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"description":"Unauthorized"}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => mock.on('listening', r));
    S = await startServer({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42', TELEGRAM_API_BASE: `http://127.0.0.1:${mock.address().port}` });
  });
  after(() => mock.close());
  const waitFor = async (fn) => { for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

  test('a new booking sends one message with the booking details; admin shows it was sent', async () => {
    const b = await (await post(S.base, ok({ date: '2026-10-26', time: '10:00', phone: '068 777 888' }))).json();
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].url, '/bot123:abc/sendMessage'); assert.equal(calls[0].body.chat_id, '42');
    assert.ok(calls[0].body.text.includes(b.ref) && calls[0].body.text.includes('+37368777888') && calls[0].body.text.includes('2026-10-26 10:00'));
    await waitFor(() => dbRead(S.db, 'SELECT notified_at FROM bookings WHERE ref = ?', b.ref)[0].notified_at);
    assert.ok((await session(S.base)).html.includes('✓ trimis'));
  });
  test('a failed notification is recorded and visible in admin (booking still saved)', async () => {
    failNext = true;
    const r = await post(S.base, ok({ date: '2026-10-26', time: '14:00', phone: uniqPhone() }));
    assert.equal(r.status, 201);
    const ref = (await r.json()).ref;
    await waitFor(() => dbRead(S.db, 'SELECT notify_error FROM bookings WHERE ref = ?', ref)[0].notify_error);
    assert.match(dbRead(S.db, 'SELECT notify_error FROM bookings WHERE ref = ?', ref)[0].notify_error, /HTTP 401: Unauthorized/);
    assert.ok((await session(S.base)).html.includes('✗ HTTP 401'));
  });
  test('the admin "Test Telegram" button reports success', async () => {
    const s = await session(S.base);
    const r = await adminPost(S.base, s, '/admin/test-notification', { csrf: s.csrf });
    assert.equal(r.headers.get('location'), '/admin?msg=tg_ok');
    assert.match(calls.at(-1).body.text, /^✅ Test My Barber/);
  });
});

describe('demo mode', () => {
  test('DEMO_MODE=1 marks the site, API answers and alerts as demo, with a valid CSP', async () => {
    const s = await startServer({ DEMO_MODE: '1' });
    try {
      const r = await fetch(s.base + '/'), html = await r.text();
      assert.ok(html.includes('<p class="demo-ribbon" role="note">DEMO'));
      const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
      assert.ok(r.headers.get('content-security-policy').includes(crypto.createHash('sha256').update(js).digest('base64')));
      assert.equal((await (await post(s.base, ok({}))).json()).demo, true);
      assert.ok((await session(s.base)).html.includes('MOD DEMO'));
    } finally { await stop(s); }
  });
});

describe('demo bookings are kept apart from real ones', () => {
  test('DEMO_MODE bookings are flagged; in live mode they never block slots, show a warning and can be deleted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbdemo-')), db = path.join(dir, 'db.sqlite');
    const demo = await startServer({ DEMO_MODE: '1' }, db);
    const b = await (await post(demo.base, ok({ date: '2026-10-28', time: '10:00', phone: '068 444 555' }))).json();
    assert.equal(b.demo, true);
    assert.equal(dbRead(db, 'SELECT demo FROM bookings WHERE ref = ?', b.ref)[0].demo, 1);
    assert.ok(!(await avail(demo.base)).days[8].slots.includes('10:00'), 'blocks the slot while in demo mode');
    await stop(demo);
    const live = await startServer({}, db);                               // same database, DEMO_MODE off
    try {
      assert.ok((await avail(live.base)).days[8].slots.includes('10:00'), 'demo booking does not block a real slot');
      const r = await post(live.base, ok({ date: '2026-10-28', time: '10:00', phone: '068 444 555' }));
      assert.equal(r.status, 201, 'same phone/day allowed: demo booking ignored for limits');
      assert.equal((await r.json()).demo, false);
      const s = await session(live.base);
      assert.ok(s.html.includes('1 programări demo rămase'), 'warning about leftover demo bookings');
      assert.ok(s.html.includes('<span class="dm">DEMO</span>'));
      const del = await adminPost(live.base, s, '/admin/demo-delete', { csrf: s.csrf });
      assert.equal(del.headers.get('location'), '/admin?msg=demo_deleted');
      assert.equal(dbRead(db, 'SELECT COUNT(*) AS n FROM bookings WHERE demo = 1')[0].n, 0);
      assert.equal(dbRead(db, 'SELECT COUNT(*) AS n FROM bookings WHERE demo = 0')[0].n, 1, 'real booking untouched');
      assert.equal((await adminPost(live.base, s, '/admin/demo-delete', { csrf: 'bad' })).status, 403);
    } finally { await stop(live); }
  });

  test('a v2 database gets the demo column without data loss', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbv2-')), 'v2.db');
    const s1 = await startServer({}, file);
    const b = await (await post(s1.base, ok({ date: '2026-10-29', time: '12:00', phone: uniqPhone() }))).json();
    await stop(s1);
    const d = new DatabaseSync(file);                                       // turn it back into a v2 database
    d.exec('ALTER TABLE bookings DROP COLUMN demo; PRAGMA user_version = 2;'); d.close();
    const s2 = await startServer({}, file);
    try {
      assert.match(s2.log(), /"event":"migrated","from":2,"to":3/);
      assert.equal(dbRead(file, 'SELECT demo FROM bookings WHERE ref = ?', b.ref)[0].demo, 0);
      assert.ok(!(await avail(s2.base)).days[9].slots.includes('12:00'));
    } finally { await stop(s2); }
  });
});

describe('Railway hosting auto-configuration', () => {
  test('uses RAILWAY_PUBLIC_DOMAIN as the trusted origin and the volume for the database', async () => {
    const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'mbvol-'));
    const s = await startServer({ DB_PATH: '', RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e', RAILWAY_PUBLIC_DOMAIN: 'mybarber-demo.up.railway.app', RAILWAY_VOLUME_MOUNT_PATH: vol, HOST: '127.0.0.1' });
    try {
      assert.ok(fs.existsSync(path.join(vol, 'bookings.db')), 'database created on the volume');
      assert.match(s.log(), /"persistentDb":true/);
      assert.equal((await post(s.base, ok({ time: '15:00', phone: uniqPhone() }), { Origin: 'https://mybarber-demo.up.railway.app' })).status, 201);
      assert.equal((await post(s.base, ok({ time: '16:00', phone: uniqPhone() }), { Origin: s.base })).status, 403, 'other origins refused');
      const r = await fetch(s.base + '/');
      assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/, 'HSTS on by default on Railway');
    } finally { await stop(s); }
  });

  test('warns loudly when no persistent volume is attached', async () => {
    const s = await startServer({ DB_PATH: '', RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e', HOST: '127.0.0.1' });
    try {
      assert.match(s.log(), /"persistentDb":false/);
      assert.ok((await session(s.base)).html.includes('NU este pe un volum persistent'));
    } finally { await stop(s); fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); }
  });

  test('rate limits use the proxy client-IP header (x-real-ip) on Railway', async () => {
    const s = await startServer({ RAILWAY_PROJECT_ID: 'p', RAILWAY_ENVIRONMENT_ID: 'e', RAILWAY_PUBLIC_DOMAIN: '127.0.0.1', HOST: '127.0.0.1', RL_BOOK: '2' });
    try {
      const send = (ip, i) => post(s.base, ok({ date: '2026-10-30', time: String(10 + i) + ':00', phone: uniqPhone() }), { 'X-Real-IP': ip });
      const a = [(await send('203.0.113.1', 0)).status, (await send('203.0.113.1', 1)).status, (await send('203.0.113.1', 2)).status];
      assert.deepEqual(a, [201, 201, 429], 'same visitor limited');
      assert.equal((await send('203.0.113.2', 3)).status, 201, 'a different visitor is not affected');
    } finally { await stop(s); }
  });
});
