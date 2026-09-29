// Recovery policy for a Multi-Lurk cell whose page died (the guest renderer
// crashed or was OOM-killed after days of uptime) or never loaded (opened
// during a network drop, so it sits on Chromium's error page). Left alone, such
// a cell stays blank for the whole broadcast while main keeps crediting watch
// time for it, because the cell is still in the grid.
//
// Contract C6: reload with backoff, at most MAX_RELOADS reloads in any
// RELOAD_WINDOW_MS, then give up and close the cell through the same path as
// the close button, so main finalizes the session and stops counting.
// Pure functions; the DOM wiring lives in multi-lurk.js.

export const RELOAD_DELAYS_MS = [5000, 30000, 120000];
export const RELOAD_WINDOW_MS = 10 * 60 * 1000;
export const MAX_RELOADS = RELOAD_DELAYS_MS.length;

// net::ERR_ABORTED: a navigation replaced by another one. Twitch and YouTube
// fire it on every SPA hop and redirect, and main's navigation guard produces
// it when it cancels an off-platform navigation. Neither is a dead page.
const ERR_ABORTED = -3;

// What went wrong, as a log phrase, or null when the event is not a failure
// of the cell's page. `type` is the <webview> event name.
export function describeCellFailure(type, e = {}) {
  if (type === 'render-process-gone') {
    // Electron puts the reason on e.details; older builds put it on the event.
    const reason = e.details?.reason ?? e.reason ?? 'gone';
    // clean-exit is the guest shutting down normally (the cell was closed).
    if (reason === 'clean-exit') return null;
    return `page process ${reason}`;
  }
  if (type === 'did-fail-load') {
    // Subframes (ads, chat embeds) fail all the time without hurting the stream.
    if (e.isMainFrame !== true) return null;
    const code = Number(e.errorCode);
    if (!code || code === ERR_ABORTED) return null;
    return `page failed to load (${e.errorDescription || code})`;
  }
  return null;
}

// Decide what to do about a failure at `now`, given the times of the reloads
// already done for this cell. The history is never cleared by a good load: a
// page that loads and then crashes again every minute is a crash loop, and
// only the window ageing out earns it more reloads.
export function planCellRecovery(reloadTimes, now) {
  const recent = (Array.isArray(reloadTimes) ? reloadTimes : [])
    .filter(t => Number.isFinite(t) && now - t < RELOAD_WINDOW_MS);
  if (recent.length >= MAX_RELOADS) return { action: 'give-up', recent };
  return {
    action: 'reload',
    recent,
    attempt: recent.length + 1,
    delayMs: RELOAD_DELAYS_MS[recent.length],
  };
}
