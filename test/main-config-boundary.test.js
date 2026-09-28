// Gate tests for main/config-boundary.js: what the dashboard's save-config,
// Settings > Import and Settings > Export may each carry (F11, F18, F22, F55),
// the stored pairing code's format (F17) and the SIGNED_OUT state (C1).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  RENDERER_KEYS, IMPORT_KEYS, rendererConfigPatch, importedConfig, importedStreamer, importedWatchTime,
  repairWatchTime, exportableConfig, normalizePairingCode, newPairingCode, isSignedOutIn, withSignedOut,
  signedOutReasonIn, channelNameProblem,
} = require('../main/config-boundary');
const { sanitizeConfig } = require('../main/config-sanitize');

// What main holds after running a while: state the dashboard never wrote.
function mainConfig() {
  return {
    streamers: [{ platform: 'twitch', username: 'a', mode: 'notify' }, { platform: 'kick', username: 'b' }],
    checkInterval: 3, autoOpen: true, twitchClientId: 'id', twitchClientSecret: 'secret',
    extensions: ['C:\\ext\\one', 'C:\\Users\\me\\AppData\\Roaming\\stream-lurker\\managed-extensions\\7tv\\dist'],
    maxTwitchTabs: 2, maxKickTabs: 2, maxYoutubeTabs: 2, maxRumbleTabs: 2,
    twitchEnabled: true, kickEnabled: true, youtubeEnabled: true, rumbleEnabled: false,
    disabledAutoQuality: {}, calendarEvents: [], syncedCalendarEvents: [], seventvLastUpdated: null,
    defaultQuality: '160p', launchOnStartup: false, onboardingComplete: true,
    accounts: { twitch: 'realname', youtube: '@me' },
    extensionPairingCode: 'ABCDEF12',
    youtubeExpiredFingerprint: 'f'.repeat(32),
    signedOutPlatforms: { kick: 1 },
    dashboardStorageMigrated: true,
    watchTime: { streamers: { 'twitch:a': 500 }, platforms: { twitch: 500, kick: 0, youtube: 0, rumble: 0 }, sessions: 9, streamerSessions: {}, daily: { '2026-09-27': 30 }, longestSessionMs: 1, streamerLongestMs: {}, streamerLastSeen: {} },
  };
}

// What the dashboard sends: its copy from page load, possibly edited.
function staleCopy(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

const merge = (current, incoming, opts) => {
  const { patch, refused, approvedUsed } = rendererConfigPatch(incoming, current, opts);
  const next = { ...current, ...patch };
  sanitizeConfig(next);
  return { next, patch, refused, approvedUsed };
};

test('F22 regression: a stale dashboard copy cannot revert what main wrote since the page loaded', () => {
  const current = mainConfig();
  const page = staleCopy(current);
  // Since the page loaded: main resolved a name, a minute ticked, an import.
  delete page.accounts.youtube;
  page.accounts.twitch = 'Twitch User';
  page.watchTime.streamers['twitch:a'] = 1;
  page.autoOpen = false; // the one thing the user changed
  const { next } = merge(current, page);
  assert.deepEqual(next.accounts, { twitch: 'realname', youtube: '@me' });
  assert.equal(next.watchTime.streamers['twitch:a'], 500);
  assert.equal(next.watchTime, current.watchTime, 'the live object, so the minute ticker keeps writing into it');
  assert.equal(next.autoOpen, false);
});

test('F18 regression: a compromised dashboard cannot set main-owned keys', () => {
  const current = mainConfig();
  const evil = {
    ...staleCopy(current),
    extensionPairingCode: '0000',
    accounts: { twitch: 'attacker' },
    watchTime: [],
    rumbleEnabled: true,
    youtubeExpiredFingerprint: null,
    signedOutPlatforms: {},
    seventvLastUpdated: 'x',
    dashboardStorageMigrated: false,
    __proto__: { polluted: true },
    somethingNew: 1,
  };
  const { next, patch } = merge(current, evil);
  for (const key of ['extensionPairingCode', 'accounts', 'watchTime', 'rumbleEnabled', 'youtubeExpiredFingerprint', 'signedOutPlatforms', 'seventvLastUpdated', 'dashboardStorageMigrated', 'somethingNew']) {
    assert.equal(Object.prototype.hasOwnProperty.call(patch, key), false, key);
    assert.deepEqual(next[key], current[key], key);
  }
  assert.equal({}.polluted, undefined);
});

test('F22: the YouTube expiry marker main set, or cleared, after the page loaded stays as main has it', () => {
  const current = mainConfig();
  const page = staleCopy(current);
  delete page.youtubeExpiredFingerprint; // the page loaded before main set it
  assert.equal(merge(current, page).next.youtubeExpiredFingerprint, current.youtubeExpiredFingerprint);
  const cleared = { ...mainConfig() };
  delete cleared.youtubeExpiredFingerprint; // main cleared it since
  const old = { ...staleCopy(cleared), youtubeExpiredFingerprint: 'old' };
  assert.equal('youtubeExpiredFingerprint' in merge(cleared, old).next, false, 'not brought back');
});

test('F18: extensions: removals and reorders pass, a new folder only if picked in main\'s dialog', () => {
  const current = mainConfig();
  const [one, sevenTv] = current.extensions;
  const unc = '\\\\attacker.host@SSL\\share\\ext';
  const picked = 'D:\\my-ext';
  const approved = new Set([picked]);

  let r = merge(current, { extensions: [sevenTv, unc, one] }, { approvedExtensions: approved });
  assert.deepEqual(r.next.extensions, [sevenTv, one], 'reordered, UNC path refused');
  assert.ok(r.refused.some(x => x.key === 'extensions' && x.reason.includes('attacker.host')));

  r = merge(current, { extensions: [one] }, { approvedExtensions: approved });
  assert.deepEqual(r.next.extensions, [one], 'Remove works');

  r = merge(current, { extensions: [one, sevenTv, picked, picked] }, { approvedExtensions: approved });
  assert.deepEqual(r.next.extensions, [one, sevenTv, picked], 'the picked folder is added once');
  assert.deepEqual(r.approvedUsed, [picked]);

  // null, {} and a string used to brick startup; now they change nothing.
  for (const bad of [null, {}, 'C:\\x', 5]) {
    r = merge(current, { extensions: bad });
    assert.deepEqual(r.next.extensions, current.extensions, JSON.stringify(bad));
  }
});

test('F22 regression: a stale extension list sent after a catalog install keeps the new folder', () => {
  const [one, sevenTv] = mainConfig().extensions;
  // The dashboard fetched [one]; then install-catalog-extension added 7TV and
  // saved, and a settings toggle sent the page's copy before its refetch.
  const current = { ...mainConfig(), extensions: [one, sevenTv] };
  const seen = new Set([one]);
  let r = merge(current, { ...staleCopy(current), extensions: [one], autoOpen: false }, { dashboardExtensions: seen });
  assert.deepEqual(r.next.extensions, [one, sevenTv], 'not dropped, so not unloaded');
  assert.deepEqual(r.patch.extensions, [one, sevenTv]);
  assert.equal(r.next.autoOpen, false, 'the setting the user changed still saves');
  assert.deepEqual(rendererConfigPatch({ extensions: [one] }, current, { dashboardExtensions: seen }).keptExtensions, [sevenTv]);

  // Once the dashboard has fetched the list with 7TV in it, Remove works.
  r = merge(current, { extensions: [one] }, { dashboardExtensions: new Set([one, sevenTv]) });
  assert.deepEqual(r.next.extensions, [one]);
  // An uninstall main did since is not undone by the stale copy either.
  r = merge({ ...current, extensions: [one] }, { extensions: [one, sevenTv] }, { dashboardExtensions: new Set([one, sevenTv]) });
  assert.deepEqual(r.next.extensions, [one]);
  // Without a snapshot (older callers), the copy is taken as is.
  assert.deepEqual(merge(current, { extensions: [one] }).next.extensions, [one]);
});

test('F18: settings are type-checked and clamped; unusable values keep main\'s', () => {
  const current = mainConfig();
  const { next, refused } = merge(current, {
    checkInterval: 0, maxTwitchTabs: 50, maxKickTabs: '4', maxYoutubeTabs: null, maxRumbleTabs: 'abc',
    autoOpen: 'yes', notificationsEnabled: false, launchOnStartup: true, startMinimized: 1,
    defaultQuality: '4k', twitchClientId: '  newid  ', twitchClientSecret: { x: 1 },
    onboardingComplete: true, twitchEnabled: false,
  });
  assert.equal(next.checkInterval, 1, 'never a 1 ms scan loop');
  assert.equal(next.maxTwitchTabs, 10);
  assert.equal(next.maxKickTabs, 4);
  assert.equal(next.maxYoutubeTabs, 2, 'null kept main\'s');
  assert.equal(next.maxRumbleTabs, 2);
  assert.equal(next.autoOpen, true, 'a string is not a boolean');
  assert.equal(next.notificationsEnabled, false);
  assert.equal(next.launchOnStartup, true, 'the Settings toggle still works');
  assert.equal(next.startMinimized, undefined);
  assert.equal(next.defaultQuality, '160p');
  assert.equal(next.twitchClientId, 'newid');
  assert.equal(next.twitchClientSecret, 'secret');
  assert.equal(next.twitchEnabled, false);
  assert.deepEqual(refused.map(r => r.key).sort(), ['autoOpen', 'defaultQuality', 'maxRumbleTabs', 'maxYoutubeTabs', 'startMinimized', 'twitchClientSecret'].sort());
});

test('F18: streamers keep order and mode; main\'s stored entries are kept; junk is refused', () => {
  const current = mainConfig();
  const { next, patch, refused } = merge(current, {
    streamers: [
      { platform: 'kick', username: 'b', mode: 'ignore', extra: '<img>' },
      { platform: 'twitch', username: 'a', mode: 'bogus' },
      null,
    ],
  });
  // An invalid mode leaves main's; the extra field never reaches config.json.
  assert.deepEqual(patch.streamers, [{ platform: 'kick', username: 'b', mode: 'ignore' }, { platform: 'twitch', username: 'a', mode: 'notify' }]);
  assert.deepEqual(next.streamers, patch.streamers);
  assert.deepEqual(refused, [{ key: 'streamers', reason: 'not an object: null' }]);
  assert.deepEqual(merge(current, { streamers: 'x' }).next.streamers, current.streamers);
});

test('F18 regression: save-config cannot add an unknown platform, a path-like name or a 5 MB name', () => {
  const current = mainConfig();
  const huge = 'y'.repeat(5 * 1024 * 1024);
  const { next, refused } = merge(current, {
    streamers: [
      ...staleCopy(current).streamers,
      { platform: 'myspace', username: 'x' },
      { platform: 'kick', username: '../../v2/secret?x=' },
      { platform: 'youtube', username: huge },
      { platform: 'twitch', username: 'has-dash' },
    ],
  });
  assert.deepEqual(next.streamers, current.streamers, 'main\'s list is unchanged');
  assert.deepEqual(refused.map(r => r.reason.split(':')[0]), ['unknown platform', 'not a channel name', 'not a channel name', 'not a valid channel name']);
  for (const r of refused) assert.ok(r.reason.length < 200, 'a refusal never echoes the whole value');
  // The same checks as add-streamer: a real new channel still goes in.
  const added = merge(current, { streamers: [...current.streamers, { platform: 'KICK', username: ' new_one ', mode: 'notify' }] });
  assert.deepEqual(added.next.streamers.at(-1), { platform: 'kick', username: 'new_one', mode: 'notify' });
  assert.deepEqual(added.refused, []);
});

test('F18: reorder, mode change and removal of existing entries still work; stored spelling wins', () => {
  const current = { ...mainConfig(), streamers: [{ platform: 'twitch', username: 'Old-Name', mode: 'notify' }, { platform: 'kick', username: 'b' }, { platform: 'youtube', username: '@Me' }] };
  // Reorder (the drag handle) and a mode change on one entry.
  let r = merge(current, { streamers: [{ platform: 'youtube', username: '@Me', mode: 'ignore' }, { platform: 'kick', username: 'b' }, { platform: 'twitch', username: 'Old-Name', mode: 'notify' }] });
  assert.deepEqual(r.next.streamers, [{ platform: 'youtube', username: '@Me', mode: 'ignore' }, { platform: 'kick', username: 'b' }, { platform: 'twitch', username: 'Old-Name', mode: 'notify' }]);
  assert.deepEqual(r.refused, []);
  // Removal.
  r = merge(current, { streamers: [{ platform: 'kick', username: 'b' }] });
  assert.deepEqual(r.next.streamers, [{ platform: 'kick', username: 'b' }]);
  // An existing name that would fail today's rules is still main's, spelled as
  // stored, so its watch history stays attached (F89).
  r = merge(current, { streamers: [{ platform: 'TWITCH', username: 'old-name', mode: 'auto' }] });
  assert.deepEqual(r.next.streamers, [{ platform: 'twitch', username: 'Old-Name', mode: 'auto' }]);
  // A duplicate keeps the first.
  r = merge(current, { streamers: [{ platform: 'kick', username: 'b', mode: 'notify' }, { platform: 'kick', username: 'B', mode: 'ignore' }] });
  assert.deepEqual(r.next.streamers, [{ platform: 'kick', username: 'b', mode: 'notify' }]);
  assert.match(r.refused[0].reason, /^duplicate: kick:B$/);
});

test('F18: the monitored list and the refusal log are both bounded', () => {
  const current = mainConfig();
  const many = (n) => Array.from({ length: n }, (_, i) => ({ platform: 'twitch', username: `n${i}` }));
  // Longer than the cap plus everything main has: refused whole, main's kept.
  let r = merge(current, { streamers: many(2003) });
  assert.deepEqual(r.next.streamers, current.streamers);
  assert.match(r.refused[0].reason, /more than 2000 entries/);
  // At the edge: new entries stop at the cap.
  r = merge(current, { streamers: many(2002) });
  assert.equal(r.next.streamers.length, 2000);
  assert.deepEqual(r.refused.map(x => x.reason), [
    'the list already has 2000 entries: twitch:n2000', 'the list already has 2000 entries: twitch:n2001',
  ]);
  // Thirty bad entries log ten lines and one count.
  r = merge(current, { streamers: [...current.streamers, ...Array.from({ length: 30 }, () => ({ platform: 'myspace', username: 'x' }))] });
  assert.equal(r.refused.length, 11);
  assert.equal(r.refused[10].reason, '20 more entries refused');
  assert.deepEqual(r.next.streamers, current.streamers);
});

test('F18: calendar and quality maps keep their shape and size', () => {
  const current = mainConfig();
  const event = { id: 'manual-1', streamer: 's', platform: 'twitch', day: 3, time: '20:00', title: 't'.repeat(5000), type: 'manual', nested: { a: 1 }, fn: [1] };
  const { next } = merge(current, {
    calendarEvents: [event, 'junk', null],
    syncedCalendarEvents: new Array(6000).fill({ id: 'x', day: 1 }),
    disabledAutoQuality: { 'twitch:a': true, 'kick:b': 'yes', ['x'.repeat(300)]: true },
  });
  assert.deepEqual(Object.keys(next.calendarEvents[0]), ['id', 'streamer', 'platform', 'day', 'time', 'title', 'type']);
  assert.equal(next.calendarEvents[0].title.length, 1000);
  assert.equal(next.calendarEvents.length, 1);
  assert.equal(next.syncedCalendarEvents.length, 5000);
  assert.deepEqual(next.disabledAutoQuality, { 'twitch:a': true });
  assert.deepEqual(merge(current, { calendarEvents: {} }).next.calendarEvents, current.calendarEvents);
});

test('F18 regression: an event field name is capped too, from the dashboard and from a backup', () => {
  const current = mainConfig();
  const bigKey = 'k'.repeat(2 * 1024 * 1024);
  const event = { id: 'manual-1', [bigKey]: 'v', day: 2, ['x'.repeat(51)]: 1, ['y'.repeat(50)]: 1 };
  const { next } = merge(current, { calendarEvents: [event] });
  assert.deepEqual(Object.keys(next.calendarEvents[0]), ['id', 'day', 'y'.repeat(50)]);
  assert.ok(JSON.stringify(next.calendarEvents).length < 200);
  const imported = importedConfig({ streamers: [], watchTime: {}, syncedCalendarEvents: [event] }, current);
  assert.deepEqual(Object.keys(imported.config.syncedCalendarEvents[0]), ['id', 'day', 'y'.repeat(50)]);
});

test('F18: every key the dashboard writes is renderer-owned, and none that main owns', () => {
  // The keys src/settings.js, streamers.js, calendar.js, multi-lurk.js,
  // onboarding.js, extensions.js and renderer.js change before saveConfig.
  const written = ['autoOpen', 'checkInterval', 'maxTwitchTabs', 'maxKickTabs', 'maxYoutubeTabs', 'maxRumbleTabs',
    'twitchEnabled', 'kickEnabled', 'youtubeEnabled', 'defaultQuality', 'twitchClientId', 'twitchClientSecret',
    'autoClaimPoints', 'notificationsEnabled', 'launchOnStartup', 'startMinimized', 'calendarEvents',
    'syncedCalendarEvents', 'disabledAutoQuality', 'onboardingComplete', 'streamers', 'extensions'];
  for (const k of written) assert.ok(RENDERER_KEYS.includes(k), k);
  for (const k of ['accounts', 'watchTime', 'extensionPairingCode', 'youtubeExpiredFingerprint', 'signedOutPlatforms', 'rumbleEnabled', 'seventvLastUpdated', 'dashboardStorageMigrated']) {
    assert.ok(!RENDERER_KEYS.includes(k), k);
  }
  assert.deepEqual(rendererConfigPatch(null, mainConfig()).patch, {});
  assert.deepEqual(rendererConfigPatch([1], mainConfig()).patch, {});
  // A key the page holds as undefined is simply not sent: no refusal logged.
  const r = rendererConfigPatch({ startMinimized: undefined, autoOpen: false }, mainConfig());
  assert.deepEqual(r.patch, { autoOpen: false });
  assert.deepEqual(r.refused, []);
});

test('F11 regression: an imported file never brings extensions, a pairing code, accounts or machine state', () => {
  const current = mainConfig();
  const file = {
    streamers: [{ platform: 'youtube', username: '@new' }],
    watchTime: { streamers: { 'youtube:@new': 60 } },
    extensions: ['\\\\host\\share\\x'],
    extensionPairingCode: 12345678,
    accounts: { twitch: 'someone-else' },
    rumbleEnabled: true, onboardingComplete: false, seventvLastUpdated: 'x', launchOnStartup: true,
    youtubeExpiredFingerprint: 'x', signedOutPlatforms: {}, dashboardStorageMigrated: false,
  };
  const r = importedConfig(file, current);
  for (const key of ['extensions', 'extensionPairingCode', 'accounts', 'rumbleEnabled', 'onboardingComplete', 'seventvLastUpdated', 'launchOnStartup', 'youtubeExpiredFingerprint', 'signedOutPlatforms', 'dashboardStorageMigrated']) {
    assert.deepEqual(r.config[key], current[key], key);
    assert.ok(r.ignored.includes(key), key);
  }
  assert.deepEqual(r.config.streamers, [{ platform: 'youtube', username: '@new' }]);
  assert.equal(r.config.watchTime.streamers['youtube:@new'], 60);
  for (const k of ['extensions', 'extensionPairingCode', 'accounts']) assert.ok(!IMPORT_KEYS.includes(k), k);
});

test('F11: damaged values in a backup are refused, one bad streamer never sinks the import', () => {
  const current = mainConfig();
  const r = importedConfig({
    streamers: [null, { platform: 'twitch', username: 'ok' }, { username: 'x' }, { platform: 'myspace', username: 'x' },
      { platform: 'KICK', username: ' Mixed ', mode: 'notify' }, { platform: 'kick', username: 'mixed' },
      { platform: 'twitch', username: '../../api' }, { platform: 'youtube', username: 'a b' }, { platform: 'twitch', username: 42 }],
    watchTime: { streamers: [], platforms: { twitch: 'lots', kick: 5 }, daily: { d: -1, e: 2 }, sessions: 'x' },
    checkInterval: 0, maxKickTabs: 'abc', defaultQuality: 'source', autoOpen: 'true', notificationsEnabled: false,
    twitchClientSecret: 7, calendarEvents: 'none',
  }, current);
  assert.deepEqual(r.config.streamers, [
    { platform: 'twitch', username: 'ok' },
    { platform: 'kick', username: 'Mixed', mode: 'notify' },
    { platform: 'twitch', username: '42' },
  ]);
  assert.deepEqual(r.dropped.map(d => d.reason), ['not an object', 'unknown platform', 'unknown platform', 'duplicate', 'not a channel name', 'not a channel name']);
  assert.ok(r.dropped.every(d => Number.isInteger(d.index) && 'entry' in d), 'kept whole, for the salvage file');
  assert.deepEqual(r.config.watchTime.streamers, {}, '[] is not a watch-time map');
  assert.deepEqual(r.config.watchTime.platforms, { kick: 5, twitch: 0, youtube: 0, rumble: 0 });
  assert.deepEqual(r.config.watchTime.daily, { e: 2 });
  assert.equal(r.config.watchTime.sessions, 0);
  assert.equal(r.config.checkInterval, 1);
  assert.equal(r.config.maxKickTabs, 2, 'kept this machine\'s');
  assert.equal(r.config.defaultQuality, 'source');
  assert.equal(r.config.autoOpen, true, 'kept');
  assert.equal(r.config.notificationsEnabled, false);
  assert.equal(r.config.twitchClientSecret, 'secret');
  assert.deepEqual(r.config.calendarEvents, []);
  assert.deepEqual(r.refused.map(x => x.key).sort(), ['autoOpen', 'calendarEvents', 'maxKickTabs', 'twitchClientSecret'].sort());
});

test('F11: not a backup at all is null; a legitimate older backup imports whole', () => {
  const current = mainConfig();
  for (const bad of [null, [], { streamers: [] }, { watchTime: {} }, { streamers: {}, watchTime: {} }, { streamers: [], watchTime: [] }]) {
    assert.equal(importedConfig(bad, current), null, JSON.stringify(bad));
  }
  // An old backup: no streamerLastSeen, no daily, no mode fields.
  const old = { streamers: [{ platform: 'twitch', username: 'x' }], watchTime: { streamers: { 'twitch:x': 10 }, platforms: { twitch: 10 }, sessions: 2 }, checkInterval: 5 };
  const r = importedConfig(old, current);
  assert.deepEqual(r.config.watchTime, {
    streamers: { 'twitch:x': 10 }, platforms: { twitch: 10, kick: 0, youtube: 0, rumble: 0 }, streamerSessions: {},
    daily: {}, streamerLongestMs: {}, streamerLastSeen: {}, sessions: 2, longestSessionMs: 0,
  });
  assert.equal(r.config.checkInterval, 5);
  assert.deepEqual(r.dropped, []);
  assert.equal(importedStreamer({ platform: 'youtube', username: '@Some.Channel-name_1' }).streamer.username, '@Some.Channel-name_1');
  assert.equal(importedWatchTime([]), null);
});

test('F11: repairWatchTime makes every container usable without touching entries', () => {
  const cfg = { watchTime: { streamers: [], platforms: null, sessions: 'x', daily: { d: 1 }, streamerLastSeen: { k: 'odd' } } };
  const repaired = repairWatchTime(cfg);
  assert.deepEqual(repaired.sort(), ['watchTime.platforms', 'watchTime.sessions', 'watchTime.streamers'].sort());
  assert.deepEqual(cfg.watchTime.streamers, {});
  assert.deepEqual(cfg.watchTime.platforms, { twitch: 0, kick: 0, youtube: 0, rumble: 0 });
  assert.equal(cfg.watchTime.sessions, 0);
  assert.deepEqual(cfg.watchTime.daily, { d: 1 });
  assert.deepEqual(cfg.watchTime.streamerLastSeen, { k: 'odd' }, 'entries are left alone');
  const fresh = {};
  assert.deepEqual(repairWatchTime(fresh), [], 'a missing watchTime is a new install, not a repair');
  assert.deepEqual(Object.keys(fresh.watchTime).sort(), ['daily', 'longestSessionMs', 'platforms', 'sessions', 'streamerLastSeen', 'streamerLongestMs', 'streamerSessions', 'streamers']);
  const arr = { watchTime: [] };
  assert.deepEqual(repairWatchTime(arr).includes('watchTime'), true);
  // A minute written after the repair survives a save.
  arr.watchTime.streamers['twitch:a'] = 1;
  assert.equal(JSON.parse(JSON.stringify(arr)).watchTime.streamers['twitch:a'], 1);
});

test('F55: an export carries no pairing code or cookie-jar markers, and main\'s config is untouched', () => {
  const current = mainConfig();
  const out = exportableConfig(current);
  assert.equal('extensionPairingCode' in out, false);
  assert.equal('youtubeExpiredFingerprint' in out, false);
  assert.equal('signedOutPlatforms' in out, false);
  assert.equal(JSON.stringify(out).includes('ABCDEF12'), false);
  assert.equal(current.extensionPairingCode, 'ABCDEF12');
  assert.deepEqual(out.streamers, current.streamers);
  assert.equal(out.twitchClientSecret, 'secret', 'kept on purpose: restoring a setup needs it');
  // And importing that export (or an old one that has the code) keeps ours.
  const old = { ...staleCopy(current), extensionPairingCode: '99999999' };
  assert.equal(importedConfig(old, { ...current, extensionPairingCode: 'LOCALCODE' }).config.extensionPairingCode, 'LOCALCODE');
});

test('F17: stored pairing codes: 8 to 64 upper-case hex; new ones are 128-bit', () => {
  assert.equal(normalizePairingCode('abcdef12'), 'ABCDEF12', 'an existing 8-character code is kept, not rotated');
  assert.equal(normalizePairingCode(' ABCDEF12 '), 'ABCDEF12');
  for (const bad of [12345678, '0000', 'GHIJKLMN', '', null, undefined, 'A'.repeat(65), {}]) {
    assert.equal(normalizePairingCode(bad), null, JSON.stringify(bad));
  }
  const code = newPairingCode(crypto.randomBytes);
  assert.match(code, /^[0-9A-F]{32}$/);
  assert.notEqual(newPairingCode(crypto.randomBytes), code);
  assert.equal(normalizePairingCode(code), code);
});

test('F89 layer 2: channel names are checked per platform, case-insensitively', () => {
  const ok = [
    ['twitch', 'xQc'], ['twitch', 'a_b_1'], ['twitch', 'x'.repeat(25)], ['twitch', 42],
    ['kick', 'Some-Slug_2'], ['KICK', 'adin'],
    ['youtube', '@Some.Channel-name_1'], ['youtube', 'plainhandle'], ['youtube', 'UCabcdefghijklmnopqrstuv'],
    ['youtube', '@日本語チャンネル'], ['youtube', '@Café'],
    ['rumble', 'c.name-1'],
  ];
  for (const [p, u] of ok) assert.equal(channelNameProblem(p, u), null, `${p}:${u}`);
  const bad = [
    ['twitch', 'x'.repeat(26)], ['twitch', 'has-dash'], ['twitch', 'a.b'], ['twitch', 'https://www.twitch.tv/xqc'],
    ['kick', 'dot.name'], ['kick', 'a b'],
    ['youtube', '@@double'], ['youtube', 'x" onmouseover="1'], ['youtube', 'channel/UCabc'], ['youtube', '<b>'],
    ['youtube', `@${'y'.repeat(101)}`],
    ['twitch', 'x" webpreferences="contextIsolation=no'],
  ];
  for (const [p, u] of bad) assert.match(channelNameProblem(p, u), /not a valid/, `${p}:${u}`);
  assert.match(channelNameProblem('twitch', 'https://www.twitch.tv/xqc'), /not a link/);
  assert.equal(channelNameProblem('myspace', 'x'), 'Unknown platform.');
  assert.equal(channelNameProblem('twitch', '   '), 'Username cannot be empty');
  assert.equal(channelNameProblem('twitch', null), 'Username cannot be empty');
});

test('F89 layer 2: an import checks names only for entries this install does not have yet', () => {
  const current = { ...mainConfig(), streamers: [{ platform: 'twitch', username: 'Old-Name', mode: 'notify' }] };
  const r = importedConfig({
    streamers: [
      { platform: 'twitch', username: 'old-name', mode: 'notify' }, // already monitored here: kept as stored
      { platform: 'twitch', username: 'new-name' },                 // new and not a Twitch name
      { platform: 'kick', username: 'fine_name' },
    ],
    watchTime: { streamers: { 'twitch:old-name': 90 } },
  }, current);
  assert.deepEqual(r.config.streamers, [{ platform: 'twitch', username: 'old-name', mode: 'notify' }, { platform: 'kick', username: 'fine_name' }]);
  assert.deepEqual(r.dropped.map(d => [d.index, d.reason]), [[1, 'not a valid channel name']]);
  assert.equal(r.config.watchTime.streamers['twitch:old-name'], 90, 'its history comes with it');
});

test('F53 item 3: a platform connected in the app blocks re-sync with its own reason', () => {
  let map = withSignedOut(undefined, 'twitch', true, 111, 'app-login');
  assert.deepEqual(map, { twitch: { at: 111, reason: 'app-login' } });
  assert.equal(isSignedOutIn(map, 'twitch'), true, 'an older build reading this still refuses');
  assert.equal(signedOutReasonIn(map, 'twitch'), 'app-login');
  map = withSignedOut(map, 'kick', true, 222);
  assert.equal(signedOutReasonIn(map, 'kick'), 'signed-out');
  assert.equal(map.kick, 222, 'a sign-out is stored exactly as before');
  // A sign-out after an app login replaces the reason; clearing removes it.
  map = withSignedOut(map, 'twitch', true, 333, 'signed-out');
  assert.equal(signedOutReasonIn(map, 'twitch'), 'signed-out');
  map = withSignedOut(map, 'twitch', false);
  assert.equal(signedOutReasonIn(map, 'twitch'), null);
  for (const damaged of [undefined, null, [], 'x', { twitch: 0 }, { twitch: { reason: 'app-login' } }]) {
    const reason = signedOutReasonIn(damaged, 'twitch');
    assert.equal(reason, isSignedOutIn(damaged, 'twitch') ? 'app-login' : null, JSON.stringify(damaged));
  }
  // Never crosses a boundary: not exported, not imported, not the dashboard's.
  assert.equal('signedOutPlatforms' in exportableConfig({ signedOutPlatforms: map }), false);
  assert.ok(!RENDERER_KEYS.includes('signedOutPlatforms') && !IMPORT_KEYS.includes('signedOutPlatforms'));
});

test('C1: signed-out state defaults to not signed out and round-trips', () => {
  for (const damaged of [undefined, null, [], 'twitch', 5]) assert.equal(isSignedOutIn(damaged, 'twitch'), false);
  let map = withSignedOut(undefined, 'twitch', true, 111);
  assert.deepEqual(map, { twitch: 111 });
  assert.equal(isSignedOutIn(map, 'twitch'), true);
  assert.equal(isSignedOutIn(map, 'kick'), false);
  assert.equal(isSignedOutIn(map, 'constructor'), false, 'own keys only');
  const before = map;
  map = withSignedOut(map, 'twitch', false);
  assert.deepEqual(map, {});
  assert.deepEqual(before, { twitch: 111 }, 'a new object each time');
  assert.deepEqual(withSignedOut([], 'kick', true, 5), { kick: 5 });
});

// ---------------------------------------------------------------------------
// Edges pinned by mutation testing (StrykerJS over main/config-boundary.js):
// each test below fails on a mutant the tests above let through. Values such
// as NaN, Infinity and undefined are real inputs: IPC is a structured clone,
// which keeps all three, and JSON.parse turns 1e999 into Infinity.

test('F18: every quality the Settings <select> offers saves, from the dashboard and from a backup', () => {
  // The <option> values of index.html's quality select.
  for (const q of ['160p', '360p', '480p', '720p', 'source']) {
    const current = { ...mainConfig(), defaultQuality: q === 'source' ? '160p' : 'source' };
    assert.equal(merge(current, { defaultQuality: q }).next.defaultQuality, q, q);
    assert.equal(importedConfig({ streamers: [], watchTime: {}, defaultQuality: q }, current).config.defaultQuality, q, q);
  }
});

test('F18: a numeric setting that is not a number is refused and keeps main\'s value, never the default', () => {
  // main has 5 and the default is 3, so a value coerced to the default shows.
  const current = { ...mainConfig(), checkInterval: 5 };
  for (const bad of ['', '   ', 'abc', NaN, Infinity, -Infinity, null, true, [], {}]) {
    const { next, refused } = merge(current, { checkInterval: bad });
    assert.equal(next.checkInterval, 5, String(bad));
    assert.deepEqual(refused, [{ key: 'checkInterval', reason: 'not a number' }], String(bad));
  }
  const imported = importedConfig({ streamers: [], watchTime: {}, checkInterval: ' ' }, current);
  assert.equal(imported.config.checkInterval, 5);
  assert.deepEqual(imported.refused, [{ key: 'checkInterval', reason: 'not a number' }]);
  // A numeric string (a range input's value) still counts, clamped.
  assert.equal(merge(current, { checkInterval: ' 7 ' }).next.checkInterval, 7);
  assert.equal(merge(current, { checkInterval: '120' }).next.checkInterval, 60);
});

test('F18: the Twitch client id and secret are capped at 200 characters', () => {
  const { next } = merge(mainConfig(), { twitchClientId: ` ${'i'.repeat(500)} `, twitchClientSecret: 's'.repeat(201) });
  assert.equal(next.twitchClientId, 'i'.repeat(200));
  assert.equal(next.twitchClientSecret, 's'.repeat(200));
  const imported = importedConfig({ streamers: [], watchTime: {}, twitchClientId: 'j'.repeat(300) }, mainConfig());
  assert.equal(imported.config.twitchClientId, 'j'.repeat(200));
});

test('F18: a calendar event keeps booleans and nulls, drops non-finite numbers, and holds 20 fields at most', () => {
  const current = mainConfig();
  const ev = { id: 'e', done: true, hidden: false, note: null, day: NaN, time: Infinity, low: -Infinity };
  assert.deepEqual(merge(current, { calendarEvents: [ev] }).next.calendarEvents, [{ id: 'e', done: true, hidden: false, note: null }]);
  // Twenty kept fields; a dropped one (nested) does not use up a slot.
  const fields = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i]));
  const wide = merge(current, { calendarEvents: [{ nested: { a: 1 }, ...fields(30) }, fields(21), fields(20)] }).next.calendarEvents;
  assert.deepEqual(wide.map(e => Object.keys(e).length), [20, 20, 20]);
  assert.deepEqual(wide[0], fields(20));
});

test('F18: the auto-quality flags are an object of true flags, bounded in count and key length', () => {
  const current = { ...mainConfig(), disabledAutoQuality: { 'twitch:a': true } };
  // Anything but an object is refused and main's map stays: a list used to
  // come through as {} and clear every flag.
  for (const bad of [[], [true], 'twitch:a', 5, null]) {
    const { next, patch, refused } = merge(current, { disabledAutoQuality: bad });
    assert.deepEqual(next.disabledAutoQuality, { 'twitch:a': true }, JSON.stringify(bad));
    assert.equal('disabledAutoQuality' in patch, false, JSON.stringify(bad));
    assert.deepEqual(refused, [{ key: 'disabledAutoQuality', reason: 'not an object' }], JSON.stringify(bad));
  }
  // A key of 200 characters is the longest kept.
  const k200 = 'k'.repeat(200);
  assert.deepEqual(merge(current, { disabledAutoQuality: { [k200]: true, [`${k200}x`]: true } }).next.disabledAutoQuality, { [k200]: true });
  // 5000 flags at most, the first ones; a skipped entry does not use up a slot.
  const many = { skipped: 'yes', ...Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`twitch:n${i}`, true])) };
  const kept = merge(current, { disabledAutoQuality: many }).next.disabledAutoQuality;
  assert.equal(Object.keys(kept).length, 5000);
  assert.equal(kept['twitch:n4999'], true);
  assert.equal('twitch:n5000' in kept, false);
  // A backup's map goes through the same checks, and a bad one keeps this machine's.
  assert.deepEqual(importedConfig({ streamers: [], watchTime: {}, disabledAutoQuality: { 'kick:b': true, 'kick:c': 1 } }, current).config.disabledAutoQuality, { 'kick:b': true });
  const bad = importedConfig({ streamers: [], watchTime: {}, disabledAutoQuality: [] }, current);
  assert.deepEqual(bad.config.disabledAutoQuality, { 'twitch:a': true });
  assert.deepEqual(bad.refused, [{ key: 'disabledAutoQuality', reason: 'not an object' }]);
});

test('F18: a streamer from the dashboard finds main\'s entry by trimmed, lower-cased platform:name, numbers included', () => {
  const stored = [{ platform: 'twitch', username: 'Old-Name', mode: 'notify' }, { platform: 'twitch', username: '42', mode: 'notify' }];
  const current = { ...mainConfig(), streamers: stored };
  // Padding and a numeric name still match: main's entry, spelled as stored and with its mode.
  const r = merge(current, { streamers: [{ platform: ' Twitch ', username: ' old-name ' }, { platform: 'twitch', username: 42 }] });
  assert.deepEqual(r.next.streamers, stored);
  assert.deepEqual(r.refused, []);
});

test('F18: an entry without a usable name never stands in for a stored channel', () => {
  // NaN, Infinity, null and undefined are all valid Twitch channel names as text.
  const stored = ['NaN', 'Infinity', 'null', 'undefined'].map(username => ({ platform: 'twitch', username, mode: 'notify' }));
  const current = { ...mainConfig(), streamers: stored };
  const { patch, refused } = rendererConfigPatch({ streamers: [
    { platform: 'twitch', username: NaN, mode: 'ignore' },
    { platform: 'twitch', username: Infinity, mode: 'ignore' },
    { platform: 'twitch', username: null, mode: 'ignore' },
    { platform: 'twitch', mode: 'ignore' },
  ] }, current);
  assert.deepEqual(patch.streamers, [], 'nothing matched, so all four stored entries were removed, none re-moded');
  assert.deepEqual(refused.map(x => x.reason), [
    'no username: twitch:NaN', 'no username: twitch:Infinity', 'no username: twitch:object', 'no username: twitch:undefined',
  ]);
});

test('F18: an entry without a text platform is refused, not a crash', () => {
  const { patch, refused } = rendererConfigPatch({ streamers: [{ username: 'x' }, { platform: 5, username: 'y' }] }, mainConfig());
  assert.deepEqual(patch.streamers, []);
  assert.deepEqual(refused.map(x => x.reason), ['unknown platform: undefined:x', 'unknown platform: 5:y']);
});

test('F18: when main\'s own list holds a channel twice (a hand edit), the first entry is the one kept', () => {
  const current = { ...mainConfig(), streamers: [{ platform: 'twitch', username: 'Dup', mode: 'notify' }, { platform: 'twitch', username: 'dup', mode: 'ignore' }] };
  assert.deepEqual(merge(current, { streamers: [{ platform: 'twitch', username: 'DUP' }] }).next.streamers, [{ platform: 'twitch', username: 'Dup', mode: 'notify' }]);
});

test('F18: a new channel sent twice in one save goes in once', () => {
  const current = mainConfig();
  const r = merge(current, { streamers: [...current.streamers, { platform: 'kick', username: 'new_one' }, { platform: 'KICK', username: 'NEW_ONE ' }] });
  assert.deepEqual(r.next.streamers, [...current.streamers, { platform: 'kick', username: 'new_one' }]);
  assert.deepEqual(r.refused, [{ key: 'streamers', reason: 'duplicate: KICK:NEW_ONE ' }]);
});

test('F18: streamer ids fold case like watch-history keys (toLowerCase), so distinct channels stay distinct', () => {
  // Upper-casing would merge them: 'ß' becomes 'SS', and a dotless 'ı' becomes 'I'.
  const current = { ...mainConfig(), streamers: [{ platform: 'youtube', username: '@straße' }, { platform: 'twitch', username: 'a', mode: 'notify' }] };
  const r = merge(current, { streamers: [
    { platform: 'youtube', username: '@straße' }, { platform: 'youtube', username: '@strasse' }, { platform: 'twıtch', username: 'a' },
  ] });
  assert.deepEqual(r.next.streamers, [{ platform: 'youtube', username: '@straße' }, { platform: 'youtube', username: '@strasse' }]);
  assert.deepEqual(r.refused, [{ key: 'streamers', reason: 'unknown platform: twıtch:a' }]);
});

test('F18: a refused streamer is described in one short line whatever it holds', () => {
  const { refused } = rendererConfigPatch({ streamers: [
    [1], 'x', 5, true, { platform: {}, username: 42 }, { platform: 'myspace', username: 'y'.repeat(100) },
  ] }, mainConfig());
  assert.deepEqual(refused.map(x => x.reason), [
    'not an object: a list', 'not an object: a string', 'not an object: a number', 'not an object: a boolean',
    'unknown platform: object:42', `unknown platform: myspace:${'y'.repeat(40)}`,
  ]);
});

test('F11: an imported streamer\'s platform is trimmed, and a missing, non-finite or blank name is refused with its reason', () => {
  assert.deepEqual(importedStreamer({ platform: ' Twitch ', username: 'x' }), { streamer: { platform: 'twitch', username: 'x' } });
  const cases = [[undefined, 'no username'], [null, 'no username'], [NaN, 'no username'], [Infinity, 'no username'],
    [{}, 'no username'], [['x'], 'no username'], ['', 'empty username'], ['   ', 'empty username']];
  for (const [username, reason] of cases) {
    assert.deepEqual(importedStreamer({ platform: 'twitch', username }), { reason }, String(username));
  }
  assert.deepEqual(importedStreamer({ platform: 'twitch' }), { reason: 'no username' });
  // 100 characters is the longest name taken.
  assert.deepEqual(importedStreamer({ platform: 'kick', username: 'k'.repeat(100) }), { streamer: { platform: 'kick', username: 'k'.repeat(100) } });
  assert.deepEqual(importedStreamer({ platform: 'kick', username: 'k'.repeat(101) }), { reason: 'not a channel name' });
});

test('F89 layer 2: channelNameProblem takes a padded platform, refuses non-text names, and anchors Rumble\'s rule too', () => {
  assert.equal(channelNameProblem(' Twitch ', 'xqc'), null);
  for (const p of [null, undefined, 5, {}]) assert.equal(channelNameProblem(p, 'x'), 'Unknown platform.', String(p));
  for (const u of [NaN, Infinity, {}, ['x'], true, undefined]) {
    assert.equal(channelNameProblem('twitch', u), 'Username cannot be empty', String(u));
  }
  // A pasted URL or a name with a slash or space is not a Rumble name either.
  for (const u of ['https://rumble.com/c/name', 'name/extra', 'a b']) assert.match(channelNameProblem('rumble', u), /not a valid Rumble/, u);
});

test('F89 layer 2: the add-streamer error names the platform and its rule, and says "not a link" only for a link', () => {
  for (const [p, u, label] of [['twitch', 'has-dash', 'Twitch'], ['kick', 'dot.name', 'Kick'], ['youtube', '<b>', 'YouTube'], ['rumble', 'a b', 'Rumble']]) {
    const msg = channelNameProblem(p, u);
    assert.match(msg, new RegExp(`^That is not a valid ${label} channel name \\(.+\\)\\.$`), msg);
  }
  assert.match(channelNameProblem('kick', 'kick.com/name'), /\)\. Enter the channel name, not a link\.$/);
});

test('F11: the import reports as ignored exactly the keys it did not read', () => {
  const current = mainConfig();
  const r = importedConfig({ ...staleCopy(current), disabledAutoQuality: { 'twitch:x': true }, somethingNew: 1 }, current);
  assert.deepEqual(r.ignored.sort(), ['accounts', 'dashboardStorageMigrated', 'extensionPairingCode', 'extensions', 'launchOnStartup',
    'onboardingComplete', 'rumbleEnabled', 'seventvLastUpdated', 'signedOutPlatforms', 'somethingNew', 'youtubeExpiredFingerprint']);
  assert.deepEqual(r.config.disabledAutoQuality, { 'twitch:x': true });
  assert.deepEqual(r.refused, []);
});

test('F11: a damaged entry in this install\'s own list never breaks an import', () => {
  const current = { ...mainConfig(), streamers: [null, 'x', { username: 'x' }, { platform: 5, username: 'y' }, { platform: 'twitch', username: 'Old-Name' }] };
  const r = importedConfig({ streamers: [{ platform: 'twitch', username: 'old-name' }], watchTime: {} }, current);
  assert.deepEqual(r.config.streamers, [{ platform: 'twitch', username: 'old-name' }], 'still recognised as monitored here (F89)');
  assert.deepEqual(r.dropped, []);
});

test('F11: a backup\'s watch time keeps zero minutes and drops negatives, text and what JSON turns into Infinity', () => {
  const file = JSON.parse('{"streamers":{"twitch:a":0,"twitch:b":1e999,"twitch:c":-1,"twitch:d":5},"sessions":"5","longestSessionMs":1e999}');
  const wt = importedWatchTime(file);
  assert.deepEqual(wt.streamers, { 'twitch:a': 0, 'twitch:d': 5 });
  assert.equal(wt.sessions, 0, 'a string is not a count');
  assert.equal(wt.longestSessionMs, 0);
  assert.equal(importedWatchTime({ sessions: -3 }).sessions, 0);
  assert.equal(importedWatchTime({ sessions: 4, longestSessionMs: 0 }).sessions, 4);
});

test('F11: repairWatchTime leaves healthy totals alone and resets non-finite ones', () => {
  const healthy = { watchTime: { streamers: {}, platforms: { twitch: 1, kick: 0, youtube: 0, rumble: 0 }, streamerSessions: {}, daily: {},
    streamerLongestMs: {}, streamerLastSeen: {}, sessions: 9, longestSessionMs: 3600000 } };
  const before = staleCopy(healthy);
  assert.deepEqual(repairWatchTime(healthy), []);
  assert.deepEqual(healthy, before, 'minutes are never reset on a healthy config');
  // NaN (a bad sum in memory) or Infinity (1e999 in the file) would stick: NaN + 1 is NaN.
  const bad = { watchTime: { sessions: NaN, longestSessionMs: Infinity } };
  assert.deepEqual(repairWatchTime(bad), ['watchTime.sessions', 'watchTime.longestSessionMs']);
  assert.equal(bad.watchTime.sessions, 0);
  assert.equal(bad.watchTime.longestSessionMs, 0);
});

test('F18: extensions: non-text entries are skipped silently, and a clean save reports nothing', () => {
  const current = mainConfig();
  const [one, sevenTv] = current.extensions;
  const r = rendererConfigPatch({ extensions: [sevenTv, 5, null, '', {}, one] }, current);
  assert.deepEqual(r.patch.extensions, [sevenTv, one]);
  assert.deepEqual([r.refused, r.approvedUsed, r.keptExtensions], [[], [], []]);
  // Without an extensions key, no approval is spent and nothing is kept.
  const s = rendererConfigPatch({ autoOpen: false }, current, { approvedExtensions: new Set(['D:\\x']), dashboardExtensions: new Set() });
  assert.deepEqual([s.approvedUsed, s.keptExtensions], [[], []]);
  // A list that is not a list is refused whole, with its key.
  assert.deepEqual(rendererConfigPatch({ extensions: 'C:\\x' }, current).refused, [{ key: 'extensions', reason: 'not a list' }]);
  // A config with no extension list knows no folder: none matched, none kept.
  const bare = rendererConfigPatch({ extensions: ['C:\\ext\\one'] }, { streamers: [] }, { dashboardExtensions: new Set() });
  assert.deepEqual([bare.patch.extensions, bare.keptExtensions], [[], []]);
});

test('F18: extension refusals log ten lines at most, each path cut to 160 characters', () => {
  const long = `D:\\${'x'.repeat(1000)}`;
  assert.deepEqual(rendererConfigPatch({ extensions: [long] }, mainConfig()).refused,
    [{ key: 'extensions', reason: `folder not picked in Stream Lurker's own dialog: ${long.slice(0, 160)}` }]);
  const evil = (n) => Array.from({ length: n }, (_, i) => `D:\\evil${i}`);
  assert.equal(rendererConfigPatch({ extensions: evil(10) }, mainConfig()).refused.length, 10, 'exactly ten: no "0 more" line');
  const eleven = rendererConfigPatch({ extensions: evil(11) }, mainConfig()).refused;
  assert.equal(eleven.length, 11);
  assert.equal(eleven[10].reason, '1 more entries refused');
});

test('F18: a save that is not an object is refused whole, in one log line', () => {
  for (const bad of [null, [1], 'x', 5]) {
    assert.deepEqual(rendererConfigPatch(bad, mainConfig()),
      { patch: {}, refused: [{ key: '(config)', reason: 'not an object' }], approvedUsed: [], keptExtensions: [] }, JSON.stringify(bad));
  }
});

test('C1: only an app-login record reads as app-login; changing one platform keeps the others', () => {
  // A plain-object value of another shape (a newer build's) still blocks as a sign-out.
  for (const v of [{ at: 1 }, { at: 1, reason: 'signed-out' }, { at: 1, reason: 'future' }]) {
    assert.equal(signedOutReasonIn({ twitch: v }, 'twitch'), 'signed-out', JSON.stringify(v));
  }
  const others = { kick: 5, youtube: { at: 6, reason: 'app-login' } };
  assert.deepEqual(withSignedOut(others, 'twitch', true, 7), { ...others, twitch: 7 });
  assert.deepEqual(withSignedOut({ ...others, twitch: 7 }, 'twitch', false), others);
});
