// Ends a stream page that has stopped responding. A <webview> guest whose
// renderer hangs (a page script stuck in a loop, a wedged player) shows a
// frozen frame for as long as the app runs: the dashboard can see a crash or
// a failed load (C6) but not a hang (F15). Chromium tells main instead, with
// 'unresponsive' once its own hang timer runs out (it runs while the page owes
// an answer, such as to input) and 'responsive' if the page recovers. A page
// that stays hung for another `graceMs` has its renderer crashed on purpose,
// which the dashboard then recovers like any other crash, with its reload
// cap. Tested with a fake webContents in test/main-hang-watch.test.js.

const HANG_GRACE_MS = 60 * 1000;

// contents: a webContents (on/isDestroyed/isCrashed/forcefullyCrashRenderer/getURL).
// onKill(url): told once the renderer is crashed, for the log.
function watchForHang(contents, { graceMs = HANG_GRACE_MS, onKill = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const cancel = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  contents.on('unresponsive', () => {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      try {
        if (contents.isDestroyed() || contents.isCrashed()) return;
        const url = contents.getURL();
        contents.forcefullyCrashRenderer();
        onKill(url);
      } catch (e) { /* closed in the meantime */ }
    }, graceMs);
  });
  contents.on('responsive', cancel);
  contents.on('render-process-gone', cancel);
  contents.on('destroyed', cancel);
  return { cancel };
}

module.exports = { HANG_GRACE_MS, watchForHang };
