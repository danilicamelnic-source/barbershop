'use strict';
/*
 * Admin authentication helpers: scrypt password hashes, in-memory sessions, CSRF tokens.
 * The admin password is never stored in plain text: .env holds ADMIN_PASSWORD_HASH created by
 * `npm run hash-password`.
 */
const crypto = require('node:crypto');

// scrypt parameters: N=2^16, r=8, p=1 (~64 MB, ~0.1–0.3 s per check)
const N = 65536, R = 8, P = 1, KEYLEN = 32, MAXMEM = 256 * 1024 * 1024;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function parseHash(h) {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{32,})$/.exec(h || '');
  if (!m) return null;
  return { N: +m[1], r: +m[2], p: +m[3], salt: Buffer.from(m[4], 'base64url'), key: Buffer.from(m[5], 'base64url') };
}

// Always runs the full scrypt computation (also for unknown users) so timing doesn't reveal anything.
function verifyPassword(password, parsed) {
  const target = parsed || { N, r: R, p: P, salt: Buffer.alloc(16), key: Buffer.alloc(KEYLEN) };
  return new Promise((resolve) => {
    crypto.scrypt(String(password).normalize('NFKC'), target.salt, target.key.length, { N: target.N, r: target.r, p: target.p, maxmem: MAXMEM }, (err, key) => {
      resolve(!err && !!parsed && crypto.timingSafeEqual(key, target.key));
    });
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest(), hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class Sessions {
  constructor({ idleMs = 2 * 3600_000, absoluteMs = 12 * 3600_000 } = {}) {
    this.map = new Map(); this.idleMs = idleMs; this.absoluteMs = absoluteMs;
    setInterval(() => this.sweep(), 10 * 60_000).unref();
  }
  create(user) {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(this.key(id), { user, csrf: crypto.randomBytes(24).toString('base64url'), created: now, seen: now });
    return id;
  }
  key(id) { return crypto.createHash('sha256').update(id).digest('base64url'); } // store only a hash of the cookie value
  get(id) {
    if (!id || id.length > 100) return null;
    const k = this.key(id), s = this.map.get(k), now = Date.now();
    if (!s) return null;
    if (now - s.seen > this.idleMs || now - s.created > this.absoluteMs) { this.map.delete(k); return null; }
    s.seen = now;
    return s;
  }
  destroy(id) { if (id) this.map.delete(this.key(id)); }
  sweep() { const now = Date.now(); for (const [k, s] of this.map) if (now - s.seen > this.idleMs || now - s.created > this.absoluteMs) this.map.delete(k); }
}

module.exports = { hashPassword, parseHash, verifyPassword, safeEqual, Sessions };
