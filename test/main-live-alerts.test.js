// Gate tests for main/live-alerts.js (F28): a go-live toast stays referenced
// until it is clicked or fails, survives 'close' (the Windows timeout into
// Action Center), and the set is bounded for weeks-long runs. A toast clicked
// while the dashboard is down is opened once it loads (issue-3). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ALERT_TTL_MS, MAX_ALERTS, PENDING_OPEN_TTL_MS, createAlertKeeper, createPendingOpens } = require('../main/live-alerts');

class FakeNotification extends EventEmitter {
  constructor() { super(); this.closed = false; }
  close() { this.closed = true; this.emit('close'); }
}

const T0 = Date.UTC(2026, 8, 27);

test('kept until clicked; a click releases it', () => {
  const k = createAlertKeeper();
  const n = new FakeNotification();
  k.keep('kick:x', n, T0);
  assert.ok(k.has('kick:x'));
  n.emit('click');
  assert.equal(k.has('kick:x'), false);
});

test('regression F28: the Windows timeout (close) does NOT release it', () => {
  const k = createAlertKeeper();
  const n = new FakeNotification();
  k.keep('kick:x', n, T0);
  n.emit('close'); // toast moved into Action Center; still clickable there
  assert.ok(k.has('kick:x'), 'dropping it here is exactly the bug');
});

test('failed releases it', () => {
  const k = createAlertKeeper();
  const n = new FakeNotification();
  k.keep('kick:x', n, T0);
  n.emit('failed', {}, 'toast error');
  assert.equal(k.size, 0);
});

test('a re-alert for the same stream replaces (and closes) the older toast', () => {
  const k = createAlertKeeper();
  const a = new FakeNotification();
  const b = new FakeNotification();
  k.keep('kick:x', a, T0);
  k.keep('kick:x', b, T0 + 1000);
  assert.equal(k.size, 1);
  assert.equal(a.closed, true);
  // A late click on the replaced toast must not release the new one.
  a.emit('click');
  assert.ok(k.has('kick:x'));
});

test('bounded by count: the oldest is evicted and closed', () => {
  const k = createAlertKeeper({ max: 3 });
  const ns = [0, 1, 2, 3].map(() => new FakeNotification());
  ns.forEach((n, i) => k.keep(`kick:s${i}`, n, T0 + i));
  assert.equal(k.size, 3);
  assert.equal(k.has('kick:s0'), false);
  assert.equal(ns[0].closed, true);
  assert.equal(MAX_ALERTS, 50);
});

test('bounded by age: day-old toasts are dropped when a new one arrives', () => {
  const k = createAlertKeeper();
  const old = new FakeNotification();
  k.keep('kick:old', old, T0);
  k.keep('kick:new', new FakeNotification(), T0 + ALERT_TTL_MS + 1);
  assert.equal(k.has('kick:old'), false);
  assert.equal(old.closed, true);
  assert.ok(k.has('kick:new'));
});

test('issue-3: a toast clicked while the dashboard is dead is opened once it loads, once', () => {
  const p = createPendingOpens();
  p.add('kick', 'Alice', T0);
  p.add('twitch', 'bob', T0 + 1000);
  p.add('KICK', 'alice', T0 + 2000); // a second click on the same stream
  assert.equal(p.size, 2);
  const { open, expired } = p.take(T0 + 30 * 1000);
  assert.deepEqual(open, [{ platform: 'twitch', username: 'bob' }, { platform: 'KICK', username: 'alice' }]);
  assert.deepEqual(expired, []);
  assert.equal(p.size, 0);
  assert.deepEqual(p.take(T0 + 60 * 1000), { open: [], expired: [] }, 'the next load opens nothing again');
});

test('issue-3: a click the dashboard took too long to come back for is dropped, not opened', () => {
  assert.equal(PENDING_OPEN_TTL_MS, 5 * 60 * 1000);
  const p = createPendingOpens();
  p.add('kick', 'old', T0);
  p.add('kick', 'fresh', T0 + PENDING_OPEN_TTL_MS);
  const { open, expired } = p.take(T0 + PENDING_OPEN_TTL_MS + 1);
  assert.deepEqual(open, [{ platform: 'kick', username: 'fresh' }]);
  assert.deepEqual(expired, [{ platform: 'kick', username: 'old' }]);
});
