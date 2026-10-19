// Consistent online backup of the bookings database (safe while the server is running).
// Usage: npm run backup                 -> backups/bookings-YYYY-MM-DD-HHMMSS.db, keeps the newest 30
//        node tools/backup.js <file>    -> backup to a specific file
// Restore: stop the server, copy a backup over data/bookings.db (delete bookings.db-wal/-shm), start the server.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
process.umask(0o077);
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env optional */ }
const VOL = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const src = path.resolve(ROOT, process.env.DB_PATH || (VOL ? path.join(VOL, 'bookings.db') : 'data/bookings.db'));
if (!fs.existsSync(src)) { console.error('Database not found: ' + src); process.exit(1); }
const dir = path.resolve(ROOT, process.env.BACKUP_DIR || (VOL ? path.join(VOL, 'backups') : 'backups'));
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = path.resolve(process.argv[2] || path.join(dir, `bookings-${stamp}.db`));
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) { console.error('Refusing to overwrite ' + out); process.exit(1); }
const db = new DatabaseSync(src, { readOnly: true });
db.prepare('VACUUM INTO ?').run(out);
db.close();
const check = new DatabaseSync(out, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get().integrity_check;
const n = check.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
check.close();
if (ok !== 'ok') { console.error('Backup integrity check failed: ' + ok); process.exit(1); }
console.log(`Backup OK: ${out} (${n} bookings)`);
if (!process.argv[2]) {
  const keep = Number(process.env.BACKUP_KEEP || 30);
  const files = fs.readdirSync(dir).filter((f) => /^bookings-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
}
