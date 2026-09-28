// The Connect-account modal's lifecycle: poll for a sign-in, claim it once,
// read the account name, save once, and resolve the IPC call exactly once
// whatever happens (the user closes the window, the page hangs, a script
// throws, time runs out). Tested in test/main-login-flow.test.js.
//
// It used to be a setInterval whose ticks overlapped (the Kick check can take
// longer than the period) and one `resolved` flag doing two jobs, so a failure
// after detection left the Connect button on "Connecting..." until restart and
// a second tick could save and announce the same login twice.

const defaultTimers = { setTimeout, clearTimeout };

// detect():       one poll; resolves to a truthy hit when signed in (it may
//                 carry { name }), falsy otherwise. A throw counts as falsy.
// extractName(h): the account name for a hit, or null.
// commit(name):   save + announce; runs at most once, never after settling.
// fallbackName(): the name to save when extraction gave none or never finished.
// closeWindow():  must be safe on a window that is already gone.
// onSettled(r):   receives { success, username } or { success: false, error }.
function createLoginFlow({
  detect, extractName, commit, fallbackName, closeWindow, onSettled,
  log = () => {},
  pollMs = 1500,
  deadlineMs = 5 * 60 * 1000,
  extractDeadlineMs = 60000,
  timers = defaultTimers,
}) {
  let settled = false;
  let detected = false;
  let pollTimer = null;
  let deadlineTimer = null;

  function finish(result) {
    if (settled) return;
    settled = true;
    timers.clearTimeout(pollTimer);
    timers.clearTimeout(deadlineTimer);
    try { closeWindow(); } catch (e) { /* already gone */ }
    onSettled(result);
  }

  // Detection proved a session, so the login happened: save it even when the
  // name never arrives, with the fallback name the background checks improve.
  function complete(name) {
    if (settled) return;
    const username = name || fallbackName();
    try {
      commit(username);
    } catch (e) {
      log(`saving the login failed: ${e && e.message ? e.message : e}`);
    }
    finish({ success: true, username });
  }

  function schedule() {
    if (settled || detected) return;
    pollTimer = timers.setTimeout(poll, pollMs);
  }

  // One poll at a time: the next is scheduled only after this one finishes.
  async function poll() {
    pollTimer = null;
    if (settled || detected) return;
    let hit = null;
    try {
      hit = await detect();
    } catch (e) {
      hit = null;
    }
    // A close or the deadline may have settled things while detect() ran.
    if (settled || detected) return;
    if (!hit) { schedule(); return; }

    // Claimed synchronously after the await, so no other path can claim too.
    detected = true;
    timers.clearTimeout(deadlineTimer);
    deadlineTimer = timers.setTimeout(() => {
      log('the account name did not arrive in time; saving the login without it.');
      complete(null);
    }, extractDeadlineMs);
    let name = null;
    try {
      name = await extractName(hit);
    } catch (e) {
      log(`reading the account name failed: ${e && e.message ? e.message : e}`);
    }
    complete(name);
  }

  return {
    start() {
      deadlineTimer = timers.setTimeout(() => {
        if (detected) return;
        log('timed out after waiting for a sign-in.');
        finish({ success: false, error: 'Login timed out' });
      }, deadlineMs);
      schedule();
    },
    // The window's 'closed' event.
    windowClosed() {
      if (settled) return;
      if (detected) {
        complete(null);
        return;
      }
      log('closed without completing.');
      finish({ success: false, error: 'Modal closed' });
    },
    get settled() { return settled; },
    get detected() { return detected; },
  };
}

module.exports = { createLoginFlow };
