// Carries Chromium's cookie database across the Electron 30 -> 44 upgrade.
//
// Electron 30 (Chromium 124) stores cookies at schema version 21. Chromium 147
// removed the v21 and v22 migrations, so Electron 42 and later open such a file,
// treat it as unsupported, delete it, and start empty: every platform login is
// gone on the first launch after the update. Reproduced against a copy of a real
// v21 profile: 66 cookies on Electron 30.5.1, 0 on Electron 44.4.5.
//
// This replays Chromium 146's own v21 -> v22 -> v23 steps
// (net/extras/sqlite/sqlite_persistent_cookie_store.cc at 146.0.7680.216,
// DoMigrateDatabaseSchema) before Chromium opens the file. Two deliberate
// differences from Chromium: both steps run in ONE transaction, so a failure
// leaves the file exactly as it was instead of stranded at v22 (which Chromium
// 152 would also delete); and `CONCAT` is spelled `||`, which every SQLite
// understands. It stops at 23 on purpose: Chromium 152 still migrates 23 -> 24
// itself, and that step is the one that knows about cookie encryption.
//
// Cookie rows never pass through JavaScript: Chromium stores times as
// microseconds since 1601 (~1.3e16), past Number.MAX_SAFE_INTEGER, so every
// copy is an INSERT ... SELECT inside SQLite.
//
// Must run before app 'ready' and before any session exists, while holding the
// single-instance lock. Once the network service opens the file it is too late.
//
// ROLLBACK HAZARD: after Chromium 152 marks the file v24, an Electron 30 build
// sees a database "too new" to open and razes it. Never ship a build on an
// Electron older than the one that last wrote the profile.

const fs = require('fs');
const path = require('path');

const TARGET_VERSION = 23;

// Verbatim from Chromium 146 CreateV22Schema / CreateV23Schema.
const V22_TABLE =
  'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,' +
  'top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,' +
  'encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,' +
  'is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,' +
  'last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,' +
  'is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,' +
  'samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,' +
  'source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,' +
  'source_type INTEGER NOT NULL);';
const V22_INDEX =
  'CREATE UNIQUE INDEX cookies_unique_index ' +
  'ON cookies(host_key, top_frame_site_key, name, path, source_scheme, source_port)';
const V23_TABLE =
  'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,' +
  'top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,' +
  'encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,' +
  'is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,' +
  'last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,' +
  'is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,' +
  'samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,' +
  'source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,' +
  'source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);';
const V23_INDEX =
  'CREATE UNIQUE INDEX cookies_unique_index ' +
  'ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, ' +
  'name, path, source_scheme, source_port)';

const STEP_21_TO_22 = [
  'DROP TABLE IF EXISTS cookies_old',
  'ALTER TABLE cookies RENAME TO cookies_old',
  'DROP INDEX IF EXISTS cookies_unique_index',
  V22_TABLE,
  V22_INDEX,
  // The default source_type is 0, CookieSourceType::kUnknown.
  'INSERT OR REPLACE INTO cookies ' +
    '(creation_utc, host_key, top_frame_site_key, name, value, ' +
    'encrypted_value, path, expires_utc, is_secure, is_httponly, ' +
    'last_access_utc, has_expires, is_persistent, priority, samesite, ' +
    'source_scheme, source_port, last_update_utc, source_type) ' +
    'SELECT creation_utc, host_key, top_frame_site_key, name, value, ' +
    'encrypted_value, path, expires_utc, is_secure, is_httponly, ' +
    'last_access_utc, has_expires, is_persistent, priority, ' +
    'samesite, source_scheme, source_port, last_update_utc, 0 ' +
    'FROM cookies_old ORDER BY creation_utc ASC',
  'DROP TABLE cookies_old',
];

const STEP_22_TO_23 = [
  'DROP TABLE IF EXISTS cookies_old',
  'ALTER TABLE cookies RENAME TO cookies_old',
  'DROP INDEX IF EXISTS cookies_unique_index',
  V23_TABLE,
  V23_INDEX,
  // source_scheme 0 is kUnset and 2 is kSecure. The has_cross_site_ancestor
  // substring match is Chromium's own, loose on purpose (see its comment).
  'INSERT OR REPLACE INTO cookies ' +
    '(creation_utc, host_key, top_frame_site_key, name, value, ' +
    'encrypted_value, path, expires_utc, is_secure, is_httponly, ' +
    'last_access_utc, has_expires, is_persistent, priority, samesite, ' +
    'source_scheme, source_port, last_update_utc, source_type, ' +
    'has_cross_site_ancestor) ' +
    'SELECT creation_utc, host_key, top_frame_site_key, name, value, ' +
    'encrypted_value, path, expires_utc, is_secure, is_httponly, ' +
    'last_access_utc, has_expires, is_persistent, priority, samesite, ' +
    'CASE WHEN source_scheme = 0 AND is_secure = 1 THEN 2 ELSE source_scheme END, ' +
    'source_port, last_update_utc, source_type, ' +
    "CASE WHEN INSTR(top_frame_site_key, '://') > 0 AND host_key " +
    "LIKE '%' || SUBSTR(top_frame_site_key, INSTR(top_frame_site_key, '://') + 3) || '%' " +
    'THEN 0 ELSE 1 END AS has_cross_site_ancestor ' +
    'FROM cookies_old ORDER BY creation_utc ASC',
  'DROP TABLE cookies_old',
];

// Every cookie database in a profile: the default session's, plus one per
// persistent partition (the app's streams and logins live in persist:default).
function findCookieDbs(userDataDir) {
  const out = [];
  const main = path.join(userDataDir, 'Network', 'Cookies');
  if (fs.existsSync(main)) out.push(main);
  const partitions = path.join(userDataDir, 'Partitions');
  let names = [];
  try { names = fs.readdirSync(partitions); } catch (e) { /* no partitions yet */ }
  for (const name of names) {
    const f = path.join(partitions, name, 'Network', 'Cookies');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

function loadSqlite() {
  try { return require('node:sqlite'); } catch (e) { return null; }
}

function readVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
  return row ? Number(row.value) : NaN;
}

function copyWithJournal(from, to) {
  fs.copyFileSync(from, to);
  const journal = from + '-journal';
  if (fs.existsSync(journal)) fs.copyFileSync(journal, to + '-journal');
}

function removeWithJournal(f) {
  for (const p of [f, f + '-journal']) {
    try { fs.unlinkSync(p); } catch (e) { /* absent */ }
  }
}

// Returns { file, status, from?, to?, rowsBefore?, rowsAfter?, backup?, error? }.
// status: 'current' (nothing to do), 'migrated', 'skipped' (cannot or should not
// touch it), or 'failed' (file left exactly as it was; the backup is kept).
function migrateCookieDb(file, opts = {}) {
  const sqlite = opts.sqlite === undefined ? loadSqlite() : opts.sqlite;
  if (!sqlite) return { file, status: 'skipped', error: 'node:sqlite is not available in this runtime' };

  // Copy first, open second. Opening can roll a hot journal back into the file,
  // which is already a write, so the untouched original has to be saved before.
  const pending = file + '.migration-pending';
  try {
    copyWithJournal(file, pending);
  } catch (e) {
    return { file, status: 'skipped', error: 'could not snapshot the cookie file: ' + e.message };
  }

  let db = null;
  try {
    db = new sqlite.DatabaseSync(file);
    const from = readVersion(db);
    if (from >= TARGET_VERSION) {
      db.close(); db = null;
      removeWithJournal(pending);
      return { file, status: 'current', from };
    }
    if (from !== 21 && from !== 22) {
      db.close(); db = null;
      removeWithJournal(pending);
      return { file, status: 'skipped', from, error: `unexpected schema version ${from}` };
    }

    // Keep the first backup ever taken; a later run must not replace the real
    // pre-upgrade copy with something newer.
    const backup = `${file}.v${from}-backup`;
    if (!fs.existsSync(backup)) {
      fs.renameSync(pending, backup);
      const pj = pending + '-journal';
      if (fs.existsSync(pj)) fs.renameSync(pj, backup + '-journal');
    } else {
      removeWithJournal(pending);
    }

    const rowsBefore = db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n;
    const steps = from === 21 ? [...STEP_21_TO_22, ...STEP_22_TO_23] : STEP_22_TO_23;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of steps) db.exec(sql);
      const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      // BigInt binds as INTEGER, stored as '23' exactly as Chromium's MetaTable
      // writes it. A JS number binds as REAL and would be stored as '23.0'.
      setMeta.run('version', BigInt(TARGET_VERSION));
      setMeta.run('last_compatible_version', BigInt(TARGET_VERSION));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* already rolled back */ }
      throw e;
    }
    const rowsAfter = db.prepare('SELECT COUNT(*) AS n FROM cookies').get().n;
    db.close(); db = null;
    return { file, status: 'migrated', from, to: TARGET_VERSION, rowsBefore, rowsAfter, backup };
  } catch (e) {
    try { if (db) db.close(); } catch (e2) { /* ignore */ }
    // The transaction rolled back, so the file is unchanged. If the backup was
    // never promoted, keep the snapshot rather than lose the only copy.
    return { file, status: 'failed', error: e.message };
  }
}

function migrateProfileCookies(userDataDir, opts = {}) {
  return findCookieDbs(userDataDir).map(f => migrateCookieDb(f, opts));
}

module.exports = { migrateCookieDb, migrateProfileCookies, findCookieDbs, TARGET_VERSION, V23_TABLE, V23_INDEX };
