// Gate tests for main/dashboard-health.js (F31, C6): while the dashboard
// renderer is dead nothing is credited or opened; recovery backs off to a slow
// retry instead of giving up for good. The last test drives the planner the
// way doScan does while the dashboard is dead. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_QUICK_RELOADS, QUICK_WINDOW_MS, QUICK_RELOAD_DELAY_MS, SLOW_RELOAD_DELAY_MS, createDashboardHealth,
} = require('../main/dashboard-health');
const { applyScanResults } = require('../main/scan-planner');
const { createStreamLiveness } = require('../main/stream-liveness');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 27);

test('loading -> alive -> dead -> alive gates credit and opening', () => {
  const h = createDashboardHealth();
  assert.equal(h.state, 'loading');
  assert.equal(h.creditsWatchTime, false, 'no cells exist before the first load');
  assert.equal(h.canOpenStreams, true, 'a spawn before load is restored via get-active-containers');
  h.loaded();
  assert.equal(h.creditsWatchTime, true);
  const plan = h.gone('crashed', T0);
  assert.equal(h.state, 'dead');
  assert.equal(h.creditsWatchTime, false, 'the 1 s reload gap is not credited either');
  assert.equal(h.canOpenStreams, false);
  assert.deepEqual(plan, { action: 'reload', delayMs: QUICK_RELOAD_DELAY_MS, attempt: 1, max: MAX_QUICK_RELOADS });
  h.loaded();
  assert.equal(h.creditsWatchTime, true);
});

test('regression F31: after the quick reloads it gives up for a while, not forever', () => {
  const h = createDashboardHealth();
  h.loaded();
  for (let i = 1; i <= MAX_QUICK_RELOADS; i++) {
    assert.equal(h.gone('crashed', T0 + i * MIN).action, 'reload');
  }
  const giveUp = h.gone('crashed', T0 + 4 * MIN);
  assert.deepEqual(giveUp, { action: 'give-up', delayMs: SLOW_RELOAD_DELAY_MS });
  assert.equal(h.creditsWatchTime, false);
  // The slow retry reloads 30 minutes later; a crash then gets quick reloads again.
  assert.equal(h.gone('crashed', T0 + 4 * MIN + SLOW_RELOAD_DELAY_MS + 1000).action, 'reload');
});

test('crashes spread out beyond the window never exhaust the quick reloads', () => {
  const h = createDashboardHealth();
  for (let i = 0; i < 10; i++) {
    assert.equal(h.gone('oom', T0 + i * (QUICK_WINDOW_MS + 1)).action, 'reload');
  }
});

test('a clean exit or a quit is not a crash to recover from, but the renderer is still gone', () => {
  const h = createDashboardHealth();
  h.loaded();
  assert.deepEqual(h.gone('clean-exit', T0), { action: 'none' });
  assert.equal(h.creditsWatchTime, false);
  h.loaded();
  assert.deepEqual(h.gone('crashed', T0, { quitting: true }), { action: 'none' });
});

// doScan passes { ...config, autoOpen: false } while !canOpenStreams. A scan
// landing in the crash gap must not record the stream as opened, or it would
// stay closed for the rest of its broadcast once the dashboard is back.
test('F31: a scan while the dashboard is dead opens nothing and leaves it openable later', () => {
  const h = createDashboardHealth();
  h.loaded();
  h.gone('crashed', T0);
  const config = { autoOpen: true, streamers: [{ platform: 'kick', username: 'x' }], maxKickTabs: 2 };
  const ctx = (cfg) => {
    const spawned = [];
    return {
      spawned,
      now: T0 + MIN,
      config: cfg,
      activeWindows: new Map(),
      openedSessions,
      notifiedSessions: new Map(),
      liveness: createStreamLiveness(),
      modeOf: () => 'auto',
      notify: () => {},
      spawn: (p, u) => spawned.push(`${p}:${u}`),
      closeTab: () => {},
      log: () => {},
    };
  };
  const openedSessions = new Map();
  const live = [{ platform: 'kick', username: 'x', isLive: true, liveSince: '2026-09-27T00:00:00Z' }];
  const dead = ctx(h.canOpenStreams ? config : { ...config, autoOpen: false });
  applyScanResults(live, dead);
  assert.deepEqual(dead.spawned, []);
  assert.equal(openedSessions.size, 0);
  h.loaded();
  const back = ctx(h.canOpenStreams ? config : { ...config, autoOpen: false });
  applyScanResults(live, back);
  assert.deepEqual(back.spawned, ['kick:x'], 'opens on the first scan after recovery');
});
