// F33 / F34 / F73: what counts as a Kick sign-in, the YouTube expiry marker,
// and the write counters that stop a slow background check from undoing a
// sign-out. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  placeholderName, isPlaceholderName, sameAccountName, hasKickSessionToken, youtubeAuthFingerprint,
  isNewYouTubeSignIn, youtubeRenameDecision, createAccountEpochs, createSyncTickets,
} = require('../main/account-state');
const { kickNameToStore } = require('../main/kick-user');

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

// r2-7: set-google-cookies holds automatic YouTube re-syncs off while a paste
// runs (a block that is not persisted) and ends the ones already running
// (a ticket bump right before its writes).
test('r2-7 regression: a re-sync already running when a paste writes is ended, even though the paste then fails', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  // The paste starts and writes while the re-sync resolves; it then fails,
  // so nothing turns re-sync off for good and the block is gone again.
  const paste = () => { blocked.add('youtube'); tickets.bump('youtube'); blocked.delete('youtube'); };
  const r = await simulatedImport({ tickets, blocked, auto: true, platform: 'youtube', during: { resolve: paste } });
  assert.deepEqual(r, { refused: true, cookies: [], account: {} });
});

test('r2-7 regression: a re-sync that arrives while a paste runs writes nothing', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set(['youtube']); // youtubePastesRunning > 0
  const r = await simulatedImport({ tickets, blocked, auto: true, platform: 'youtube' });
  assert.equal(r.refused, true);
  assert.deepEqual(r.cookies, []);
});

test('r2-7: after a failed paste, re-sync works again; a manual Connect click is never held off', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  blocked.add('youtube'); tickets.bump('youtube'); blocked.delete('youtube'); // a paste came and went
  assert.equal((await simulatedImport({ tickets, blocked, auto: true, platform: 'youtube' })).ok, true, 'nothing persisted');
  blocked.add('youtube');
  assert.equal((await simulatedImport({ tickets, blocked, auto: false, platform: 'youtube' })).ok, true, 'a click in the extension is the user deciding');
});

// r4-2: writeCookieList asks the ticket before every cookie and stops at the
// first no. The importer's check right after must then see no as well, or it
// would save the account over the half-written session.
test('r4-2: a ticket that has said no never says yes again, even once the block lifts', () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  const isBlocked = (p) => blocked.has(p);
  const ticket = tickets.take('youtube', { auto: true, isBlocked });
  assert.equal(ticket.valid(), true);
  blocked.add('youtube'); // a paste starts (youtubePastesRunning > 0)
  assert.equal(ticket.valid(), false, 'the re-sync stops at its next cookie');
  blocked.delete('youtube'); // and fails before it ends anything for good
  assert.equal(ticket.valid(), false, 'so the stopped re-sync undoes instead of saving');
  // Only that import is affected: a new re-sync, and any manual import, go through.
  assert.equal(tickets.take('youtube', { auto: true, isBlocked }).valid(), true);
  assert.equal(tickets.take('youtube', { auto: false, isBlocked: () => true }).valid(), true);
});

test('r4-2 regression: a re-sync stopped mid-write by a block that then lifts is undone, not saved', async () => {
  const tickets = createSyncTickets();
  const blocked = new Set();
  const ticket = tickets.take('youtube', { auto: true, isBlocked: (p) => blocked.has(p) });
  // writeCookieList: asked before every cookie. The block arrives during the
  // second, the loop stops at the third, and the block is gone again before
  // the importer's own check after the write.
  const written = [];
  for (const name of ['SID', 'HSID', 'SSID']) {
    if (!ticket.valid()) break;
    written.push(name);
    await null;
    if (name === 'HSID') blocked.add('youtube');
  }
  blocked.delete('youtube');
  assert.deepEqual(written, ['SID', 'HSID']);
  assert.equal(ticket.valid(), false, 'ticket.undo(), not the account save');
});

// r2-6: refreshPlaceholderAccountNames snapshots Kick before its cookie read.
test('r2-6 regression: a Sign Out during the placeholder refresh\'s cookie read drops the lookup', () => {
  const epochs = createAccountEpochs();
  const accounts = { kick: 'Kick User' };
  const before = epochs.snapshot('kick', accounts); // taken before the await (now)
  // logout-platform lands while readKickSessionCookies() is pending.
  epochs.bump('kick');
  delete accounts.kick;
  const after = epochs.snapshot('kick', accounts); // where it used to be taken
  assert.equal(epochs.isCurrent(before, accounts), false, 'the lookup is dropped');
  // The old placement saw nothing wrong, and then took any name for the
  // signed-out account, a page-read one included.
  assert.equal(epochs.isCurrent(after, accounts), true);
  assert.equal(kickNameToStore(after.name, { name: 'featuredstreamer', source: 'dom' }), 'featuredstreamer');
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

// ---------------------------------------------------------------------------
// Decisions the tests above left open (Stryker survivors on account-state.js).
// Each test pins one of them through the exported API.

// A placeholder is exactly one of the four "<Platform> User" names, trimmed.
// A real name that only contains one is a real account; taken for a
// placeholder, any page-read name (the avatar's alt text included) would
// replace it at once.
test('placeholder names: the whole name must match, surrounding spaces ignored', () => {
  assert.equal(isPlaceholderName('Former Twitch User'), false, 'a real name ending in one');
  assert.equal(isPlaceholderName('YouTube Users United'), false, 'a real name starting with one');
  assert.equal(isPlaceholderName('  YouTube User '), true, 'a padded placeholder (a hand-edited config) is still one');
  for (const stored of ['Former Twitch User', 'YouTube Users United']) {
    assert.deepEqual(youtubeRenameDecision({ stored, name: 'Alice', source: 'label' }), { rename: false, pending: null }, stored);
  }
  assert.deepEqual(youtubeRenameDecision({ stored: ' YouTube User ', name: 'Alice', source: 'label' }), { rename: true, pending: null });
});

// sameAccountName folds case with toLowerCase. An uppercase fold would also
// merge different letters, Turkish dotless ı with i ('kırmızı' and 'kirmizi'
// are both KIRMIZI), and a switch between two such accounts would go unseen.
test('F52: folding case does not merge different letters', () => {
  assert.equal(sameAccountName('@kırmızı', '@kirmizi'), false);
  assert.equal(sameAccountName('@Kırmızı', '@kırmızı'), true, 'a real case difference still matches');
  assert.deepEqual(youtubeRenameDecision({ stored: '@kırmızı', name: '@kirmizi', source: 'ytcfg' }), { rename: false, pending: '@kirmizi' }, 'the other account is noticed');
});

// The fingerprint's allowlist is exact. accounts.google.com also returns
// cookies whose names only end in SID (LSID, __Host-1PLSID, __Host-3PLSID,
// OSID): they neither make a session on their own nor move a session's
// fingerprint. Both PAPISID variants are on the list.
test('F34: only the listed Google identifiers make the fingerprint', () => {
  const acct = (name, value) => yt(name, value, 'accounts.google.com');
  const session = [yt('SID', 's1', '.google.com'), yt('__Secure-1PSID', 'p1', '.google.com')];
  const suffixOnly = [acct('LSID', 'l1'), acct('__Host-1PLSID', 'l1'), acct('__Host-3PLSID', 'l3'), acct('OSID', 'o1')];
  assert.equal(youtubeAuthFingerprint(suffixOnly), null, 'no stable identifier, no session');
  assert.equal(youtubeAuthFingerprint([...session, ...suffixOnly]), youtubeAuthFingerprint(session));
  assert.equal(youtubeAuthFingerprint([...session, acct('LSID', 'l2')]), youtubeAuthFingerprint([...session, acct('LSID', 'l1')]),
    'a new LSID value is not a new sign-in');
  for (const name of ['__Secure-1PAPISID', '__Secure-3PAPISID']) {
    assert.notEqual(youtubeAuthFingerprint([yt(name, 'a1')]), null, `${name} alone is a session`);
    assert.notEqual(youtubeAuthFingerprint([...session, yt(name, 'a2')]), youtubeAuthFingerprint([...session, yt(name, 'a1')]),
      `a new ${name} is a new sign-in`);
  }
});

// The expiry marker (config.youtubeExpiredFingerprint) is saved to disk and
// read back by whichever build auto-updates over this one. If the digest is
// built differently, every saved marker misses: the dead session is re-added
// and its expiry announced again on the first launch after the update
// (issue-16/17). The value below is sha256 over the sorted "host|name=value"
// lines joined by \n, first 32 hex chars, checked independently with
// sha256sum and Python's hashlib. Change it only together with a migration of
// saved markers.
test('F34: the fingerprint recipe is fixed, so a saved expiry marker still matches after an update', () => {
  const jar = [
    yt('SID', 'g.a000sid', '.google.com'),
    yt('__Secure-1PSID', 'g.a000p1', '.google.com'),
    yt('SAPISID', 'sap/AbC', '.youtube.com'),
    yt('HSID', 'Hh1', 'www.youtube.com'), // host-only: its inner dots are kept
    yt('__Secure-3PAPISID', 'sap/AbC', 'accounts.google.com'),
    yt('YSC', 'rot', '.youtube.com'), // rotating, not part of it
    yt('__Secure-1PSIDTS', 'rot', '.google.com'),
  ];
  assert.equal(youtubeAuthFingerprint(jar), 'c516b00a38c604b9f8015707f310d8bc');
  // Only a domain cookie's leading dot is dropped: the same cookie stored
  // with or without it is the same session.
  assert.equal(youtubeAuthFingerprint([yt('SID', 's1', '.youtube.com'), yt('HSID', 'h1', '.youtube.com')]),
    youtubeAuthFingerprint([yt('SID', 's1', 'youtube.com'), yt('HSID', 'h1', 'youtube.com')]));
});

// youtubeRenameDecision's early exits, each reached by the input that needs it.

// probeYouTubeLogin reports a live session with name null when the page
// showed none. Renaming on that would write null (or blanks) over the
// account, a placeholder included.
test('issue-14: a probe that read no name leaves the stored one alone', () => {
  for (const name of [null, undefined, '', '   ']) {
    assert.deepEqual(youtubeRenameDecision({ stored: 'YouTube User', name, source: 'ytcfg' }), { rename: false, pending: null }, String(name));
  }
});

// The same account spelled another way is no change: no pending name, and so
// no second read that "confirms" a rename, a config write and a "signed-in
// account is now ..." notice for the account already stored.
test('issue-14: the same account, however it is spelled, is never queued or renamed', () => {
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: '@ALICE', source: 'ytcfg' }), { rename: false, pending: null });
  assert.deepEqual(youtubeRenameDecision({ stored: 'Alice Smith', name: 'alice smith', source: 'ytcfg', pending: 'alice smith' }), { rename: false, pending: null });
  assert.deepEqual(youtubeRenameDecision({ stored: 'Alice Smith', name: 'Alice Smith', source: 'ytcfg', pending: 'Alice Smith' }), { rename: false, pending: null });
});

// Only ytcfg and the menu's channel handle may rename a real account. The
// menu's display name, the avatar's alt text or a name with no source never
// do, even when two reads in a row agree, and never leave a pending name.
test('issue-14: an untrusted source never renames a real account, however often it repeats', () => {
  for (const source of ['account-name', 'label', null, undefined]) {
    assert.deepEqual(youtubeRenameDecision({ stored: 'Alice Smith', name: 'Bob Jones', source, pending: 'Bob Jones' }), { rename: false, pending: null }, `display name, ${source}`);
    assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: '@bob', source, pending: '@bob' }), { rename: false, pending: null }, `handle, ${source}`);
  }
});

// ytcfg's values are not trimmed on the way in, and a rename stores the name
// as read. A handle with a stray space is still a handle: the same account's
// display name must not replace it, and another account's handle is tracked.
test('issue-14: a handle with stray whitespace is still a handle', () => {
  assert.deepEqual(youtubeRenameDecision({ stored: ' @alice', name: 'Alice Smith', source: 'ytcfg', pending: 'Alice Smith' }), { rename: false, pending: null });
  assert.deepEqual(youtubeRenameDecision({ stored: '@alice', name: ' @bob', source: 'ytcfg' }), { rename: false, pending: ' @bob' });
  assert.equal(youtubeRenameDecision({ stored: '@alice', name: '@bob', source: 'ytcfg', pending: ' @bob' }).rename, true);
});
