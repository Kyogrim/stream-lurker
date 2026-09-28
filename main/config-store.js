// Reads config.json (falling back to config.json.bak) and decides what
// loadConfig may do with the result. Tested against real temp directories in
// test/main-config-store.test.js.
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
// from the first read are reused rather than reading the file again. The
// damaged config.json is then moved out of the way, so saveConfig cannot
// roll it over a good .bak. Returns the salvage path, or null.
function preserveDamaged(filePath, raw, stamp, { fs: fsImpl = fs, unlink = false } = {}) {
  const salvagePath = `${filePath}.corrupt-${stamp}.json`;
  try {
    fsImpl.writeFileSync(salvagePath, raw, { flag: 'wx' });
  } catch (e) {
    return null;
  }
  if (unlink) {
    try { fsImpl.unlinkSync(filePath); } catch (e) { /* the copy is what matters */ }
  }
  return salvagePath;
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
};
