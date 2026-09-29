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
  saveConfigFile, writeFileDurably, preserveDamaged,
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

// ── Saving: a crash at any moment leaves a whole config on disk ─────────────
//
// A real config.json came back as 24,099 zero bytes after an unexpected
// shutdown: the save renamed a file whose data was never flushed, and the
// .bak copied next to it was unflushed too. crashDisk models that disk:
//   - file data reaches the disk only when fsync'd after its last write;
//     anything else comes back as zeros of the same length;
//   - creates, renames and deletes go to a journal written in order. fsync
//     commits everything before it, and a crash can land after any prefix of
//     the rest has been written (the journal also flushes on its own).
// Initial files are on disk unless given as { data, durable: false }.
function crashDisk(initial) {
  let nextIno = 1;
  const inode = (data, durable) => ({ id: nextIno++, data: Buffer.from(data), durable: durable ? Buffer.from(data) : null, dirty: !durable });
  const live = new Map();
  const committed = new Map();
  for (const [p, v] of Object.entries(initial)) {
    const spec = typeof v === 'string' ? { data: v, durable: true } : v;
    const ino = inode(spec.data, spec.durable);
    live.set(p, ino);
    committed.set(p, ino);
  }
  const pending = []; // journal entries not yet on disk, oldest first
  const fds = new Map();
  let nextFd = 100;
  let budget = Infinity;
  const disk = { crashed: false };
  // Also set when production code swallows the crash (best-effort catches).
  const step = () => {
    if (budget-- <= 0) {
      disk.crashed = true;
      throw Object.assign(new Error('CRASH'), { crash: true });
    }
  };
  const err = (code, p) => Object.assign(new Error(`${code}: '${p}'`), { code });
  const bind = (p, ino) => {
    live.set(p, ino);
    pending.push((ns) => ns.set(p, ino));
  };
  return Object.assign(disk, {
    openSync(p, flags) {
      step();
      let ino;
      if (flags === 'r' || flags === 'r+') { // existing file, not truncated
        if (!live.has(p)) throw err('ENOENT', p);
        ino = live.get(p);
      } else {
        if (flags === 'wx' && live.has(p)) throw err('EEXIST', p);
        ino = inode('', false);
        bind(p, ino);
      }
      const fd = nextFd++;
      fds.set(fd, ino);
      return fd;
    },
    writeFileSync(target, data) {
      step();
      if (typeof target === 'number') {
        const ino = fds.get(target);
        ino.data = Buffer.from(data);
        ino.dirty = true;
        return;
      }
      bind(target, inode(data, false));
    },
    fsyncSync(fd) {
      step();
      const ino = fds.get(fd);
      ino.durable = Buffer.from(ino.data);
      ino.dirty = false;
      for (const op of pending.splice(0)) op(committed);
    },
    closeSync(fd) { fds.delete(fd); },
    readFileSync(p) {
      if (!live.has(p)) throw err('ENOENT', p);
      return Buffer.from(live.get(p).data);
    },
    existsSync(p) { return live.has(p); },
    copyFileSync(a, b) {
      step();
      bind(b, inode(live.get(a).data, false));
    },
    renameSync(a, b) {
      step();
      if (!live.has(a)) throw err('ENOENT', a);
      const ino = live.get(a);
      live.delete(a);
      live.set(b, ino);
      pending.push((ns) => { ns.delete(a); ns.set(b, ino); });
    },
    unlinkSync(p) {
      step();
      if (!live.has(p)) throw err('ENOENT', p);
      live.delete(p);
      pending.push((ns) => ns.delete(p));
    },
    statSync(p) {
      if (live.has(p)) return { isDirectory: () => false };
      throw err('ENOENT', p);
    },
    crashAfter(n) { budget = n; },
    pendingCount() { return pending.length; },
    // What the next boot finds when the first `prefix` pending journal
    // entries made it to disk, written into a real folder for the real loader.
    rebootInto(dir, prefix) {
      const ns = new Map(committed);
      for (const op of pending.slice(0, prefix)) op(ns);
      for (const [p, ino] of ns) {
        fs.writeFileSync(path.join(dir, path.basename(p)), ino.durable && !ino.dirty ? ino.durable : Buffer.alloc(ino.data.length));
      }
      return path.join(dir, 'config.json');
    },
  });
}

const DISK_CONFIG = 'D:/profile/config.json';
const NEWER = { streamers: [{ platform: 'kick', username: 'x' }], watchTime: { streamers: { 'kick:x': 13000 } } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Crashes the save after 0, 1, 2 ... disk operations and, at each, boots the
// real loader on every journal prefix that can have reached the disk.
function crashAtEveryStep(save, initial) {
  const outcomes = [];
  for (let k = 0; k < 60; k++) {
    const disk = crashDisk(initial);
    disk.crashAfter(k);
    try {
      save(DISK_CONFIG, JSON.stringify(NEWER), disk);
    } catch (e) {
      if (!e.crash) throw e;
    }
    const finished = !disk.crashed;
    for (let prefix = 0; prefix <= disk.pendingCount(); prefix++) {
      const booted = disk.rebootInto(tempDir(), prefix);
      const r = loadConfigFromDisk(booted, { sleep: noSleep, stamp: 'S' });
      outcomes.push({ k, prefix, all: prefix === disk.pendingCount(), finished, status: r.status, data: r.data, bak: readConfigFileResult(`${booted}.bak`) });
    }
    if (finished) return outcomes;
  }
  throw new Error('the save never finished');
}

const newSave = (p, json, disk) => saveConfigFile(p, json, { fs: disk });
const at = (o) => `crash after ${o.k} steps, ${o.prefix} journal entries on disk`;

test('saveConfigFile: a crash at any step boots into the old or the new config', () => {
  const outcomes = crashAtEveryStep(newSave, { [DISK_CONFIG]: JSON.stringify(GOOD), [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) });
  assert.ok(outcomes.some(o => !o.finished) && outcomes.some(o => o.finished), 'crashed mid-save and after it');
  for (const o of outcomes) {
    assert.equal(o.status, 'loaded', `${at(o)}: ${o.status}`);
    assert.ok(same(o.data, GOOD) || same(o.data, NEWER), `${at(o)}: ${JSON.stringify(o.data)}`);
  }
  // Once it returns, the new config survives any crash, whatever the journal did.
  const done = outcomes.filter(o => o.finished);
  assert.ok(done.length > 0);
  for (const o of done) assert.deepEqual(o.data, NEWER, at(o));
  // And with the journal written, the previous one is the .bak: two good
  // generations, the fallback for whatever damages config.json later.
  const settled = done.find(o => o.all);
  assert.equal(settled.bak.status, 'ok');
  assert.deepEqual(settled.bak.data, GOOD);
});

// Every release up to v0.14.0-beta saved without flushing, so the first save
// after an update can start from a config.json that is not on disk yet. The
// old .bak must survive until the new config is.
test('saveConfigFile: the first save after an update from an unflushed config.json never ends in defaults', () => {
  const outcomes = crashAtEveryStep(newSave, {
    [DISK_CONFIG]: { data: JSON.stringify(GOOD), durable: false },
    [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER),
  });
  for (const o of outcomes) {
    assert.ok(o.status === 'loaded' || o.status === 'recovered', `${at(o)}: ${o.status}`);
    assert.ok(same(o.data, OLDER) || same(o.data, NEWER), `${at(o)}: ${JSON.stringify(o.data)}`);
  }
  for (const o of outcomes.filter(x => x.finished)) assert.deepEqual(o.data, NEWER, at(o));
  const settled = outcomes.find(o => o.finished && o.all);
  assert.deepEqual(settled.bak.data, GOOD, 'the unflushed config was kept, from memory, as the .bak');
});

// The model has teeth: the save as it was (write, copy, rename, no flush)
// loses both files once the journal is written, and the app starts empty.
// This is what happened to the real config.
test('the unflushed save this replaced ends in defaults after a crash (regression)', () => {
  const oldSave = (p, json, disk) => {
    disk.writeFileSync(`${p}.tmp`, json, 'utf8');
    if (disk.existsSync(p)) disk.copyFileSync(p, `${p}.bak`);
    disk.renameSync(`${p}.tmp`, p);
  };
  const outcomes = crashAtEveryStep(oldSave, { [DISK_CONFIG]: JSON.stringify(GOOD), [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) });
  const settled = outcomes.find(o => o.finished && o.all);
  assert.equal(settled.status, 'defaults', 'config.json and .bak both came back as zeros');
});

test('saveConfigFile on a real folder: new config in place, previous one in .bak, no temp files left', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  saveConfigFile(p, JSON.stringify(OLDER));
  assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'first save: nothing to roll to .bak');
  saveConfigFile(p, JSON.stringify(GOOD));
  const r = saveConfigFile(p, JSON.stringify(NEWER));
  assert.equal(r.backupError, null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak']);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')), GOOD);
});

test('saveConfigFile never rolls a damaged config.json over a good .bak', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, Buffer.alloc(24099)); // what the crash left
  fs.writeFileSync(`${p}.bak`, JSON.stringify(GOOD));
  saveConfigFile(p, JSON.stringify(NEWER));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')), GOOD);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
});

test('saveConfigFile: a .bak that cannot be written is reported, and the save still lands', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const denyBak = { ...fs, openSync: (f, ...rest) => { if (String(f).endsWith('.bak.tmp')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.openSync(f, ...rest); } };
  const r = saveConfigFile(p, JSON.stringify(NEWER), { fs: denyBak });
  assert.equal(r.backupError && r.backupError.code, 'EPERM');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
});

test('writeFileDurably flushes before it closes, and closes even when the write fails', () => {
  const calls = [];
  const spy = {
    openSync: (p, f) => { calls.push(`open ${f}`); return 7; },
    writeFileSync: (fd) => { calls.push(`write ${fd}`); },
    fsyncSync: (fd) => { calls.push(`fsync ${fd}`); },
    closeSync: (fd) => { calls.push(`close ${fd}`); },
  };
  writeFileDurably('x', 'data', spy);
  assert.deepEqual(calls, ['open w', 'write 7', 'fsync 7', 'close 7']);
  calls.length = 0;
  const failing = { ...spy, writeFileSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } };
  assert.throws(() => writeFileDurably('x', 'data', failing), /ENOSPC/);
  assert.deepEqual(calls, ['open w', 'close 7']);
});

// Some network shares cannot flush at all. Failing every save there would be
// worse than saving unflushed; a real I/O error still fails the save.
test('writeFileDurably: a volume that cannot flush still gets the write; a real flush error does not pass', () => {
  const fsyncFails = (code) => ({
    openSync: () => 7, writeFileSync: () => {}, closeSync: () => {},
    fsyncSync: () => { throw Object.assign(new Error(code), { code }); },
  });
  for (const code of ['EISDIR', 'EINVAL', 'ENOTSUP']) assert.doesNotThrow(() => writeFileDurably('x', 'd', fsyncFails(code)), code);
  for (const code of ['EIO', 'EPERM', 'ENOSPC']) assert.throws(() => writeFileDurably('x', 'd', fsyncFails(code)), new RegExp(code));
});

// The copy of a damaged config.json is the only one once the original is
// deleted, so it must be on disk first.
test('a damaged config.json is copied to disk before the original is deleted', () => {
  const disk = crashDisk({ [DISK_CONFIG]: 'garbage-but-maybe-fixable', [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) });
  const r = loadConfigFromDisk(DISK_CONFIG, { fs: disk, sleep: noSleep, stamp: 'S' });
  assert.equal(r.status, 'recovered');
  const dir = tempDir();
  disk.rebootInto(dir, disk.pendingCount()); // the delete made it to disk
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json.corrupt-S.json'), 'utf8'), 'garbage-but-maybe-fixable');
});

// Every way a save can start. Once saveConfigFile returns, the new config
// survives any crash, whatever the journal did; mid-save, the boot never
// finds less than it would have found had the save not started.
const START_STATES = {
  'a fresh install': {},
  'the first save after recovering from .bak': { [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) },
  'a damaged config.json with a good .bak': { [DISK_CONFIG]: '\0'.repeat(64), [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) },
  'both files unflushed by an older release': {
    [DISK_CONFIG]: { data: JSON.stringify(GOOD), durable: false },
    [`${DISK_CONFIG}.bak`]: { data: JSON.stringify(OLDER), durable: false },
  },
};
for (const [name, initial] of Object.entries(START_STATES)) {
  test(`saveConfigFile from ${name}: never worse than before mid-save, the new config once it returns`, () => {
    const before = loadConfigFromDisk(crashDisk(initial).rebootInto(tempDir(), 0), { sleep: noSleep, stamp: 'S' });
    const outcomes = crashAtEveryStep(newSave, initial);
    for (const o of outcomes) {
      const asBefore = o.status === before.status && same(o.data, before.data);
      assert.ok(asBefore || same(o.data, NEWER), `${at(o)}: ${o.status} ${JSON.stringify(o.data)} (before the save: ${before.status})`);
    }
    for (const o of outcomes.filter(x => x.finished)) assert.deepEqual(o.data, NEWER, at(o));
  });
}

test('an earlier salvage copy with the same name is neither overwritten nor deleted', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, 'new damage');
  fs.writeFileSync(`${p}.corrupt-S.json`, 'earlier damage');
  assert.equal(preserveDamaged(p, Buffer.from('new damage'), 'S', { unlink: true }), null);
  assert.equal(fs.readFileSync(`${p}.corrupt-S.json`, 'utf8'), 'earlier damage');
  assert.equal(fs.readFileSync(p, 'utf8'), 'new damage', 'no copy was made, so the original stays');
});

test('saveConfigFile throws when the new config cannot be put in place, and the old one stays', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const busy = { ...fs, renameSync: (a, b) => {
    if (String(a).endsWith('config.json.tmp')) throw Object.assign(new Error('EBUSY: held by another program'), { code: 'EBUSY' });
    return fs.renameSync(a, b);
  } };
  assert.throws(() => saveConfigFile(p, JSON.stringify(NEWER), { fs: busy }), /EBUSY/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), GOOD);
});

test('saveConfigFile reports a volume that cannot flush, and still saves there', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const noFlush = { ...fs, fsyncSync: () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); } };
  const r = saveConfigFile(p, JSON.stringify(NEWER), { fs: noFlush });
  assert.equal(r.flushSkipped, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
  assert.equal(saveConfigFile(p, JSON.stringify(GOOD)).flushSkipped, false);
});

// FAT32/exFAT keep no journal: a crash can leave a save's flushed temp file
// whole with neither name pointing at it. Anything whole beats defaults.
test('with config.json and .bak both unusable, a whole temp file from a save is recovered, .tmp first', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, Buffer.alloc(100));
  fs.writeFileSync(`${p}.bak`, Buffer.alloc(100));
  fs.writeFileSync(`${p}.bak.tmp`, JSON.stringify(OLDER));
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(NEWER));
  const logs = [];
  const r = loadConfigFromDisk(p, { sleep: noSleep, stamp: 'S', log: (t) => logs.push(t) });
  assert.equal(r.status, 'recovered');
  assert.deepEqual(r.data, NEWER);
  assert.match(logs.join('\n'), /recovered your settings from config\.json\.tmp/);

  const dir2 = tempDir();
  const p2 = path.join(dir2, 'config.json');
  fs.writeFileSync(`${p2}.tmp`, Buffer.alloc(50));
  fs.writeFileSync(`${p2}.bak.tmp`, JSON.stringify(OLDER));
  assert.deepEqual(loadConfigFromDisk(p2, { sleep: noSleep, stamp: 'S' }).data, OLDER, 'a damaged .tmp falls through to .bak.tmp');
});

test('a config.json that exists but is locked is never bypassed by a temp file', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(NEWER));
  const r = loadConfigFromDisk(p, { fs: lockingFs([p]), sleep: noSleep });
  assert.equal(r.status, 'locked');
});
