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

// Whether the Google session in the jar is a sign-in made in the login
// window: the stable identifiers must differ from those present when the
// window opened (a session already in the jar is not a new sign-in) and from
// the set YouTube already reported signed out (the dead session the expiry
// marker describes would otherwise "sign in" on the first poll).
function isNewYouTubeSignIn(fingerprint, { atOpen = null, expired = null } = {}) {
  return !!fingerprint && fingerprint !== atOpen && fingerprint !== expired;
}

// Where the YouTube probe read the account name. Only these two identify the
// account reliably: the page's own config, and the handle the account menu
// renders. The menu's display-name element and the avatar's alt text are
// good enough to replace a placeholder, never to rename a real account.
const YOUTUBE_TRUSTED_NAME_SOURCES = new Set(['ytcfg', 'channel-handle']);

const isHandle = (name) => String(name == null ? '' : name).trim().startsWith('@');

// Whether a background YouTube probe that found the session live may replace
// the stored account name. A placeholder takes any name. A real name changes
// only for a name from a trusted source, never from a handle to a display name
// (ytcfg gives CHANNEL_HANDLE on one load and USER_NAME on the next, for the
// same account), and only once two probes in a row report the same new name.
// Returns { rename, pending }: pending is the name the next probe must repeat.
// The cost: an account swapped for one with no channel (no handle) keeps
// showing the old handle until it is reconnected.
function youtubeRenameDecision({ stored, name, source, pending = null } = {}) {
  if (!name || !String(name).trim()) return { rename: false, pending: null };
  if (isPlaceholderName(stored)) return { rename: true, pending: null };
  if (sameAccountName(name, stored)) return { rename: false, pending: null };
  if (!YOUTUBE_TRUSTED_NAME_SOURCES.has(source)) return { rename: false, pending: null };
  if (isHandle(stored) && !isHandle(name)) return { rename: false, pending: null };
  if (pending && sameAccountName(pending, name)) return { rename: true, pending: null };
  return { rename: false, pending: name };
}

// Per-platform write counters. Every path that signs an account in or out
// bumps it; a background check snapshots it before its slow await and drops
// its result if anything moved meanwhile. The name comparison catches writers
// that change a name without bumping: get-twitch-follows, and the background
// lookups that name an account (the YouTube health check's rename, the Kick
// placeholder lookup, validateSavedSessions' Twitch recovery).
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

// Counts, per platform, the moments the extension's automatic re-sync was
// switched off (a sign-out, a login made in the app). The receiver checks that
// state when a request arrives, but an import then awaits Twitch's account
// check, a probe page and every cookie write, and a Sign Out clicked meanwhile
// used to be undone by the import finishing (F53). An automatic import takes a
// ticket first and asks valid() before it writes, before every cookie it
// removes or sets, and again before it saves the account; a manual import (a
// click in the extension) is always valid.
function createSyncTickets() {
  const counts = new Map();
  const current = (p) => counts.get(p) || 0;
  return {
    bump(platform) { counts.set(platform, current(platform) + 1); },
    take(platform, { auto, isBlocked }) {
      const at = current(platform);
      // Once false, false for good. An import that stopped part way through
      // its cookie writes must go on to undo; if the block that stopped it
      // had lifted by its next check (a paste that failed), it would save
      // the account over half a session.
      let lost = false;
      return {
        valid: () => {
          if (!auto) return true;
          if (!lost && (isBlocked(platform) || current(platform) !== at)) lost = true;
          return !lost;
        },
      };
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
  isNewYouTubeSignIn,
  youtubeRenameDecision,
  createAccountEpochs,
  createSyncTickets,
};
