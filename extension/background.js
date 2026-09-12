// Keeps the desktop app's copy of your platform cookies fresh.
//
// Importing cookies from the popup is a one-shot snapshot, but Google in
// particular rotates its session tokens (__Secure-*PSIDTS) continuously. A
// snapshot therefore goes stale and nothing renews it, which is why a
// previously-working YouTube login quietly stops working. This worker re-pushes
// the current cookies on a timer so the app tracks the browser.
//
// It only ever syncs platforms you have already connected by hand, and only
// while the pairing code is present — it never connects anything on its own.

const PORTS = [47100, 47101, 47102, 47103, 47104];
const DOMAINS = {
  twitch: ['twitch.tv'],
  youtube: ['youtube.com', 'google.com'],
  kick: ['kick.com'],
};

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

// The popup tells us which platforms were connected successfully.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'connected' && msg.platform) {
    chrome.storage.local.get({ connectedPlatforms: [] }, (d) => {
      const set = new Set(d.connectedPlatforms);
      set.add(msg.platform);
      chrome.storage.local.set({ connectedPlatforms: [...set] }, () => sendResponse({ ok: true }));
    });
    return true; // async response
  }
  if (msg && msg.type === 'resync-now') {
    resyncAll().then(r => sendResponse(r));
    return true;
  }
});

async function findApp() {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { method: 'GET' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.app === 'stream-lurker') return port;
      }
    } catch (e) { /* not this port */ }
  }
  return null;
}

async function collectCookies(platform) {
  const seen = new Set();
  const out = [];
  for (const domain of DOMAINS[platform] || []) {
    let cookies = [];
    try { cookies = await chrome.cookies.getAll({ domain }); } catch (e) { continue; }
    for (const c of cookies) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      });
    }
  }
  return out;
}

async function resyncAll() {
  const { pairingCode, connectedPlatforms } = await chrome.storage.local.get({
    pairingCode: '', connectedPlatforms: [],
  });
  if (!pairingCode || !connectedPlatforms.length) return { skipped: 'not paired' };

  const port = await findApp();
  if (!port) return { skipped: 'app not running' };

  const results = {};
  for (const platform of connectedPlatforms) {
    try {
      const cookies = await collectCookies(platform);
      // No cookies means you're signed out in the browser too. Pushing an empty
      // set would only overwrite a possibly-working session with nothing.
      if (!cookies.length) { results[platform] = 'no cookies in browser'; continue; }
      const r = await fetch(`http://127.0.0.1:${port}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode, platform, cookies, auto: true }),
      });
      const j = await r.json().catch(() => ({}));
      results[platform] = j.success ? `ok (${j.cookiesSet} cookies)` : (j.error || 'failed');
    } catch (e) {
      results[platform] = 'error: ' + e.message;
    }
  }
  await chrome.storage.local.set({ lastResync: Date.now(), lastResyncResults: results });
  return results;
}
