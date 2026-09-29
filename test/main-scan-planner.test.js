// Gate tests for main/scan-planner.js: what a run of scans does to the open
// cells. Each scenario drives applyScanResults scan after scan, the way
// main.js does, with fakes for the effects. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_TTL_MS, streamKey, sessionKeyFor, evictStale, clearSessionsFor, tabLimitFor,
  buildPriorityMap, choosePreemption, applyScanResults,
} = require('../main/scan-planner');
const { createStreamLiveness } = require('../main/stream-liveness');
const { parseYoutubeLivePage } = require('../main/youtube-live');

const MIN = 60 * 1000;
const INTERVAL = 3 * MIN;
const T0 = Date.UTC(2026, 8, 27, 8, 0, 0);

// The world main.js keeps, plus a record of every effect.
function makeWorld(streamers, configOverrides = {}) {
  const config = { autoOpen: true, maxTwitchTabs: 2, maxKickTabs: 2, maxYoutubeTabs: 2, maxRumbleTabs: 2, ...configOverrides, streamers };
  const w = {
    config,
    activeWindows: new Map(),
    openedSessions: new Map(),
    notifiedSessions: new Map(),
    liveness: createStreamLiveness(),
    notified: [],
    spawned: [],
    closed: [],
    logs: [],
  };
  w.scan = (results, now) => applyScanResults(results, {
    now,
    config,
    activeWindows: w.activeWindows,
    openedSessions: w.openedSessions,
    notifiedSessions: w.notifiedSessions,
    liveness: w.liveness,
    modeOf: (p, u) => {
      const e = config.streamers.find(s => streamKey(s.platform, s.username) === `${p}:${u}`);
      return e && (e.mode === 'notify' || e.mode === 'ignore') ? e.mode : 'auto';
    },
    notify: s => w.notified.push(streamKey(s.platform, s.username)),
    // As spawnStreamContainer does.
    spawn: (p, u) => {
      const key = streamKey(p, u);
      w.activeWindows.set(key, true);
      w.liveness.start(key, now);
      w.spawned.push(key);
    },
    closeTab: (p, u) => w.closed.push(streamKey(p, u)),
    log: t => w.logs.push(t),
  });
  // The user opening or closing a cell in the dashboard.
  w.userOpen = (key, now) => { w.activeWindows.set(key, true); w.liveness.start(key, now); };
  w.userClose = (key) => { w.activeWindows.delete(key); w.liveness.forget(key); };
  return w;
}

const live = (platform, username, fields = {}) => ({ platform, username, isLive: true, title: 't', viewerCount: 1, category: 'c', liveSince: '', ...fields });
const offline = (platform, username) => ({ platform, username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '' });
const errored = (platform, username) => ({ ...offline(platform, username), error: 'timed out after 15s' });

// What checkYoutubeStreamer now returns for a live /live page.
function youtubeLiveResult(username, videoId, start) {
  const html = `<html><link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}">`
    + `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${videoId}","title":"24/7 radio","isLive":true},`
    + `"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"${start}"}}},`
    + `"viewCount":"1234"};</script></html>`;
  const page = parseYoutubeLivePage(html);
  assert.equal(page.isLive, true);
  return { platform: 'youtube', username, isLive: true, title: page.title, viewerCount: page.viewerCount, category: 'YouTube Live', liveSince: page.liveSince, sessionId: page.sessionId };
}

test('session keys: the broadcast id first, then the start time, then the day; never the scan time', () => {
  assert.equal(sessionKeyFor(live('YouTube', '@Chan', { sessionId: 'ab-cd_EF123', liveSince: '2026-09-27T08:00:04.000Z' }), T0), 'youtube:@chan:ab-cd_EF123');
  assert.equal(sessionKeyFor(live('twitch', 'Foo', { liveSince: '2026-09-27T08:00:04Z' }), T0), 'twitch:foo:2026-09-27T08:00:04');
  assert.equal(sessionKeyFor(live('kick', 'bar'), T0), `kick:bar:${new Date(T0).toDateString()}`);
  // Same broadcast seen an hour later: same key.
  const a = youtubeLiveResult('@chan', 'ab-cd_EF123', '2026-09-27T06:00:00+00:00');
  const b = youtubeLiveResult('@chan', 'ab-cd_EF123', '2026-09-27T06:00:00+00:00');
  assert.equal(sessionKeyFor(a, T0), sessionKeyFor(b, T0 + 60 * MIN));
});

test('F12: one live YouTube channel over 20 scans alerts once and opens once', () => {
  const w = makeWorld([{ platform: 'youtube', username: '@lofi' }]);
  for (let i = 0; i < 20; i++) {
    w.scan([youtubeLiveResult('@lofi', 'jfKfPfyJRdk', '2026-09-27T06:00:00+00:00')], T0 + i * INTERVAL);
  }
  assert.deepEqual(w.notified, ['youtube:@lofi']);
  assert.deepEqual(w.spawned, ['youtube:@lofi']);
  assert.deepEqual(w.closed, []);
  assert.equal(w.notifiedSessions.size, 1, 'one dedupe entry, not one per scan');
  assert.equal(w.openedSessions.size, 1);
});

test('F12: a YouTube cell the user closes stays closed for the rest of that broadcast', () => {
  const w = makeWorld([{ platform: 'youtube', username: '@lofi' }]);
  const result = () => youtubeLiveResult('@lofi', 'jfKfPfyJRdk', '2026-09-27T06:00:00+00:00');
  w.scan([result()], T0);
  w.userClose('youtube:@lofi');
  for (let i = 1; i <= 20; i++) w.scan([result()], T0 + i * INTERVAL);
  assert.deepEqual(w.spawned, ['youtube:@lofi']);
  assert.equal(w.activeWindows.size, 0);
  // A new broadcast (new video id) is a new go-live.
  w.scan([youtubeLiveResult('@lofi', 'NEWvideo_01', '2026-09-28T06:00:00+00:00')], T0 + 21 * INTERVAL);
  assert.deepEqual(w.notified, ['youtube:@lofi', 'youtube:@lofi']);
  assert.deepEqual(w.spawned, ['youtube:@lofi', 'youtube:@lofi']);
});

test('F12/F23: two open live YouTube channels at maxYoutubeTabs=2 never churn', () => {
  const w = makeWorld([{ platform: 'youtube', username: '@alpha' }, { platform: 'youtube', username: '@bravo' }]);
  for (let i = 0; i < 20; i++) {
    w.scan([
      youtubeLiveResult('@alpha', 'aaaaaaaaaaa', '2026-09-27T06:00:00Z'),
      youtubeLiveResult('@bravo', 'bbbbbbbbbbb', '2026-09-27T07:00:00Z'),
    ], T0 + i * INTERVAL);
  }
  assert.deepEqual(w.spawned, ['youtube:@alpha', 'youtube:@bravo']);
  assert.deepEqual(w.closed, []);
  assert.equal(w.logs.filter(l => l.includes('Preempting')).length, 0);
});

test('F23: an already-open stream never preempts another, even when its session key changes every scan', () => {
  const w = makeWorld([{ platform: 'youtube', username: '@a' }, { platform: 'youtube', username: '@b' }]);
  w.userOpen('youtube:@a', T0);
  w.userOpen('youtube:@b', T0);
  for (let i = 0; i < 5; i++) {
    const now = T0 + i * INTERVAL;
    // The old bug's shape: a new key per scan.
    w.scan([live('youtube', '@a', { liveSince: new Date(now).toISOString() }), live('youtube', '@b', { liveSince: new Date(now).toISOString() })], now);
  }
  assert.deepEqual(w.spawned, []);
  assert.deepEqual(w.closed, []);
});

test('F23: hand-opened Twitch streams at the limit are left alone', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'one' }, { platform: 'twitch', username: 'two' }]);
  w.userOpen('twitch:one', T0);
  w.userOpen('twitch:two', T0);
  for (let i = 0; i < 3; i++) {
    w.scan([live('twitch', 'one', { liveSince: '2026-09-27T07:00:00Z' }), live('twitch', 'two', { liveSince: '2026-09-27T07:10:00Z' })], T0 + i * INTERVAL);
  }
  assert.deepEqual(w.spawned, []);
  assert.deepEqual(w.closed, []);
  // Recorded, so a cell the user then closes stays closed for the broadcast.
  w.userClose('twitch:two');
  w.scan([live('twitch', 'one', { liveSince: '2026-09-27T07:00:00Z' }), live('twitch', 'two', { liveSince: '2026-09-27T07:10:00Z' })], T0 + 4 * INTERVAL);
  assert.deepEqual(w.spawned, []);
});

test('F23: a genuinely new higher-priority stream at the limit still preempts the lowest-priority one', () => {
  const w = makeWorld([
    { platform: 'twitch', username: 'top' },
    { platform: 'twitch', username: 'mid' },
    { platform: 'twitch', username: 'low' },
  ]);
  const midLive = live('twitch', 'mid', { liveSince: '2026-09-27T07:00:00Z' });
  const lowLive = live('twitch', 'low', { liveSince: '2026-09-27T07:00:00Z' });
  const topLive = live('twitch', 'top', { liveSince: '2026-09-27T08:01:00Z' });
  w.scan([offline('twitch', 'top'), midLive, lowLive], T0);
  assert.deepEqual(w.spawned, ['twitch:mid', 'twitch:low']);

  w.scan([topLive, midLive, lowLive], T0 + INTERVAL);
  assert.deepEqual(w.closed, ['twitch:low']);
  assert.deepEqual(w.spawned, ['twitch:mid', 'twitch:low', 'twitch:top']);
  assert.ok(w.logs.some(l => l.includes('Preempting') && l.includes('low')));

  // Held back while there is no room, with no churn...
  w.scan([topLive, midLive, lowLive], T0 + 2 * INTERVAL);
  assert.deepEqual(w.closed, ['twitch:low']);
  // ...and reopened once a slot frees up.
  w.scan([offline('twitch', 'top'), midLive, lowLive], T0 + 3 * INTERVAL);
  w.scan([offline('twitch', 'top'), midLive, lowLive], T0 + 4 * INTERVAL);
  assert.deepEqual(w.closed, ['twitch:low', 'twitch:top']);
  assert.deepEqual(w.spawned.slice(-1), ['twitch:low']);
});

test('a stream held back by the tab limit is not recorded, so it opens when a slot frees', () => {
  const w = makeWorld([{ platform: 'kick', username: 'a' }, { platform: 'kick', username: 'b' }], { maxKickTabs: 1 });
  w.scan([live('kick', 'a', { liveSince: 'x1' }), live('kick', 'b', { liveSince: 'x2' })], T0);
  assert.deepEqual(w.spawned, ['kick:a']);
  assert.ok(w.logs.some(l => l.startsWith('[Lurk] Limit reached') && l.includes('b')));
  w.userClose('kick:a');
  w.scan([live('kick', 'a', { liveSince: 'x1' }), live('kick', 'b', { liveSince: 'x2' })], T0 + INTERVAL);
  assert.deepEqual(w.spawned, ['kick:a', 'kick:b']);
  assert.deepEqual(w.notified, ['kick:a', 'kick:b'], 'one alert each, no repeat while held back');
});

test('F68: a 24/7 stream is alerted once and a closed cell stays closed across days', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'radio' }]);
  const result = live('twitch', 'radio', { liveSince: '2026-09-20T00:00:00Z' });
  w.scan([result], T0);
  w.userClose('twitch:radio');
  const scans = (3 * SESSION_TTL_MS) / INTERVAL;
  for (let i = 1; i <= scans; i++) w.scan([result], T0 + i * INTERVAL);
  assert.deepEqual(w.notified, ['twitch:radio']);
  assert.deepEqual(w.spawned, ['twitch:radio']);
});

test('F68: dedupe entries are evicted 24h after the last sighting, not the first', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'x' }], { autoOpen: false });
  const result = live('twitch', 'x', { liveSince: '2026-09-27T07:00:00Z' });
  const lastSeen = T0 + 30 * 60 * MIN; // live for 30 hours, seen every scan
  for (let now = T0; now <= lastSeen; now += INTERVAL) w.scan([result], now);
  assert.equal(w.notifiedSessions.size, 1);
  w.scan([offline('twitch', 'x')], lastSeen + SESSION_TTL_MS - MIN);
  assert.equal(w.notifiedSessions.size, 1, 'still inside 24h of the last sighting');
  w.scan([offline('twitch', 'x')], lastSeen + SESSION_TTL_MS + MIN);
  assert.equal(w.notifiedSessions.size, 0);
  assert.deepEqual(w.notified, ['twitch:x']);
});

test('F25: auto-close needs two consecutive clean offline results; errors never close', () => {
  const w = makeWorld([{ platform: 'kick', username: 'k' }]);
  const liveK = live('kick', 'k', { liveSince: '2026-09-27T07:00:00Z' });
  w.scan([liveK], T0);
  w.scan([offline('kick', 'k')], T0 + INTERVAL);
  assert.deepEqual(w.closed, [], 'one offline is not enough');
  w.scan([errored('kick', 'k')], T0 + 2 * INTERVAL);
  w.scan([offline('kick', 'k')], T0 + 3 * INTERVAL);
  assert.deepEqual(w.closed, [], 'an error in between breaks the streak');
  for (let i = 4; i < 20; i++) w.scan([errored('kick', 'k')], T0 + i * INTERVAL);
  assert.deepEqual(w.closed, [], 'errors alone never close');
  w.scan([offline('kick', 'k')], T0 + 20 * INTERVAL);
  w.scan([offline('kick', 'k')], T0 + 21 * INTERVAL);
  assert.deepEqual(w.closed, ['kick:k']);
  assert.equal(w.activeWindows.has('kick:k'), false);
});

test('closeTab runs after the key has left activeWindows, so the dashboard is told the current set', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'hi' }, { platform: 'twitch', username: 'lo' }], { maxTwitchTabs: 1 });
  const seen = [];
  const scan = (results, now) => applyScanResults(results, {
    now, config: w.config, activeWindows: w.activeWindows, openedSessions: w.openedSessions, notifiedSessions: w.notifiedSessions,
    liveness: w.liveness, modeOf: () => 'auto', notify: () => {}, log: () => {},
    spawn: (p, u) => { w.activeWindows.set(streamKey(p, u), true); w.liveness.start(streamKey(p, u), now); },
    // What main.js's closeTab sends as active-containers-update.
    closeTab: (p, u) => seen.push({ closed: streamKey(p, u), open: [...w.activeWindows.keys()] }),
  });
  scan([offline('twitch', 'hi'), live('twitch', 'lo', { liveSince: 's' })], T0);
  scan([live('twitch', 'hi', { liveSince: 's' }), live('twitch', 'lo', { liveSince: 's' })], T0 + INTERVAL); // preempts lo
  scan([offline('twitch', 'hi'), offline('twitch', 'lo')], T0 + 2 * INTERVAL);
  scan([offline('twitch', 'hi'), offline('twitch', 'lo')], T0 + 3 * INTERVAL); // auto-closes hi
  assert.deepEqual(seen, [{ closed: 'twitch:lo', open: [] }, { closed: 'twitch:hi', open: [] }]);
});

test('F25: a streamer listed twice still needs two separate offline scans to close', () => {
  const w = makeWorld([{ platform: 'kick', username: 'dup' }, { platform: 'kick', username: 'DUP' }]);
  w.scan([live('kick', 'dup', { liveSince: 's' }), live('kick', 'DUP', { liveSince: 's' })], T0);
  assert.deepEqual(w.spawned, ['kick:dup']);
  w.scan([offline('kick', 'dup'), offline('kick', 'DUP')], T0 + INTERVAL);
  assert.deepEqual(w.closed, []);
  w.scan([offline('kick', 'dup'), offline('kick', 'DUP')], T0 + 2 * INTERVAL);
  assert.deepEqual(w.closed, ['kick:dup']);
});

test('F25: a stream auto-closed on a false offline is reopened when it shows up live again', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'x' }]);
  const liveX = live('twitch', 'x', { liveSince: '2026-09-27T07:00:00Z' });
  w.scan([liveX], T0);
  w.scan([offline('twitch', 'x')], T0 + INTERVAL);
  w.scan([offline('twitch', 'x')], T0 + 2 * INTERVAL);
  assert.deepEqual(w.closed, ['twitch:x']);
  w.scan([liveX], T0 + 3 * INTERVAL);
  assert.deepEqual(w.spawned, ['twitch:x', 'twitch:x'], 'the same broadcast key no longer blocks it');
  assert.deepEqual(w.notified, ['twitch:x'], 'but it is not alerted twice');
});

test('issue-7 regression: two offline results seconds apart (Scan Now after a scheduled scan) do not close', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'x' }]);
  const liveX = live('twitch', 'x', { liveSince: '2026-09-27T07:00:00Z' });
  w.scan([liveX], T0);
  w.scan([offline('twitch', 'x')], T0 + INTERVAL);
  w.scan([offline('twitch', 'x')], T0 + INTERVAL + 5000); // Scan Now
  assert.deepEqual(w.closed, [], 'one false offline seen twice is still one observation');
  assert.ok(w.logs.some(l => /reported offline again, 5 s after the first/.test(l)));
  // The false offline passes: nothing closed, nothing reopened, one session.
  w.scan([liveX], T0 + 2 * INTERVAL);
  assert.deepEqual(w.closed, []);
  assert.deepEqual(w.spawned, ['twitch:x']);
});

test('issue-7: two offline results an interval apart still close; the span counts from the first offline', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'x' }]);
  w.scan([live('twitch', 'x', { liveSince: 's' })], T0);
  w.scan([offline('twitch', 'x')], T0 + INTERVAL);
  w.scan([offline('twitch', 'x')], T0 + INTERVAL + 5000);
  w.scan([offline('twitch', 'x')], T0 + 2 * INTERVAL);
  assert.deepEqual(w.closed, ['twitch:x'], 'the next scheduled scan agrees');

  // Exactly half an interval is enough, just under is not; the interval
  // comes from ctx when given (main.js passes it), else from the config.
  const edge = (gapMs, ctxInterval) => {
    const e = makeWorld([{ platform: 'kick', username: 'k' }], { checkInterval: 10 });
    const scan = (results, now) => applyScanResults(results, {
      now, config: e.config, intervalMs: ctxInterval, activeWindows: e.activeWindows, openedSessions: e.openedSessions,
      notifiedSessions: e.notifiedSessions, liveness: e.liveness, modeOf: () => 'auto', notify: () => {}, log: () => {},
      spawn: (p, u) => { e.activeWindows.set(streamKey(p, u), true); e.liveness.start(streamKey(p, u), now); },
      closeTab: (p, u) => e.closed.push(streamKey(p, u)),
    });
    scan([live('kick', 'k', { liveSince: 's' })], T0);
    scan([offline('kick', 'k')], T0 + MIN);
    scan([offline('kick', 'k')], T0 + MIN + gapMs);
    return e.closed.length === 1;
  };
  assert.equal(edge(5 * MIN, undefined), true, 'checkInterval 10: half is 5 min');
  assert.equal(edge(5 * MIN - 1000, undefined), false);
  assert.equal(edge(90 * 1000, 3 * MIN), true, 'ctx.intervalMs wins over the config');
  assert.equal(edge(89 * 1000, 3 * MIN), false);
});

test('F66: a null or NaN tab limit falls back to the default instead of blocking every open', () => {
  for (const bad of [null, NaN, 'abc', '', undefined]) {
    const w = makeWorld([{ platform: 'twitch', username: 'a' }], { maxTwitchTabs: bad });
    w.scan([live('twitch', 'a', { liveSince: 's' })], T0);
    assert.deepEqual(w.spawned, ['twitch:a'], String(bad));
  }
  assert.equal(tabLimitFor({ maxKickTabs: 0 }, 'kick'), 1);
  assert.equal(tabLimitFor({ maxKickTabs: 99 }, 'kick'), 10);
  assert.equal(tabLimitFor({ maxKickTabs: '4' }, 'kick'), 4);
  assert.equal(tabLimitFor({}, 'newplatform'), 2);
});

test('modes: notify alerts once and never opens; ignore does neither; auto-open off only alerts', () => {
  const w = makeWorld([
    { platform: 'twitch', username: 'n', mode: 'notify' },
    { platform: 'twitch', username: 'i', mode: 'ignore' },
  ]);
  for (let i = 0; i < 3; i++) w.scan([live('twitch', 'n', { liveSince: 's' }), live('twitch', 'i', { liveSince: 's' })], T0 + i * INTERVAL);
  assert.deepEqual(w.notified, ['twitch:n']);
  assert.deepEqual(w.spawned, []);

  const off = makeWorld([{ platform: 'kick', username: 'a' }], { autoOpen: false });
  for (let i = 0; i < 3; i++) off.scan([live('kick', 'a', { liveSince: 's' })], T0 + i * INTERVAL);
  assert.deepEqual(off.notified, ['kick:a']);
  assert.deepEqual(off.spawned, []);
  assert.equal(off.openedSessions.size, 0, 'nothing recorded as opened, so turning auto-open on later still opens it');
});

test('results open in config priority order, whatever order the scan returned them in', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'first' }, { platform: 'twitch', username: 'second' }], { maxTwitchTabs: 1 });
  w.scan([live('twitch', 'second', { liveSince: 's' }), live('twitch', 'first', { liveSince: 's' })], T0);
  assert.deepEqual(w.spawned, ['twitch:first']);
});

test('choosePreemption: lowest priority open stream, strictly below the incoming one', () => {
  const p = buildPriorityMap([
    { platform: 'twitch', username: 'A' }, { platform: 'twitch', username: 'b' }, { platform: 'twitch', username: 'c' },
    { platform: 'twitch', username: 'a' }, // duplicate: first occurrence wins
    null, { username: 'noplatform' },
  ]);
  assert.equal(p.get('twitch:a'), 0);
  assert.equal(p.size, 3);
  assert.equal(choosePreemption(['twitch:b', 'twitch:c'], p, 'twitch:a').key, 'twitch:c');
  assert.equal(choosePreemption(['twitch:a', 'twitch:b'], p, 'twitch:c'), null);
  // An unmonitored open stream is the first to go, but an unmonitored incoming one preempts nothing.
  assert.equal(choosePreemption(['twitch:b', 'twitch:zz'], p, 'twitch:a').username, 'zz');
  assert.equal(choosePreemption(['twitch:zz', 'twitch:yy'], p, 'twitch:xx'), null);
  // Ties keep the earliest opened; the incoming key is never its own victim.
  assert.equal(choosePreemption(['twitch:zz', 'twitch:yy'], p, 'twitch:a').key, 'twitch:zz');
  assert.equal(choosePreemption(['twitch:a'], p, 'twitch:a'), null);
});

test('evictStale and clearSessionsFor', () => {
  const m = new Map([['twitch:a:1', T0], ['twitch:ab:1', T0 - SESSION_TTL_MS - 1], ['twitch:a:2', T0]]);
  evictStale(m, T0);
  assert.deepEqual([...m.keys()], ['twitch:a:1', 'twitch:a:2']);
  m.set('twitch:ab:1', T0);
  clearSessionsFor(m, 'twitch:a');
  assert.deepEqual([...m.keys()], ['twitch:ab:1'], 'prefix match stops at the colon');
});

// ── Gaps a mutation run found (Stryker on main/scan-planner.js) ────────────
// Each test below fails on at least one mutant the tests above let through.
// The comment on each says which decision it pins.

// TAB_LIMIT_KEYS: every platform reads its own setting (not the fallback of
// 2), and only that platform's open cells count against it. A cell on another
// platform must never be preempted to make room.
test('tab limits: each platform reads its own setting and counts only its own open cells', () => {
  assert.equal(tabLimitFor({ maxTwitchTabs: 3 }, 'twitch'), 3);
  assert.equal(tabLimitFor({ maxKickTabs: 4 }, 'kick'), 4);
  assert.equal(tabLimitFor({ maxYoutubeTabs: 5 }, 'youtube'), 5);
  assert.equal(tabLimitFor({ maxRumbleTabs: 7 }, 'rumble'), 7);

  const yt = makeWorld([
    { platform: 'youtube', username: '@a' }, { platform: 'youtube', username: '@b' }, { platform: 'youtube', username: '@c' },
  ], { maxYoutubeTabs: 3 });
  yt.scan([
    youtubeLiveResult('@a', 'aaaaaaaaaaa', '2026-09-27T06:00:00Z'),
    youtubeLiveResult('@b', 'bbbbbbbbbbb', '2026-09-27T06:00:00Z'),
    youtubeLiveResult('@c', 'ccccccccccc', '2026-09-27T06:00:00Z'),
  ], T0);
  assert.deepEqual(yt.spawned, ['youtube:@a', 'youtube:@b', 'youtube:@c'], 'maxYoutubeTabs 3 opens a third cell');

  // One Kick cell open (hand-opened and unmonitored, so it ranks below
  // everything) and a Twitch limit of 1: the Twitch stream still has its slot.
  const w = makeWorld([{ platform: 'twitch', username: 'top' }], { maxTwitchTabs: 1, maxKickTabs: 1 });
  w.userOpen('kick:other', T0);
  w.scan([live('twitch', 'top', { liveSince: 's' })], T0);
  assert.deepEqual(w.spawned, ['twitch:top']);
  assert.deepEqual(w.closed, [], 'the Kick cell is not preempted for a Twitch stream');
  assert.ok(w.activeWindows.has('kick:other'));
  assert.ok(!w.logs.some(l => l.includes('Limit reached') || l.includes('Preempting')));
});

// evictStale drops entries strictly older than the TTL: one last seen exactly
// 24h ago stays, one a millisecond older goes. The optional ttlMs is honoured.
test('evictStale: an entry exactly the TTL old is kept, one ms older is dropped', () => {
  const m = new Map([['twitch:a:1', T0 - SESSION_TTL_MS], ['twitch:b:1', T0 - SESSION_TTL_MS - 1]]);
  evictStale(m, T0);
  assert.deepEqual([...m.keys()], ['twitch:a:1']);
  const n = new Map([['kick:x:1', T0 - 1000], ['kick:y:1', T0 - 1001]]);
  evictStale(n, T0, 1000);
  assert.deepEqual([...n.keys()], ['kick:x:1']);
});

// openedSessions is evicted on the same clock as notifiedSessions. Without
// it, a cell the user closed stays closed for good once its broadcast key
// comes back after more than a day unseen (an outage over a 24/7 stream),
// and the map only ever grows.
test('F68: opened-session entries expire too, so a stream back after a day unseen opens again', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'radio' }]);
  const result = live('twitch', 'radio', { liveSince: '2026-09-20T00:00:00Z' });
  w.scan([result], T0);
  w.userClose('twitch:radio');
  w.scan([result], T0 + INTERVAL);
  assert.deepEqual(w.spawned, ['twitch:radio'], 'closed by the user: stays closed for the broadcast');

  // A day of errored checks: nothing refreshes either entry.
  const back = T0 + INTERVAL + SESSION_TTL_MS + MIN;
  w.scan([errored('twitch', 'radio')], back);
  assert.equal(w.openedSessions.size, 0);
  assert.equal(w.notifiedSessions.size, 0);
  w.scan([result], back + INTERVAL);
  assert.deepEqual(w.notified, ['twitch:radio', 'twitch:radio']);
  assert.deepEqual(w.spawned, ['twitch:radio', 'twitch:radio']);
});

// The once-per-key dedupe of scan results: a streamer listed twice adds one
// offline observation per scan, not two. The span rule alone hides a double
// count from auto-close, so the streak itself is what is pinned.
test('F25: a streamer listed twice adds one offline observation per scan, not two', () => {
  const w = makeWorld([{ platform: 'kick', username: 'dup' }, { platform: 'kick', username: 'DUP' }]);
  w.scan([live('kick', 'dup', { liveSince: 's' }), live('kick', 'DUP', { liveSince: 's' })], T0);
  w.scan([offline('kick', 'dup'), offline('kick', 'DUP')], T0 + INTERVAL);
  assert.equal(w.liveness.offlineStreak('kick:dup'), 1);
  // One line per scan, not one per entry.
  assert.deepEqual(w.logs.filter(l => l.includes('reported offline')),
    ['[Lurk] dup on KICK reported offline (1/2). Closing it if the next scan agrees.']);
  w.scan([offline('kick', 'dup'), offline('kick', 'DUP')], T0 + 2 * INTERVAL);
  assert.deepEqual(w.logs.filter(l => l.includes('went offline')),
    ['[Lurk] Streamer dup on KICK went offline. Auto-closing container.']);
  assert.deepEqual(w.closed, ['kick:dup']);
});

// The close check reads the result liveness observed, the key's first. A
// duplicate that disagrees with it says nothing, so it must not log a
// "reported offline (0/2)" for a stream the scan just saw live.
test('a duplicate entry that disagrees with the first result neither logs nor closes', () => {
  const w = makeWorld([{ platform: 'kick', username: 'dup' }, { platform: 'kick', username: 'DUP' }]);
  w.scan([live('kick', 'dup', { liveSince: 's' })], T0);
  for (let i = 1; i <= 3; i++) w.scan([live('kick', 'dup', { liveSince: 's' }), offline('kick', 'DUP')], T0 + i * INTERVAL);
  assert.deepEqual(w.logs.filter(l => l.includes('offline')), []);
  assert.deepEqual(w.closed, []);
  // An errored first result says nothing either, so its duplicate is not asked.
  for (let i = 4; i <= 6; i++) w.scan([errored('kick', 'dup'), offline('kick', 'DUP')], T0 + i * INTERVAL);
  assert.deepEqual(w.logs.filter(l => l.includes('offline')), []);
  assert.deepEqual(w.closed, []);
});

// The go-live pass reads the same one result per key. Read per result, an
// offline first result closed the cell and a live duplicate reopened it in
// the same scan: a flap, a fresh liveness entry and a second session.
test('a duplicate entry cannot reopen a cell the first result just closed', () => {
  const w = makeWorld([{ platform: 'kick', username: 'dup' }, { platform: 'kick', username: 'DUP' }]);
  w.scan([live('kick', 'dup', { liveSince: 's' })], T0);
  w.scan([offline('kick', 'dup')], T0 + INTERVAL);
  w.scan([offline('kick', 'dup'), live('kick', 'DUP', { liveSince: 's' })], T0 + 2 * INTERVAL);
  assert.deepEqual(w.closed, ['kick:dup']);
  assert.deepEqual(w.spawned, ['kick:dup'], 'not reopened by the duplicate in the same scan');
  assert.equal(w.activeWindows.has('kick:dup'), false);
});

// liveness.retain: a streamer the scan no longer covers (removed from the
// list while its cell stays open, as delete-streamer leaves it) loses its
// liveness entry. Kept, the stale offline streak starved the cell of watch
// time, and after re-adding it a single offline result closed the cell.
test('a streamer removed from the list and re-added starts a fresh offline count', () => {
  const w = makeWorld([{ platform: 'kick', username: 'k' }, { platform: 'kick', username: 'other' }]);
  w.scan([live('kick', 'k', { liveSince: 's' }), offline('kick', 'other')], T0);
  w.scan([offline('kick', 'k'), offline('kick', 'other')], T0 + INTERVAL); // k: 1/2

  const removed = w.config.streamers.shift();
  w.scan([offline('kick', 'other')], T0 + 2 * INTERVAL);
  assert.equal(w.liveness.has('kick:k'), false);
  assert.equal(w.liveness.credit('kick:k', T0 + 2 * INTERVAL, INTERVAL).credit, true, 'credited like any open cell the scanner does not know');

  // Re-added: its first offline result counts as a first again.
  w.config.streamers.push(removed);
  w.scan([offline('kick', 'other'), offline('kick', 'k')], T0 + 3 * INTERVAL);
  assert.deepEqual(w.closed, []);
  assert.ok(w.activeWindows.has('kick:k'));
});

// The priority sort ranks every result by its full config index, not
// "index 0 first, the rest tied". With the rest tied, #3 took the one free
// slot and #2 then preempted it: an open and a close for nothing.
test('results sort by full config priority, so a lower-ranked stream never opens only to be preempted', () => {
  const w = makeWorld([
    { platform: 'twitch', username: 'lead' },
    { platform: 'twitch', username: 'second' },
    { platform: 'twitch', username: 'third' },
  ], { maxTwitchTabs: 1 });
  w.scan([offline('twitch', 'lead'), live('twitch', 'third', { liveSince: 's' }), live('twitch', 'second', { liveSince: 's' })], T0);
  assert.deepEqual(w.spawned, ['twitch:second']);
  assert.deepEqual(w.closed, []);
});

// The activity console is the only trace of these decisions, so its lines
// are pinned scan by scan: the platform in capitals, the offline count before
// the second confirmation, the wait in seconds, and nothing at all for an
// open cell whose check came back live or errored.
test('log lines: each auto-close and auto-open decision, and silence for live or errored open cells', () => {
  const w = makeWorld([{ platform: 'twitch', username: 'Top' }, { platform: 'twitch', username: 'Low' }], { maxTwitchTabs: 1 });
  const scanLogs = (results, now) => {
    const from = w.logs.length;
    w.scan(results, now);
    return w.logs.slice(from);
  };
  const since = { liveSince: '2026-09-27T07:00:00Z' };

  assert.deepEqual(scanLogs([offline('twitch', 'Top'), live('twitch', 'Low', since)], T0), [
    '[Lurk] Detected live stream: Low on TWITCH!',
  ]);
  // Low is open and live, so no offline line for it; Top goes live and takes its slot.
  assert.deepEqual(scanLogs([live('twitch', 'Top', since), live('twitch', 'Low', since)], T0 + INTERVAL), [
    '[Lurk] Detected live stream: Top on TWITCH!',
    '[Lurk] Preempting: Closing lower-priority active stream low on TWITCH (priority index 1) to open higher-priority stream Top (priority index 0).',
    '[Lurk] Limit reached: Skip auto-opening TWITCH stream for Low (Active: 1/1)',
  ]);
  // Top is open and its check errored: that says nothing either way.
  assert.deepEqual(scanLogs([errored('twitch', 'Top'), offline('twitch', 'Low')], T0 + 2 * INTERVAL), []);
  assert.deepEqual(scanLogs([offline('twitch', 'Top'), offline('twitch', 'Low')], T0 + 3 * INTERVAL), [
    '[Lurk] Top on TWITCH reported offline (1/2). Closing it if the next scan agrees.',
  ]);
  assert.deepEqual(scanLogs([offline('twitch', 'Top'), offline('twitch', 'Low')], T0 + 3 * INTERVAL + 5000), [
    '[Lurk] Top on TWITCH reported offline again, 5 s after the first. Closing it if a scan at least 90 s after that one agrees.',
  ]);
  assert.deepEqual(scanLogs([offline('twitch', 'Top'), offline('twitch', 'Low')], T0 + 4 * INTERVAL), [
    '[Lurk] Streamer Top on TWITCH went offline. Auto-closing container.',
  ]);
  assert.deepEqual(w.closed, ['twitch:low', 'twitch:top']);
});

// Found by mutation testing: prototype names resolved to inherited functions
// and threw instead of falling back to the default limit.
test('tabLimitFor falls back to 2 for prototype-named platforms', () => {
  for (const p of ['constructor', '__proto__', 'toString', 'valueOf']) assert.equal(tabLimitFor({}, p), 2, p);
});
