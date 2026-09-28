// Gate tests for main/config-store.js (F29): only a config that is genuinely
// absent may be replaced by defaults. A file that exists but cannot be read
// (locked by a backup/sync/antivirus tool, an unreachable redirected AppData)
// must come back as 'locked' with both files byte-identical and nothing new
// written. Real temp directories; locks are simulated with an fs wrapper
// (a real exclusive Windows lock is exercised by a separate harness).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readConfigFileResult, readConfigWithRetry, isDirReachable, decideConfigSource, loadConfigFromDisk,
} = require('../main/config-store');

const GOOD = { streamers: [{ platform: 'kick', username: 'x' }], watchTime: { streamers: { 'kick:x': 12345 } } };
const OLDER = { streamers: [{ platform: 'kick', username: 'x' }], watchTime: { streamers: { 'kick:x': 12000 } } };
const noSleep = () => {};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sl-config-store-'));
}

function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) out[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
  return out;
}

// fs that fails reads of the given paths with `code` (EBUSY: another process
// holds the file with no sharing), optionally only for the first N attempts.
function lockingFs(lockedPaths, { code = 'EBUSY', failFirst = Infinity } = {}) {
  const attempts = new Map();
  return {
    ...fs,
    readFileSync(p, ...rest) {
      if (lockedPaths.includes(p)) {
        const n = (attempts.get(p) || 0) + 1;
        attempts.set(p, n);
        if (n <= failFirst) {
          const err = new Error(`${code}: resource busy or locked, open '${p}'`);
          err.code = code;
          throw err;
        }
      }
      return fs.readFileSync(p, ...rest);
    },
    attempts,
  };
}

test('readConfigFileResult tells missing, unreadable, damaged and good apart', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  assert.equal(readConfigFileResult(p).status, 'missing');
  fs.writeFileSync(p, '{"a":');
  assert.equal(readConfigFileResult(p).status, 'corrupt');
  fs.writeFileSync(p, '[1,2]');
  assert.equal(readConfigFileResult(p).status, 'corrupt', 'not a JSON object');
  fs.writeFileSync(p, '');
  assert.equal(readConfigFileResult(p).status, 'corrupt', 'a zero-byte file');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  assert.deepEqual(readConfigFileResult(p).data, GOOD);
  const locked = readConfigFileResult(p, lockingFs([p]));
  assert.equal(locked.status, 'ioerror');
  assert.equal(locked.err.code, 'EBUSY');
  // A directory where the file should be is unreadable, not missing.
  const d = path.join(dir, 'dir.json');
  fs.mkdirSync(d);
  assert.equal(readConfigFileResult(d).status, 'ioerror');
});

test('a lock that clears within the retries is read normally', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const lfs = lockingFs([p], { failFirst: 3 });
  let slept = 0;
  const r = readConfigWithRetry(p, { fs: lfs, sleep: () => { slept++; } });
  assert.equal(r.status, 'ok');
  assert.equal(slept, 3);
  // A missing file is never retried.
  let s2 = 0;
  assert.equal(readConfigWithRetry(path.join(dir, 'nope.json'), { sleep: () => { s2++; } }).status, 'missing');
  assert.equal(s2, 0);
});

test('regression F29: config.json and .bak both locked -> locked, nothing written, both byte-identical', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  fs.writeFileSync(`${p}.bak`, JSON.stringify(OLDER));
  const before = snapshot(dir);
  const lfs = lockingFs([p, `${p}.bak`]);
  const r = loadConfigFromDisk(p, { fs: lfs, sleep: noSleep });
  assert.equal(r.status, 'locked');
  assert.equal(r.error, 'EBUSY');
  assert.match(r.reason, /could not be read/);
  assert.deepEqual(snapshot(dir), before, 'no salvage copy, no unlink, no rewrite');
  assert.equal(lfs.attempts.get(p), 5, 'retried before giving up');
});

test('only config.json locked, .bak good -> recovered from .bak, config.json untouched', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  fs.writeFileSync(`${p}.bak`, JSON.stringify(OLDER));
  const before = snapshot(dir);
  const r = loadConfigFromDisk(p, { fs: lockingFs([p]), sleep: noSleep });
  assert.equal(r.status, 'recovered');
  assert.deepEqual(r.data, OLDER);
  assert.equal(r.from, 'ioerror');
  assert.deepEqual(snapshot(dir), before, 'an unreadable-but-fine file is never salvaged or unlinked');
});

test('config.json missing but .bak locked -> locked (not a fresh install)', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(`${p}.bak`, JSON.stringify(OLDER));
  const r = loadConfigFromDisk(p, { fs: lockingFs([`${p}.bak`]), sleep: noSleep });
  assert.equal(r.status, 'locked');
});

test('fresh install: both missing in a reachable folder -> defaults', () => {
  const dir = tempDir();
  const r = loadConfigFromDisk(path.join(dir, 'config.json'), { sleep: noSleep });
  assert.equal(r.status, 'defaults');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('fresh install whose folder does not exist yet is still a fresh install', () => {
  const dir = path.join(tempDir(), 'stream-lurker');
  const r = loadConfigFromDisk(path.join(dir, 'config.json'), { sleep: noSleep });
  assert.equal(r.status, 'defaults');
  assert.ok(fs.statSync(dir).isDirectory());
});

test('unreachable settings folder (ENOENT everywhere, parent gone) -> locked, never defaults', () => {
  // Stands in for a redirected AppData on a share that is not up yet: every
  // path under it reports ENOENT and the folder cannot be created either.
  const p = path.join('Z:\\definitely-not-mounted', 'AppData', 'stream-lurker', 'config.json');
  const deadFs = {
    ...fs,
    readFileSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    statSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    mkdirSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeFileSync() { throw new Error('must not write'); },
    unlinkSync() { throw new Error('must not unlink'); },
  };
  const r = loadConfigFromDisk(p, { fs: deadFs, sleep: noSleep });
  assert.equal(r.status, 'locked');
  assert.match(r.reason, /not reachable/);
});

test('corrupt config.json, good .bak -> recovered; the damaged bytes are preserved and moved aside', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{"streamers": [tru');
  fs.writeFileSync(`${p}.bak`, JSON.stringify(OLDER));
  const logs = [];
  const r = loadConfigFromDisk(p, { sleep: noSleep, log: (t) => logs.push(t), stamp: 'STAMP' });
  assert.equal(r.status, 'recovered');
  assert.deepEqual(r.data, OLDER);
  assert.equal(fs.existsSync(p), false, 'moved aside so saveConfig cannot roll it over the good .bak');
  assert.equal(fs.readFileSync(`${p}.corrupt-STAMP.json`, 'utf8'), '{"streamers": [tru');
  assert.match(logs.join('\n'), /preserved a copy as config\.json\.corrupt-STAMP\.json/);
});

test('corrupt config.json, corrupt .bak -> defaults, with both damaged files preserved', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, 'garbage-main');
  fs.writeFileSync(`${p}.bak`, 'garbage-bak');
  const r = loadConfigFromDisk(p, { sleep: noSleep, stamp: 'S' });
  assert.equal(r.status, 'defaults');
  assert.equal(fs.readFileSync(`${p}.corrupt-S.json`, 'utf8'), 'garbage-main');
  assert.equal(fs.readFileSync(`${p}.bak.corrupt-S.json`, 'utf8'), 'garbage-bak');
});

test('corrupt config.json whose copy cannot be preserved, no usable .bak -> locked', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, 'garbage');
  const before = snapshot(dir);
  const noWriteFs = { ...fs, writeFileSync() { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } };
  const r = loadConfigFromDisk(p, { fs: noWriteFs, sleep: noSleep });
  assert.equal(r.status, 'locked');
  assert.match(r.reason, /could not be preserved/);
  assert.deepEqual(snapshot(dir), before, 'the only copy of the damaged file is not unlinked');
});

test('decideConfigSource: defaults only when nothing exists that could hold data', () => {
  const d = (main, backup, extra = {}) => decideConfigSource({ main, backup, salvaged: true, dirReachable: true, ...extra }).source;
  assert.equal(d('ok', 'ioerror'), 'main');
  assert.equal(d('ioerror', 'ok'), 'backup');
  assert.equal(d('missing', 'missing'), 'defaults');
  assert.equal(d('missing', 'corrupt'), 'defaults');
  assert.equal(d('corrupt', 'missing'), 'defaults');
  for (const [m, b] of [['ioerror', 'missing'], ['ioerror', 'corrupt'], ['ioerror', 'ioerror'], ['missing', 'ioerror'], ['corrupt', 'ioerror']]) {
    assert.equal(d(m, b), null, `${m}/${b}`);
  }
  assert.equal(d('corrupt', 'missing', { salvaged: false }), null);
  assert.equal(d('missing', 'missing', { dirReachable: false }), null);
});

test('isDirReachable: existing folder yes, a file no, a creatable folder yes', () => {
  const dir = tempDir();
  assert.equal(isDirReachable(dir), true);
  const f = path.join(dir, 'f');
  fs.writeFileSync(f, 'x');
  assert.equal(isDirReachable(f), false);
  assert.equal(isDirReachable(path.join(dir, 'new', 'deeper')), true);
});
