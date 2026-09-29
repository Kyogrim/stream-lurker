// Reads config.json (falling back to config.json.bak) and decides what
// loadConfig may do with the result, and writes it so that a crash always
// leaves a whole config on disk (saveConfigFile). Tested against real temp directories and
// a simulated crash in test/main-config-store.test.js.
//
// Why: every read error used to look like "no config yet". With config.json
// and .bak briefly locked by a backup, sync or antivirus tool, or AppData
// redirected to a share that was not reachable yet, the app started from
// defaults, and the next saves rolled the user's watch history out of both
// files. Only a file that is genuinely absent may be replaced by defaults;
// anything that exists but cannot be read must never be written over.

const fs = require('fs');
const path = require('path');

const READ_ATTEMPTS = 5;
const READ_RETRY_DELAY_MS = 200;

// loadConfig runs synchronously during startup, so a blocking wait is fine and
// keeps it synchronous.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// { status: 'ok', data, raw } | { status: 'missing' } |
// { status: 'ioerror', err } | { status: 'corrupt', raw }
// 'corrupt' means the bytes were read and are not a JSON object.
function readConfigFileResult(filePath, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'ioerror', err };
  }
  try {
    const data = JSON.parse(raw.toString('utf8'));
    return isPlainObject(data) ? { status: 'ok', data, raw } : { status: 'corrupt', raw };
  } catch (e) {
    return { status: 'corrupt', raw };
  }
}

// A lock held by another program usually clears within a second.
function readConfigWithRetry(filePath, { fs: fsImpl = fs, attempts = READ_ATTEMPTS, delayMs = READ_RETRY_DELAY_MS, sleep = sleepSync } = {}) {
  let result = readConfigFileResult(filePath, fsImpl);
  for (let i = 1; i < attempts && result.status === 'ioerror'; i++) {
    sleep(delayMs);
    result = readConfigFileResult(filePath, fsImpl);
  }
  return result;
}

// A missing config.json only means "fresh install" when its folder is really
// there: an unreachable redirected AppData also reports ENOENT. Electron has
// normally created the folder by now; if not, creating it proves the parent
// is reachable.
function isDirReachable(dir, fsImpl = fs) {
  try {
    return fsImpl.statSync(dir).isDirectory();
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return false;
  }
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    return fsImpl.statSync(dir).isDirectory();
  } catch (e) {
    return false;
  }
}

// Given how config.json and .bak read, where the config comes from.
// source: 'main' | 'backup' | 'defaults' | null (null: writes must stay off).
function decideConfigSource({ main, backup, salvaged, dirReachable }) {
  if (main === 'ok') return { source: 'main' };
  if (backup === 'ok') return { source: 'backup' };
  if (main === 'ioerror') return { source: null, reason: 'config.json exists but could not be read' };
  if (backup === 'ioerror') return { source: null, reason: 'config.json.bak exists but could not be read' };
  if (main === 'corrupt' && !salvaged) return { source: null, reason: 'config.json is damaged and a copy of it could not be preserved' };
  if (main === 'missing' && !dirReachable) return { source: null, reason: 'the settings folder is not reachable' };
  return { source: 'defaults' };
}

// Keeps the bytes that were read as <file>.corrupt-<stamp>.json. The bytes
// from the first read are reused rather than reading the file again. The copy
// is flushed before the damaged config.json is moved out of the way (so
// saveConfig cannot roll it over a good .bak): once the original is gone, the
// copy is the only one left. Returns the salvage path, or null.
function preserveDamaged(filePath, raw, stamp, { fs: fsImpl = fs, unlink = false } = {}) {
  const salvagePath = `${filePath}.corrupt-${stamp}.json`;
  try {
    writeFileDurably(salvagePath, raw, fsImpl, 'wx');
  } catch (e) {
    // 'wx' created the file unless it already existed: never leave half a copy.
    if (!e || e.code !== 'EEXIST') {
      try { fsImpl.unlinkSync(salvagePath); } catch (e2) { /* never created */ }
    }
    return null;
  }
  if (unlink) {
    try { fsImpl.unlinkSync(filePath); } catch (e) { /* the copy is what matters */ }
  }
  return salvagePath;
}

// Writes data and forces it to disk before returning. NTFS journals a rename
// but not the data behind it: after an unexpected shutdown, a file renamed
// into place moments earlier can come back at the right size and all zeros.
// A real config.json was lost that way (24,099 zero bytes after a crash), and
// the .bak copied next to it without a flush is exposed to the same thing.
// A volume that cannot flush at all (some network shares; Node reports it as
// EISDIR, EINVAL or ENOTSUP) still gets the write: failing every save there
// would be worse than saving unflushed, as every release before this did.
// Returns false in that case, so the caller can say so once.
const FLUSH_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'ENOTSUP']);
function flushFd(fd, fsImpl) {
  try {
    fsImpl.fsyncSync(fd);
    return true;
  } catch (e) {
    if (!e || !FLUSH_UNSUPPORTED.has(e.code)) throw e;
    return false;
  }
}
function writeFileDurably(filePath, data, fsImpl = fs, flags = 'w') {
  const fd = fsImpl.openSync(filePath, flags);
  try {
    fsImpl.writeFileSync(fd, data);
    return flushFd(fd, fsImpl);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// Flushes a file that is already written, without changing it ('r+': write
// access, which Windows needs to flush, but no truncation).
function flushExisting(filePath, fsImpl = fs) {
  const fd = fsImpl.openSync(filePath, 'r+');
  try {
    return flushFd(fd, fsImpl);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// POSIX needs the directory flushed for a rename to survive a crash. On
// Windows the directory opens but flushing it fails (EPERM), which is
// ignored: NTFS journals the rename, and a crash before the journal reaches
// the disk costs at most that one save.
function syncDir(dir, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(fd);
  } catch (e) {
    /* not supported here */
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch (e) { /* closed */ } }
  }
}

// Saves config.json so that a crash at any moment leaves a whole config on
// disk for loadConfigFromDisk, even when the config.json already there was
// never flushed (every release up to v0.14.0-beta saved without flushing, so
// the first save after an update starts from exactly that):
//   1. the current config.json is read, and kept only if it reads as a
//      config (a damaged file never replaces a good backup);
//   2. the new config goes to .tmp, is flushed and renamed over config.json,
//      and config.json is flushed again: that commits the rename itself (a
//      directory cannot be flushed on Windows), so from here the new config
//      is whole on disk under its own name;
//   3. the bytes from step 1 go to .bak.tmp, are flushed and renamed over
//      .bak. The old .bak is never truncated, so it stays whole until the
//      new one is.
// Once it returns, the new config survives a crash.
// Returns { backupError, flushSkipped }: backupError when only step 3 failed
// (the save itself worked); flushSkipped when something could not be flushed
// (a volume that cannot flush, or config.json held open by another program
// right after the rename: the new config is in place, only not yet forced to
// disk). Throws when the new config could not be written or renamed; the
// caller logs it.
function saveConfigFile(configPath, json, { fs: fsImpl = fs } = {}) {
  const current = readConfigFileResult(configPath, fsImpl);
  const tmpPath = `${configPath}.tmp`;
  let flushed = writeFileDurably(tmpPath, json, fsImpl);
  fsImpl.renameSync(tmpPath, configPath);
  try {
    flushed = flushExisting(configPath, fsImpl) && flushed;
  } catch (e) {
    flushed = false;
  }
  let backupError = null;
  if (current.status === 'ok') {
    const bakTmp = `${configPath}.bak.tmp`;
    try {
      flushed = writeFileDurably(bakTmp, current.raw, fsImpl) && flushed;
      fsImpl.renameSync(bakTmp, `${configPath}.bak`);
    } catch (e) {
      backupError = e;
    }
  }
  syncDir(path.dirname(configPath), fsImpl);
  return { backupError, flushSkipped: !flushed };
}

// Everything loadConfig needs to know, without touching the app's state.
// Returns { status, data?, reason?, error? }:
//   'loaded'    config.json read fine
//   'recovered' config.json unusable, .bak read fine
//   'defaults'  nothing on disk: a fresh install (or both files damaged and
//               preserved), so starting from defaults loses nothing
//   'locked'    something exists that could not be read: run on defaults in
//               memory and never write
function loadConfigFromDisk(configPath, opts = {}) {
  const fsImpl = opts.fs || fs;
  const log = opts.log || (() => {});
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const readOpts = { fs: fsImpl, attempts: opts.attempts, delayMs: opts.delayMs, sleep: opts.sleep };
  const backupPath = `${configPath}.bak`;

  const main = readConfigWithRetry(configPath, readOpts);
  if (main.status === 'ok') return { status: 'loaded', data: main.data };

  let salvaged = null;
  if (main.status === 'corrupt') {
    salvaged = preserveDamaged(configPath, main.raw, stamp, { fs: fsImpl, unlink: true });
    log(salvaged
      ? `[Config] config.json was unreadable — preserved a copy as ${path.basename(salvaged)}.`
      : '[Config] config.json was unreadable and a copy could not be preserved.');
  } else if (main.status === 'ioerror') {
    log(`[Config] config.json could not be read (${main.err && (main.err.code || main.err.message)}).`);
  }

  const backup = readConfigWithRetry(backupPath, readOpts);
  if (backup.status === 'ok') return { status: 'recovered', data: backup.data, from: main.status };
  if (backup.status === 'corrupt') {
    const kept = preserveDamaged(backupPath, backup.raw, stamp, { fs: fsImpl });
    if (kept) log(`[Config] config.json.bak was unreadable too — preserved a copy as ${path.basename(kept)}.`);
  }

  const dirReachable = main.status === 'missing' ? isDirReachable(path.dirname(configPath), fsImpl) : true;
  const decision = decideConfigSource({ main: main.status, backup: backup.status, salvaged: !!salvaged, dirReachable });
  if (decision.source === 'defaults') return { status: 'defaults' };
  const err = main.err || backup.err;
  return { status: 'locked', reason: decision.reason, error: err ? (err.code || err.message) : undefined };
}

module.exports = {
  READ_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  sleepSync,
  readConfigFileResult,
  readConfigWithRetry,
  isDirReachable,
  decideConfigSource,
  preserveDamaged,
  loadConfigFromDisk,
  writeFileDurably,
  saveConfigFile,
};
