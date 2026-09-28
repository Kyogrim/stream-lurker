// Stream-cell lifecycle in the Multi-Lurk grid, run against the real renderer
// modules on the fake DOM from renderer-fake-dom.js:
//   F15  a crashed or failed-to-load cell is reloaded with capped backoff and
//        closed through the close button's path when that fails (contract C6)
//   F90  mute and ghost state survive a reload
//   F42  "Need Alt+T" never steals focus and is acted on once per page
//   F88  main closing a stream doesn't move a user off a static tab
//   F49  a dashed username's sidebar tab shows its own cell
//   G1.4 the quality script is injected on exact platform hosts only
// Run: node --test test/renderer-cell-lifecycle.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, FakeElement } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const T0 = 1_780_000_000_000;

// What the fake DOM lacks and multi-lurk.js uses.
Object.defineProperty(FakeElement.prototype, 'isConnected', {
  configurable: true,
  get() { for (let n = this; n; n = n.parentNode) if (n.tagName === 'HTML') return true; return false; },
});
FakeElement.prototype.focus = function focus() { this.ownerDocument.activeElement = this; };
FakeElement.prototype.blur = function blur() {
  if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
};
globalThis.ResizeObserver = class { observe() {} unobserve() {} };
globalThis.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };

// One document for the file: appendLogMessage caches the console element the
// first time it runs.
const doc = createDocument();
const consoleEl = doc.add('div', 'console-logs');
doc.add('div', 'active-lurk-tabs');
const grid = doc.add('div', 'multi-lurk-grid', 'multi-lurk-grid');
const multiTab = doc.add('section', 'tab-multi-lurk', 'tab-content');
doc.add('section', 'tab-dashboard', 'tab-content active');
doc.add('section', 'tab-settings', 'tab-content');
for (const name of ['dashboard', 'settings']) {
  const b = doc.add('button', null, name === 'dashboard' ? 'nav-btn active' : 'nav-btn');
  b.setAttribute('data-tab', name);
}
doc.activeElement = doc.body;
doc.focused = true;
doc.hasFocus = () => doc.focused;
globalThis.document = doc;

const api = { calls: [] };
for (const name of ['updateActiveTabs', 'closeStreamContainer', 'saveConfig', 'openExternal', 'popoutStream']) {
  api[name] = (...args) => { api.calls.push([name, ...args]); return Promise.resolve(true); };
}
const windowListeners = {};
globalThis.window = {
  api,
  addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(f => f !== fn); },
};
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: online }) });

const logs = () => consoleEl.children.map(c => c.textContent);
const callsOf = name => api.calls.filter(c => c[0] === name);

// The <webview> guest API the cell code calls, recorded.
function stubWebview(wv, url) {
  wv.url = url;
  wv.muted = true;
  wv.log = [];
  wv.getURL = () => wv.url;
  wv.setAudioMuted = m => { wv.muted = m; wv.log.push(['setAudioMuted', m]); };
  wv.isAudioMuted = () => wv.muted;
  wv.executeJavaScript = code => { wv.log.push(['exec', code]); return Promise.resolve(); };
  wv.reload = () => wv.log.push(['reload']);
  wv.sendInputEvent = ev => wv.log.push(['input', ev.type]);
  const focus = wv.focus;
  wv.focus = () => { wv.log.push(['focus']); focus.call(wv); };
  return wv;
}
const count = (wv, kind) => wv.log.filter(e => e[0] === kind).length;

let ml, tabs, inject, recovery, state;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  ml = await load('src/multi-lurk.js');
  tabs = await load('src/tabs.js');
  inject = await load('src/inject.js');
  recovery = await load('src/cell-recovery.js');
});

function reset() {
  ml.closeAllStreamTabs();
  api.calls.length = 0;
  consoleEl.children = [];
  online = true;
  doc.activeElement = doc.body;
  doc.focused = true;
  state.currentConfig = { streamers: [], disabledAutoQuality: {}, watchTime: { streamers: {} }, defaultQuality: '160p' };
  state.currentStatuses = [];
  tabs.switchTab('dashboard');
}

function openCell(platform, username, url = `https://www.${platform}.tv/${username}`) {
  ml.createStreamTab(platform, username);
  const cell = doc.getElementById(`grid-cell-${platform}-${username.toLowerCase()}`);
  return { cell, wv: stubWebview(cell.querySelector('webview'), url) };
}

// ── F15 ─────────────────────────────────────────────────────────────────────

test('F15 policy: which webview events are failures', () => {
  const d = recovery.describeCellFailure;
  assert.equal(d('render-process-gone', { details: { reason: 'crashed' } }), 'page process crashed');
  assert.equal(d('render-process-gone', { details: { reason: 'oom' } }), 'page process oom');
  assert.equal(d('render-process-gone', { reason: 'killed' }), 'page process killed');
  assert.equal(d('render-process-gone', { details: { reason: 'clean-exit' } }), null);
  assert.match(d('did-fail-load', { isMainFrame: true, errorCode: -106, errorDescription: 'ERR_INTERNET_DISCONNECTED' }), /ERR_INTERNET_DISCONNECTED/);
  // SPA navigations, redirects and cancelled navigations: ERR_ABORTED.
  assert.equal(d('did-fail-load', { isMainFrame: true, errorCode: -3 }), null);
  // Ad and chat subframes fail all the time.
  assert.equal(d('did-fail-load', { isMainFrame: false, errorCode: -105 }), null);
  assert.equal(d('did-fail-load', { errorCode: -105 }), null);
  assert.equal(d('did-fail-load', { isMainFrame: true, errorCode: 0 }), null);
  assert.equal(d('dom-ready', {}), null);
});

test('F15 policy: at most 3 reloads in any 10 minutes, backing off', () => {
  const plan = recovery.planCellRecovery;
  assert.deepEqual(recovery.RELOAD_DELAYS_MS, [5000, 30000, 120000]);
  assert.equal(recovery.MAX_RELOADS, 3);
  assert.deepEqual(plan([], T0), { action: 'reload', recent: [], attempt: 1, delayMs: 5000 });
  assert.equal(plan([T0], T0 + 10).delayMs, 30000);
  assert.equal(plan([T0, T0 + 1], T0 + 10).delayMs, 120000);
  assert.equal(plan([T0, T0 + 1, T0 + 2], T0 + 10).action, 'give-up');
  // Reloads older than the window no longer count, successful loads or not.
  const aged = plan([T0, T0 + 1, T0 + 2], T0 + 10 * 60 * 1000 + 2);
  assert.equal(aged.action, 'reload');
  assert.equal(aged.attempt, 1);
  assert.deepEqual(aged.recent, []);
  // Exactly 10 minutes old is out; a millisecond younger is in.
  const edge = plan([T0, T0 + 1, T0 + 2], T0 + 10 * 60 * 1000);
  assert.deepEqual(edge.recent, [T0 + 1, T0 + 2]);
  assert.equal(edge.delayMs, 120000);
  assert.equal(plan([T0 - 1, T0 + 1, T0 + 2], T0 + 10 * 60 * 1000 - 1).action, 'reload', 'only two within the window');
  assert.equal(plan(null, T0).action, 'reload');
  assert.equal(plan([NaN, 'x'], T0).attempt, 1);
});

test('F15: a crashed cell reloads after 5 s and clears once a platform page loads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { cell, wv } = openCell('twitch', 'crashy');

  await wv.dispatch('render-process-gone', { details: { reason: 'crashed', exitCode: 1 } });
  assert.equal(cell.dataset.crashed, 'true');
  assert.match(logs().at(-1), /crashy \(TWITCH\): page process crashed\. Reloading in 5s \(attempt 1\/3\)/);
  t.mock.timers.tick(4999);
  assert.equal(count(wv, 'reload'), 0);
  t.mock.timers.tick(1);
  assert.equal(count(wv, 'reload'), 1);

  await wv.dispatch('did-start-loading');
  await wv.dispatch('dom-ready');
  await wv.dispatch('did-finish-load');
  assert.equal(cell.dataset.crashed, undefined);
  assert.match(logs().at(-1), /crashy \(TWITCH\) recovered/);
  assert.equal(callsOf('closeStreamContainer').length, 0);
});

test('F15: a crash loop gets 3 reloads, then the cell is closed through the close button path', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { cell, wv } = openCell('twitch', 'loop');

  for (const delay of [5000, 30000, 120000]) {
    await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
    t.mock.timers.tick(delay);
    // Each reload loads fine and crashes again a minute later.
    await wv.dispatch('did-start-loading');
    await wv.dispatch('did-finish-load');
    t.mock.timers.tick(60000);
  }
  assert.equal(count(wv, 'reload'), 3);
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  assert.deepEqual(callsOf('closeStreamContainer'), [['closeStreamContainer', 'twitch', 'loop']]);
  assert.match(logs().at(-1), /3 reloads in 10 minutes did not fix it; closing the stream/);
  // No further reloads, and a second failure doesn't close it twice.
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(count(wv, 'reload'), 3);
  assert.equal(callsOf('closeStreamContainer').length, 1);

  // Main answers with close-stream-tab, the same as for the close button.
  ml.removeStreamTab('twitch', 'loop');
  assert.equal(cell.isConnected, false);
  assert.deepEqual(callsOf('updateActiveTabs').at(-1), ['updateActiveTabs', []]);
});

test('F15: reloads older than 10 minutes stop counting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { wv } = openCell('kick', 'daily');
  for (const delay of [5000, 30000, 120000]) {
    await wv.dispatch('render-process-gone', { details: { reason: 'oom' } });
    t.mock.timers.tick(delay);
  }
  t.mock.timers.tick(11 * 60 * 1000);
  await wv.dispatch('render-process-gone', { details: { reason: 'oom' } });
  assert.match(logs().at(-1), /attempt 1\/3/);
  t.mock.timers.tick(5000);
  assert.equal(count(wv, 'reload'), 4);
  assert.equal(callsOf('closeStreamContainer').length, 0);
});

test('F15: a failed load reloads, and its error page never counts as recovered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { cell, wv } = openCell('youtube', '@chan', 'https://www.youtube.com/@chan/live');

  await wv.dispatch('did-start-loading');
  await wv.dispatch('did-fail-load', { isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: wv.url });
  // Chromium's error page: dom-ready and a finish-load on the same URL.
  await wv.dispatch('dom-ready');
  await wv.dispatch('did-finish-load');
  assert.equal(cell.dataset.crashed, 'true');
  // One outage, several events: still one pending reload.
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  t.mock.timers.tick(5000);
  assert.equal(count(wv, 'reload'), 1);

  await wv.dispatch('did-start-loading');
  await wv.dispatch('did-finish-load');
  assert.equal(cell.dataset.crashed, undefined);
});

test('F15: a recovered page that never fires load still clears on dom-ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { cell, wv } = openCell('twitch', 'noload');
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  t.mock.timers.tick(5000);
  await wv.dispatch('did-start-loading');
  await wv.dispatch('dom-ready');
  assert.equal(cell.dataset.crashed, undefined);
  // Off the platform (a login bounce, say) is not "recovered".
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  t.mock.timers.tick(30000);
  wv.url = 'https://accounts.google.com/ServiceLogin';
  await wv.dispatch('did-start-loading');
  await wv.dispatch('dom-ready');
  await wv.dispatch('did-finish-load');
  assert.equal(cell.dataset.crashed, 'true');
});

test('F15: routine failures are ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { cell, wv } = openCell('twitch', 'calm');
  await wv.dispatch('did-fail-load', { isMainFrame: true, errorCode: -3 });
  await wv.dispatch('did-fail-load', { isMainFrame: false, errorCode: -105 });
  await wv.dispatch('render-process-gone', { details: { reason: 'clean-exit' } });
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(cell.dataset.crashed, undefined);
  assert.equal(count(wv, 'reload'), 0);
});

test('F15: closing a cell cancels its pending reload and ignores the teardown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { wv } = openCell('twitch', 'gone');
  const { wv: healthy } = openCell('twitch', 'fine');
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  ml.removeStreamTab('twitch', 'gone');
  ml.removeStreamTab('twitch', 'fine');
  const linesAfterClose = logs().length;
  // Tearing the guest down may still report in.
  await wv.dispatch('render-process-gone', { details: { reason: 'killed' } });
  await healthy.dispatch('render-process-gone', { details: { reason: 'killed' } });
  await healthy.dispatch('did-fail-load', { isMainFrame: true, errorCode: -2 });
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(count(wv, 'reload') + count(healthy, 'reload'), 0);
  assert.equal(callsOf('closeStreamContainer').length, 0);
  assert.equal(logs().length, linesAfterClose, 'nothing announced for a closed cell');
});

test('F15: offline, recovery waits for the network instead of burning attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { wv } = openCell('twitch', 'wifi');
  online = false;
  await wv.dispatch('did-fail-load', { isMainFrame: true, errorCode: -106 });
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(count(wv, 'reload'), 0);
  assert.match(logs().at(-1), /Offline; will reload when the network is back/);
  assert.equal(windowListeners.online.length, 1);

  online = true;
  windowListeners.online.slice().forEach(fn => fn());
  assert.equal(windowListeners.online.length, 0);
  assert.match(logs().at(-1), /attempt 1\/3/);
  t.mock.timers.tick(5000);
  assert.equal(count(wv, 'reload'), 1);
});

test('F15: the manual reload button takes over a pending automatic reload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  reset();
  const { cell, wv } = openCell('twitch', 'manual');
  await wv.dispatch('render-process-gone', { details: { reason: 'crashed' } });
  await cell.querySelector('.reload-btn').dispatch('click');
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(count(wv, 'reload'), 1);
});

// ── F90 ─────────────────────────────────────────────────────────────────────

test('F90: a reload keeps the mute button and the audio in agreement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  const { cell, wv } = openCell('twitch', 'loud');
  const muteBtn = cell.querySelector('.mute-btn');
  const lastMute = () => wv.log.filter(e => e[0] === 'setAudioMuted').at(-1)?.[1];

  await wv.dispatch('dom-ready');
  assert.equal(lastMute(), true, 'a new cell starts muted');

  await muteBtn.dispatch('click');
  assert.equal(lastMute(), false);
  assert.equal(muteBtn.classList.contains('muted'), false);
  assert.equal(muteBtn.title, 'Mute Audio');

  // Reload button, recovery or an extension install: same dom-ready.
  await wv.dispatch('dom-ready');
  assert.equal(lastMute(), false, 'the user unmuted it, so it stays unmuted');
  assert.equal(muteBtn.classList.contains('muted'), false);
});

test('F90: a ghosted cell stays silent and suspended across a reload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  const { cell, wv } = openCell('twitch', 'ghosty');
  const muteBtn = cell.querySelector('.mute-btn');
  const ghostBtn = cell.querySelector('.ghost-mode-btn');
  const lastMute = () => wv.log.filter(e => e[0] === 'setAudioMuted').at(-1)?.[1];
  const suspends = () => wv.log.filter(e => e[0] === 'exec' && e[1] === inject.ghostSuspendScript).length;

  await muteBtn.dispatch('click'); // user unmutes
  await ghostBtn.dispatch('click'); // then ghosts it
  assert.equal(lastMute(), true, 'ghost mode mutes the page itself');
  assert.equal(suspends(), 1);

  // Toggling mute while ghosted changes the button, never the silence. The
  // toggle follows the button, not the webContents, which ghost muted.
  await muteBtn.dispatch('click');
  assert.equal(muteBtn.classList.contains('muted'), true);
  assert.equal(lastMute(), true);
  await muteBtn.dispatch('click');
  assert.equal(muteBtn.classList.contains('muted'), false);
  assert.equal(lastMute(), true);

  wv.log.length = 0;
  await wv.dispatch('dom-ready');
  assert.equal(lastMute(), true, 'reloaded while ghosted: still silent');
  // The player's <video> appears after dom-ready; suspension is retried.
  t.mock.timers.tick(30000);
  assert.equal(suspends(), 4);

  await ghostBtn.dispatch('click'); // un-ghost
  assert.equal(lastMute(), false, 'back to what the mute button says');
  wv.log.length = 0;
  await wv.dispatch('dom-ready');
  t.mock.timers.tick(30000);
  assert.equal(suspends(), 0, 'an un-ghosted cell is not re-suspended');
});

test('F90: un-ghosting while suspension retries are pending cancels them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  const { cell, wv } = openCell('kick', 'flip', 'https://kick.com/flip');
  const ghostBtn = cell.querySelector('.ghost-mode-btn');
  await ghostBtn.dispatch('click');
  await wv.dispatch('dom-ready');
  t.mock.timers.tick(0);
  await ghostBtn.dispatch('click');
  wv.log.length = 0;
  t.mock.timers.tick(30000);
  assert.equal(wv.log.filter(e => e[0] === 'exec' && e[1] === inject.ghostSuspendScript).length, 0);
});

// ── G1.4 ────────────────────────────────────────────────────────────────────

test('G1.4: the quality script goes into exact platform hosts only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  const { wv } = openCell('twitch', 'hosty');
  const injected = () => wv.log.filter(e => e[0] === 'exec' && /__autoQualityDisabled/.test(e[1])).length;
  const cases = [
    ['https://www.twitch.tv/hosty', true],
    ['https://twitch.tv/hosty', true],
    ['https://kick.com/hosty', true],
    ['https://www.youtube.com/@hosty/live', true],
    ['https://twitch.tv.example.net/hosty', false],
    ['https://evil.tld/?next=twitch.tv', false],
    ['https://nottwitch.tv/x', false],
    ['http://www.twitch.tv/hosty', false],
    ['', false],
  ];
  for (const [url, expected] of cases) {
    wv.url = url;
    wv.log.length = 0;
    await wv.dispatch('dom-ready');
    assert.equal(injected() > 0, expected, url);
  }
});

// ── F42 ─────────────────────────────────────────────────────────────────────

test('F42 policy: theaterKeyDecision', async () => {
  const { theaterKeyDecision, ALT_T_PER_PAGE } = await load('src/theater-key.js');
  assert.equal(ALT_T_PER_PAGE, 1);
  const ok = { url: 'https://www.twitch.tv/x', windowFocused: true, cellVisible: true, focusOwner: 'none' };
  assert.deepEqual(theaterKeyDecision(0, ok), { send: true, focus: true, reason: 'ok' });
  assert.deepEqual(theaterKeyDecision(0, { ...ok, focusOwner: 'self' }), { send: true, focus: false, reason: 'ok' });
  assert.equal(theaterKeyDecision(0, { ...ok, focusOwner: 'other' }).send, true);
  assert.equal(theaterKeyDecision(1, ok).reason, 'cap');
  assert.equal(theaterKeyDecision(0, { ...ok, url: 'https://kick.com/x' }).reason, 'not-twitch');
  assert.equal(theaterKeyDecision(0, { ...ok, url: 'https://twitch.tv.evil.net/x' }).reason, 'not-twitch');
  assert.equal(theaterKeyDecision(0, { ...ok, url: undefined }).reason, 'not-twitch');
  assert.equal(theaterKeyDecision(0, { ...ok, windowFocused: false }).reason, 'not-visible');
  assert.equal(theaterKeyDecision(0, { ...ok, cellVisible: false }).reason, 'not-visible');
  assert.equal(theaterKeyDecision(0, { ...ok, focusOwner: 'editable' }).reason, 'user-busy');
  assert.equal(theaterKeyDecision(0, { ...ok, focusOwner: 'webview' }).reason, 'user-busy');
});

test('F42: Alt+T only for a visible Twitch cell, once per page, never out of an input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  const { cell, wv } = openCell('twitch', 'theatre');
  const ask = () => wv.dispatch('console-message', { message: '[Twitch Theater] Need Alt+T' });
  const sent = () => count(wv, 'input');

  // On the dashboard: the grid isn't visible, so nothing happens.
  await ask();
  assert.equal(sent(), 0);

  // Typing in Settings... and on the grid but typing in a form field.
  tabs.switchTab('multi-lurk');
  const input = doc.createElement('input');
  doc.body.appendChild(input);
  doc.activeElement = input;
  await ask();
  assert.equal(sent(), 0);
  assert.equal(doc.activeElement, input, 'focus stays in the field');

  // Another cell has focus (the user is using its chat).
  const other = doc.createElement('webview');
  doc.activeElement = other;
  await ask();
  assert.equal(sent(), 0);

  // The window isn't focused.
  doc.activeElement = doc.body;
  doc.focused = false;
  await ask();
  assert.equal(sent(), 0);

  // Visible, focused window, nobody typing: exactly one press.
  doc.focused = true;
  await ask();
  assert.equal(sent(), 2, 'keyDown + keyUp');
  assert.equal(count(wv, 'focus'), 1);
  for (let i = 0; i < 5; i++) await ask();
  assert.equal(sent(), 2, 'a page that still asks gets no second press');
  assert.equal(logs().filter(l => /Sent native Alt\+T/.test(l)).length, 1);

  // A new document gets a fresh allowance; focus already there isn't re-taken.
  await wv.dispatch('did-navigate');
  await ask();
  assert.equal(sent(), 4);
  assert.equal(count(wv, 'focus'), 1);
  // Focus goes back where it was once the key has landed.
  assert.equal(doc.activeElement, wv);
  t.mock.timers.tick(500);
  assert.equal(doc.activeElement, doc.body);

  // Hidden in single view of another stream.
  await wv.dispatch('did-navigate');
  openCell('twitch', 'other');
  tabs.switchTab('stream-twitch-other');
  await ask();
  assert.equal(sent(), 4);
  assert.ok(cell.isConnected);
});

test('F42: every visible cell gets its Alt+T, and focus returns to where it was', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  tabs.switchTab('multi-lurk');
  const { wv: a } = openCell('twitch', 'first');
  const { wv: b } = openCell('twitch', 'second');
  const ask = wv => wv.dispatch('console-message', { message: '[Twitch Theater] Need Alt+T' });

  // The user last clicked a toolbar button (not a text field).
  const button = doc.createElement('button');
  doc.body.appendChild(button);
  doc.activeElement = button;
  await ask(a);
  await ask(b); // a holds focus for a moment: b waits its turn
  assert.deepEqual([count(a, 'input'), count(b, 'input')], [2, 0]);
  t.mock.timers.tick(500);
  assert.equal(doc.activeElement, button, 'focus went back to the button');
  await ask(b);
  assert.deepEqual([count(a, 'input'), count(b, 'input')], [2, 2]);

  // If the user moves focus meanwhile, it is left alone.
  const input = doc.createElement('input');
  doc.body.appendChild(input);
  await b.dispatch('did-navigate');
  doc.activeElement = doc.body;
  await ask(b);
  doc.activeElement = input;
  t.mock.timers.tick(500);
  assert.equal(doc.activeElement, input);
});

test('F42: an off-Twitch page printing the string gets nothing', async () => {
  reset();
  tabs.switchTab('multi-lurk');
  const { wv } = openCell('twitch', 'spoof', 'https://www.twitch.tv.example.net/spoof');
  await wv.dispatch('console-message', { message: 'ad says [Twitch Theater] Need Alt+T' });
  wv.url = 'https://kick.com/spoof';
  await wv.dispatch('console-message', { message: '[Twitch Theater] Need Alt+T' });
  assert.equal(count(wv, 'input'), 0);
  assert.equal(count(wv, 'focus'), 0);
});

// ── F88 ─────────────────────────────────────────────────────────────────────

const activeTab = () => doc.querySelector('.tab-content.active')?.id;

test('F88: main closing a stream leaves a user on a static tab where they are', () => {
  reset();
  openCell('twitch', 'a');
  openCell('twitch', 'b');
  openCell('kick', 'c');
  tabs.switchTab('settings');
  ml.removeStreamTab('twitch', 'a'); // offline auto-close / preemption
  assert.equal(activeTab(), 'tab-settings');
  assert.ok(doc.querySelector('.nav-btn[data-tab="settings"]').classList.contains('active'));
  // Closing everything (closeAllStreamTabs) also leaves them there.
  ml.closeAllStreamTabs();
  assert.equal(activeTab(), 'tab-settings');
});

test('F88: closing the stream being watched full-size falls back to the grid', () => {
  reset();
  openCell('twitch', 'a');
  openCell('twitch', 'b');
  tabs.switchTab('stream-twitch-a');
  assert.ok(grid.classList.contains('single-view'));
  ml.removeStreamTab('twitch', 'a');
  assert.equal(activeTab(), 'tab-multi-lurk');
  assert.equal(grid.classList.contains('single-view'), false);
  assert.ok(doc.getElementById('multi-lurk-tab-btn').classList.contains('active'));
});

test('F88: the grid view stays the grid view; the last close still goes to the dashboard', () => {
  reset();
  openCell('twitch', 'a');
  openCell('twitch', 'b');
  tabs.switchTab('multi-lurk');
  ml.removeStreamTab('twitch', 'a');
  assert.equal(activeTab(), 'tab-multi-lurk');
  // Watching another stream full-size: closing a background one keeps it.
  openCell('twitch', 'c');
  tabs.switchTab('stream-twitch-c');
  ml.removeStreamTab('twitch', 'b');
  assert.equal(activeTab(), 'tab-multi-lurk');
  assert.ok(doc.getElementById('grid-cell-twitch-c').classList.contains('maximized'));
  assert.ok(grid.classList.contains('single-view'));
  ml.removeStreamTab('twitch', 'c');
  assert.equal(activeTab(), 'tab-dashboard');
});

// ── F49 ─────────────────────────────────────────────────────────────────────

test('F49: a dashed username shows its own cell, not a prefix match', async () => {
  const { streamTabId, gridCellId, gridCellIdForTab } = await load('src/state.js');
  for (const [p, u] of [['kick', 'some-user'], ['youtube', '@foo-bar'], ['twitch', 'xqc'], ['kick', 'a-b-c-d'], ['youtube', '@Mixed-Case']]) {
    assert.equal(gridCellIdForTab(streamTabId(p, u)), gridCellId(p, u), `${p}/${u}`);
  }
  assert.equal(gridCellIdForTab('settings'), '');
  assert.equal(gridCellIdForTab(undefined), '');

  reset();
  openCell('kick', 'some', 'https://kick.com/some');
  openCell('kick', 'some-user', 'https://kick.com/some-user');
  openCell('youtube', '@foo-bar', 'https://www.youtube.com/@foo-bar/live');
  const maximized = () => grid.children.filter(c => c.classList.contains('maximized')).map(c => c.id);

  // Clicking the sidebar tab is what calls switchTab.
  await doc.querySelector('[data-tab="stream-kick-some-user"]').dispatch('click', { target: doc.querySelector('[data-tab="stream-kick-some-user"]') });
  assert.deepEqual(maximized(), ['grid-cell-kick-some-user']);
  tabs.switchTab('stream-youtube-@foo-bar');
  assert.deepEqual(maximized(), ['grid-cell-youtube-@foo-bar']);
  tabs.switchTab('stream-kick-some');
  assert.deepEqual(maximized(), ['grid-cell-kick-some']);
  assert.equal(activeTab(), 'tab-multi-lurk');
});
