'use strict';
/*
 * Browser tests (real Chromium via Playwright) for the booking dialog.
 *   npm install                      (dev dependency: playwright)
 *   npx playwright install chromium  (once)
 *   npm run test:browser
 * Covers: local preview (file opened directly / localhost ?preview=sample) with SAMPLE slots and no network,
 * server mode with the real availability API, an unavailable API, and real booking submission.
 * The browser clock and the server clock are both fixed to 2026-10-20 16:10 Chișinău time (13:10 UTC).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const NOW_UTC = '2026-10-20T13:10:00Z';                 // 16:10 in Chișinău → today's earliest start 17:10 → first slot 17:30
const FILE_URL = 'file://' + path.join(ROOT, 'public', 'index.html');
let browser, srv;

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbb-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const db = path.join(dir, 'db.sqlite');
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.js'], {
      cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: 'test', TEST_NOW: NOW_UTC, PORT: String(port), HOST: '127.0.0.1', DB_PATH: db, RL_BOOK: '1000', ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('"started"')) resolve({ p, port, base: `http://127.0.0.1:${port}`, db }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('server exited ' + c + '\n' + out)));
  });
}
const count = (db) => { const d = new DatabaseSync(db, { readOnly: true }); try { return d.prepare('SELECT COUNT(*) AS n FROM bookings').get().n; } finally { d.close(); } };

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--host-resolver-rules=MAP barber.test 127.0.0.1'] });
  srv = await startServer();
});
after(async () => { await browser?.close(); srv?.p.kill(); });

// New page with fixed clock, fonts blocked, and a record of every request + console problem.
async function open(url, { locale = 'ro-RO', mobile = false } = {}) {
  const ctx = await browser.newContext({ locale, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW_UTC));
  const requests = [], problems = [];
  page.on('request', (r) => { if (!/fonts\.g/.test(r.url())) requests.push(r.method() + ' ' + r.url()); });
  page.on('console', (m) => { if ((m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) || /Content Security|Refused/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(url);
  await page.waitForTimeout(400);
  return { ctx, page, requests, problems };
}
const chips = (page, n) => page.locator('#bb .chips').nth(n).locator('button');
const enabledTexts = async (loc) => (await loc.evaluateAll((bs) => bs.filter((b) => !b.disabled).map((b) => b.textContent)));
async function openDialog(page) { await page.locator('header [data-book]').click(); await page.waitForSelector('#dlg[open]'); }
async function pickService(page, label) { await page.locator('#bb .chip', { hasText: label }).first().click(); }

describe('local preview (file opened directly)', () => {
  test('full customer journey with SAMPLE slots, no network, never a real booking', async () => {
    const { ctx, page, requests, problems } = await open(FILE_URL);
    try {
      await openDialog(page);
      assert.match(await page.locator('#bb .demo-top').innerText(), /^DEMO — nu se creează nicio programare reală/, 'DEMO banner at the start');
      await page.locator('#nx').click();
      assert.match(await page.locator('#err').innerText(), /Alegeți serviciul/, 'cannot continue without a service');

      await pickService(page, 'Tunsoare · 40 min'); await page.locator('#nx').click();
      await page.waitForSelector('#bb .chips');
      assert.equal(await page.locator('#bb .lb').nth(0).innerText(), 'ZIUA · EXEMPLE');
      assert.equal(await page.locator('#bb .lb').nth(1).innerText(), 'ORA · EXEMPLE');
      assert.equal(await chips(page, 0).count(), 14, '14 sample days');
      assert.match(await page.locator('#bb').innerText(), /Mai întâi alegeți ziua/);
      await page.locator('#nx').click(); assert.match(await page.locator('#err').innerText(), /Alegeți ziua/, 'cannot continue without a day');

      await chips(page, 0).filter({ hasText: 'Astăzi' }).click();
      assert.deepEqual(await enabledTexts(chips(page, 1)), ['17:30', '18:00'], 'today: past times and lead time excluded (16:10 now)');
      await page.locator('#nx').click(); assert.match(await page.locator('#err').innerText(), /Alegeți o oră liberă/, 'cannot continue without a time');
      await chips(page, 1).filter({ hasText: '17:30' }).click();

      await chips(page, 0).filter({ hasText: 'Mâine' }).click();             // selecting another date refreshes the times
      const tomorrow = await enabledTexts(chips(page, 1));
      assert.equal(tomorrow[0], '10:00'); assert.equal(tomorrow.at(-1), '18:00'); assert.equal(tomorrow.length, 17, '40 min → last start 18:00');
      assert.equal(await page.locator('#bb .chips').nth(1).locator('[aria-pressed="true"]').count(), 0, 'time selection reset after changing the day');

      await page.locator('#bk').click(); await pickService(page, 'Tunsoare: tată + fiu'); await page.locator('#nx').click();  // change service → duration 90
      await chips(page, 0).filter({ hasText: 'Mâine' }).click();
      const fs90 = await enabledTexts(chips(page, 1));
      assert.equal(fs90.at(-1), '17:30'); assert.equal(fs90.length, 16, '90 min → last start 17:30');
      await chips(page, 0).filter({ hasText: 'Astăzi' }).click();
      assert.deepEqual(await enabledTexts(chips(page, 1)), ['17:30']);
      await chips(page, 1).filter({ hasText: '17:30' }).click(); await page.locator('#nx').click();

      await page.waitForSelector('#fn'); await page.locator('#nx').click();
      assert.match(await page.locator('#err').innerText(), /numele/, 'name validation still active');
      await page.fill('#fn', 'Demo Client'); await page.fill('#fp', '12'); await page.locator('#nx').click();
      assert.match(await page.locator('#err').innerText(), /telefonul/, 'phone validation still active');
      await page.fill('#fp', '068 123 456'); await page.locator('#nx').click();

      const review = await page.locator('#bb').innerText();
      assert.match(review, /90 min/); assert.match(review, /Astăzi, 17:30/); assert.match(review, /DEMO — nu se creează/);
      assert.equal(await page.locator('#nx').innerText(), 'TRIMITE (DEMO)');
      await page.locator('#nx').click();

      assert.equal(await page.locator('#bt').innerText(), 'DEMO — nicio programare creată', 'DEMO message at the end');
      const end = await page.locator('#bb').innerText();
      assert.match(end, /DEMO — nu se creează nicio programare reală/); assert.match(end, /demo — nerezervat/);
      assert.doesNotMatch(end, /MB-|confirmată|Programare confirmată|Cerere primită|în așteptarea confirmării/, 'never presented as a real or confirmed booking ("Preț de confirmat" is only the price placeholder)');
      assert.deepEqual(requests.filter((r) => !r.includes('file://')), [], 'no network request of any kind');
      assert.deepEqual(problems, [], 'no console / CSP errors');
    } finally { await ctx.close(); }
  });

  test('banner and sample labels in Russian and English', async () => {
    for (const [locale, banner, label] of [['ru-RU', /^ДЕМО — реальная запись не создаётся/, 'ДЕНЬ · ПРИМЕРЫ'], ['en-GB', /^DEMO — no real booking is created/, 'DAY · SAMPLES']]) {
      const { ctx, page, problems } = await open(FILE_URL, { locale });
      try {
        await page.locator('#rows li:nth-child(1) button').click(); await page.waitForSelector('#bb .chips');
        assert.match(await page.locator('#bb .demo-top').innerText(), banner);
        assert.equal(await page.locator('#bb .lb').nth(0).innerText(), label);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    }
  });

  test('mobile: date and time chips visible and usable', async () => {
    const { ctx, page } = await open(FILE_URL, { mobile: true });
    try {
      await page.evaluate(() => scrollTo(0, innerHeight)); await page.waitForTimeout(500);
      await page.locator('#bar2 [data-book]').click(); await pickService(page, 'Tunsoare · 40 min'); await page.locator('#nx').click();
      await chips(page, 0).filter({ hasText: 'Mâine' }).click(); await chips(page, 1).first().click();
      assert.equal(await chips(page, 1).first().getAttribute('aria-pressed'), 'true');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
      await page.locator('#nx').click(); await page.waitForSelector('#fn');
    } finally { await ctx.close(); }
  });
});

describe('localhost ?preview=sample (explicit opt-in on a dev machine)', () => {
  test('uses sample slots and never contacts the API, even with the server running', async () => {
    const before = count(srv.db);
    const { ctx, page, requests, problems } = await open(srv.base + '/?preview=sample');
    try {
      await page.locator('#rows li:nth-child(1) button').click(); await page.waitForSelector('#bb .chips');
      assert.match(await page.locator('#bb .demo-top').innerText(), /^DEMO/);
      await chips(page, 0).filter({ hasText: 'Mâine' }).click(); await chips(page, 1).first().click();
      await page.locator('#nx').click(); await page.fill('#fn', 'Preview Test'); await page.fill('#fp', '068000001');
      await page.locator('#nx').click(); await page.locator('#nx').click();
      assert.equal(await page.locator('#bt').innerText(), 'DEMO — nicio programare creată');
      // second safety layer: even a direct call to the page's API helper is refused in preview mode
      const direct = await page.evaluate(() => api('/bookings', { service: 'haircut' }).then(() => 'sent', (e) => 'blocked: ' + e.message));
      assert.equal(direct, 'blocked: preview: network disabled');
      assert.deepEqual(requests.filter((r) => r.includes('/api/')), [], 'no API request at all');
      assert.equal(count(srv.db), before, 'nothing written to the database');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('?preview=sample is ignored on a real (non-localhost) domain', async () => {
    const { ctx, page, requests } = await open(`http://barber.test:${srv.port}/?preview=sample`);
    try {
      await page.locator('#rows li:nth-child(1) button').click(); await page.waitForSelector('#bb .chips');
      assert.equal(await page.locator('#bb .demo-top').count(), 0, 'no demo mode');
      assert.ok(requests.some((r) => r.includes('/api/availability?service=haircut')), 'real API used');
    } finally { await ctx.close(); }
  });
});

describe('server mode (real backend)', () => {
  test('slots come from the availability API; booking is saved and shown with the server reference', async () => {
    const api = await (await fetch(srv.base + '/api/availability?service=haircut')).json();
    const before = count(srv.db);
    const { ctx, page, requests, problems } = await open(srv.base + '/');
    try {
      await openDialog(page);
      assert.equal(await page.locator('#bb .demo-top').count(), 0, 'no demo banner on the server');
      await pickService(page, 'Tunsoare · 40 min'); await page.locator('#nx').click(); await page.waitForSelector('#bb .chips');
      assert.equal(await page.locator('#bb .lb').nth(0).innerText(), 'ZIUA', 'not labelled as samples');
      await chips(page, 0).filter({ hasText: 'Astăzi' }).click();
      assert.deepEqual(await enabledTexts(chips(page, 1)), api.days[0].slots, 'today = server slots');
      await chips(page, 0).filter({ hasText: 'Mâine' }).click();
      assert.deepEqual(await enabledTexts(chips(page, 1)), api.days[1].slots, 'tomorrow = server slots');
      await chips(page, 1).filter({ hasText: '11:00' }).click(); await page.locator('#nx').click();
      await page.fill('#fn', 'Server Client'); await page.fill('#fp', '079 123 456'); await page.locator('#nx').click();
      assert.equal(await page.locator('#nx').innerText(), 'TRIMITE CEREREA');
      await page.locator('#nx').click();
      await page.waitForFunction(() => document.getElementById('bt').textContent === 'Cerere primită');
      const ref = await page.locator('#bb p.ok').innerText();
      assert.match(ref, /^MB-[A-Z0-9]{6}$/);
      assert.equal(count(srv.db), before + 1);
      const d = new DatabaseSync(srv.db, { readOnly: true });
      const row = d.prepare('SELECT status, date, start_min FROM bookings WHERE ref = ?').get(ref); d.close();
      assert.deepEqual({ ...row }, { status: 'pending', date: api.days[1].date, start_min: 660 });
      assert.match(await page.locator('#bb').innerText(), /în așteptarea confirmării/, 'labelled pending, not confirmed');
      assert.ok(requests.some((r) => r.startsWith('POST ') && r.endsWith('/api/bookings')));
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('API unreachable: clear error + retry, no invented slots, no silent demo mode', async () => {
    const { ctx, page } = await open(srv.base + '/');
    try {
      await page.route('**/api/availability**', (r) => r.abort());
      await page.locator('#rows li:nth-child(1) button').click();
      await page.waitForSelector('#bb .btn.sm');
      const txt = await page.locator('#bb').innerText();
      assert.match(txt, /Nu am putut contacta serverul de programări/);
      assert.equal(await page.locator('#bb .chips').count(), 0, 'no date/time chips');
      assert.equal(await page.locator('#bb .demo-top').count(), 0, 'no demo banner');
      await page.locator('#nx').click(); assert.match(await page.locator('#err').innerText(), /Alegeți ziua/, 'cannot continue');
      await page.unroute('**/api/availability**');
      await page.locator('#bb .btn.sm', { hasText: 'Reîncearcă' }).click();
      await page.waitForSelector('#bb .chips');
      assert.equal(await chips(page, 0).count(), 14, 'real slots after retry');
    } finally { await ctx.close(); }
  });

  test('API error (HTTP 500): server-error message, no slots', async () => {
    const { ctx, page } = await open(srv.base + '/');
    try {
      await page.route('**/api/availability**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server_error"}' }));
      await page.locator('#rows li:nth-child(1) button').click();
      await page.waitForSelector('#bb .btn.sm');
      assert.match(await page.locator('#bb').innerText(), /Eroare de server/);
      assert.equal(await page.locator('#bb .chips').count(), 0);
    } finally { await ctx.close(); }
  });
});
