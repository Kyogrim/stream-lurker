// Security policy for every web page the app hosts: where a stream cell,
// pop-out, login or hidden window may navigate, what a <webview> may attach
// with, which web permissions a page gets, which downloads go through, which
// IPC senders are trusted, and when a page may send the user to their real
// browser. Pure functions only, so every rule runs under plain Node in
// test/main-web-security.test.js; main.js wires them to Electron.

const { isDashboardUrl, isDashboardOrigin } = require('./dashboard-protocol');

// The partition every stream cell, pop-out, login and probe window shares.
const STREAM_PARTITION = 'persist:default';

// Anchored on a dot or the start, so twitch.tv.evil.net and eviltwitch.tv fail.
const PLATFORM_HOST = /(^|\.)(twitch\.tv|kick\.com|youtube\.com|youtube-nocookie\.com|rumble\.com)$/i;
// Google hosts a YouTube page can hop through on its own: the EU consent
// interstitial and a re-auth prompt. Not attacker-controlled, and blocking them
// strands a cell or the probe on 'unknown'.
const GOOGLE_AUTH_HOST = /^(accounts|consent)\.google\.com$/i;
// The Google hosts a login window's own pages live on: sign-in, the account
// pages it links to, the EU consent prompt and the post-sign-in "protect your
// account" interstitial (gds). Named one by one: other google.com hosts
// (sites.google.com, docs.google.com) serve pages anyone can write, and this
// is the one window where a lookalike sign-in page matters most.
const LOGIN_GOOGLE_HOSTS = new Set(['accounts.google.com', 'www.google.com', 'myaccount.google.com', 'consent.google.com', 'gds.google.com']);
// Google's per-country cookie hop (accounts.google.co.uk/accounts/SetSID).
// Only that one path: a two-letter TLD is not proof Google owns the domain.
const GOOGLE_COUNTRY_ACCOUNTS_HOST = /^accounts\.google\.(?:[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i;
const GOOGLE_SETSID_PATH = '/accounts/setsid';
// Sign in with Apple (appleid.apple.com, idmsa.apple.com).
const APPLE_HOST = /(^|\.)apple\.com$/i;

function isLoginHelperUrl(value) {
  const u = parseUrl(value);
  if (!u || u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (LOGIN_GOOGLE_HOSTS.has(host) || APPLE_HOST.test(host)) return true;
  return GOOGLE_COUNTRY_ACCOUNTS_HOST.test(host) && u.pathname.toLowerCase() === GOOGLE_SETSID_PATH;
}
// The only window.open targets a login window may open in-app: Kick's
// "Continue with Google / Apple" popups.
const OAUTH_POPUP_HOST = /^(accounts\.google\.com|appleid\.apple\.com)$/i;

// Schemes a third-party frame may navigate to. chrome-extension: is for frames
// the loaded 7TV/BTTV extensions inject; about/blob/data cover ad and player
// iframes. Everything else (file:, app:, ms-settings:, mailto:, ...) is refused.
const FRAME_SCHEMES = new Set(['http:', 'https:', 'about:', 'blob:', 'data:', 'chrome-extension:']);

function parseUrl(value) {
  try { return new URL(String(value)); } catch (e) { return null; }
}

function isWebUrl(value) {
  const u = parseUrl(value);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:');
}

function isHttpsHost(value, hostPattern) {
  const u = parseUrl(value);
  return !!u && u.protocol === 'https:' && hostPattern.test(u.hostname);
}

function isPlatformUrl(value) {
  return isHttpsHost(value, PLATFORM_HOST);
}

function isOAuthPopupUrl(value) {
  return isHttpsHost(value, OAUTH_POPUP_HOST);
}

// Where a top-level page of each kind of surface may go. Roles:
//   dashboard - the app's own UI: only ever itself (a reload).
//   stream    - <webview> cells and pop-outs: the platforms plus Google consent/auth.
//   hidden    - probe windows and the Twitch GQL page: same set, nobody watching.
//   login     - login modal and its OAuth popups: platforms, Google, Apple.
//   clip      - the clip player: the platforms.
//   anything else (DevTools, extension pages): not restricted here.
function isAllowedTopLevelUrl(role, url) {
  switch (role) {
    case 'dashboard': return isDashboardUrl(url);
    case 'stream':
    case 'hidden': return isPlatformUrl(url) || isHttpsHost(url, GOOGLE_AUTH_HOST);
    case 'login': return isPlatformUrl(url) || isLoginHelperUrl(url);
    case 'clip': return isPlatformUrl(url);
    default: return true;
  }
}

// Surfaces that load third-party pages and get the frame scheme filter. The
// dashboard is excluded (it is app://) and so are unknown contents.
const THIRD_PARTY_ROLES = new Set(['stream', 'hidden', 'login', 'clip']);

function isAllowedFrameUrl(role, url) {
  if (!THIRD_PARTY_ROLES.has(role)) return true;
  const u = parseUrl(url);
  return !!u && FRAME_SCHEMES.has(u.protocol);
}

// Hidden windows never hand anything to the user's browser: nobody is there to
// have clicked it.
function mayOpenExternally(role) {
  return role !== 'hidden';
}

// Applied to every <webview> before it attaches. The preferences are forced
// whatever the markup asked for, so injected markup cannot get a preload, Node,
// or web security turned off. Returns whether the attach may go ahead.
function sanitizeWebviewAttach(webPreferences, params) {
  const prefs = webPreferences || {};
  delete prefs.preload;
  delete prefs.preloadURL;
  delete prefs.enableBlinkFeatures;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.webviewTag = false;
  prefs.experimentalFeatures = false;

  const p = params || {};
  if (p.partition !== STREAM_PARTITION) {
    return { allow: false, reason: `partition "${p.partition || '(none)'}" is not ${STREAM_PARTITION}` };
  }
  if (!isPlatformUrl(p.src)) {
    return { allow: false, reason: `src ${String(p.src || '(empty)').slice(0, 120)} is not a platform page` };
  }
  // The guest is created from webPreferences.partition, not params.partition,
  // and Electron spreads the markup's `webpreferences` attribute over the
  // value it copied from params: webpreferences="partition=" would otherwise
  // attach on the default session, or on any other partition.
  prefs.partition = STREAM_PARTITION;
  return { allow: true, reason: '' };
}

// A main-frame load starting in a stream surface that must be stopped:
// the attach-time src check covers only the first page, and a load the
// embedder starts later (webview.src, webview.loadURL) is browser-initiated,
// so will-navigate never sees it. In-page (same-document) changes and
// subframes are left to their own hooks.
function isBlockedStreamLoad(role, { url, isMainFrame, isSameDocument } = {}) {
  if (role !== 'stream' || !isMainFrame || isSameDocument) return false;
  return !isAllowedTopLevelUrl('stream', url);
}

// Web permissions. Deny by default: the app never needs a camera, microphone,
// screen capture, notifications, clipboard reads, devices or external protocol
// launches from a web page. HTML fullscreen is what the player's fullscreen
// button uses (the grid relies on it, see webview:fullscreen in style.css), and
// it is harmless from any origin. Copy buttons on the platforms, in the loaded
// extensions and in the dashboard itself need a sanitized clipboard write.
const ALWAYS_ALLOWED_PERMISSIONS = new Set(['fullscreen']);
const TRUSTED_ORIGIN_PERMISSIONS = new Set(['clipboard-sanitized-write']);

// `from` is the requesting frame's URL (request handler) or origin (check
// handler), never the top-level page: an ad iframe inside twitch.tv must not
// inherit twitch.tv's grants.
function isPermissionAllowed(permission, from) {
  if (ALWAYS_ALLOWED_PERMISSIONS.has(permission)) return true;
  if (TRUSTED_ORIGIN_PERMISSIONS.has(permission)) {
    const u = parseUrl(from);
    if (!u) return false;
    if (u.protocol === 'chrome-extension:') return true;
    if (isDashboardOrigin(u.href)) return true;
    return isPlatformUrl(u.href);
  }
  return false;
}

// Only the dashboard's own top frame, on app://bundle, may call the privileged
// IPC API. A null senderFrame means the frame navigated or died mid-call.
function isTrustedDashboardSender(event, dashboardContents) {
  if (!event || !dashboardContents || event.sender !== dashboardContents) return false;
  const frame = event.senderFrame;
  if (!frame) return false;
  try {
    return frame.parent === null && isDashboardOrigin(frame.url);
  } catch (e) {
    return false;
  }
}

// A popup handler gets no user-gesture flag, so a page can call window.open on
// a timer. Only let a page reach the user's browser right after a real click or
// key press in it, while its window is focused, once per gesture, and never the
// same URL twice in a row. An unattended page can then open nothing at all.
function createExternalOpenGate({ gestureWindowMs = 5000, minIntervalMs = 2000, dedupeMs = 10000, now = Date.now } = {}) {
  const state = new WeakMap(); // webContents -> { gestureAt, lastOpenAt, lastUrl }
  const get = (key) => {
    let s = state.get(key);
    if (!s) { s = { gestureAt: 0, lastOpenAt: 0, lastUrl: '' }; state.set(key, s); }
    return s;
  };
  return {
    noteGesture(key) {
      if (key && typeof key === 'object') get(key).gestureAt = now();
    },
    decide(key, url, { focused } = {}) {
      const u = parseUrl(url);
      if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return { open: false, reason: 'not an http(s) link' };
      if (!key || typeof key !== 'object') return { open: false, reason: 'no opener' };
      if (!focused) return { open: false, reason: 'its window was not focused' };
      const s = get(key);
      const t = now();
      if (!s.gestureAt || t - s.gestureAt > gestureWindowMs) return { open: false, reason: 'no click or key press just before it' };
      if (t - s.lastOpenAt < minIntervalMs) return { open: false, reason: 'rate limited' };
      if (s.lastUrl === u.href && t - s.lastOpenAt < dedupeMs) return { open: false, reason: 'same link again' };
      s.lastOpenAt = t;
      s.lastUrl = u.href;
      s.gestureAt = 0; // one gesture, one tab
      return { open: true, reason: '', href: u.href };
    },
  };
}

// Pages retry denied permissions and popups constantly. Log each distinct thing
// once per interval, and keep the key set bounded so weeks of uptime cannot
// grow it without limit.
function createLogThrottle({ intervalMs = 60 * 60 * 1000, maxKeys = 500, now = Date.now } = {}) {
  const seen = new Map();
  return {
    shouldLog(key) {
      const t = now();
      const last = seen.get(key);
      if (last !== undefined && t - last < intervalMs) return false;
      if (seen.size >= maxKeys) seen.clear();
      seen.set(key, t);
      return true;
    },
  };
}

// Origin and path identify a clip; signed CDN links carry a query that
// Chromium's canonicalizer and WHATWG URL can spell differently.
function downloadIdentity(value) {
  const u = parseUrl(value);
  return u ? `${u.origin}${u.pathname}` : null;
}

// Downloads the dashboard asked for (download-clip), so the session's
// will-download can let exactly those through and cancel everything else.
function createDownloadAllowlist({ ttlMs = 60 * 1000, maxEntries = 20, now = Date.now } = {}) {
  const pending = [];
  const prune = () => {
    const t = now();
    for (let i = pending.length - 1; i >= 0; i--) {
      if (t - pending[i].at > ttlMs) pending.splice(i, 1);
    }
    while (pending.length > maxEntries) pending.shift();
  };
  return {
    expect(url, filename) {
      const id = downloadIdentity(url);
      if (!id) return false;
      pending.push({ id, filename, at: now() });
      prune();
      return true;
    },
    // `urlChain` is item.getURLChain(): the requested URL first, then redirects.
    take(urlChain) {
      prune();
      const ids = (Array.isArray(urlChain) ? urlChain : [urlChain]).map(downloadIdentity).filter(Boolean);
      const i = pending.findIndex(p => ids.includes(p.id));
      if (i === -1) return null;
      const [hit] = pending.splice(i, 1);
      return hit.filename;
    },
  };
}

module.exports = {
  STREAM_PARTITION,
  isWebUrl,
  isPlatformUrl,
  isOAuthPopupUrl,
  isAllowedTopLevelUrl,
  isAllowedFrameUrl,
  mayOpenExternally,
  sanitizeWebviewAttach,
  isBlockedStreamLoad,
  isPermissionAllowed,
  isTrustedDashboardSender,
  createExternalOpenGate,
  createLogThrottle,
  createDownloadAllowlist,
};
