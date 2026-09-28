// Keeps the desktop app's copy of your platform cookies fresh.
//
// Importing cookies from the popup is a one-shot snapshot, but Google in
// particular rotates its session tokens (__Secure-*PSIDTS) continuously. A
// snapshot therefore goes stale and nothing renews it, which is why a
// previously-working YouTube login quietly stops working. This worker re-pushes
// the current cookies on a timer so the app tracks the browser.
//
// It only ever syncs platforms you have already connected by hand, only while
// the pairing code is present, and only to a listener that has just proved it
// holds that code (see findApp in connector.js). It never connects anything on
// its own, and a platform you sign out of inside the app drops out of the sync.

importScripts('connector.js');
const SL = self.SLConnector;

const ALARM = 'stream-lurker-resync';
const PERIOD_MINUTES = 30;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) resyncAll();
});

// The popup's "Sync now" button.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'resync-now') {
    resyncAll().then(sendResponse, (e) => sendResponse({ status: 'error', error: String(e && e.message || e) }));
    return true; // async response
  }
});

// The alarm and "Sync now" can land together; share one pass rather than
// importing every platform twice.
let inflight = null;
function resyncAll() {
  if (!inflight) {
    inflight = SL.runResync({
      storage: chrome.storage.local,
      cookies: chrome.cookies,
      fetch: self.fetch.bind(self),
      crypto: self.crypto,
    }).finally(() => { inflight = null; });
  }
  return inflight;
}
