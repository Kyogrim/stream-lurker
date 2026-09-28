// Gate tests for main/config-sanitize.js: numeric settings and the streamer
// list are made safe wherever a config enters (load, import, save), without
// silently losing anything. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SETTING_RANGES, clampSetting, scanIntervalMs, normalizeConfigNumbers, normalizeStreamers, sanitizeConfig,
  streamerPlatform, streamerName,
} = require('../main/config-sanitize');

test('F66: checkInterval is clamped to 1-60 minutes; non-numbers fall back to 3', () => {
  const cases = [[null, 3], [0, 1], [-5, 1], ['abc', 3], ['', 3], ['5', 5], [1e9, 60], [3, 3], [NaN, 3], [Infinity, 3], [2.6, 3], [undefined, 3], [{}, 3], [true, 3]];
  for (const [input, expected] of cases) {
    assert.equal(clampSetting(input, SETTING_RANGES.checkInterval), expected, JSON.stringify(input));
  }
});

test('F66: tab limits are clamped to 1-10; non-numbers fall back to 2', () => {
  for (const key of ['maxTwitchTabs', 'maxKickTabs', 'maxYoutubeTabs', 'maxRumbleTabs']) {
    assert.equal(clampSetting(null, SETTING_RANGES[key]), 2);
    assert.equal(clampSetting(0, SETTING_RANGES[key]), 1);
    assert.equal(clampSetting(50, SETTING_RANGES[key]), 10);
    assert.equal(clampSetting('4', SETTING_RANGES[key]), 4);
  }
});

test('F66: the scan interval can never reach setInterval as 0, NaN or past 2^31-1 ms', () => {
  for (const v of [null, 0, -1, 'abc', '', NaN, 1e12, undefined]) {
    const ms = scanIntervalMs({ checkInterval: v });
    assert.ok(ms >= 60000 && ms <= 3600000, `${v} -> ${ms}`);
  }
  assert.equal(scanIntervalMs({ checkInterval: 3 }), 180000);
  assert.equal(scanIntervalMs(null), 180000);
});

test('F66: normalizeConfigNumbers fixes in place, reports changes, leaves absent keys absent', () => {
  const cfg = { checkInterval: null, maxTwitchTabs: '3', maxKickTabs: 2, other: 'x' };
  const changes = normalizeConfigNumbers(cfg);
  assert.deepEqual(cfg, { checkInterval: 3, maxTwitchTabs: 3, maxKickTabs: 2, other: 'x' });
  assert.deepEqual(changes, [{ key: 'checkInterval', from: null, to: 3 }, { key: 'maxTwitchTabs', from: '3', to: 3 }]);
  assert.deepEqual(normalizeConfigNumbers(null), []);
});

test('G2.2: unusable streamer entries are dropped and reported; usable ones are kept intact', () => {
  const input = [
    null,
    { username: 'x' },
    { platform: 'kick', username: 123 },
    { platform: 'Twitch', username: ' a ', mode: 'notify' },
    'str',
    { platform: 'rumble', username: 'r' },
    { platform: 'kick', username: '   ' },
    { platform: 'youtube', username: '@chan' },
    { platform: 'kick', username: NaN },
    [1, 2],
  ];
  const { streamers, dropped } = normalizeStreamers(input);
  assert.deepEqual(streamers, [
    { platform: 'kick', username: '123' },
    { platform: 'twitch', username: 'a', mode: 'notify' },
    { platform: 'rumble', username: 'r' },
    { platform: 'youtube', username: '@chan' },
  ]);
  assert.equal(streamers[3], input[7], 'an already-clean entry is the same object');
  assert.deepEqual(dropped.map(d => [d.index, d.reason]), [
    [0, 'not an object'], [1, 'no platform'], [4, 'not an object'], [6, 'empty username'], [8, 'no username'], [9, 'not an object'],
  ]);
  assert.equal('mode' in streamers[0], false, 'a missing mode stays missing (reads as auto)');
});

test('G2.2: a non-list streamers value becomes an empty list, preserved when it held something', () => {
  assert.deepEqual(normalizeStreamers(null), { streamers: [], dropped: [] });
  assert.deepEqual(normalizeStreamers(undefined), { streamers: [], dropped: [] });
  assert.deepEqual(normalizeStreamers({}), { streamers: [], dropped: [{ entry: {}, reason: 'the streamers value is not a list' }] });
});

test('G2.2: sanitizeConfig runs both and makes a scan-style filter safe', () => {
  const cfg = { checkInterval: 0, streamers: [null, { username: 'xqc', mode: 'auto' }, { platform: 'kick', username: 123 }] };
  const { clamped, dropped } = sanitizeConfig(cfg);
  assert.equal(cfg.checkInterval, 1);
  assert.equal(clamped.length, 1);
  assert.equal(dropped.length, 2);
  // The expression that used to throw on every scan.
  assert.doesNotThrow(() => cfg.streamers.filter(s => s.platform.toLowerCase() === 'kick').map(s => s.username.toLowerCase()));
  assert.deepEqual(sanitizeConfig(null), { clamped: [], dropped: [] });
  assert.deepEqual(sanitizeConfig([]), { clamped: [], dropped: [] });
});

test('streamerPlatform / streamerName never throw', () => {
  for (const bad of [null, undefined, 'x', 5, {}, { platform: 3 }, { username: {} }]) {
    assert.equal(streamerPlatform(bad), '');
    assert.equal(typeof streamerName(bad), 'string');
  }
  assert.equal(streamerPlatform({ platform: 'KICK' }), 'kick');
  assert.equal(streamerName({ username: 42 }), '42');
});
