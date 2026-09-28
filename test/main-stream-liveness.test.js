// Gate tests for main/stream-liveness.js: watch time is credited only while
// scans still confirm a stream live, and a session that ended unseen is cut
// at its last confirmation. The outage scenarios drive the planner and a
// minute ticker the way main.js does. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { OFFLINE_CONFIRMATIONS, OFFLINE_MIN_SPAN_SHARE, offlineMinSpanMs, staleAfterMs, createStreamLiveness } = require('../main/stream-liveness');
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

test('issue-2: an old confirmation stands until a later scan fails to repeat it', () => {
  const l = createStreamLiveness();
  l.observe('kick:x', live('x'), T0);
  // A slow scan is still running: nothing has reported since the confirmation.
  const late = T0 + 10 * INTERVAL;
  assert.equal(l.credit('kick:x', late, INTERVAL).credit, true);
  assert.equal(l.sessionEnd('kick:x', late, INTERVAL), late, 'a cell closed meanwhile keeps its whole session');
  // The scan lands and confirms it: still credited.
  l.observe('kick:x', live('x'), late + MIN);
  assert.equal(l.credit('kick:x', late + 2 * MIN, INTERVAL).credit, true);
  // The next one lands errored after a long wait: the confirmation is old and
  // a finished scan did not repeat it.
  l.observe('kick:x', errored('x'), late + 9 * MIN);
  assert.equal(l.credit('kick:x', late + 9 * MIN, INTERVAL).credit, false);
  assert.equal(l.sessionEnd('kick:x', late + 9 * MIN, INTERVAL), late + MIN + INTERVAL);
});

test('issue-2: a scan that fails as a whole counts against every stream', () => {
  const l = createStreamLiveness();
  l.observe('kick:x', live('x'), T0);
  l.observe('kick:y', live('y'), T0);
  for (let t = T0 + INTERVAL; t <= T0 + 4 * INTERVAL; t += INTERVAL) l.scanFailed(t);
  assert.equal(l.credit('kick:x', T0 + staleAfterMs(INTERVAL), INTERVAL).credit, true, 'one failed scan is tolerated');
  assert.equal(l.credit('kick:x', T0 + staleAfterMs(INTERVAL) + 1, INTERVAL).credit, false);
  assert.equal(l.credit('kick:y', T0 + 4 * INTERVAL, INTERVAL).credit, false);
  l.observe('kick:x', live('x'), T0 + 5 * INTERVAL);
  assert.equal(l.credit('kick:x', T0 + 5 * INTERVAL + MIN, INTERVAL).credit, true, 'a confirmation resumes it');
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

test('issue-7: an offline confirmation needs the streak and half an interval since the first offline', () => {
  const l = createStreamLiveness();
  assert.equal(OFFLINE_MIN_SPAN_SHARE, 0.5);
  assert.equal(offlineMinSpanMs(INTERVAL), 90 * 1000);
  assert.equal(offlineMinSpanMs(undefined), 0, 'no interval known: the count alone decides, as before');
  l.start('kick:x', T0);
  l.observe('kick:x', offline('x'), T0 + INTERVAL);
  assert.equal(l.offlineSince('kick:x'), T0 + INTERVAL);
  assert.equal(l.offlineConfirmed('kick:x', T0 + INTERVAL + 5000, INTERVAL), false, 'one result');
  l.observe('kick:x', offline('x'), T0 + INTERVAL + 5000);
  assert.equal(l.offlineSince('kick:x'), T0 + INTERVAL, 'the clock starts at the first offline');
  assert.equal(l.offlineConfirmed('kick:x', T0 + INTERVAL + 5000, INTERVAL), false, 'two results, 5 s apart');
  assert.equal(l.offlineConfirmed('kick:x', T0 + INTERVAL + 90 * 1000, INTERVAL), true);
  // Live, an error or a reopen starts over.
  for (const reset of [(t) => l.observe('kick:x', live('x'), t), (t) => l.observe('kick:x', errored('x'), t), (t) => l.start('kick:x', t)]) {
    reset(T0 + 10 * INTERVAL);
    assert.equal(l.offlineSince('kick:x'), undefined);
    assert.equal(l.offlineConfirmed('kick:x', T0 + 20 * INTERVAL, INTERVAL), false);
    l.observe('kick:x', offline('x'), T0 + 11 * INTERVAL);
    l.observe('kick:x', offline('x'), T0 + 12 * INTERVAL);
    assert.equal(l.offlineConfirmed('kick:x', T0 + 12 * INTERVAL, INTERVAL), true);
  }
  assert.equal(l.offlineConfirmed('kick:unknown', T0, INTERVAL), false);
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

// main.js cadence, not the idealised one above: the scan tick fires every
// interval but is skipped while a scan is still running (resetPoller), a
// scan's results land when it finishes, the first scan runs 3 s after
// startup, and the watch-time ticker runs on its own one-minute timer.
function simulateCadence({ intervalMs, scanMs, to, scanResult, phaseMs = 17 * 1000 }) {
  const liveness = createStreamLiveness();
  const activeWindows = new Map();
  const openedSessions = new Map();
  const notifiedSessions = new Map();
  const config = { autoOpen: true, maxKickTabs: 10, streamers: [{ platform: 'kick', username: 'a' }] };
  let finishesAt = null;
  let ticked = 0;
  let credited = 0;
  for (let t = 0; t < to; t += 1000) {
    const now = T0 + t;
    if (finishesAt !== null && t >= finishesAt) {
      finishesAt = null;
      applyScanResults(config.streamers.map(s => scanResult(s.username, t)), {
        now, intervalMs, config, activeWindows, openedSessions, notifiedSessions, liveness,
        modeOf: () => 'auto', notify: () => {}, log: () => {},
        closeTab: (p, u) => activeWindows.delete(streamKey(p, u)),
        spawn: (p, u) => { activeWindows.set(streamKey(p, u), true); liveness.start(streamKey(p, u), now); },
      });
    }
    const due = t === 3000 || (t > 0 && t % intervalMs === 0);
    if (due && finishesAt === null) finishesAt = t + scanMs;
    if (t >= phaseMs && (t - phaseMs) % MIN === 0) {
      for (const key of activeWindows.keys()) {
        ticked++;
        if (liveness.credit(key, now, intervalMs).credit) credited++;
      }
    }
  }
  return { ticked, credited };
}

test('issue-2: scans slower than two intervals do not pause credit for a stream every scan confirms live', () => {
  // The rule before this fix credited 87/116, 89/113 and 96/115 minutes here.
  for (const [intervalMin, scanMin] of [[1, 3.5], [3, 6.5], [2, 4.5], [1, 2.5], [1, 0.2]]) {
    const { ticked, credited } = simulateCadence({
      intervalMs: intervalMin * MIN, scanMs: scanMin * MIN, to: 120 * MIN, scanResult: (u) => live(u),
    });
    assert.ok(ticked > 100, `interval ${intervalMin}, scan ${scanMin}: the cell was open (${ticked} min)`);
    assert.equal(credited, ticked, `interval ${intervalMin}, scan ${scanMin}: every minute credited`);
  }
});

test('issue-2: with slow scans an outage still pauses credit at the first scan that finishes without confirming', () => {
  for (const [intervalMin, scanMin] of [[1, 3.5], [3, 6.5], [3, 0.2]]) {
    const { credited } = simulateCadence({
      intervalMs: intervalMin * MIN, scanMs: scanMin * MIN, to: 240 * MIN,
      scanResult: (u, t) => (t < 30 * MIN ? live(u) : errored(u)),
    });
    // Live for the first 30 minutes (less the first scan), then at most the
    // staleness allowance plus the scan that brought the first error.
    const bound = 30 + staleAfterMs(intervalMin * MIN) / MIN + scanMin;
    assert.ok(credited >= 25 && credited <= bound, `interval ${intervalMin}, scan ${scanMin}: credited ${credited}, bound ${bound}`);
  }
});
