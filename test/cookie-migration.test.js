// Gate tests for cookie-migration.js. Run: npm test
//
// The v21 fixture uses the schema read from a real Electron 30 profile. The
// expected v23 schema strings are the ones Chromium 152 (Electron 44.4.5)
// itself wrote into a fresh database, not a transcription of its source, so a
// typo in our DDL fails here rather than on a user's machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { migrateCookieDb, migrateProfileCookies, findCookieDbs } = require('../main/cookie-migration');

const V21_META = 'CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)';
const V21_TABLE =
  'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,' +
  'name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,' +
  'is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,' +
  'is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,' +
  'source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL)';
const V21_INDEX =
  'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, name, path, source_scheme, source_port)';

// Written by Chromium 152 into a fresh Cookies file.
const CHROMIUM_152_TABLE =
  'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,' +
  'name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,' +
  'is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,' +
  'is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,' +
  'source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,' +
  'has_cross_site_ancestor INTEGER NOT NULL)';
const CHROMIUM_152_INDEX =
  'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, ' +
  'name, path, source_scheme, source_port)';

// [host_key, top_frame_site_key, name, value, path, is_secure, is_httponly, samesite, source_scheme]
const ROWS = [
  ['.twitch.tv', '', 'auth-token', 'tok123', '/', 1, 0, 0, 2],               // domain cookie
  ['www.youtube.com', '', 'PREF', 'f6=40000000', '/', 1, 0, -1, 2],           // host-only
  ['accounts.google.com', '', '__Host-GAPS', 'gaps', '/', 1, 1, 0, 2],         // __Host- cookie
  ['.kick.com', '', 'session_token', 'kick%7Csess', '/', 1, 1, 1, 2],
  ['.example.com', '', 'legacy_secure', 'x', '/', 1, 0, 0, 0],                // kUnset + secure -> kSecure
  ['.example.com', '', 'legacy_plain', 'y', '/', 0, 0, 0, 0],                 // kUnset + insecure stays 0
  ['.youtube.com', 'https://youtube.com', 'part_same', 'p1', '/', 1, 0, 0, 2],    // partitioned, same-site
  ['.google.com', 'https://youtube.com', 'part_cross', 'p2', '/', 1, 0, 0, 2],    // partitioned, cross-site
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cookie-test-'));
}

function makeV21(file, { version = 21, rows = ROWS, table = V21_TABLE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(V21_META);
  db.exec(table);
  if (table === V21_TABLE) db.exec(V21_INDEX);
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('mmap_status', '-1');
  meta.run('version', String(version));
  meta.run('last_compatible_version', String(version));
  if (table === V21_TABLE) {
    const ins = db.prepare(
      'INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    rows.forEach(([host, tfsk, name, value, p, sec, http, ss, scheme], i) => {
      // Chromium times are microseconds since 1601, past Number.MAX_SAFE_INTEGER.
      const t = 13390000000000000n + BigInt(i);
      ins.run(t, host, tfsk, name, value, new Uint8Array(0), p, t + 10000000000000n, sec, http, t, 1, 1, 1, ss, scheme, 443, t);
    });
  }
  db.close();
}

// Chromium 146 CreateV22Schema: v21 plus source_type. v22 kept v21's unique index.
const V22_TABLE = V21_TABLE.replace(/\)$/, ',source_type INTEGER NOT NULL)');

// source_type is CookieSourceType: 0 kUnknown, 1 kHTTP, 2 kScript, 3 kOther.
// Row i gets i % 4, so every value is present and a reset to 0 shows.
function makeV22(file, rows = ROWS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(V21_META);
  db.exec(V22_TABLE);
  db.exec(V21_INDEX);
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('version', '22');
  meta.run('last_compatible_version', '22');
  const ins = db.prepare(
    'INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  rows.forEach(([host, tfsk, name, value, p, sec, http, ss, scheme], i) => {
    const t = 13390000000000000n + BigInt(i);
    ins.run(t, host, tfsk, name, value, new Uint8Array(0), p, t + 10000000000000n, sec, http, t, 1, 1, 1, ss, scheme, 443, t, i % 4);
  });
  db.close();
}

// Leaves `file` the way a crash mid-write leaves it: the pages of an uncommitted
// transaction (every cookie deleted, version 99) already in the file, and the
// originals in a hot `-journal` beside it. Only the pair is the real database.
// Captured from a live transaction on a sibling copy, which then rolls back.
function makeCrashedV21(file) {
  const live = file + '.live';
  makeV21(live);
  const db = new DatabaseSync(live);
  db.exec('PRAGMA cache_size = 1'); // spill dirty pages into the file before commit
  db.exec('BEGIN IMMEDIATE');
  db.exec('DELETE FROM cookies');
  db.exec("UPDATE meta SET value = '99' WHERE key = 'version'");
  db.exec('CREATE TABLE junk(x)');
  db.exec('INSERT INTO junk SELECT randomblob(1000) FROM ' +
    '(WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 300) SELECT i FROM c)');
  fs.copyFileSync(live, file);
  fs.copyFileSync(live + '-journal', file + '-journal');
  db.exec('ROLLBACK');
  db.close();
  fs.unlinkSync(live);
}

// Opening read-write lets SQLite roll a hot journal back, as Chromium would on
// its next start. `read` opens read-only, which cannot.
function recover(file) {
  const db = new DatabaseSync(file);
  db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  db.close();
}

// The real node:sqlite, with every connection the migration opens recorded.
function trackingSqlite() {
  const opened = [];
  class TrackedDatabaseSync extends DatabaseSync {
    constructor(...args) { super(...args); opened.push(this); }
  }
  return { sqlite: { DatabaseSync: TrackedDatabaseSync }, opened };
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function read(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, String(r.value)]));
  const schema = Object.fromEntries(
    db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(r => [r.name, r.sql]));
  const stmt = db.prepare('SELECT * FROM cookies ORDER BY creation_utc');
  stmt.setReadBigInts(true);
  // Small enum columns back to plain numbers for readable asserts; only the
  // ones this schema version actually has.
  const small = ['source_scheme', 'source_type', 'has_cross_site_ancestor'];
  const rows = stmt.all().map(r => {
    const o = { ...r };
    for (const k of small) if (k in o) o[k] = Number(o[k]);
    return o;
  });
  db.close();
  return { meta, schema, rows };
}

test('v21 -> v23: schema matches what Chromium 152 writes, meta says 23', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'migrated');
  assert.equal(r.from, 21);
  assert.equal(r.to, 23);
  const { meta, schema } = read(f);
  assert.equal(meta.version, '23');
  assert.equal(meta.last_compatible_version, '23');
  assert.equal(meta.mmap_status, '-1', 'unrelated meta keys are left alone');
  assert.equal(schema.cookies, CHROMIUM_152_TABLE);
  assert.equal(schema.cookies_unique_index, CHROMIUM_152_INDEX);
  assert.equal(schema.cookies_old, undefined, 'the scratch table is dropped');
});

test('v21 -> v23: every row and every original column survives unchanged', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  const before = read(f).rows;
  const r = migrateCookieDb(f);
  assert.equal(r.rowsBefore, ROWS.length);
  assert.equal(r.rowsAfter, ROWS.length);
  const after = read(f).rows;
  assert.equal(after.length, before.length);
  const cols = Object.keys(before[0]).filter(c => c !== 'source_scheme');
  before.forEach((b, i) => {
    for (const c of cols) assert.deepEqual(after[i][c], b[c], `row ${b.name} column ${c}`);
    assert.equal(after[i].source_type, 0, 'source_type defaults to kUnknown');
  });
});

test("v22 -> v23 applies Chromium's source_scheme and has_cross_site_ancestor rules", () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  migrateCookieDb(f);
  const by = Object.fromEntries(read(f).rows.map(r => [r.name, r]));
  assert.equal(by.legacy_secure.source_scheme, 2, 'kUnset + secure becomes kSecure');
  assert.equal(by.legacy_plain.source_scheme, 0, 'kUnset + insecure stays kUnset');
  assert.equal(by['auth-token'].source_scheme, 2);
  assert.equal(by.part_same.has_cross_site_ancestor, 0, 'host inside the partition site');
  assert.equal(by.part_cross.has_cross_site_ancestor, 1, 'host outside the partition site');
  assert.equal(by['auth-token'].has_cross_site_ancestor, 1, 'unpartitioned rows get 1, as in Chromium');
});

test('host-only, domain and __Host- cookies keep their exact host_key', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  migrateCookieDb(f);
  const by = Object.fromEntries(read(f).rows.map(r => [r.name, r]));
  assert.equal(by.PREF.host_key, 'www.youtube.com');
  assert.equal(by['__Host-GAPS'].host_key, 'accounts.google.com');
  assert.equal(by['auth-token'].host_key, '.twitch.tv');
});

test('a backup of the untouched v21 file is kept, and a second run never replaces it', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  const original = sha(f);
  const first = migrateCookieDb(f);
  assert.equal(first.backup, f + '.v21-backup');
  assert.equal(sha(first.backup), original, 'backup is byte-identical to the pre-migration file');
  const second = migrateCookieDb(f);
  assert.equal(second.status, 'current');
  assert.equal(sha(first.backup), original, 'backup unchanged by a later run');
  assert.equal(fs.existsSync(f + '.migration-pending'), false, 'no snapshot left behind');
});

test('an already-current database is not touched', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  migrateCookieDb(f);
  const h = sha(f);
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'current');
  assert.equal(r.from, 23);
  assert.equal(sha(f), h);
});

test('an unknown old version is skipped and left byte-identical', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f, { version: 20 });
  const h = sha(f);
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'skipped');
  assert.equal(r.from, 20);
  // main.js logs a skip only when `error` is set; the log has to name the version.
  assert.match(r.error, /\b20\b/);
  assert.equal(sha(f), h);
  assert.equal(fs.existsSync(f + '.migration-pending'), false);
});

test('a failure mid-migration rolls back: the file is still a readable v21 with every row', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  // A v21 file missing a column the migration SELECTs, so the INSERT fails
  // after the rename and table creation have already run inside the transaction.
  const broken = V21_TABLE.replace(',last_update_utc INTEGER NOT NULL', '');
  makeV21(f, { table: broken });
  const db = new DatabaseSync(f);
  db.exec("INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port) VALUES (1, '.a.com', '', 'n', 'v', x'', '/', 2, 1, 0, 1, 1, 1, 1, 0, 2, 443)");
  db.close();
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'failed');
  const after = read(f);
  assert.equal(after.meta.version, '21');
  assert.equal(after.rows.length, 1);
  assert.equal(after.schema.cookies, broken, 'original table restored by the rollback');
  assert.equal(after.schema.cookies_old, undefined);
});

test('without node:sqlite it skips instead of throwing', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  const h = sha(f);
  const r = migrateCookieDb(f, { sqlite: null });
  assert.equal(r.status, 'skipped');
  // main.js logs a skip only when `error` is set: an empty reason hides it.
  assert.match(r.error, /node:sqlite/);
  assert.equal(sha(f), h);
});

test('migrateProfileCookies finds the default session and every partition', () => {
  const ud = tmpdir();
  makeV21(path.join(ud, 'Network', 'Cookies'));
  makeV21(path.join(ud, 'Partitions', 'default', 'Network', 'Cookies'));
  makeV21(path.join(ud, 'Partitions', 'other', 'Network', 'Cookies'));
  fs.mkdirSync(path.join(ud, 'Partitions', 'empty'), { recursive: true });
  assert.equal(findCookieDbs(ud).length, 3);
  const results = migrateProfileCookies(ud);
  assert.deepEqual(results.map(r => r.status), ['migrated', 'migrated', 'migrated']);
  assert.deepEqual(migrateProfileCookies(tmpdir()), [], 'a fresh profile has nothing to do');
});

// --- v22 input -------------------------------------------------------------
// A profile last written at v22 (Chromium's intermediate schema) must migrate
// too, through the 22 -> 23 step only: re-running 21 -> 22 on it would reset
// every cookie's source_type to kUnknown.

test('v22 -> v23: migrated, and every cookie keeps its source_type', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV22(f);
  const original = sha(f);
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'migrated');
  assert.equal(r.from, 22);
  assert.equal(r.to, 23);
  assert.equal(r.rowsBefore, ROWS.length);
  assert.equal(r.rowsAfter, ROWS.length);
  assert.equal(r.backup, f + '.v22-backup');
  assert.equal(sha(r.backup), original);
  const { meta, schema, rows } = read(f);
  assert.equal(meta.version, '23');
  assert.equal(schema.cookies, CHROMIUM_152_TABLE);
  assert.equal(schema.cookies_unique_index, CHROMIUM_152_INDEX);
  rows.forEach((row, i) => assert.equal(row.source_type, i % 4, `row ${row.name} source_type`));
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(by.legacy_secure.source_scheme, 2, 'the 22 -> 23 rules still apply');
  assert.equal(by.part_same.has_cross_site_ancestor, 0);
  assert.equal(by.part_cross.has_cross_site_ancestor, 1);
});

// --- leftover scratch table ------------------------------------------------
// Each step renames cookies to cookies_old. Like Chromium, it first drops a
// cookies_old left by an interrupted earlier run; otherwise the rename fails
// and the whole migration with it, at v21 and at v22 alike.

for (const [version, make] of [[21, makeV21], [22, makeV22]]) {
  test(`v${version}: a leftover cookies_old table does not block the migration`, () => {
    const dir = tmpdir();
    const f = path.join(dir, 'Cookies');
    make(f);
    const db = new DatabaseSync(f);
    db.exec('CREATE TABLE cookies_old(stale INTEGER)');
    db.close();
    const r = migrateCookieDb(f);
    assert.equal(r.status, 'migrated', r.error);
    const after = read(f);
    assert.equal(after.meta.version, '23');
    assert.equal(after.rows.length, ROWS.length);
    assert.equal(after.schema.cookies_old, undefined);
  });
}

// --- journal files and backups ---------------------------------------------
// A crash mid-write leaves Cookies-journal beside Cookies, and the file alone is
// torn. The backup has to be the untouched pair, and the first backup ever taken
// is the one kept.

test('a hot journal is backed up with the file: the backup pair restores every cookie', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeCrashedV21(f);
  const crashed = { db: sha(f), journal: sha(f + '-journal') };
  // The fixture is what it claims: without its journal the file has lost every cookie.
  const alone = path.join(tmpdir(), 'Cookies');
  fs.copyFileSync(f, alone);
  assert.equal(read(alone).rows.length, 0);

  const r = migrateCookieDb(f);
  assert.equal(r.status, 'migrated');
  assert.equal(r.rowsBefore, ROWS.length, 'the crashed write was rolled back before migrating');
  assert.equal(read(f).rows.length, ROWS.length);
  assert.equal(sha(r.backup), crashed.db, 'backup is the file as found, before SQLite touched it');
  assert.equal(sha(r.backup + '-journal'), crashed.journal, 'and its journal beside it');
  assert.equal(fs.existsSync(f + '.migration-pending'), false);
  assert.equal(fs.existsSync(f + '.migration-pending-journal'), false);

  // Restore it the way a user would: both files, side by side.
  const restored = path.join(tmpdir(), 'Cookies');
  fs.copyFileSync(r.backup, restored);
  fs.copyFileSync(r.backup + '-journal', restored + '-journal');
  recover(restored);
  const back = read(restored);
  assert.equal(back.meta.version, '21');
  assert.deepEqual(back.rows.map(x => x.name), ROWS.map(x => x[2]));
});

test('an existing backup is never replaced, and the new snapshot is cleaned up', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  // An earlier start took the backup and then failed; the old build ran again
  // and kept writing v21 (and crashed mid-write, so there is a journal too).
  const backup = f + '.v21-backup';
  makeV21(backup, { rows: ROWS.slice(0, 2) });
  const firstBackup = sha(backup);
  makeCrashedV21(f);
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'migrated');
  assert.equal(r.backup, backup);
  assert.equal(sha(backup), firstBackup, 'the first backup is the real pre-upgrade copy');
  assert.equal(fs.existsSync(backup + '-journal'), false, "this run's journal is not paired with the old backup");
  assert.equal(fs.existsSync(f + '.migration-pending'), false);
  assert.equal(fs.existsSync(f + '.migration-pending-journal'), false);
});

// --- no snapshot, no migration ---------------------------------------------
// The snapshot is the only copy of the untouched file. If it cannot be taken,
// the file must not even be opened.

test('if the snapshot cannot be written, the file is skipped and left byte-identical', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'Cookies');
  makeV21(f);
  const h = sha(f);
  // A directory where the snapshot goes: a stand-in for a full disk or an
  // unwritable path.
  fs.mkdirSync(f + '.migration-pending');
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'skipped');
  assert.match(r.error, /snapshot/);
  assert.equal(sha(f), h, 'never migrated without a backup');
  assert.equal(fs.existsSync(f + '.v21-backup'), false);
});

test('a cookie file that vanished before its turn is skipped, not recreated empty', () => {
  const f = path.join(tmpdir(), 'Cookies');
  const r = migrateCookieDb(f);
  assert.equal(r.status, 'skipped');
  assert.equal(fs.existsSync(f), false);
});

// --- connections ------------------------------------------------------------
// Every connection the migration opens is closed before it returns, on every
// path. Chromium's network service opens the same file right after; a handle
// left open (after a failure, possibly still inside the transaction) is one it
// has to share.

const CLOSE_CASES = [
  ['migrated', f => makeV21(f)],
  ['current', f => { makeV21(f); migrateCookieDb(f); }],
  ['skipped', f => makeV21(f, { version: 20 })],
  // Fails reading the version, before any backup exists.
  ['failed', f => fs.writeFileSync(f, 'not a sqlite database '.repeat(100))],
  // Fails inside the transaction: the INSERT SELECTs a column this file lacks.
  ['failed', f => makeV21(f, { table: V21_TABLE.replace(',last_update_utc INTEGER NOT NULL', ''), rows: [] })],
];

CLOSE_CASES.forEach(([status, make], i) => {
  test(`every connection is closed when the result is '${status}' (case ${i + 1})`, () => {
    const f = path.join(tmpdir(), 'Cookies');
    make(f);
    const { sqlite, opened } = trackingSqlite();
    const r = migrateCookieDb(f, { sqlite });
    assert.equal(r.status, status);
    assert.ok(opened.length > 0, 'the migration opened the file');
    assert.deepEqual(opened.map(db => db.isOpen), opened.map(() => false));
  });
});
