// Keeps each go-live Notification reachable until it can no longer be
// clicked. Tested in test/main-live-alerts.test.js.
//
// Why: Electron's Notification is garbage-collected like any other object.
// Once nothing references it, the toast still sits in Action Center but its
// click handler is gone, so "click to watch" (what makes notify-only mode
// useful) silently did nothing.
//
// Released on 'click' and 'failed' only. On Windows 'close' also fires when a
// toast times out into Action Center, which is exactly when it must stay
// alive. Bounded by age and count instead, since the app runs for weeks.

const ALERT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ALERTS = 50;

function createAlertKeeper({ ttlMs = ALERT_TTL_MS, max = MAX_ALERTS } = {}) {
  const alerts = new Map(); // key -> { notif, at }; insertion order = age

  // Evicted toasts are closed so a dead one does not linger in Action Center.
  function evict(key) {
    const entry = alerts.get(key);
    alerts.delete(key);
    if (!entry) return;
    try { entry.notif.close(); } catch (e) { /* already gone */ }
  }

  function prune(now) {
    for (const [key, entry] of alerts) {
      if (now - entry.at > ttlMs) evict(key);
    }
  }

  return {
    // One alert per key (a stream): a re-alert replaces the older toast.
    keep(key, notif, now) {
      prune(now);
      if (alerts.has(key)) evict(key);
      while (alerts.size >= max) evict(alerts.keys().next().value);
      alerts.set(key, { notif, at: now });
      const release = () => {
        const entry = alerts.get(key);
        if (entry && entry.notif === notif) alerts.delete(key);
      };
      notif.on('click', release);
      notif.on('failed', release);
    },

    has(key) {
      return alerts.has(key);
    },

    get size() {
      return alerts.size;
    },
  };
}

module.exports = { ALERT_TTL_MS, MAX_ALERTS, createAlertKeeper };
