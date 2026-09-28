// F33 / F34 / F73: what counts as a Kick sign-in, the YouTube expiry marker,
// and the write counters that stop a slow background check from undoing a
// sign-out. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  placeholderName, isPlaceholderName, sameAccountName, hasKickSessionToken, youtubeAuthFingerprint,
  isNewYouTubeSignIn, youtubeRenameDecision, createAccountEpochs, createSyncTickets,
} = require('../main/account-state');

const ck = (name, value = 'v', domain = 'kick.com') => ({ name, value, domain });

test('F33: Kick visitor cookies are not a sign-in', () => {
  // A logged-out visitor, or any Kick stream cell: Laravel's per-visitor
  // session, the XSRF cookie and Cloudflare's.
  assert.equal(hasKickSessionToken([ck('kick_session', 'eyJ...'), ck('XSRF-TOKEN'), ck('__cf_bm')]), false);
  assert.equal(hasKickSessionToken([ck('impersonate_session_token', '1')]), false, 'no substring match');
  assert.equal(hasKickSessionToken([ck('session_token', '')]), false, 'empty value');
  assert.equal(hasKickSessionToken([ck('Session_Token', '1')]), false, 'exact name');
  assert.equal(hasKickSessionToken(null), false);
});

test('F33: session_token with a value is a sign-in', () => {
  assert.equal(hasKickSessionToken([ck('kick_session'), ck('session_token', '123|abc')]), true);
});

test('placeholder names', () => {
  assert.equal(placeholderName('youtube'), 'YouTube User', 'the casing every other path uses');
  assert.equal(placeholderName('kick'), 'Kick User');
  assert.equal(isPlaceholderName('Youtube User'), true, 'names written by older builds still count');
  assert.equal(isPlaceholderName(undefined), true);
  assert.equal(isPlaceholderName('alice'), false);
});

const yt = (name, value, domain = '.youtube.com') => ({ name, value, domain });

test('F34: the fingerprint identifies one Google session, order-free', () => {
  const a = [yt('SID', 's1'), yt('__Secure-1PSID', 'p1'), yt('SID', 'g1', '.google.com'), yt('HSID', 'h1')];
  const b = [...a].reverse();
  assert.equal(youtubeAuthFingerprint(a), youtubeAuthFingerprint(b));
  assert.match(youtubeAuthFingerprint(a), /^[0-9a-f]{32}$/);
  // The two lookups (youtube.com and accounts.google.com) can both return a
  // .google.com cookie; duplicates do not change the result.
  assert.equal(youtubeAuthFingerprint([...a, a[2]]), youtubeAuthFingerprint(a));
});

test('F34: rotating cookies do not change it; a new sign-in does', () => {
  const base = [yt('SID', 's1'), yt('__Secure-1PSID', 'p1'), yt('__Secure-1PSIDTS', 'ts1'), yt('__Secure-1PSIDCC', 'cc1'), yt('YSC', 'y1')];
  const rotated = [yt('SID', 's1'), yt('__Secure-1PSID', 'p1'), yt('__Secure-1PSIDTS', 'ts2'), yt('__Secure-1PSIDCC', 'cc2'), yt('YSC', 'y2')];
  assert.equal(youtubeAuthFingerprint(rotated), youtubeAuthFingerprint(base));
  const resigned = [yt('SID', 's2'), yt('__Secure-1PSID', 'p2')];
  assert.notEqual(youtubeAuthFingerprint(resigned), youtubeAuthFingerprint(base));
  assert.equal(youtubeAuthFingerprint([yt('YSC', 'y'), yt('PREF', 'p')]), null, 'nothing to fingerprint');
  assert.equal(youtubeAuthFingerprint([]), null);
});

test('F73: a sign-out while a probe runs invalidates the probe', () => {
  const epochs = createAccountEpochs();
  const accounts = { youtube: 'YouTube User' };
  const snap = epochs.snapshot('youtube', accounts);
  // logout-platform: bump, then delete.
  epochs.bump('youtube');
  delete accounts.youtube;
  assert.equal(epochs.isCurrent(snap, accounts), false);
});

test('F73: a re-import to the same placeholder name still invalidates the probe', () => {
  const epochs = createAccountEpochs();
  const accounts = { kick: 'Kick User' };
  const snap = epochs.snapshot('kick', accounts);
  epochs.bump('kick'); // importKickSession
  accounts.kick = 'Kick User';
  assert.equal(epochs.isCurrent(snap, accounts), false, 'a name comparison alone would miss this');
});

test('F73: a writer that does not bump is still caught by the name', () => {
  const epochs = createAccountEpochs();
  const accounts = { youtube: 'YouTube User' };
  const snap = epochs.snapshot('youtube', accounts);
  accounts.youtube = 'someone';
  assert.equal(epochs.isCurrent(snap, accounts), false);
});

test('F73: nothing changed, the probe result applies; other platforms do not interfere', () => {
  const epochs = createAccountEpochs();
  const accounts = { youtube: 'YouTube User', kick: 'k' };
  const snap = epochs.snapshot('youtube', accounts);
  epochs.bump('kick');
  assert.equal(epochs.isCurrent(snap, accounts), true);
  assert.equal(epochs.isCurrent(null, accounts), false);
});

// The expiry marker surviving a stale dashboard save is now part of the
// config boundary (main-config-boundary.test.js, F18/F22).

// F53 item 4. The shape of main.js's importers (see the wiring test in
// main-boundary-wiring): ticket first, then the slow account check, the
// write, and the account save, each gated on the ticket.
function simulatedImport({ tickets, blocked, auto, platform = 'twitch', during = {} }) {
  const account = {};
  const cookies = [];
  return (async () => {
    const ticket = tickets.take(platform, { auto, isBlocked: (p) => blocked.has(p) });
    await null; during.resolve && during.resolve();          // resolveTwitchUser
    if (!ticket.valid()) return { refused: true, cookies, account };
    await null; cookies.push('auth-token'); during.write && during.write(); // writeCookieList
    if (!ticket.valid()) { cookies.length = 0; return { undone: true, cookies, account }; }
    account.twitch = 'someone';
    return { ok: true, cookies, account };
  })();
}

test('F53 item 4 regression: a Sign Out while a re-sync resolves the account stops it before any cookie is written', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  const signOut = () => { blocked.add('twitch'); tickets.bump('twitch'); };
  const r = await simulatedImport({ tickets, blocked, auto: true, during: { resolve: signOut } });
  assert.deepEqual(r, { refused: true, cookies: [], account: {} });
});

test('F53 item 4: a Sign Out while it writes cookies undoes the write and never saves the account', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  const r = await simulatedImport({ tickets, blocked, auto: true, during: { write: () => { blocked.add('twitch'); tickets.bump('twitch'); } } });
  assert.equal(r.undone, true);
  assert.deepEqual(r.account, {});
});

test('F53 item 4: signed out and reconnected by hand while a re-sync ran still stops that re-sync', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  // Sign Out, then a click in the extension clears the block, all mid-flight:
  // the flag reads clear again, only the count remembers.
  const r = await simulatedImport({ tickets, blocked, auto: true, during: { resolve: () => { blocked.add('twitch'); tickets.bump('twitch'); blocked.delete('twitch'); } } });
  assert.equal(r.refused, true);
});

test('F53 item 4: manual imports, other platforms and undisturbed re-syncs go through', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  const signOut = () => { blocked.add('twitch'); tickets.bump('twitch'); };
  assert.equal((await simulatedImport({ tickets, blocked, auto: false, during: { resolve: signOut } })).ok, true, 'a click is the user deciding');
  blocked.clear();
  const kick = await simulatedImport({ tickets, blocked, auto: true, platform: 'kick', during: { resolve: signOut } });
  assert.equal(kick.ok, true, 'a Twitch sign-out does not touch Kick');
  blocked.clear();
  assert.equal((await simulatedImport({ tickets, blocked, auto: true })).ok, true);
});

test('issue-17: a jar with only the rotating Google cookies has no session to validate', () => {
  // validateSavedSessions counts YouTube as signed in only when the jar has a
  // fingerprint, so an expiry can always leave a marker for the same cookies.
  const rotatingOnly = [yt('LOGIN_INFO', 'li'), yt('__Secure-1PSIDTS', 'ts'), yt('__Secure-3PSIDCC', 'cc')];
  assert.equal(youtubeAuthFingerprint(rotatingOnly), null);
  assert.notEqual(youtubeAuthFingerprint([...rotatingOnly, yt('__Secure-1PSID', 'p')]), null, 'the modern stable identifier alone counts');
});

test('issue-16 regression: the login modal does not take a session already in the jar for a new sign-in', () => {
  const dead = youtubeAuthFingerprint([yt('SID', 'dead'), yt('HSID', 'dead-h')]);
  const fresh = youtubeAuthFingerprint([yt('SID', 'new'), yt('HSID', 'new-h')]);
  // The jar still holds the session YouTube reported signed out.
  assert.equal(isNewYouTubeSignIn(dead, { atOpen: dead, expired: dead }), false);
  assert.equal(isNewYouTubeSignIn(dead, { atOpen: undefined, expired: dead }), false, 'even if the jar could not be read when the window opened');
  // A live session already there when the window opened is not a sign-in made in it.
  assert.equal(isNewYouTubeSignIn(fresh, { atOpen: fresh, expired: null }), false);
  // The user signed in: the identifiers changed.
  assert.equal(isNewYouTubeSignIn(fresh, { atOpen: dead, expired: dead }), true);
  assert.equal(isNewYouTubeSignIn(fresh, { atOpen: null, expired: null }), true, 'an empty jar at open');
  assert.equal(isNewYouTubeSignIn(null, { atOpen: null }), false, 'no stable identifiers: nothing signed in');
});

test('issue-14 regression: a label-sourced name never renames a real YouTube account', () => {
  // The account menu's aria-label, or the avatar alt, is not a name.
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: 'Account menu', source: 'label' }), { rename: false, pending: null });
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: 'Account menu', source: 'label', pending: 'Account menu' }), { rename: false, pending: null });
  assert.equal(youtubeRenameDecision({ stored: '@alice', name: 'Alice S', source: 'account-name', pending: 'Alice S' }).rename, false, 'the menu\'s display name either');
  // A placeholder takes any name, at once.
  assert.deepEqual(youtubeRenameDecision({ stored: 'YouTube User', name: 'Alice S', source: 'label' }), { rename: true, pending: null });
  assert.equal(youtubeRenameDecision({ stored: undefined, name: '@alice', source: 'ytcfg' }).rename, true);
});

test('issue-14 regression: a handle and the same account\'s display name do not flip the stored name', () => {
  // ytcfg gives CHANNEL_HANDLE on one load and USER_NAME on the next.
  let pending = null;
  for (const name of ['Alice Smith', '@alice', 'Alice Smith', 'Alice Smith', '@ALICE']) {
    const d = youtubeRenameDecision({ stored: '@alice', name, source: 'ytcfg', pending });
    assert.equal(d.rename, false, name);
    pending = d.pending;
  }
  // The same account named the same way: nothing to do, nothing pending.
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: 'alice', source: 'ytcfg', pending: '@bob' }), { rename: false, pending: null });
});

test('issue-14: a different account from a trusted source renames only when two probes in a row agree', () => {
  const first = youtubeRenameDecision({ stored: '@alice', name: '@bob', source: 'ytcfg' });
  assert.deepEqual(first, { rename: false, pending: '@bob' });
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: '@bob', source: 'channel-handle', pending: first.pending }), { rename: true, pending: null });
  // A different name the second time starts over.
  const other = youtubeRenameDecision({ stored: '@alice', name: '@carol', source: 'ytcfg', pending: '@bob' });
  assert.deepEqual(other, { rename: false, pending: '@carol' });
  // A display name may become a handle (same kind of upgrade, still twice).
  assert.equal(youtubeRenameDecision({ stored: 'Alice Smith', name: '@alice', source: 'ytcfg', pending: '@alice' }).rename, true);
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: '', source: 'ytcfg', pending: '@bob' }), { rename: false, pending: null });
});

test('F52: the same account is recognised however its name is spelled', () => {
  assert.equal(sameAccountName('@Streamer', 'streamer'), true, 'a handle with and without its @');
  assert.equal(sameAccountName(' Alice ', 'alice'), true);
  assert.equal(sameAccountName(undefined, null), true);
  assert.equal(sameAccountName('alice', 'bob'), false);
  assert.equal(sameAccountName(undefined, 'bob'), false, 'no account before is a change');
  assert.equal(sameAccountName('a@b', 'ab'), false, 'only a leading @ is dropped');
});
