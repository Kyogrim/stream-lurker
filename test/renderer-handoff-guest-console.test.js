// Which lines a stream page prints reach the activity console (F43 item 3,
// F44 item 5): the Twitch quality lines and the Kick theatre give-up are
// forwarded like the Kick quality ones, only from a platform page, and the
// same line from one cell is shown at most once a minute. Also the sync
// opt-out on createStreamTab that the dashboard restore uses (F77).
// Runs src/guest-console.js directly and src/multi-lurk.js on the fake DOM.
// Run: node --test test/renderer-handoff-guest-console.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, FakeElement } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

// ── The policy ───────────────────────────────────────────────────────────────

test('F43/F44: guestLogLine forwards the tagged lines inject.js prints, reworded', async () => {
  const { guestLogLine } = await load('src/guest-console.js');
  assert.equal(guestLogLine('[Twitch Quality] Quality set to 160p30 on /xqc.', 'xQc'),
    '[Quality - xQc] Quality set to 160p30 on /xqc.');
  assert.equal(guestLogLine('[Kick Quality] Could not find the quality menu; giving up on /abc.', 'abc'),
    '[Quality - abc] Could not find the quality menu; giving up on /abc.');
  assert.equal(guestLogLine('[Kick Quality] Error in quality setting loop: boom', 'abc'),
    '[Quality - abc] Error in quality setting loop: boom');
  assert.equal(guestLogLine('[Kick Theater] Theater button did not respond after 3 clicks; leaving the layout alone.', 'abc'),
    '[Theater - abc] Theater button did not respond after 3 clicks; leaving the layout alone.');
});

test('F43/F44: guestLogLine ignores everything else', async () => {
  const { guestLogLine } = await load('src/guest-console.js');
  for (const message of [
    '[Twitch Theater] Need Alt+T',        // handled by the Alt+T path, not logged
    '[YT Quality] Selected 144p',
    '[Ghost Mode] Video decoding suspended to save CPU.',
    '[Rewards - x] Claimed channel points chest!', // points.js logs these itself (F48)
    'ad says [Twitch Quality] you won',   // a tag mid-line is not ours
    '[Twitch Quality]',                   // nothing after the tag
    '[Twitch Quality]    ',
    '', null, undefined, 42, { toString: () => '[Kick Quality] x' },
  ]) {
    assert.equal(guestLogLine(message, 'u'), null, String(message));
  }
});

test('F44: a huge page string is cut, not copied into the console whole', async () => {
  const { guestLogLine } = await load('src/guest-console.js');
  const line = guestLogLine(`[Kick Quality] ${'x'.repeat(10000)}`, 'u');
  assert.ok(line.length <= '[Quality - u] '.length + 300, String(line.length));
});

test('F44: createLineDeduper drops a repeat within the window and allows it after', async () => {
  const { createLineDeduper, GUEST_LOG_DEDUPE_MS } = await load('src/guest-console.js');
  assert.equal(GUEST_LOG_DEDUPE_MS, 60000);
  const show = createLineDeduper();
  const t0 = 1_000_000;
  assert.equal(show('a', t0), true);
  assert.equal(show('a', t0 + 15000), false, 'the 15 s retry loop line');
  assert.equal(show('b', t0 + 15000), true, 'a different line is not held back');
  assert.equal(show('a', t0 + 59999), false);
  assert.equal(show('a', t0 + 60000), true, 'a minute after it was shown');
  assert.equal(show('a', t0 + 60001), false);
});

test('F44: lines a full window apart are always shown', async () => {
  const { createLineDeduper } = await load('src/guest-console.js');
  const show = createLineDeduper(1000);
  // An expired entry must not keep suppressing its line.
  for (let i = 0; i < 500; i++) assert.equal(show(`line ${i % 5}`, i * 1000), true, String(i));
});

// ── Wired into a grid cell ───────────────────────────────────────────────────

Object.defineProperty(FakeElement.prototype, 'isConnected', {
  configurable: true,
  get() { for (let n = this; n; n = n.parentNode) if (n.tagName === 'HTML') return true; return false; },
});
FakeElement.prototype.focus = function focus() { this.ownerDocument.activeElement = this; };
FakeElement.prototype.blur = function blur() {};
globalThis.ResizeObserver = class { observe() {} unobserve() {} };
globalThis.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };

const doc = createDocument();
const consoleEl = doc.add('div', 'console-logs');
doc.add('div', 'active-lurk-tabs');
doc.add('div', 'multi-lurk-grid', 'multi-lurk-grid');
doc.add('section', 'tab-multi-lurk', 'tab-content');
doc.add('section', 'tab-dashboard', 'tab-content active');
doc.activeElement = doc.body;
doc.hasFocus = () => true;
globalThis.document = doc;

const api = { calls: [] };
for (const name of ['updateActiveTabs', 'closeStreamContainer', 'saveConfig', 'openExternal', 'popoutStream']) {
  api[name] = (...args) => { api.calls.push([name, ...args]); return Promise.resolve(true); };
}
globalThis.window = { api, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: true }) });

const logs = () => consoleEl.children.map(c => c.textContent);

let ml, state;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  ml = await load('src/multi-lurk.js');
});

function reset() {
  ml.closeAllStreamTabs();
  api.calls.length = 0;
  consoleEl.children = [];
  state.currentConfig = { streamers: [], disabledAutoQuality: {}, watchTime: { streamers: {} }, defaultQuality: '160p' };
  state.currentStatuses = [];
}

function openCell(platform, username, url) {
  ml.createStreamTab(platform, username);
  const cell = doc.getElementById(`grid-cell-${platform}-${username.toLowerCase()}`);
  const wv = cell.querySelector('webview');
  wv.url = url;
  wv.getURL = () => wv.url;
  wv.setAudioMuted = () => {};
  wv.executeJavaScript = () => Promise.resolve();
  wv.reload = () => {};
  wv.sendInputEvent = () => {};
  return { cell, wv };
}
const say = (wv, message) => wv.dispatch('console-message', { message });

test('F43: a Twitch cell forwards its quality lines like a Kick cell does', async () => {
  reset();
  const { wv: tw } = openCell('twitch', 'Alpha', 'https://www.twitch.tv/alpha');
  const { wv: kk } = openCell('kick', 'beta', 'https://kick.com/beta');
  await say(tw, '[Twitch Quality] Quality set to 160p30 on /alpha.');
  await say(kk, '[Kick Quality] Quality set to 160p on /beta.');
  await say(kk, '[Kick Theater] Theater button did not respond after 3 clicks; leaving the layout alone.');
  assert.deepEqual(logs().filter(l => /^\[(Quality|Theater) - /.test(l)), [
    '[Quality - Alpha] Quality set to 160p30 on /alpha.',
    '[Quality - beta] Quality set to 160p on /beta.',
    '[Theater - beta] Theater button did not respond after 3 clicks; leaving the layout alone.',
  ]);
});

test('F44: the same line from one cell shows once a minute; other cells are separate', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_780_000_000_000 });
  reset();
  const { wv: a } = openCell('kick', 'aa', 'https://kick.com/aa');
  const { wv: b } = openCell('kick', 'bb', 'https://kick.com/bb');
  const fail = '[Kick Quality] Could not find the quality menu (attempt 1).';
  const forwarded = () => logs().filter(l => l.startsWith('[Quality - '));

  for (let i = 0; i < 4; i++) {                // a page stuck logging every 15 s
    await say(a, fail);
    t.mock.timers.tick(15000);
  }
  assert.deepEqual(forwarded(), ['[Quality - aa] Could not find the quality menu (attempt 1).']);
  await say(b, fail);                          // same text, another cell
  assert.equal(forwarded().length, 2);
  await say(a, fail);                          // 60 s after a's first line
  assert.equal(forwarded().length, 3);
});

test('F44: tagged lines from a page off the platform hosts are not forwarded', async () => {
  reset();
  const { wv } = openCell('twitch', 'gamma', 'https://twitch.tv.example.net/gamma');
  await say(wv, '[Twitch Quality] Quality set to 160p30 on /gamma.');
  wv.url = 'http://www.twitch.tv/gamma';
  await say(wv, '[Twitch Quality] Quality set to 160p30 on /gamma.');
  wv.url = 'https://www.twitch.tv/gamma';
  await say(wv, 'ad frame: [Twitch Quality] fake');
  assert.deepEqual(logs().filter(l => l.startsWith('[Quality - ')), []);
});

test('F44: a quality line never reaches the Alt+T path, and a malformed event is ignored', async () => {
  reset();
  const { wv } = openCell('twitch', 'delta', 'https://www.twitch.tv/delta');
  let pressed = 0;
  wv.sendInputEvent = () => { pressed++; };
  await say(wv, '[Twitch Quality] [Twitch Theater] Need Alt+T');
  await wv.dispatch('console-message', {});
  await wv.dispatch('console-message', { message: 12 });
  assert.equal(pressed, 0);
});

// ── F77: createStreamTab's sync opt-out ─────────────────────────────────────

test('F77: createStreamTab syncs by default and not with { sync: false }', () => {
  reset();
  const syncs = () => api.calls.filter(c => c[0] === 'updateActiveTabs').map(c => c[1]);
  ml.createStreamTab('twitch', 'one');
  assert.deepEqual(syncs(), [['twitch:one']], 'a user or main open reports itself at once');
  ml.createStreamTab('kick', 'Two', { sync: false });
  ml.createStreamTab('youtube', '@three', { sync: false });
  assert.equal(syncs().length, 1, 'restore opens stay quiet');
  assert.ok(doc.getElementById('grid-cell-kick-two'), 'the cell is still built');
  ml.syncActiveTabs();
  assert.deepEqual(syncs()[1], ['twitch:one', 'kick:two', 'youtube:@three']);
});
