// F14: a hidden probe page always settles by its deadline and always destroys
// its window, whatever the page does. Electron's executeJavaScript can stay
// pending forever (a crash, a reload mid-script, a load that never stops), so
// these fakes model exactly that: nothing settles unless the test says so.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPageScript, runScriptWithin, createProbeGate, isCrossDocumentMainFrameNavigation, HIDDEN_PAGE_DEADLINE_MS } = require('../main/hidden-page');
const { createClock, createFakeWindow } = require('./main-auth-fakes');

// Records unhandled rejections for the duration of one test.
function watchUnhandled() {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  return { seen, stop: () => process.off('unhandledRejection', onUnhandled) };
}

function start(clock, overrides = {}) {
  const fake = createFakeWindow();
  const result = runPageScript(fake.win, {
    url: 'https://www.youtube.com/', script: 'probe()', settleMs: 6000, deadlineMs: 45000, timers: clock, ...overrides,
  });
  let settled = false;
  let value;
  result.then((v) => { settled = true; value = v; });
  return { ...fake, result, isSettled: () => settled, value: () => value };
}

const listenerCount = (contents) =>
  ['render-process-gone', 'unresponsive', 'did-start-navigation'].reduce((n, e) => n + contents.listenerCount(e), 0);

test('default deadline covers a slow load plus the 6 s settle', () => {
  assert.equal(HIDDEN_PAGE_DEADLINE_MS, 45000);
});

test('happy path: returns the script value, destroys the window, leaves no timer or listener', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  assert.equal(run.state.loads.length, 1);
  assert.deepEqual(run.state.loads[0].options, undefined);
  run.state.loads[0].resolve();
  await clock.advance(5999);
  assert.equal(run.state.scripts.length, 0, 'script waits for the settle');
  await clock.advance(1);
  assert.equal(run.state.scripts.length, 1);
  run.state.scripts[0].resolve({ cfgReady: true, loggedIn: true });
  await clock.flush();
  assert.equal(run.isSettled(), true);
  assert.deepEqual(run.value(), { cfgReady: true, loggedIn: true });
  assert.equal(run.state.destroyed, true);
  assert.equal(clock.pending(), 0, 'the deadline timer is cleared on success');
  assert.equal(listenerCount(run.contents), 0);
});

test('a load that never finishes resolves null at the deadline and destroys the window', async () => {
  const clock = createClock();
  const watch = watchUnhandled();
  const run = start(clock);
  await clock.advance(44999);
  assert.equal(run.isSettled(), false);
  await clock.advance(1);
  assert.equal(run.isSettled(), true);
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
  assert.equal(clock.pending(), 0);
  // The load rejects once its window is destroyed; that must not surface.
  await new Promise((r) => setImmediate(r));
  watch.stop();
  assert.deepEqual(watch.seen, []);
});

test('a script that never replies resolves null at the deadline', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  run.state.loads[0].resolve();
  await clock.advance(6000);
  assert.equal(run.state.scripts.length, 1);
  await clock.advance(38999);
  assert.equal(run.isSettled(), false);
  await clock.advance(1);
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
  // A reply that arrives after the deadline changes nothing.
  run.state.scripts[0].resolve({ late: true });
  await clock.flush();
  assert.equal(run.value(), null);
});

test('a renderer crash during the settle bails out at once', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  run.state.loads[0].resolve();
  await clock.advance(2000);
  run.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  await clock.flush();
  assert.equal(run.isSettled(), true);
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
  assert.equal(clock.pending(), 0, 'settle and deadline timers both cleared');
  assert.equal(run.state.scripts.length, 0, 'no script is sent to a dead page');
});

test('an unresponsive page bails out', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  run.contents.emit('unresponsive');
  await clock.flush();
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
});

test('a main-frame document swap while the script runs bails out; one during the settle does not', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  run.state.loads[0].resolve();
  // Cloudflare reload during the settle: executeJavaScript would simply run in
  // the new document, so this is not a reason to give up.
  run.contents.emit('did-start-navigation', { url: 'https://kick.com/', isMainFrame: true, isSameDocument: false });
  await clock.advance(6000);
  assert.equal(run.isSettled(), false);
  assert.equal(run.state.scripts.length, 1);
  // Same-document (pushState) and subframe navigations are harmless too.
  run.contents.emit('did-start-navigation', { url: 'https://www.youtube.com/#x', isMainFrame: true, isSameDocument: true });
  run.contents.emit('did-start-navigation', { url: 'https://ads.example/', isMainFrame: false, isSameDocument: false });
  await clock.flush();
  assert.equal(run.isSettled(), false);
  // A redirect that replaces the document mid-script: its reply never comes.
  run.contents.emit('did-start-navigation', { url: 'https://consent.youtube.com/', isMainFrame: true, isSameDocument: false });
  await clock.flush();
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
});

test('legacy positional did-start-navigation arguments are understood', () => {
  assert.equal(isCrossDocumentMainFrameNavigation({}, false, true), true);
  assert.equal(isCrossDocumentMainFrameNavigation({}, true, true), false);
  assert.equal(isCrossDocumentMainFrameNavigation({}, false, false), false);
  assert.equal(isCrossDocumentMainFrameNavigation({ isMainFrame: true, isSameDocument: false }), true);
});

test('a failed load resolves null without waiting for the deadline', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  run.state.loads[0].reject(new Error('ERR_NAME_NOT_RESOLVED'));
  await clock.flush();
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
  assert.equal(clock.pending(), 0);
});

test('a script that rejects resolves null', async () => {
  const clock = createClock();
  const run = start(clock);
  await clock.flush();
  run.state.loads[0].resolve();
  await clock.advance(6000);
  run.state.scripts[0].reject(new Error('Script failed to execute'));
  await clock.flush();
  assert.equal(run.value(), null);
  assert.equal(run.state.destroyed, true);
});

test('runScriptWithin: resolves, times out, and fails fast when the page goes away', async () => {
  const clock = createClock();
  const { contents, state } = createFakeWindow();

  const ok = runScriptWithin(contents, 'a', 5000, clock);
  state.scripts[0].resolve(42);
  assert.equal(await ok, 42);
  assert.equal(contents.listenerCount('destroyed'), 0);
  assert.equal(contents.listenerCount('render-process-gone'), 0);
  assert.equal(clock.pending(), 0);

  const slow = runScriptWithin(contents, 'b', 5000, clock);
  const slowResult = slow.then(() => 'resolved', (e) => e.code);
  await clock.advance(5000);
  assert.equal(await slowResult, 'ETIMEDOUT');
  assert.equal(contents.listenerCount('destroyed'), 0);

  const gone = runScriptWithin(contents, 'c', 5000, clock);
  const goneResult = gone.then(() => 'resolved', (e) => e.code);
  contents.emit('render-process-gone');
  assert.equal(await goneResult, 'EGONE');
  assert.equal(clock.pending(), 0);

  state.destroyed = true;
  const dead = runScriptWithin(contents, 'd', 5000, clock);
  assert.equal(await dead.then(() => 'resolved', (e) => e.code), 'EGONE');
  assert.equal(state.scripts.length, 3, 'nothing is sent to a destroyed page');
});

test('runScriptWithin: a synchronous throw becomes a rejection', async () => {
  const clock = createClock();
  const { contents } = createFakeWindow();
  contents.executeJavaScript = () => { throw new Error('Object has been destroyed'); };
  await assert.rejects(runScriptWithin(contents, 'x', 5000, clock), /destroyed/);
  assert.equal(clock.pending(), 0);
});

test('probe gate: run() joins the probe in flight, fresh() always loads again', async () => {
  let calls = 0;
  const pending = [];
  const gate = createProbeGate(() => {
    calls++;
    return new Promise((r) => pending.push(r));
  });
  const a = gate.run();
  const b = gate.run();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, 'two background checks share one window');
  const c = gate.fresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'an import never gets a page that loaded with the old cookies');
  const d = gate.run();
  pending[0]('old');
  pending[1]('new');
  assert.equal(await a, 'old');
  assert.equal(await b, 'old');
  assert.equal(await c, 'new');
  assert.equal(await d, 'new', 'a background call joins the fresh probe');
  await new Promise((r) => setImmediate(r));
  assert.equal(gate.running, false);
  gate.run();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 3, 'a settled probe is not reused');
});

test('probe gate: a probe that throws is not kept', async () => {
  let calls = 0;
  const gate = createProbeGate(async () => { calls++; throw new Error('boom'); });
  await assert.rejects(gate.run(), /boom/);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(gate.run(), /boom/);
  assert.equal(calls, 2);
});
