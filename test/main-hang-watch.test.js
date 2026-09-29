// Gate tests for main/hang-watch.js (F15): a stream page that stays hung is
// crashed on purpose so the dashboard's crash recovery reloads it, and a page
// that recovers, crashes or closes on its own is left alone. A fake
// webContents and a manual clock stand in for Electron. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { HANG_GRACE_MS, watchForHang } = require('../main/hang-watch');

function fakeContents() {
  const c = new EventEmitter();
  c.destroyed = false;
  c.crashed = false;
  c.kills = 0;
  c.isDestroyed = () => c.destroyed;
  c.isCrashed = () => c.crashed;
  c.getURL = () => 'https://www.twitch.tv/someone';
  c.forcefullyCrashRenderer = () => { c.kills++; c.crashed = true; };
  return c;
}

// setTimeout / clearTimeout on a clock the test moves by hand.
function manualClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

function watch(c, clock, killed = []) {
  return watchForHang(c, { graceMs: 1000, onKill: (url) => killed.push(url), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
}

test('F15: a page still hung after the grace period is crashed once, and logged', () => {
  const c = fakeContents();
  const clock = manualClock();
  const killed = [];
  watch(c, clock, killed);
  c.emit('unresponsive');
  c.emit('unresponsive'); // repeated reports do not stack timers
  assert.equal(clock.pending(), 1);
  clock.advance(999);
  assert.equal(c.kills, 0, 'not before the grace period');
  clock.advance(1);
  assert.equal(c.kills, 1);
  assert.deepEqual(killed, ['https://www.twitch.tv/someone']);
  assert.ok(HANG_GRACE_MS >= 30000, 'long enough that a busy page is not mistaken for a dead one');
});

test('F15: a page that answers again, crashes on its own or closes is left alone', () => {
  for (const ev of ['responsive', 'render-process-gone', 'destroyed']) {
    const c = fakeContents();
    const clock = manualClock();
    watch(c, clock);
    c.emit('unresponsive');
    c.emit(ev);
    assert.equal(clock.pending(), 0, ev);
    clock.advance(5000);
    assert.equal(c.kills, 0, ev);
  }
  // Already crashed or destroyed when the timer fires: nothing to do.
  for (const flag of ['crashed', 'destroyed']) {
    const c = fakeContents();
    const clock = manualClock();
    watch(c, clock);
    c.emit('unresponsive');
    c[flag] = true;
    clock.advance(1000);
    assert.equal(c.kills, 0, flag);
  }
  // A second hang after a recovery gets a fresh grace period.
  const c = fakeContents();
  const clock = manualClock();
  watch(c, clock);
  c.emit('unresponsive');
  clock.advance(900);
  c.emit('responsive');
  c.emit('unresponsive');
  clock.advance(900);
  assert.equal(c.kills, 0);
  clock.advance(100);
  assert.equal(c.kills, 1);
});

test('F15: a contents that throws while closing does not take main down', () => {
  const c = fakeContents();
  c.forcefullyCrashRenderer = () => { throw new Error('Object has been destroyed'); };
  const clock = manualClock();
  watch(c, clock);
  c.emit('unresponsive');
  assert.doesNotThrow(() => clock.advance(1000));
});

test('F15: main.js watches every webview guest, and only guests', () => {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = mainJs.indexOf("app.on('web-contents-created'");
  const body = mainJs.slice(start, mainJs.indexOf('\n});', start));
  const webviewOnly = body.indexOf("if (contents.getType() !== 'webview') return;");
  const watchAt = body.indexOf('watchForHang(contents, {');
  assert.ok(webviewOnly > 0 && watchAt > webviewOnly, 'after the webview-only return');
});
