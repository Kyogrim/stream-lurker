// Gate tests for main/stream-liveness.js: watch time is credited only while
// scans still confirm a stream live, and a session that ended unseen is cut
// at its last confirmation. The outage scenarios drive the planner and a
// minute ticker the way main.js does. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { OFFLINE_CONFIRMATIONS, staleAfterMs, createStreamLiveness } = require('../main/stream-liveness');
const { applyScanResults, streamKey } = require('../main/scan-planner');

const MIN = 60 * 1000;
const INTERVAL = 3 * MIN;
const T0 = Date.UTC(2026, 8, 27, 0, 0, 0);

const live = (u) => ({ platform: 'kick', username: u, isLive: true, title: '', viewerCount: 0, category: '', liveSince: '2026-09-26T20:00:00Z' });
const offline = (u) => ({ platform: 'kick', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '' });
const errored = (u) => ({ ...offline(u), error: 'Status 403' });

test('a key the scanner knows nothing about is always credited', () => {
  const l = createStreamLiveness();
  assert.deepEqual(l.credit('kick:x', T0, INTERVAL), { credit: true, transition: null, lastLiveAt: undefined });
  assert.equal(l.sessionEnd('kick:x', T0, INTERVAL), T0);
});

test('credit pauses on a clean offline and resumes on the next live result', () => {
  const l = createStreamLiveness();
  l.start('kick:x', T0);
  assert.equal(l.credit('kick:x', T0 + MIN, INTERVAL).credit, true);
  assert.equal(l.observe('kick:x', offline('x'), T0 + INTERVAL), 1);
  assert.deepEqual(l.credit('kick:x', T0 + INTERVAL + MIN, INTERVAL), { credit: false, transition: 'paused', lastLiveAt: T0 });
  assert.equal(l.credit('kick:x', T0 + INTERVAL + 2 * MIN, INTERVAL).transition, null, 'the transition is reported once');
  l.observe('kick:x', live('x'), T0 + 2 * INTERVAL);
  assert.deepEqual(l.credit('kick:x', T0 + 2 * INTERVAL + MIN, INTERVAL), { credit: true, transition: 'resumed', lastLiveAt: T0 + 2 * INTERVAL });
});

test('errors: one errored scan is tolerated, credit stops once the last confirmation is two intervals old', () => {
  const l = createStreamLiveness();
  l.observe('kick:x', live('x'), T0);
  l.observe('kick:x', errored('x'), T0 + INTERVAL);
  assert.equal(l.credit('kick:x', T0 + INTERVAL + MIN, INTERVAL).credit, true);
  assert.equal(l.credit('kick:x', T0 + staleAfterMs(INTERVAL), INTERVAL).credit, true);
  assert.equal(l.credit('kick:x', T0 + staleAfterMs(INTERVAL) + 1, INTERVAL).credit, false);
  // An error proves nothing: it breaks an offline streak without confirming live.
  l.observe('kick:x', offline('x'), T0 + 3 * INTERVAL);
  l.observe('kick:x', errored('x'), T0 + 4 * INTERVAL);
  assert.equal(l.offlineStreak('kick:x'), 0);
  assert.equal(l.credit('kick:x', T0 + 4 * INTERVAL + MIN, INTERVAL).credit, false, 'still stale');
});

test('offline streak counts consecutive clean offline results', () => {
  const l = createStreamLiveness();
  assert.equal(OFFLINE_CONFIRMATIONS, 2);
  l.start('kick:x', T0);
  assert.equal(l.observe('kick:x', offline('x'), T0 + INTERVAL), 1);
  assert.equal(l.observe('kick:x', offline('x'), T0 + 2 * INTERVAL), 2);
  assert.equal(l.observe('kick:x', live('x'), T0 + 3 * INTERVAL), 0);
  l.start('kick:x', T0); // reopening resets it
  assert.equal(l.offlineStreak('kick:x'), 0);
});

test('sessionEnd: cut one interval after the last confirmation when no longer confirmed', () => {
  const l = createStreamLiveness();
  l.observe('kick:x', live('x'), T0);
  assert.equal(l.sessionEnd('kick:x', T0 + 2 * MIN, INTERVAL), T0 + 2 * MIN, 'confirmed: ends now');
  l.observe('kick:x', offline('x'), T0 + INTERVAL);
  assert.equal(l.sessionEnd('kick:x', T0 + 8 * 60 * MIN, INTERVAL), T0 + INTERVAL);
  // Never later than now.
  l.observe('kick:y', live('y'), T0);
  l.observe('kick:y', offline('y'), T0 + MIN);
  assert.equal(l.sessionEnd('kick:y', T0 + 2 * MIN, INTERVAL), T0 + 2 * MIN);
});

test('retain drops keys the scan no longer covers; forget drops one', () => {
  const l = createStreamLiveness();
  l.observe('kick:a', offline('a'), T0);
  l.observe('kick:b', offline('b'), T0);
  l.retain(new Set(['kick:a']));
  assert.equal(l.has('kick:a'), true);
  assert.equal(l.has('kick:b'), false);
  assert.equal(l.credit('kick:b', T0, INTERVAL).credit, true, 'removed from the list while open: still credited');
  l.forget('kick:a');
  assert.equal(l.has('kick:a'), false);
});

// main.js wiring in miniature: scans every INTERVAL through the planner, a
// ticker every minute that credits what liveness allows.
function simulate({ from, to, scanResult }) {
  const liveness = createStreamLiveness();
  const activeWindows = new Map();
  const credited = new Map();
  const config = { autoOpen: true, maxKickTabs: 10, streamers: ['a', 'b', 'c', 'd'].map(u => ({ platform: 'kick', username: u })) };
  const ctx = (now) => ({
    now, config, activeWindows, openedSessions: new Map(), notifiedSessions: new Map(), liveness,
    modeOf: () => 'auto', notify: () => {}, log: () => {}, closeTab: () => {},
    spawn: (p, u) => { activeWindows.set(streamKey(p, u), true); liveness.start(streamKey(p, u), now); },
  });
  for (let now = from; now < to; now += MIN) {
    if ((now - from) % INTERVAL === 0) {
      applyScanResults(config.streamers.map(s => scanResult(s.username, now)), ctx(now));
    }
    for (const key of activeWindows.keys()) {
      if (liveness.credit(key, now, INTERVAL).credit) credited.set(key, (credited.get(key) || 0) + 1);
    }
  }
  return { credited, activeWindows, liveness };
}

test('G4.6: an overnight outage does not credit the hours the streams were not confirmed live', () => {
  // Live until 01:00, then every scan errors until 09:00 (the streams really
  // ended at 02:00, nobody could tell).
  const outageAt = T0 + 60 * MIN;
  const { credited, activeWindows } = simulate({
    from: T0,
    to: T0 + 9 * 60 * MIN,
    scanResult: (u, now) => (now < outageAt ? live(u) : errored(u)),
  });
  assert.equal(activeWindows.size, 4, 'errors never close the cells');
  for (const [key, minutes] of credited) {
    // One hour of real viewing plus at most the staleness allowance.
    assert.ok(minutes >= 60 && minutes <= 60 + staleAfterMs(INTERVAL) / MIN, `${key}: ${minutes} min`);
  }
});

test('G4.6: credit resumes when scans recover with the stream still live, and the cells close when they recover offline', () => {
  const recovered = simulate({
    from: T0,
    to: T0 + 3 * 60 * MIN,
    scanResult: (u, now) => (now >= T0 + 60 * MIN && now < T0 + 120 * MIN ? errored(u) : live(u)),
  });
  for (const minutes of recovered.credited.values()) {
    assert.ok(minutes >= 120 && minutes < 180 - 50, `credited ${minutes}`);
  }

  const ended = simulate({
    from: T0,
    to: T0 + 3 * 60 * MIN,
    scanResult: (u, now) => (now < T0 + 60 * MIN ? live(u) : now < T0 + 120 * MIN ? errored(u) : offline(u)),
  });
  assert.equal(ended.activeWindows.size, 0, 'closed after two clean offline scans');
  for (const key of ['kick:a', 'kick:b', 'kick:c', 'kick:d']) {
    assert.ok(ended.credited.get(key) <= 60 + staleAfterMs(INTERVAL) / MIN);
  }
});
