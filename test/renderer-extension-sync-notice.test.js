// F96: the Platform Logins warning for the extension's automatic re-sync is
// built from everything get-extension-info reports, not only lastAutoSync:
//   - the extension re-syncs twitch, youtube, kick in one pass, and each
//     attempt overwrites lastAutoSync, so a failing YouTube was hidden
//     seconds later by Kick's success
//   - a wrong pairing code is refused before main knows the import was
//     automatic, so it only shows up in codeRejectedAt
// Run: node --test test/renderer-extension-sync-notice.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'extension-status.js')).href);
const NOW = 1_780_000_000_000;
const MIN = 60_000;

// What main sends after one pass of the extension: Twitch fine, YouTube
// failed, Kick fine a few seconds later (so Kick is lastAutoSync).
function onePass({ youtubeError = 'No YouTube login cookies were found in the browser.' } = {}) {
  const twitch = { at: NOW - 12_000, ok: true, error: '' };
  const youtube = { at: NOW - 8_000, ok: false, error: youtubeError };
  const kick = { at: NOW - 4_000, ok: true, error: '' };
  return {
    lastAutoSync: { platform: 'kick', ...kick },
    autoSync: { twitch, youtube, kick },
    codeRejectedAt: 0,
  };
}

test('F96: a failing platform still warns after a later platform succeeds', async () => {
  const { extensionSyncNotice, lastSyncNotice } = await load();
  const info = onePass();
  // What the panel used to show: Kick's success, and no warning.
  assert.deepEqual(lastSyncNotice(info.lastAutoSync, NOW), { text: 'Extension last synced Kick just now.', warn: false });

  const notice = extensionSyncNotice(info, NOW);
  assert.equal(notice.warn, true);
  assert.equal(notice.text,
    "The extension's last automatic sync of YouTube failed just now: No YouTube login cookies were found in the browser. Log in to YouTube in your browser, then click Connect in the extension.");
  assert.doesNotMatch(notice.text, /pairing code/, 'the code was accepted for this attempt');
});

test('F96: a wrong pairing code newer than the last success warns', async () => {
  const { extensionSyncNotice } = await load();
  // Every platform synced fine an hour ago; since then, "New code" was
  // clicked and the extension keeps sending the old one.
  const info = {
    lastAutoSync: { platform: 'kick', at: NOW - 60 * MIN, ok: true, error: '' },
    autoSync: {
      twitch: { at: NOW - 61 * MIN, ok: true, error: '' },
      kick: { at: NOW - 60 * MIN, ok: true, error: '' },
    },
    codeRejectedAt: NOW - 5 * MIN,
  };
  const notice = extensionSyncNotice(info, NOW);
  assert.equal(notice.warn, true);
  assert.equal(notice.text,
    'An import with a wrong pairing code was refused 5 min ago. If that was your browser extension, paste the current code shown above into it.');

  // A success after the refusal (the new code was pasted in) clears it.
  const fixed = { ...info, autoSync: { ...info.autoSync, twitch: { at: NOW - MIN, ok: true, error: '' } }, lastAutoSync: { platform: 'twitch', at: NOW - MIN, ok: true, error: '' } };
  assert.deepEqual(extensionSyncNotice(fixed, NOW), { text: 'Extension last synced Twitch 1 min ago.', warn: false });

  // Refused with nothing ever synced: still a warning.
  assert.match(extensionSyncNotice({ lastAutoSync: null, autoSync: {}, codeRejectedAt: NOW - 3 * 3600_000 }, NOW).text,
    /^An import with a wrong pairing code was refused 3 h ago\./);
});

test('F96: both problems at once, and several failed platforms', async () => {
  const { extensionSyncNotice } = await load();
  const info = {
    lastAutoSync: { platform: 'kick', at: NOW - 2 * MIN, ok: false, error: 'Kick rejected the session' },
    autoSync: {
      twitch: { at: NOW - 4 * MIN, ok: false, error: 'x' },
      youtube: { at: NOW - 3 * MIN, ok: false, error: 'y' },
      kick: { at: NOW - 2 * MIN, ok: false, error: 'Kick rejected the session' },
    },
    codeRejectedAt: NOW - MIN,
  };
  const { text, warn } = extensionSyncNotice(info, NOW);
  assert.equal(warn, true);
  assert.match(text, /^An import with a wrong pairing code was refused 1 min ago\. /);
  assert.match(text, /last automatic sync of Kick failed 2 min ago: Kick rejected the session\. YouTube and Twitch failed too\. Log in to them in your browser/);
});

test('F96: all good, or nothing reported yet, reads as before', async () => {
  const { extensionSyncNotice } = await load();
  const info = onePass();
  info.autoSync.youtube = { at: NOW - 8_000, ok: true, error: '' };
  assert.deepEqual(extensionSyncNotice(info, NOW), { text: 'Extension last synced Kick just now.', warn: false });
  // An older refusal than the newest success is history, not a warning.
  assert.equal(extensionSyncNotice({ ...info, codeRejectedAt: NOW - 3600_000 }, NOW).warn, false);
  for (const nothing of [undefined, null, {}, { lastAutoSync: null, autoSync: {}, codeRejectedAt: 0 }]) {
    assert.equal(extensionSyncNotice(nothing, NOW), null, JSON.stringify(nothing));
  }
  // Only lastAutoSync (an app from before autoSync existed): unchanged wording.
  assert.equal(extensionSyncNotice({ lastAutoSync: { platform: 'twitch', at: NOW - 3 * 3600_000, ok: false, error: 'Invalid pairing code' } }, NOW).text,
    "The extension's last automatic sync of Twitch failed 3 h ago: Invalid pairing code. If the pairing code changed, paste the current one into the extension.");
});

test('F96: only allowlisted platforms and well-formed entries count; nothing is echoed raw', async () => {
  const { extensionSyncNotice } = await load();
  const autoSync = Object.create({ youtube: { at: NOW, ok: false, error: 'inherited' } });
  Object.assign(autoSync, {
    '<b>x</b>': { at: NOW, ok: false, error: 'not a platform' },
    rumble: { at: NOW, ok: false, error: 'not synced by the extension' },
    constructor: { at: NOW, ok: false, error: 'prototype key' },
    twitch: { at: 'soon', ok: false, error: 'bad time' },
    kick: 'broken',
  });
  assert.equal(extensionSyncNotice({ autoSync, codeRejectedAt: 'yesterday' }, NOW), null);
  const long = extensionSyncNotice({ autoSync: { youtube: { at: NOW, ok: false, error: `a\n\n${'z'.repeat(5000)}` } } }, NOW);
  assert.ok(long.text.length < 400, 'the error is capped');
  assert.doesNotMatch(long.text, /\n/);
  // No error text at all: still a full sentence.
  assert.match(extensionSyncNotice({ autoSync: { youtube: { at: NOW, ok: false } } }, NOW).text, /YouTube failed just now\. Log in to YouTube/);
});
