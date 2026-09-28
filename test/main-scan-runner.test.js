// Gate tests for main/scan-runner.js: scans never overlap, a user request
// always gets a scan that started after it, and a throwing scan releases the
// lock. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSingleFlight } = require('../main/scan-runner');

// A task whose runs finish only when the test says so.
function controllableTask() {
  const runs = [];
  let active = 0;
  let maxActive = 0;
  const task = () => new Promise((resolve, reject) => {
    active++;
    maxActive = Math.max(maxActive, active);
    runs.push({
      finish: () => { active--; resolve(); },
      fail: (e) => { active--; reject(e); },
    });
  });
  return { task, runs, get maxActive() { return maxActive; } };
}

const tick = () => new Promise(r => setImmediate(r));

test('F25: scheduled scans join the one in progress instead of overlapping', async () => {
  const t = controllableTask();
  const runner = createSingleFlight(t.task);
  const a = runner.run();
  const b = runner.run();
  assert.equal(a, b);
  await tick();
  assert.equal(t.runs.length, 1);
  assert.equal(runner.running, true);
  t.runs[0].finish();
  await a;
  assert.equal(runner.running, false);
  assert.equal(t.maxActive, 1);
});

test('F25: requests during a scan share one follow-up that starts after it', async () => {
  const t = controllableTask();
  const runner = createSingleFlight(t.task);
  const first = runner.run();
  await tick();
  const order = [];
  const r1 = runner.runFresh().then(() => order.push('r1'));
  const r2 = runner.runFresh().then(() => order.push('r2'));
  const r3 = runner.runFresh().then(() => order.push('r3'));
  await tick();
  assert.equal(t.runs.length, 1, 'no second scan while the first runs');
  t.runs[0].finish();
  await first;
  await tick();
  assert.equal(t.runs.length, 2, 'exactly one follow-up for three requests');
  assert.deepEqual(order, [], 'requests are not answered by the scan that was already running');
  t.runs[1].finish();
  await Promise.all([r1, r2, r3]);
  assert.deepEqual(order, ['r1', 'r2', 'r3']);
  assert.equal(t.maxActive, 1);
  assert.equal(runner.running, false);
});

test('F25: a request when idle starts a scan immediately', async () => {
  const t = controllableTask();
  const runner = createSingleFlight(t.task);
  const p = runner.runFresh();
  await tick();
  assert.equal(t.runs.length, 1);
  t.runs[0].finish();
  await p;
});

test('G2.2: a scan that throws is reported, never rejects, and does not wedge the runner', async () => {
  const errors = [];
  const t = controllableTask();
  const runner = createSingleFlight(t.task, e => errors.push(e.message));
  const p = runner.run();
  await tick();
  t.runs[0].fail(new Error("Cannot read properties of undefined (reading 'toLowerCase')"));
  await p; // resolves
  assert.deepEqual(errors, ["Cannot read properties of undefined (reading 'toLowerCase')"]);
  assert.equal(runner.running, false);
  const next = runner.run();
  await tick();
  assert.equal(t.runs.length, 2);
  t.runs[1].finish();
  await next;

  const sync = createSingleFlight(() => { throw new Error('sync throw'); }, e => errors.push(e.message));
  await sync.run();
  assert.equal(errors.at(-1), 'sync throw');
  // A throwing reporter must not break the chain either.
  const loud = createSingleFlight(() => { throw new Error('x'); }, () => { throw new Error('reporter'); });
  await loud.run();
  assert.equal(loud.running, false);
});
