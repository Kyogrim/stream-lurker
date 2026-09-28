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

test('F18: streamers keep order and mode; entries are reduced to their fields; junk is set aside', () => {
  const current = mainConfig();
  const { next, patch } = merge(current, {
    streamers: [
      { platform: 'kick', username: 'b', mode: 'ignore', extra: '<img>' },
      { platform: 'twitch', username: 'a', mode: 'bogus' },
      null,
    ],
  });
  assert.deepEqual(patch.streamers.slice(0, 2), [{ platform: 'kick', username: 'b', mode: 'ignore' }, { platform: 'twitch', username: 'a' }]);
  assert.deepEqual(next.streamers, [{ platform: 'kick', username: 'b', mode: 'ignore' }, { platform: 'twitch', username: 'a' }]);
  assert.deepEqual(merge(current, { streamers: 'x' }).next.streamers, current.streamers);
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
