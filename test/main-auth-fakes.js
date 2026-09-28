// Fakes for the account/login tests: a manual clock, and a BrowserWindow /
// webContents pair whose loadURL and executeJavaScript the test settles by
// hand. Not a test file itself (no .test.js suffix).
const { EventEmitter } = require('events');

// Timers that only fire when the test advances the clock. advance() lets the
// promise chains between timers run, so async code steps forward naturally.
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    get now() { return now; },
    pending() { return timers.size; },
    flush,
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

// A deferred the test resolves or rejects later.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createFakeWindow() {
  const contents = new EventEmitter();
  const state = { destroyed: false, loads: [], scripts: [] };
  contents.isDestroyed = () => state.destroyed;
  contents.loadURL = undefined;
  contents.executeJavaScript = (script) => {
    const d = deferred();
    state.scripts.push({ script, ...d });
    return d.promise;
  };
  const win = {
    webContents: contents,
    isDestroyed: () => state.destroyed,
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      contents.emit('destroyed');
      // As in Electron: a pending load fails once its window is gone.
      for (const l of state.loads) l.reject(new Error('ERR_FAILED (-2) loading'));
    },
    loadURL(url, options) {
      const d = deferred();
      state.loads.push({ url, options, ...d });
      return d.promise;
    },
  };
  return { win, contents, state };
}

module.exports = { createClock, deferred, createFakeWindow };
