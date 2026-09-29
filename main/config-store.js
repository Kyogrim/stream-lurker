// Reads config.json (falling back to config.json.bak, then the daily copies)
// and decides what loadConfig may do with the result, and writes it so that a
// crash always leaves a whole config on disk (saveConfigFile). Tested against
// real temp directories and a simulated crash in test/main-config-store.test.js.
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
// copy is the only one left. Returns the salvage path, or null when no whole
// copy could be written, and the original then stays where it is.
function preserveDamaged(filePath, raw, stamp, { fs: fsImpl = fs, unlink = false } = {}) {
  const salvagePath = `${filePath}.corrupt-${stamp}.json`;
  let fd;
  try {
    fd = fsImpl.openSync(salvagePath, 'wx');
  } catch (e) {
    return null; // created nothing, so an earlier copy of that name stays as it is
  }
  try {
    fsImpl.writeFileSync(fd, raw);
    // Flushed where the volume allows. Where it fails, the copy is as safe as
    // any other write there, and keeping the damaged original back instead
    // would leave the app unable to start saving again on such a volume.
    flushFd(fd, fsImpl);
  } catch (e) {
    try { fsImpl.closeSync(fd); } catch (e2) { /* closed */ }
    try { fsImpl.unlinkSync(salvagePath); } catch (e2) { /* gone */ } // our own half copy
    return null;
  }
  fsImpl.closeSync(fd);
  if (unlink) {
    try { fsImpl.unlinkSync(filePath); } catch (e) { /* the copy is what matters */ }
  }
  return salvagePath;
}

// Forces a file's data to disk. NTFS journals a rename but not the data
// behind it: after an unexpected shutdown, a file renamed into place moments
// earlier can come back at the right size and all zeros. A real config.json
// was lost that way (24,099 zero bytes after a crash), with the .bak copied
// beside it.
// Returns 'flushed', 'unsupported' (a volume that cannot flush, such as some
// network shares; Node reports EISDIR, EINVAL or ENOTSUP) or 'failed' (any
// other error). Never throws: a save whose flush fails still happens, as every
// release before this one saved, and the caller says so once. Failing every
// save there would lose changes instead.
const FLUSH_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'ENOTSUP']);
function flushFd(fd, fsImpl) {
  try {
    fsImpl.fsyncSync(fd);
    return 'flushed';
  } catch (e) {
    return e && FLUSH_UNSUPPORTED.has(e.code) ? 'unsupported' : 'failed';
  }
}

// Writes data and flushes it. Returns flushFd's result; throws only when the
// file cannot be opened or written.
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

// Replaces a file without ever truncating it in place: <file>.tmp, flush,
// rename, then flush the file again, which commits the rename too (a
// directory cannot be flushed on Windows). A crash leaves the old file or the
// new one, never neither. Returns true when everything reached the disk;
// throws when the new file could not be written or renamed (the old one is
// then untouched and no .tmp is left behind).
function replaceFileDurably(filePath, data, fsImpl = fs) {
  const tmp = `${filePath}.tmp`;
  let flushed;
  try {
    flushed = writeFileDurably(tmp, data, fsImpl) === 'flushed';
    fsImpl.renameSync(tmp, filePath);
  } catch (e) {
    try { fsImpl.unlinkSync(tmp); } catch (e2) { /* never created */ }
    throw e;
  }
  try {
    flushed = flushExisting(filePath, fsImpl) === 'flushed' && flushed;
  } catch (e) {
    flushed = false; // held open by another program right after the rename
  }
  return flushed;
}

// POSIX needs the directory flushed for a rename to survive a crash. On
// Windows the directory opens but flushing it fails (EPERM), which is
// ignored: there replaceFileDurably's second flush commits the rename.
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

const DAILY_MS = 24 * 60 * 60 * 1000;
// Due when there is none, when it is a day old, or when it is dated in the
// future (the clock was set forward once): otherwise it would stay frozen
// until the real date caught up.
function dailyIsDue(dailyPath, now, fsImpl) {
  let age;
  try {
    age = now - fsImpl.statSync(dailyPath).mtimeMs;
  } catch (e) {
    return true; // none yet
  }
  return !(age >= 0 && age < DAILY_MS);
}

// Saves config.json so that a crash at any moment leaves at least what was
// on disk before (a config.json an older release wrote and never flushed
// included), and once it returns the new config survives a crash:
//   1. the previous config: `previous`, the JSON the caller last saved, or
//      else config.json as read now, and only if it reads as a config (a
//      damaged file never replaces a good backup);
//   2. it replaces .bak. First, so that a volume without a journal (FAT32,
//      exFAT), where a crash can land between config.json being removed and
//      the new one renamed into place, still finds the previous config;
//   3. the new config replaces config.json;
//   4. at most once a day it also becomes config.json.daily.bak, the one it
//      replaces moving to config.json.daily.prev.bak first. config.json and
//      .bak are rewritten on every save, so on a drive that acknowledges
//      flushes it has not done, both can be lost together, as they were in
//      the incident. The daily copies are older: on the save that refreshes
//      .daily.bak, .daily.prev.bak still holds one a day old, moved by a
//      rename, which rewrites no data.
// Every replace is replaceFileDurably, so no file is truncated in place.
// Returns { backupError, flushSkipped }: backupError when a backup copy could
// not be written, or config.json could not be read to make one (the save
// itself worked); flushSkipped when something was saved without being forced
// to disk. Throws when the new config could not be written or renamed; the
// caller logs it.
function saveConfigFile(configPath, json, { fs: fsImpl = fs, now = Date.now(), previous = null } = {}) {
  const current = typeof previous === 'string'
    ? { status: 'ok', raw: Buffer.from(previous) }
    : readConfigFileResult(configPath, fsImpl);
  let flushed = true;
  let backupError = current.status === 'ioerror' ? current.err : null;
  if (current.status === 'ok') {
    try {
      flushed = replaceFileDurably(`${configPath}.bak`, current.raw, fsImpl) && flushed;
    } catch (e) {
      backupError = e;
    }
  }
  flushed = replaceFileDurably(configPath, json, fsImpl) && flushed;
  const dailyPath = `${configPath}.daily.bak`;
  if (dailyIsDue(dailyPath, now, fsImpl)) {
    try {
      if (readConfigFileResult(dailyPath, fsImpl).status === 'ok') fsImpl.renameSync(dailyPath, `${configPath}.daily.prev.bak`);
      flushed = replaceFileDurably(dailyPath, json, fsImpl) && flushed;
    } catch (e) {
      backupError = backupError || e;
    }
  }
  syncDir(path.dirname(configPath), fsImpl);
  return { backupError, flushSkipped: !flushed };
}

// Everything loadConfig needs to know, without touching the app's state.
// Returns { status, data?, source?, reason?, error? }:
//   'loaded'    config.json read fine
//   'recovered' config.json unusable; source says what was read instead:
//               'bak', or 'daily' / 'daily.prev' when .bak was unusable too
//   'defaults'  nothing on disk: a fresh install (or every copy damaged and
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
  if (backup.status === 'ok') return { status: 'recovered', data: backup.data, from: main.status, source: 'bak' };
  if (backup.status === 'corrupt') {
    const kept = preserveDamaged(backupPath, backup.raw, stamp, { fs: fsImpl });
    if (kept) log(`[Config] config.json.bak was unreadable too — preserved a copy as ${path.basename(kept)}.`);
  }

  const dirReachable = main.status === 'missing' ? isDirReachable(path.dirname(configPath), fsImpl) : true;
  const decision = decideConfigSource({ main: main.status, backup: backup.status, salvaged: !!salvaged, dirReachable });
  if (decision.source === 'defaults') {
    // Only where defaults would load anyway, so a file that is locked, or
    // damaged without a copy, is never bypassed. Newer daily copy first.
    for (const [name, source] of [['daily.bak', 'daily'], ['daily.prev.bak', 'daily.prev']]) {
      const copyPath = `${configPath}.${name}`;
      const copy = readConfigWithRetry(copyPath, readOpts);
      if (copy.status === 'ok') return { status: 'recovered', data: copy.data, from: main.status, source };
      if (copy.status === 'ioerror') {
        return { status: 'locked', reason: `config.json.${name} exists but could not be read`, error: copy.err && (copy.err.code || copy.err.message) };
      }
      if (copy.status === 'corrupt') preserveDamaged(copyPath, copy.raw, stamp, { fs: fsImpl });
    }
    return { status: 'defaults' };
  }
  const err = main.err || backup.err;
  return { status: 'locked', reason: decision.reason, error: err ? (err.code || err.message) : undefined };
}

module.exports = {
  READ_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  DAILY_MS,
  sleepSync,
  readConfigFileResult,
  readConfigWithRetry,
  isDirReachable,
  decideConfigSource,
  preserveDamaged,
  loadConfigFromDisk,
  writeFileDurably,
  replaceFileDurably,
  saveConfigFile,
};
