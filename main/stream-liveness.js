// What the scanner last knew about each stream, for two decisions that must
// not trust a single scan: auto-closing an open cell, and crediting watch
// time to it. In memory only; nothing here is saved to config.json. Tested in
// test/main-stream-liveness.test.js.
//
// Why: a scan that errors (network outage, a Kick 403 run, a YouTube 429)
// correctly never closes a cell, but the watch-time ticker used to credit
// every open cell every minute regardless, so an overnight outage wrote hours
// of phantom viewing into the irreplaceable history.

// Consecutive clean offline results before an open cell is auto-closed. One
// transient false offline (a flaky GQL answer, a scan that raced a manual
// open) would otherwise close the cell and reopen it a scan later, counting a
// new session.
const OFFLINE_CONFIRMATIONS = 2;
// ...and they must span at least this share of the scan interval. Scan Now,
// the tray scan and an add-streamer follow-up run seconds after a scheduled
// scan, and a false offline that lasts a minute is seen by both: counting
// scans alone closed the cell anyway.
const OFFLINE_MIN_SPAN_SHARE = 0.5;

function offlineMinSpanMs(intervalMs) {
  return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs * OFFLINE_MIN_SPAN_SHARE : 0;
}

// Credit stops once the last confirmation is older than two intervals plus a
// minute AND a scan has finished since without repeating it. On schedule that
// tolerates one errored scan, not two. Age alone is not enough: the interval
// tick is skipped while a scan runs, so one slow scan (a YouTube stall, 30 s
// per channel three at a time) spaces results several intervals apart even
// while every one of them confirms the stream live.
function staleAfterMs(intervalMs) {
  return 2 * intervalMs + 60000;
}

function createStreamLiveness() {
  // key -> { lastLiveAt, lastObservedAt, offlineStreak, firstOfflineAt, paused }
  // lastObservedAt: the last scan that reported on the key at all (live,
  // offline or errored), or that failed as a whole.
  const entries = new Map();

  function entryFor(key) {
    let e = entries.get(key);
    if (!e) {
      e = { lastLiveAt: undefined, lastObservedAt: undefined, offlineStreak: 0, firstOfflineAt: undefined, paused: false };
      entries.set(key, e);
    }
    return e;
  }

  function creditable(e, now, intervalMs) {
    if (e.offlineStreak > 0) return false;
    if (e.lastLiveAt === undefined) return true;
    // Stale only once a later scan failed to confirm it; while the next scan
    // is still running, the last confirmation stands however old it is.
    const unconfirmedSince = e.lastObservedAt !== undefined && e.lastObservedAt > e.lastLiveAt;
    return !(unconfirmedSince && now - e.lastLiveAt > staleAfterMs(intervalMs));
  }

  return {
    // A cell was just opened: it starts out confirmed.
    start(key, now) {
      const e = entryFor(key);
      e.lastLiveAt = now;
      e.offlineStreak = 0;
      e.firstOfflineAt = undefined;
    },

    // One scan result. Live resets everything; a clean offline adds to the
    // streak (the first one starts its clock); an error proves nothing either
    // way, so it breaks the streak (the offline results were not consecutive)
    // without confirming anything. Returns the offline streak after this
    // result.
    observe(key, result, now) {
      const e = entryFor(key);
      e.lastObservedAt = now;
      if (result.isLive) {
        e.lastLiveAt = now;
        e.offlineStreak = 0;
        e.firstOfflineAt = undefined;
      } else if (result.error) {
        e.offlineStreak = 0;
        e.firstOfflineAt = undefined;
      } else {
        if (e.offlineStreak === 0) e.firstOfflineAt = now;
        e.offlineStreak += 1;
      }
      return e.offlineStreak;
    },

    // A whole scan failed (threw before any result was applied). It finished
    // without confirming anything, so it counts against every stream like an
    // errored result; without this, a scan that throws every time would keep
    // crediting open cells forever.
    scanFailed(now) {
      for (const e of entries.values()) e.lastObservedAt = now;
    },

    offlineStreak(key) {
      const e = entries.get(key);
      return e ? e.offlineStreak : 0;
    },

    // When the current run of clean offline results began, or undefined.
    offlineSince(key) {
      const e = entries.get(key);
      return e ? e.firstOfflineAt : undefined;
    },

    // Whether an open cell's stream is confirmed offline for auto-close: enough
    // consecutive clean offline results, spread over enough time.
    offlineConfirmed(key, now, intervalMs) {
      const e = entries.get(key);
      if (!e || e.offlineStreak < OFFLINE_CONFIRMATIONS || e.firstOfflineAt === undefined) return false;
      return now - e.firstOfflineAt >= offlineMinSpanMs(intervalMs);
    },

    // Whether this minute of an open cell counts as watch time. A key the
    // scanner knows nothing about (opened by hand, not monitored, or removed
    // from the list while open) is credited as before. `transition` is
    // 'paused' or 'resumed' on the minute the answer changes, for the log.
    credit(key, now, intervalMs) {
      const e = entries.get(key);
      if (!e) return { credit: true, transition: null, lastLiveAt: undefined };
      const credit = creditable(e, now, intervalMs);
      let transition = null;
      if (!credit && !e.paused) transition = 'paused';
      else if (credit && e.paused) transition = 'resumed';
      e.paused = !credit;
      return { credit, transition, lastLiveAt: e.lastLiveAt };
    },

    // When a closing session really ended. If the cell was no longer
    // confirmed live, the session is cut one interval after the last scan
    // that saw it live, not at the moment the cell happened to close.
    sessionEnd(key, now, intervalMs) {
      const e = entries.get(key);
      if (!e || e.lastLiveAt === undefined || creditable(e, now, intervalMs)) return now;
      return Math.max(e.lastLiveAt, Math.min(now, e.lastLiveAt + intervalMs));
    },

    forget(key) {
      entries.delete(key);
    },

    // Drops keys the latest scan did not cover (no longer monitored), so a
    // cell left open for a removed streamer is not starved of credit by an
    // entry that can never be refreshed.
    retain(keys) {
      for (const key of entries.keys()) {
        if (!keys.has(key)) entries.delete(key);
      }
    },

    has(key) {
      return entries.has(key);
    },
  };
}

module.exports = { OFFLINE_CONFIRMATIONS, OFFLINE_MIN_SPAN_SHARE, offlineMinSpanMs, staleAfterMs, createStreamLiveness };
