// What the app counts as a signed-in account, and the bookkeeping that keeps a
// slow background check from undoing what the user did meanwhile. Pure, tested
// in test/main-account-state.test.js.

const crypto = require('crypto');

const PLACEHOLDER_NAMES = { twitch: 'Twitch User', kick: 'Kick User', youtube: 'YouTube User', rumble: 'Rumble User' };

function placeholderName(platform) {
  const p = String(platform || '').toLowerCase();
  return PLACEHOLDER_NAMES[p] || `${p.charAt(0).toUpperCase()}${p.slice(1)} User`;
}

// A stored name that carries no information, so it's worth replacing.
function isPlaceholderName(name) {
  return !name || /^(kick|youtube|twitch|rumble) user$/i.test(String(name).trim());
}

// Whether two names are the same account: YouTube shows a handle with or
// without its @, and a name differing only in case is the same login. Used to
// notice a different account, so it must not see a change where there is none.
function sameAccountName(a, b) {
  const norm = (s) => String(s == null ? '' : s).trim().replace(/^@/, '').toLowerCase();
  return norm(a) === norm(b);
}

// Kick signs in with session_token (its frontend replays it as a bearer).
// kick_session is Laravel's per-visitor cookie: every logged-out visitor, and
// every Kick stream cell, gets one. Matching on the substring "session" also
// hits that, and the staff-only impersonate_session_token.
function hasKickSessionToken(cookies) {
  return (cookies || []).some(c => c && c.name === 'session_token' && typeof c.value === 'string' && c.value.length > 0);
}

// The Google sign-in identifiers that only change on a new sign-in. The
// __Secure-*PSIDTS / *PSIDCC cookies rotate on their own every few minutes,
// so a fingerprint that included them would never match twice.
const YOUTUBE_STABLE_AUTH_COOKIE = /^(SID|HSID|SSID|APISID|SAPISID|__Secure-[13]PSID|__Secure-[13]PAPISID)$/;

// Identifies one set of Google session cookies without storing them: a short
// hash, recorded when YouTube confirms that set is signed out. Any new cookies
// (an extension re-sync, a paste, a real sign-in) hash differently, so the
// marker clears itself however they arrived. null when there is nothing to
// fingerprint.
function youtubeAuthFingerprint(cookies) {
  const parts = new Set();
  for (const c of cookies || []) {
    if (!c || !YOUTUBE_STABLE_AUTH_COOKIE.test(String(c.name || ''))) continue;
    const host = String(c.domain || '').replace(/^\./, '').toLowerCase();
    parts.add(`${host}|${c.name}=${c.value}`);
  }
  if (!parts.size) return null;
  return crypto.createHash('sha256').update([...parts].sort().join('\n')).digest('hex').slice(0, 32);
}

// Per-platform write counters. Every path that signs an account in or out
// bumps it; a background check snapshots it before its slow await and drops
// its result if anything moved meanwhile. The name comparison catches writers
// that do not bump (the dashboard's own settings save).
function createAccountEpochs() {
  const epochs = new Map();
  const current = (p) => epochs.get(p) || 0;
  return {
    bump(platform) { epochs.set(platform, current(platform) + 1); },
    current,
    snapshot(platform, accounts) {
      return { platform, epoch: current(platform), name: accounts ? accounts[platform] : undefined };
    },
    isCurrent(snap, accounts) {
      if (!snap || current(snap.platform) !== snap.epoch) return false;
      const now = accounts ? accounts[snap.platform] : undefined;
      return now === snap.name;
    },
  };
}

// Which config keys a dashboard save may carry (and so which main keeps, the
// expiry marker included) is decided in config-boundary.js.

module.exports = {
  placeholderName,
  isPlaceholderName,
  sameAccountName,
  hasKickSessionToken,
  youtubeAuthFingerprint,
  createAccountEpochs,
};
