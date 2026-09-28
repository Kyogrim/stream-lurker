// Logging helpers for the main process. Tested in test/main-app-log.test.js.

const fs = require('fs');
const path = require('path');

const ERROR_LOG_MAX_BYTES = 1024 * 1024;
// One entry (an error can carry a whole response body in its message).
const ERROR_ENTRY_MAX_CHARS = 16 * 1024;
const REPEAT_WINDOW_MS = 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 20;

function describeError(err) {
  try {
    if (err && err.stack) return String(err.stack);
    if (err && typeof err === 'object' && err.message) return String(err.message);
    return String(err);
  } catch (e) {
    return '[an error that could not be printed]';
  }
}

// Appends one line, rotating to <file>.1 past maxBytes so the file can never
// grow without bound on a machine that runs for weeks.
function appendCapped(filePath, line, maxBytes, fsImpl) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  let size = 0;
  try { size = fsImpl.statSync(filePath).size; } catch (e) { /* not there yet */ }
  if (size + Buffer.byteLength(line) > maxBytes) {
    try { fsImpl.renameSync(filePath, `${filePath}.1`); } catch (e) { /* keep appending */ }
  }
  fsImpl.appendFileSync(filePath, line, 'utf8');
}

// The process-wide 'uncaughtException' / 'unhandledRejection' sink.
//
// Why: with no listener, Electron answers a stray main-process error with a
// modal error box. While it is open no timer, IPC or tray click runs, so an
// unattended lurker stopped scanning and saving until someone found and
// dismissed it. Any listener suppresses that box; this one records the error
// and lets the app keep running.
//
// report() must never throw: a throw inside an 'uncaughtException' listener
// kills the process. addLog can throw during window teardown, so every step is
// guarded. A recurring error (every scan, or a tight timer) is logged once per
// window with a repeat count, and at most MAX_REPORTS_PER_WINDOW distinct
// errors per window, so it cannot flood the 200-line activity log or the disk.
function createFatalReporter({
  log = () => {},
  filePath = null, // string or () => string; null disables the file
  fs: fsImpl = fs,
  now = Date.now,
  consoleError = (...a) => console.error(...a),
  windowMs = REPEAT_WINDOW_MS,
  maxPerWindow = MAX_REPORTS_PER_WINDOW,
  maxBytes = ERROR_LOG_MAX_BYTES,
} = {}) {
  const seen = new Map(); // signature -> { at, repeats }
  let windowStart = -Infinity;
  let windowCount = 0;
  let dropped = 0;

  function write(text, t) {
    try { consoleError(text); } catch (e) { /* nothing else to do */ }
    try {
      // The activity log is a one-glance view; the file keeps the whole stack.
      log(text.split('\n').slice(0, 4).join('\n'));
    } catch (e) { /* window torn down */ }
    try {
      const file = typeof filePath === 'function' ? filePath() : filePath;
      const entry = text.length > ERROR_ENTRY_MAX_CHARS ? `${text.slice(0, ERROR_ENTRY_MAX_CHARS)} [truncated]` : text;
      if (file) appendCapped(file, `${new Date(t).toISOString()} ${entry}\n`, maxBytes, fsImpl);
    } catch (e) { /* disk full, read-only profile */ }
  }

  return function report(origin, err) {
    try {
      const t = now();
      const text = describeError(err);
      const signature = `${origin}|${text.split('\n')[0].slice(0, 300)}`;

      const prev = seen.get(signature);
      if (prev && t - prev.at < windowMs) {
        prev.repeats += 1;
        return;
      }

      if (t - windowStart >= windowMs) {
        windowStart = t;
        windowCount = 0;
      }
      if (windowCount >= maxPerWindow) {
        dropped += 1;
        return;
      }
      windowCount += 1;

      if (seen.size > 200) {
        for (const [k, v] of seen) if (t - v.at >= windowMs) seen.delete(k);
      }
      seen.set(signature, { at: t, repeats: 0 });

      let note = '';
      if (prev && prev.repeats) note += ` (it also happened ${prev.repeats} more time${prev.repeats === 1 ? '' : 's'} in the last minute)`;
      if (dropped) {
        note += ` (${dropped} other error${dropped === 1 ? ' was' : 's were'} not logged: too many at once)`;
        dropped = 0;
      }
      write(`[Main error] ${origin}${note}: ${text}`, t);
    } catch (e) { /* never throw from here */ }
  };
}

// One console line from a page. Electron 35+ puts the details on the event
// (level is now 'info' | 'warning' | 'error' | 'debug'); the old positional
// arguments are deprecated and trigger a warning when the listener declares
// them.
function formatConsoleMessage(label, event) {
  const e = event || {};
  return `[Console - ${label}] [${e.level}] ${e.message} at ${e.sourceId}:${e.lineNumber}`;
}

module.exports = {
  ERROR_LOG_MAX_BYTES,
  ERROR_ENTRY_MAX_CHARS,
  REPEAT_WINDOW_MS,
  MAX_REPORTS_PER_WINDOW,
  describeError,
  appendCapped,
  createFatalReporter,
  formatConsoleMessage,
};
