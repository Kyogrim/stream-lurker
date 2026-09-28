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
