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
  saveConfigFile, writeFileDurably, preserveDamaged, replaceFileDurably,
} = require('../main/config-store');

const GOOD = { streamers: [{ platform: 'kick', username: 'x' }], watchTime: { streamers: { 'kick:x': 12345 } } };
const OLDER = { streamers: [{ platform: 'kick', username: 'x' }], watchTime: { streamers: { 'kick:x': 12000 } } };
const noSleep = () => {};

const madeDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-config-store-'));
  madeDirs.push(dir);
  return dir;
}
test.after(() => { for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true }); });

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
//     With { commit: 'own' }, a weaker disk: fsync commits only the entries
//     for the file it flushes.
// Initial files are on disk unless given as { data, durable: false }.
// failOpen(path, flags) makes that open fail with EPERM.
// splitRename: a volume without a journal (FAT32, exFAT), where renaming over
// an existing file is two separate updates: remove the old one, then rename.
function crashDisk(initial, { commit = 'all', failOpen = () => false, splitRename = false } = {}) {
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
    pending.push({ ino, names: [p], apply: (ns) => ns.set(p, ino) });
  };
  return Object.assign(disk, {
    openSync(p, flags) {
      step();
      if (failOpen(p, flags)) throw err('EPERM', p);
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
      if (commit === 'all') {
        for (const e of pending.splice(0)) e.apply(committed);
      } else {
        // This file's entries, and every earlier entry on a name they touch:
        // no file system makes an older rename or delete of a name durable
        // after a newer one.
        const take = new Set(pending.filter(x => x.ino === ino));
        for (let grew = true; grew;) {
          grew = false;
          pending.forEach((x, i) => {
            if (take.has(x)) return;
            if (pending.slice(i + 1).some(y => take.has(y) && y.names.some(n => x.names.includes(n)))) { take.add(x); grew = true; }
          });
        }
        for (const x of pending.filter(e => take.has(e))) x.apply(committed);
        pending.splice(0, pending.length, ...pending.filter(e => !take.has(e)));
      }
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
      if (splitRename && live.has(b)) pending.push({ ino, names: [b], apply: (ns) => ns.delete(b) });
      live.delete(a);
      live.set(b, ino);
      pending.push({ ino, names: [a, b], apply: (ns) => { ns.delete(a); ns.set(b, ino); } });
    },
    unlinkSync(p) {
      step();
      if (!live.has(p)) throw err('ENOENT', p);
      const ino = live.get(p);
      live.delete(p);
      pending.push({ ino, names: [p], apply: (ns) => ns.delete(p) });
    },
    statSync(p) {
      if (live.has(p)) return { isDirectory: () => false, mtimeMs: 0 }; // old: the daily copy is always due
      throw err('ENOENT', p);
    },
    crashAfter(n) { budget = n; },
    pendingCount() { return pending.length; },
    // What the next boot finds when the first `prefix` pending journal
    // entries made it to disk, written into a real folder for the real loader.
    rebootInto(dir, prefix) {
      const ns = new Map(committed);
      for (const e of pending.slice(0, prefix)) e.apply(ns);
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
// Generations, oldest first; defaults (nothing recovered) is 0.
const GEN = new Map([[JSON.stringify(OLDER), 1], [JSON.stringify(GOOD), 2], [JSON.stringify(NEWER), 3]]);
const rank = (o) => (o.data ? (GEN.get(JSON.stringify(o.data)) ?? -1) : 0);

// Crashes the save after 0, 1, 2 ... disk operations and, at each, boots the
// real loader on every journal prefix that can have reached the disk.
function crashAtEveryStep(save, initial, model = {}) {
  const outcomes = [];
  for (let k = 0; k < 60; k++) {
    const disk = crashDisk(initial, model);
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
    assert.ok(rank(o) >= 1, `${at(o)}: ${JSON.stringify(o.data)} is older than the .bak it started with`);
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

test('saveConfigFile on a real folder: new config in place, previous one in .bak, the daily copy, no temp files left', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  saveConfigFile(p, JSON.stringify(OLDER));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.daily.bak'], 'first save: nothing to roll to .bak');
  saveConfigFile(p, JSON.stringify(GOOD));
  const r = saveConfigFile(p, JSON.stringify(NEWER));
  assert.equal(r.backupError, null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak', 'config.json.daily.bak']);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')), GOOD);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.daily.bak`, 'utf8')), OLDER, 'rewritten once a day, not on every save');
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
  assert.equal(writeFileDurably('x', 'data', spy), 'flushed');
  assert.deepEqual(calls, ['open w', 'write 7', 'fsync 7', 'close 7']);
  calls.length = 0;
  const failing = { ...spy, writeFileSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } };
  assert.throws(() => writeFileDurably('x', 'data', failing), /ENOSPC/);
  assert.deepEqual(calls, ['open w', 'close 7']);
});

// A flush that fails never fails the write: every release before this one
// saved without flushing at all, and failing every save on such a volume
// would lose changes instead. The result says which kind it was.
const fsyncFails = (code) => ({
  openSync: () => 7, writeFileSync: () => {}, closeSync: () => {},
  fsyncSync: () => { throw Object.assign(new Error(code), { code }); },
});
test('writeFileDurably: a volume that cannot flush and a failed flush are reported, never thrown', () => {
  for (const code of ['EISDIR', 'EINVAL', 'ENOTSUP']) assert.equal(writeFileDurably('x', 'd', fsyncFails(code)), 'unsupported', code);
  for (const code of ['EIO', 'EPERM', 'ENOSPC', 'UNKNOWN']) assert.equal(writeFileDurably('x', 'd', fsyncFails(code)), 'failed', code);
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
for (const [name, initial] of Object.entries(START_STATES)) for (const commit of ['all', 'own']) {
  test(`saveConfigFile from ${name} (fsync commits ${commit === 'all' ? 'the whole journal' : 'only its own file'}): never worse than before mid-save, the new config once it returns`, () => {
    const before = loadConfigFromDisk(crashDisk(initial).rebootInto(tempDir(), 0), { sleep: noSleep, stamp: 'S' });
    const outcomes = crashAtEveryStep(newSave, initial, { commit });
    for (const o of outcomes) {
      assert.ok(rank(o) >= rank(before), `${at(o)}: ${o.status} ${JSON.stringify(o.data)} (before the save: ${before.status} ${JSON.stringify(before.data)})`);
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
  assert.equal(fs.existsSync(`${p}.tmp`), false, 'no temp file left behind');
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

// When the .bak cannot be written, nothing else commits the rename: the save
// flushes config.json itself either way.
test('saveConfigFile: with the .bak step failing, the new config still survives once it returns', () => {
  for (const commit of ['all', 'own']) {
    const outcomes = crashAtEveryStep(newSave, { [DISK_CONFIG]: JSON.stringify(GOOD), [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) },
      { commit, failOpen: (p) => p.endsWith('.bak.tmp') });
    const done = outcomes.filter(o => o.finished);
    assert.ok(done.length > 0);
    for (const o of done) assert.deepEqual(o.data, NEWER, `${commit}: ${at(o)}`);
    for (const o of outcomes) assert.ok(same(o.data, GOOD) || same(o.data, NEWER), `${commit}: ${at(o)}`);
  }
});

// A program holding config.json right after the rename (antivirus, a sync
// tool) must not turn a save that landed into an error.
test('saveConfigFile: a config.json it cannot reopen to flush is reported, and the save stands', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const held = { ...fs, openSync: (f, flags, ...rest) => {
    if (f === p && flags === 'r+') throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return fs.openSync(f, flags, ...rest);
  } };
  const r = saveConfigFile(p, JSON.stringify(NEWER), { fs: held });
  assert.equal(r.flushSkipped, true);
  assert.equal(r.backupError, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')), GOOD);
});

// A released build's unflushed save can still be in the journal when this
// build starts, and loading from the incident state (a zeroed config.json and
// a good .bak) deletes config.json before the first save. Load then save,
// crashing at every step of both.
test('load then save from the incident state: never older than the .bak, the new config once the save returns', () => {
  const initial = { [DISK_CONFIG]: '\0'.repeat(24099), [`${DISK_CONFIG}.bak`]: JSON.stringify(GOOD) };
  const loadThenSave = (p, json, disk) => {
    const r = loadConfigFromDisk(p, { fs: disk, sleep: noSleep, stamp: 'L' });
    assert.equal(r.status, 'recovered');
    saveConfigFile(p, json, { fs: disk });
  };
  for (const commit of ['all', 'own']) {
    const outcomes = crashAtEveryStep(loadThenSave, initial, { commit });
    for (const o of outcomes) assert.ok(rank(o) >= 2, `${commit}: ${at(o)}: ${o.status} ${JSON.stringify(o.data)}`);
    for (const o of outcomes.filter(x => x.finished)) assert.deepEqual(o.data, NEWER, `${commit}: ${at(o)}`);
  }
});

test('the daily copy is written on the first save and then at most once a day', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  const t0 = Date.parse('2026-09-28T12:00:00Z');
  saveConfigFile(p, JSON.stringify(OLDER), { now: t0 });
  const daily = `${p}.daily.bak`;
  const setAge = (hours) => fs.utimesSync(daily, new Date(t0 - hours * 3600000), new Date(t0 - hours * 3600000));
  setAge(23);
  saveConfigFile(p, JSON.stringify(GOOD), { now: t0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(daily, 'utf8')), OLDER, 'under a day old: left alone');
  setAge(25);
  saveConfigFile(p, JSON.stringify(NEWER), { now: t0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(daily, 'utf8')), NEWER, 'a day old: replaced with the new config');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak', 'config.json.daily.bak']);
});

// A drive that acknowledges flushes it has not done can lose config.json and
// .bak together, both rewritten within the last minute: the daily copy is old
// enough to be on disk.
test('with config.json and .bak both unusable, the daily copy is recovered', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, Buffer.alloc(24099));
  fs.writeFileSync(`${p}.bak`, Buffer.alloc(24099));
  fs.writeFileSync(`${p}.daily.bak`, JSON.stringify(OLDER));
  const logs = [];
  const r = loadConfigFromDisk(p, { sleep: noSleep, stamp: 'S', log: (t) => logs.push(t) });
  assert.equal(r.status, 'recovered');
  assert.equal(r.source, 'daily');
  assert.deepEqual(r.data, OLDER);
  assert.match(logs.join('\n'), /recovered your settings from the daily copy/);
  // .bak is still preferred when it is whole.
  fs.writeFileSync(`${p}.bak`, JSON.stringify(GOOD));
  assert.equal(loadConfigFromDisk(p, { sleep: noSleep, stamp: 'T' }).source, 'bak');
});

test('the daily copy never bypasses a locked or unpreserved config.json, and a locked daily copy locks', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  fs.writeFileSync(`${p}.daily.bak`, JSON.stringify(OLDER));
  assert.equal(loadConfigFromDisk(p, { fs: lockingFs([p]), sleep: noSleep }).status, 'locked', 'config.json locked');

  fs.writeFileSync(p, 'damaged');
  const noCopy = { ...fs, openSync: (f, flags, ...rest) => {
    if (String(f).includes('.corrupt-')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return fs.openSync(f, flags, ...rest);
  } };
  assert.equal(loadConfigFromDisk(p, { fs: noCopy, sleep: noSleep, stamp: 'U' }).status, 'locked', 'damaged and no copy made');

  const dir2 = tempDir();
  const p2 = path.join(dir2, 'config.json');
  fs.writeFileSync(`${p2}.daily.bak`, JSON.stringify(OLDER));
  assert.equal(loadConfigFromDisk(p2, { fs: lockingFs([`${p2}.daily.bak`]), sleep: noSleep }).status, 'locked', 'daily copy locked');
});

test('preserveDamaged deletes only a copy it made itself', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, 'damaged');
  fs.writeFileSync(`${p}.corrupt-S.json`, 'earlier copy');
  const emfile = { ...fs, openSync: () => { throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }); } };
  assert.equal(preserveDamaged(p, Buffer.from('damaged'), 'S', { fs: emfile, unlink: true }), null);
  assert.equal(fs.readFileSync(`${p}.corrupt-S.json`, 'utf8'), 'earlier copy');
  assert.equal(fs.readFileSync(p, 'utf8'), 'damaged');
});

test('a damaged config.json is kept when its copy could not be flushed, unless the volume cannot flush at all', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, 'damaged');
  const flushFails = (code) => ({ ...fs, fsyncSync: () => { throw Object.assign(new Error(code), { code }); } });
  assert.equal(preserveDamaged(p, Buffer.from('damaged'), 'A', { fs: flushFails('EIO'), unlink: true }), null);
  assert.equal(fs.readFileSync(p, 'utf8'), 'damaged', 'original kept');
  assert.equal(fs.readFileSync(`${p}.corrupt-A.json`, 'utf8'), 'damaged', 'the whole copy stays too');
  assert.ok(preserveDamaged(p, Buffer.from('damaged'), 'B', { fs: flushFails('EISDIR'), unlink: true }));
  assert.equal(fs.existsSync(p), false, 'a volume that cannot flush still recovers');
});

test('a save whose flush fails still lands, as every release saved, and says so', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const r = saveConfigFile(p, JSON.stringify(NEWER), { fs: { ...fs, fsyncSync: () => { throw Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }); } } });
  assert.equal(r.flushSkipped, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')), GOOD);
});

test('a config.json that cannot be read at save time is reported as a stale backup', () => {
  const dir = tempDir();
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(GOOD));
  const r = saveConfigFile(p, JSON.stringify(NEWER), { fs: lockingFs([p], { failFirst: 1 }) });
  assert.equal(r.backupError && r.backupError.code, 'EBUSY');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), NEWER);
});

test('replaceFileDurably: the old file stays whole and no temp file is left when the rename fails', () => {
  const dir = tempDir();
  const p = path.join(dir, 'export.json');
  fs.writeFileSync(p, 'previous backup');
  const busy = { ...fs, renameSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
  assert.throws(() => replaceFileDurably(p, 'new backup', busy), /EPERM/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'previous backup');
  assert.deepEqual(fs.readdirSync(dir), ['export.json']);
  assert.equal(replaceFileDurably(p, 'new backup'), true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'new backup');
});

// On FAT32/exFAT a crash can land after the old config.json is removed and
// before the new one is renamed into place: .bak must already hold the
// previous config by then, so it is rolled first.
test('on a volume without a journal, a save never boots older than before', () => {
  for (const commit of ['all', 'own']) {
    const outcomes = crashAtEveryStep(newSave, { [DISK_CONFIG]: JSON.stringify(GOOD), [`${DISK_CONFIG}.bak`]: JSON.stringify(OLDER) },
      { commit, splitRename: true });
    assert.ok(outcomes.some(o => o.status === 'recovered'), `${commit}: the split rename was reached`);
    for (const o of outcomes) assert.ok(rank(o) >= 2, `${commit}: ${at(o)}: ${o.status} ${JSON.stringify(o.data)}`);
    for (const o of outcomes.filter(x => x.finished)) assert.deepEqual(o.data, NEWER, `${commit}: ${at(o)}`);
  }
});
