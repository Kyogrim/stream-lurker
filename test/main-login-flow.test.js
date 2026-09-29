// F35 / F85: the login modal resolves exactly once, saves at most once, and
// its polls never overlap, whatever the page or the user does. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginFlow } = require('../main/login-flow');
const { createClock, deferred } = require('./main-auth-fakes');

// A flow whose detect() and extractName() the test settles by hand.
function setup(overrides = {}) {
  const clock = createClock();
  const detects = [];
  const extracts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const commits = [];
  const settled = [];
  let closes = 0;
  const flow = createLoginFlow({
    detect: () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred();
      detects.push(d);
      return d.promise.finally(() => { inFlight--; });
    },
    extractName: (hit) => {
      const d = deferred();
      extracts.push({ hit, ...d });
      return d.promise;
    },
    commit: (name) => commits.push(name),
    fallbackName: () => 'Kick User',
    closeWindow: () => { closes++; },
    onSettled: (r) => settled.push(r),
    pollMs: 1500,
    deadlineMs: 300000,
    extractDeadlineMs: 60000,
    timers: clock,
    ...overrides,
  });
  flow.start();
  return { clock, flow, detects, extracts, commits, settled, closes: () => closes, maxInFlight: () => maxInFlight };
}

test('F85: a slow poll is never overlapped by the next one', async () => {
  const t = setup();
  await t.clock.advance(1500);
  assert.equal(t.detects.length, 1);
  // The Kick check can take longer than the 1.5 s period.
  await t.clock.advance(6000);
  assert.equal(t.detects.length, 1, 'no second poll while the first is still waiting');
  t.detects[0].resolve(null);
  await t.clock.flush();
  await t.clock.advance(1500);
  assert.equal(t.detects.length, 2);
  assert.equal(t.maxInFlight(), 1);
});

test('F85: one detected login saves and announces exactly once', async () => {
  const t = setup();
  await t.clock.advance(1500);
  t.detects[0].resolve({ name: 'alice' });
  await t.clock.flush();
  assert.equal(t.extracts.length, 1);
  assert.deepEqual(t.extracts[0].hit, { name: 'alice' });
  // Nothing else polls while the name is read.
  await t.clock.advance(10000);
  assert.equal(t.detects.length, 1);
  t.extracts[0].resolve('alice');
  await t.clock.flush();
  assert.deepEqual(t.commits, ['alice']);
  assert.deepEqual(t.settled, [{ success: true, username: 'alice' }]);
  assert.equal(t.closes(), 1);
  assert.equal(t.clock.pending(), 0, 'no timer left behind');
  // The window's 'closed' event that follows our own close() is a no-op.
  t.flow.windowClosed();
  assert.equal(t.settled.length, 1);
  assert.equal(t.commits.length, 1);
});

test('F35: closing the window while the name is read still resolves, saved once with the fallback', async () => {
  const t = setup();
  await t.clock.advance(1500);
  t.detects[0].resolve({});
  await t.clock.flush();
  t.flow.windowClosed();
  assert.deepEqual(t.commits, ['Kick User']);
  assert.deepEqual(t.settled, [{ success: true, username: 'Kick User' }]);
  // The extraction's late answer changes nothing.
  t.extracts[0].resolve('alice');
  await t.clock.flush();
  assert.deepEqual(t.commits, ['Kick User']);
  assert.equal(t.settled.length, 1);
});

test('F35: a name lookup that throws resolves with the fallback instead of hanging', async () => {
  const t = setup();
  await t.clock.advance(1500);
  t.detects[0].resolve({});
  await t.clock.flush();
  t.extracts[0].reject(new Error('Script failed to execute'));
  await t.clock.flush();
  assert.deepEqual(t.commits, ['Kick User']);
  assert.deepEqual(t.settled, [{ success: true, username: 'Kick User' }]);
});

test('F35: a name lookup that never settles is cut off by the extraction deadline', async () => {
  const t = setup();
  await t.clock.advance(1500);
  t.detects[0].resolve({});
  await t.clock.flush();
  await t.clock.advance(59999);
  assert.equal(t.settled.length, 0);
  await t.clock.advance(1);
  assert.deepEqual(t.settled, [{ success: true, username: 'Kick User' }]);
  assert.equal(t.closes(), 1);
});

test('closing before any sign-in resolves as closed, without saving', async () => {
  const t = setup();
  await t.clock.advance(1500);
  t.flow.windowClosed();
  assert.deepEqual(t.settled, [{ success: false, error: 'Modal closed' }]);
  assert.deepEqual(t.commits, []);
  // A detection that lands after the close is ignored.
  t.detects[0].resolve({ name: 'alice' });
  await t.clock.flush();
  assert.equal(t.extracts.length, 0);
  assert.deepEqual(t.commits, []);
  await t.clock.advance(10000);
  assert.equal(t.detects.length, 1, 'polling stopped');
});

test('the overall deadline closes the window and resolves as timed out', async () => {
  const t = setup();
  for (let i = 0; i < 199; i++) {
    await t.clock.advance(1500);
    t.detects[t.detects.length - 1].resolve(null);
  }
  await t.clock.advance(300000);
  assert.deepEqual(t.settled, [{ success: false, error: 'Login timed out' }]);
  assert.equal(t.closes(), 1);
  assert.deepEqual(t.commits, []);
});

test('the deadline also fires while a poll hangs (a page that never stops loading)', async () => {
  const t = setup();
  await t.clock.advance(300000);
  assert.deepEqual(t.settled, [{ success: false, error: 'Login timed out' }]);
});

test('a poll that throws keeps polling', async () => {
  const t = setup();
  await t.clock.advance(1500);
  t.detects[0].reject(new Error('page closed or crashed'));
  await t.clock.flush();
  await t.clock.advance(1500);
  assert.equal(t.detects.length, 2);
  assert.equal(t.settled.length, 0);
});

test('a commit that throws still resolves the call', async () => {
  const t = setup({ commit: () => { throw new Error('disk full'); } });
  await t.clock.advance(1500);
  t.detects[0].resolve({ name: 'alice' });
  await t.clock.flush();
  t.extracts[0].resolve('alice');
  await t.clock.flush();
  assert.deepEqual(t.settled, [{ success: true, username: 'alice' }]);
});
