// Whether the dashboard renderer is up, and what to do when it dies. Every
// stream cell is a <webview> inside it, so while it is gone nothing is being
// watched. Tested in test/main-dashboard-health.test.js.
//
// Why: after three crashes main gave up reloading for the life of the
// process, yet kept crediting a minute of watch time to every stream it still
// listed and counting sessions for streams the scanner "opened" into the dead
// renderer. Days of phantom hours reached the leaderboard and streaks.

// Quick reloads: at most MAX_QUICK_RELOADS within QUICK_WINDOW_MS.
const MAX_QUICK_RELOADS = 3;
const QUICK_WINDOW_MS = 10 * 60 * 1000;
const QUICK_RELOAD_DELAY_MS = 1000;
// After that, one slow retry per interval instead of never again, so a
// transient crash loop during a weeks-long unattended run can still recover.
const SLOW_RELOAD_DELAY_MS = 30 * 60 * 1000;

function createDashboardHealth() {
  // 'loading' until the first load finishes, 'alive' while a page is up,
  // 'dead' from a renderer crash until the next load finishes.
  let state = 'loading';
  let quickReloads = 0;
  let lastCrashAt = 0;

  return {
    get state() {
      return state;
    },

    // Minutes count as watch time only while the cells can actually exist.
    get creditsWatchTime() {
      return state === 'alive';
    },

    // Before the first load a spawned cell is restored from
    // get-active-containers, so opening is fine. A dead renderer drops
    // open-stream-tab, which would count a session nobody sees.
    get canOpenStreams() {
      return state !== 'dead';
    },

    loaded() {
      state = 'alive';
    },

    // Returns { action: 'none' | 'reload' | 'give-up', delayMs, attempt, max }.
    // 'give-up' still reloads, only much later; the caller ends every session
    // because nothing will be watched until then.
    gone(reason, now, { quitting = false } = {}) {
      state = 'dead';
      if (reason === 'clean-exit' || quitting) return { action: 'none' };
      if (now - lastCrashAt > QUICK_WINDOW_MS) quickReloads = 0;
      lastCrashAt = now;
      if (quickReloads >= MAX_QUICK_RELOADS) {
        return { action: 'give-up', delayMs: SLOW_RELOAD_DELAY_MS };
      }
      quickReloads += 1;
      return { action: 'reload', delayMs: QUICK_RELOAD_DELAY_MS, attempt: quickReloads, max: MAX_QUICK_RELOADS };
    },
  };
}

module.exports = {
  MAX_QUICK_RELOADS,
  QUICK_WINDOW_MS,
  QUICK_RELOAD_DELAY_MS,
  SLOW_RELOAD_DELAY_MS,
  createDashboardHealth,
};
