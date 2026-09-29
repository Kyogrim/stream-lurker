// Gate tests for main/config-sanitize.js: numeric settings and the streamer
// list are made safe wherever a config enters (load, import, save), without
// silently losing anything. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SETTING_RANGES, clampSetting, scanIntervalMs, normalizeConfigNumbers, normalizeStreamers, sanitizeConfig, normalizeEventList,
  streamerPlatform, streamerName, droppedStreamerLines, MAX_LOGGED_ENTRIES,
} = require('../main/config-sanitize');
const { importedConfig } = require('../main/config-boundary');

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

// r4-3: main.js sanitizeIncomingConfig logs these lines, and used to log one
// per dropped entry: a hostile backup of 50,000 junk entries was 50,000
// console writes and IPC messages, and wiped the 200-line activity log.
test('r4-3 regression: an import with 1000 unusable streamer entries logs at most 11 lines', () => {
  const incoming = {
    watchTime: {},
    streamers: [
      ...Array.from({ length: 500 }, () => null),
      ...Array.from({ length: 300 }, (_, i) => ({ platform: 'twitch', username: `bad name ${i} <script>` })),
      ...Array.from({ length: 200 }, () => ({ platform: 'kick', username: 'dupe' })),
    ],
  };
  // The import path in main.js: importedConfig refuses entries, then
  // sanitizeIncomingConfig runs the normalizer and logs both lists together.
  const imported = importedConfig(incoming, { streamers: [] });
  const { dropped: normalizerDropped } = sanitizeConfig(imported.config);
  const dropped = [...imported.dropped, ...normalizerDropped];
  assert.equal(dropped.length, 999, 'every entry but the first "dupe" is set aside');
  const salvage = 'config.json.dropped-streamers-2026-09-27T00-00-00-000Z.json';
  const lines = droppedStreamerLines(dropped, salvage);
  assert.equal(lines.length, MAX_LOGGED_ENTRIES + 1);
  assert.ok(MAX_LOGGED_ENTRIES <= 10);
  lines.slice(0, MAX_LOGGED_ENTRIES).forEach(l => assert.match(l, /^\[Config\] Skipped streamer entry \(not an object\): null$/));
  assert.equal(lines[MAX_LOGGED_ENTRIES], `[Config] Skipped 989 more streamer entries not listed here; all 999 are in ${salvage}.`);
  for (const l of lines) assert.ok(l.length < 300, 'each line is short');
});

test('r4-3: the load path is capped the same way; small lists are listed whole; no file is claimed when saving it failed', () => {
  const cfg = { streamers: Array.from({ length: 50000 }, (_, i) => (i % 2 ? 'x'.repeat(5000) : { username: i })) };
  const { dropped } = sanitizeConfig(cfg);
  assert.equal(dropped.length, 50000);
  const lines = droppedStreamerLines(dropped, null);
  assert.equal(lines.length, MAX_LOGGED_ENTRIES + 1);
  assert.equal(lines[MAX_LOGGED_ENTRIES], `[Config] Skipped ${50000 - MAX_LOGGED_ENTRIES} more streamer entries not listed here.`, 'no salvage file to point at');
  assert.ok(lines.every(l => l.length < 300), 'a 5000-character entry is shown cut short');

  const few = (n) => Array.from({ length: n }, (_, i) => ({ index: i, entry: { platform: 'kick' }, reason: 'no username' }));
  assert.deepEqual(droppedStreamerLines(few(1), 'f.json'), ['[Config] Skipped streamer entry (no username): {"platform":"kick"}']);
  assert.equal(droppedStreamerLines(few(MAX_LOGGED_ENTRIES), 'f.json').length, MAX_LOGGED_ENTRIES, 'exactly the cap: no count line');
  assert.equal(droppedStreamerLines(few(MAX_LOGGED_ENTRIES + 1), 'f.json')[MAX_LOGGED_ENTRIES], `[Config] Skipped 1 more streamer entry not listed here; all ${MAX_LOGGED_ENTRIES + 1} are in f.json.`);
  assert.deepEqual(droppedStreamerLines([], 'f.json'), []);
  assert.deepEqual(droppedStreamerLines(undefined, null), []);
  // An entry JSON cannot show is still described, not thrown on.
  assert.match(droppedStreamerLines([{ entry: 10n, reason: 'not an object' }], null)[0], /: 10$/);
});

test('F93 layer 2: both calendar lists reach the dashboard as lists of event objects', () => {
  const ev = { title: 'a', day: 1, time: '20:00' };
  const cfg = {
    calendarEvents: [ev, null, 'x', 5, ['nested'], { ...ev, title: 'b' }],
    syncedCalendarEvents: { 0: ev },
  };
  const { clamped } = sanitizeConfig(cfg);
  assert.deepEqual(cfg.calendarEvents, [ev, { ...ev, title: 'b' }]);
  assert.equal(cfg.calendarEvents[0], ev, 'kept entries are the same objects, untouched');
  assert.deepEqual(cfg.syncedCalendarEvents, []);
  assert.deepEqual(clamped, [
    { key: 'calendarEvents', from: '6 entries', to: '2 events' },
    { key: 'syncedCalendarEvents', from: 'an object', to: '0 events' },
  ]);
  // Clean lists and absent keys are left exactly as they are, unreported.
  const clean = { calendarEvents: [ev], syncedCalendarEvents: [] };
  assert.deepEqual(sanitizeConfig(clean).clamped, []);
  assert.deepEqual([clean.calendarEvents, clean.syncedCalendarEvents], [[ev], []]);
  const absent = {};
  sanitizeConfig(absent);
  assert.equal('calendarEvents' in absent, false);
  // A damaged value is described in the log, never echoed.
  assert.deepEqual(normalizeEventList('calendarEvents', 'x'.repeat(10000)).change.from, 'a string');
  assert.deepEqual(normalizeEventList('calendarEvents', null).change.from, null);
  assert.equal(normalizeEventList('calendarEvents', undefined), null);
  // The expressions the calendar runs over every entry.
  assert.doesNotThrow(() => cfg.calendarEvents.forEach(e => `${e.title}`.toLowerCase()));
});

test('streamerPlatform / streamerName never throw', () => {
  for (const bad of [null, undefined, 'x', 5, {}, { platform: 3 }, { username: {} }]) {
    assert.equal(streamerPlatform(bad), '');
    assert.equal(typeof streamerName(bad), 'string');
  }
  assert.equal(streamerPlatform({ platform: 'KICK' }), 'kick');
  assert.equal(streamerName({ username: 42 }), '42');
});
