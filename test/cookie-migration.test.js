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
const { migrateCookieDb, migrateProfileCookies, findCookieDbs } = require('../cookie-migration');

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
