// F33 / F34 / F73: what counts as a Kick sign-in, the YouTube expiry marker,
// and the write counters that stop a slow background check from undoing a
// sign-out. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  placeholderName, isPlaceholderName, sameAccountName, hasKickSessionToken, youtubeAuthFingerprint,
  createAccountEpochs,
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

test('F52: the same account is recognised however its name is spelled', () => {
  assert.equal(sameAccountName('@Streamer', 'streamer'), true, 'a handle with and without its @');
  assert.equal(sameAccountName(' Alice ', 'alice'), true);
  assert.equal(sameAccountName(undefined, null), true);
  assert.equal(sameAccountName('alice', 'bob'), false);
  assert.equal(sameAccountName(undefined, 'bob'), false, 'no account before is a change');
  assert.equal(sameAccountName('a@b', 'ab'), false, 'only a leading @ is dropped');
});
