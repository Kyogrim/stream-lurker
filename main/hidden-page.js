// Bounded page scripts. Electron's webContents.executeJavaScript only settles
// when the page replies: it waits with no timeout for the page to stop loading,
// and a renderer that crashes, or a document that navigates away while the
// script awaits, never replies at all. Destroying the window does not reject
// it either. So every deadline here sits OUTSIDE executeJavaScript and settles
// the caller's promise itself. Tested in test/main-hidden-page.test.js.

const HIDDEN_PAGE_DEADLINE_MS = 45000; // load + settle + script; 30 s was tight on a slow network

const defaultTimers = { setTimeout, clearTimeout };

// did-start-navigation passes a details object on current Electron and the
// positional (url, isInPlace, isMainFrame) arguments on older ones.
function isCrossDocumentMainFrameNavigation(details, legacyInPlace, legacyIsMainFrame) {
  const d = details && typeof details === 'object' ? details : {};
  const isMainFrame = typeof d.isMainFrame === 'boolean' ? d.isMainFrame : !!legacyIsMainFrame;
  const sameDocument = typeof d.isSameDocument === 'boolean' ? d.isSameDocument : !!legacyInPlace;
  return isMainFrame && !sameDocument;
}

// Loads url in win, waits settleMs, evaluates script, and destroys win. Always
// resolves, by deadlineMs at the latest: the script's value, or null if the
// load failed, the renderer died or hung, the document was replaced while the
// script ran (a Cloudflare/Kasada reload, a redirect), or time ran out.
// A navigation during the settle is fine: executeJavaScript runs in whatever
// document is there once loading stops.
function runPageScript(win, {
  url, script, settleMs = 5000, deadlineMs = HIDDEN_PAGE_DEADLINE_MS, loadOptions, timers = defaultTimers,
}) {
  const contents = win.webContents;
  return new Promise((resolve) => {
    let done = false;
    let scriptStarted = false;
    let deadline = null;
    let settleTimer = null;
    const listeners = [];
    const listen = (event, fn) => {
      contents.on(event, fn);
      listeners.push([event, fn]);
    };

    function finish(value) {
      if (done) return;
      done = true;
      timers.clearTimeout(deadline);
      timers.clearTimeout(settleTimer);
      for (const [event, fn] of listeners) {
        try { contents.removeListener(event, fn); } catch (e) { /* already gone */ }
      }
      // Destroying the window is the actual cleanup; it frees the renderer
      // whichever side won.
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) { /* already gone */ }
      resolve(value);
    }

    deadline = timers.setTimeout(() => finish(null), deadlineMs);
    listen('render-process-gone', () => finish(null));
    listen('unresponsive', () => finish(null));
    listen('did-start-navigation', (details, legacyUrl, legacyInPlace, legacyIsMainFrame) => {
      if (scriptStarted && isCrossDocumentMainFrameNavigation(details, legacyInPlace, legacyIsMainFrame)) finish(null);
    });

    (async () => {
      await win.loadURL(url, loadOptions);
      if (done) return null;
      await new Promise((r) => { settleTimer = timers.setTimeout(r, settleMs); });
      if (done) return null;
      scriptStarted = true;
      return contents.executeJavaScript(script);
    })().then(
      (value) => finish(value === undefined ? null : value),
      // loadURL rejects once the window is destroyed under it; nothing to report.
      () => finish(null),
    );
  });
}

// executeJavaScript on a page the user is looking at (the login modal), bounded
// the same way: rejects on timeout, on the page closing, or on its renderer
// dying, and removes its listeners either way.
function runScriptWithin(contents, script, timeoutMs, timers = defaultTimers) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const onGone = () => settle(reject, Object.assign(new Error('page closed or crashed'), { code: 'EGONE' }));
    function settle(fn, value) {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      try {
        contents.removeListener('destroyed', onGone);
        contents.removeListener('render-process-gone', onGone);
      } catch (e) { /* already gone */ }
      fn(value);
    }
    try {
      if (contents.isDestroyed()) { onGone(); return; }
      contents.once('destroyed', onGone);
      contents.once('render-process-gone', onGone);
    } catch (e) {
      settle(reject, e);
      return;
    }
    timer = timers.setTimeout(() => {
      settle(reject, Object.assign(new Error(`page script timed out after ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    let pending;
    try {
      pending = contents.executeJavaScript(script);
    } catch (e) {
      settle(reject, e);
      return;
    }
    Promise.resolve(pending).then((v) => settle(resolve, v), (e) => settle(reject, e));
  });
}

// At most one background probe of a page at a time. run() joins the probe in
// flight (a health check needs no second window); fresh() always loads the page
// again, because an import that just wrote new cookies must not be handed the
// answer of a page that loaded with the old ones. A fresh probe becomes the one
// later run() calls join.
function createProbeGate(task) {
  let current = null;
  function start() {
    const p = Promise.resolve().then(task);
    current = p;
    const clear = () => { if (current === p) current = null; };
    p.then(clear, clear);
    return p;
  }
  return {
    run: () => current || start(),
    fresh: () => start(),
    get running() { return current !== null; },
  };
}

// Waits for `promise` at most budgetMs, for a caller that must answer someone
// sooner than a probe page can take: the browser extension gives up on an
// automatic import after 25 s, a probe may run for HIDDEN_PAGE_DEADLINE_MS.
// Resolves { settled: true, value } when it settled in time (a rejection reads
// as value null, a failed probe), else { settled: false }, leaving `promise`
// running for the caller to finish with later.
function settleWithin(promise, budgetMs, timers = defaultTimers) {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve({ settled: false }), budgetMs);
    const done = (value) => {
      timers.clearTimeout(timer);
      resolve({ settled: true, value });
    };
    Promise.resolve(promise).then(done, () => done(null));
  });
}

module.exports = {
  HIDDEN_PAGE_DEADLINE_MS,
  isCrossDocumentMainFrameNavigation,
  runPageScript,
  runScriptWithin,
  createProbeGate,
  settleWithin,
};
