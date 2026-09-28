// Dashboard startup, booting the real renderer.js (init runs on import) on the
// fake DOM from renderer-fake-dom.js:
//   G4.8  the last scan's statuses are pulled before the first render, so a
//         reloaded dashboard shows live cards, viewer counts and the Live Now
//         count at once instead of "Checking..." until the next scan
//   F77   restoring open streams tells main once, with the full list, never
//         [A], [A,B], [A,B,C] (which ended and restarted B's and C's sessions)
//   F83   the dead portal refresh buttons are gone
//   F32   init logs no whole config or state objects
//   22    a rejected Scan Now still gives the button back
// Run: node --test test/renderer-handoff-init.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, FakeElement } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

test('G4.8 + F77: one boot of the dashboard against a main with three open streams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  Object.defineProperty(FakeElement.prototype, 'isConnected', {
    configurable: true,
    get() { for (let n = this; n; n = n.parentNode) if (n.tagName === 'HTML') return true; return false; },
  });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} };
  globalThis.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };

  const doc = createDocument();
  // The fake DOM does not parse pseudo-classes (settings.js asks for
  // input[name="platform"]:checked); nothing here is checked anyway.
  const qs = doc.querySelector;
  const qsa = doc.querySelectorAll;
  doc.querySelector = sel => (/:/.test(sel) ? null : qs(sel));
  doc.querySelectorAll = sel => (/:/.test(sel) ? [] : qsa(sel));
  doc.readyState = 'complete';
  doc.hasFocus = () => false;
  const consoleEl = doc.add('div', 'console-logs');
  doc.add('div', 'active-lurk-tabs');
  doc.add('div', 'multi-lurk-grid', 'multi-lurk-grid');
  doc.add('section', 'tab-multi-lurk', 'tab-content');
  doc.add('section', 'tab-dashboard', 'tab-content active');
  doc.add('div', null, 'days-columns');
  doc.add('div', 'extensions-list');
  const grid = doc.add('div', 'streams-grid');
  for (const id of ['total-streamers-stat', 'live-streamers-stat', 'containers-stat']) doc.add('span', id);
  doc.add('button', 'live-now-btn');
  const liveCount = doc.add('span', 'live-now-count');
  doc.add('div', 'live-now-list');
  const scanBtn = doc.add('button', 'scan-now-btn', 'btn btn-cyan');
  globalThis.document = doc;

  const streamers = [
    { platform: 'twitch', username: 'Alpha' },
    { platform: 'kick', username: 'beta' },
    { platform: 'youtube', username: '@Gamma' },
    { platform: 'twitch', username: 'offline' },
  ];
  const config = { streamers, watchTime: { streamers: {} }, accounts: {}, extensions: [], calendarEvents: [], syncedCalendarEvents: [] };
  const statuses = [
    { platform: 'twitch', username: 'Alpha', isLive: true, viewerCount: 1234, title: 'hi', category: 'Just Chatting', liveSince: new Date(Date.now() - 3600e3).toISOString() },
    { platform: 'twitch', username: 'offline', isLive: false },
  ];

  const registered = new Set();
  const invoked = [];
  let forceScan = () => Promise.resolve(true);
  const answers = {
    getConfig: config,
    getActiveContainers: ['twitch:alpha', 'kick:beta', 'youtube:@gamma'],
    getStatuses: statuses,
    getRecentLogs: [],
    syncPlatformSchedules: [],
  };
  globalThis.window = {
    api: new Proxy({}, {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        if (/^on[A-Z]/.test(name)) return () => { registered.add(name); };
        if (name === 'forceScan') return () => forceScan();
        return (...args) => { invoked.push([name, ...args]); return Promise.resolve(answers[name]); };
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };

  const consoleCalls = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => consoleCalls.push(args);
  console.warn = () => {};
  console.error = (...args) => consoleCalls.push(args);
  t.after(() => Object.assign(console, saved));

  await import(pathToFileURL(path.join(ROOT, 'renderer.js')).href);
  await flush();
  const logs = consoleEl.children.map(c => c.textContent);

  // G4.8: pulled once, before anything rendered from it.
  const order = invoked.map(c => c[0]);
  assert.equal(order.filter(n => n === 'getStatuses').length, 1);
  assert.ok(order.indexOf('getStatuses') > order.indexOf('getActiveContainers'), order.join(','));
  assert.ok(order.indexOf('getStatuses') < order.indexOf('updateActiveTabs'), 'before the open streams were restored');

  // The monitor grid shows the scan's answer, not placeholders.
  assert.doesNotMatch(grid.textContent, /Checking\.\.\./, 'no "Checking..." cards after a reload');
  const cards = grid.querySelectorAll('.stream-card');
  assert.equal(cards.length, 2);
  assert.ok(cards[0].classList.contains('live-twitch'), cards[0].className);
  assert.match(cards[0].textContent, /1\.2K Lurkers/);

  // The Live Now pill counts it, and the restored cell shows viewers and uptime.
  assert.equal(String(liveCount.textContent), '1');
  const alphaMeta = doc.getElementById('grid-cell-twitch-alpha').querySelector('.stream-cell-meta');
  assert.match(alphaMeta.textContent, /1\.2K/);
  assert.match(alphaMeta.textContent, /up 1h/);

  // F77: exactly one report, with every restored stream in it.
  const syncs = invoked.filter(c => c[0] === 'updateActiveTabs').map(c => c[1]);
  assert.deepEqual(syncs, [['twitch:alpha', 'kick:beta', 'youtube:@gamma']]);
  for (const id of ['grid-cell-twitch-alpha', 'grid-cell-kick-beta', 'grid-cell-youtube-@gamma']) {
    assert.ok(doc.getElementById(id), id);
  }
  assert.equal(doc.getElementById('grid-cell-youtube-@gamma').dataset.username, '@Gamma', 'display casing kept');

  assert.ok(!logs.some(l => /\[ERROR\]/.test(l)), logs.filter(l => /\[ERROR\]/.test(l)).join('\n'));

  // F32: nothing logged at startup carries an object (the config or state).
  for (const args of consoleCalls) {
    for (const a of args) assert.ok(a === null || typeof a !== 'object', `console got an object: ${String(args[0])}`);
  }

  // 22: forceScan now waits for the real scan; a rejection must not leave
  // the button stuck on "Scanning...".
  forceScan = () => Promise.reject(new Error('scan exploded'));
  await scanBtn.dispatch('click');
  assert.equal(scanBtn.disabled, true, 'busy while the scan runs');
  t.mock.timers.tick(1500);
  assert.equal(scanBtn.disabled, false, 'button given back');
  assert.match(scanBtn.textContent, /Scan Now/);
  assert.ok(consoleEl.children.map(c => c.textContent).includes('[ERROR] Scan Now failed: scan exploded'));
});

test('F77: a key that cannot be restored is still reported, once, as not open', async (t) => {
  // A second, independent boot of renderer.js (a fresh module instance) on a
  // fresh document. Its only open stream fails to restore: its auto-quality
  // flag throws when read. (A streamer entry with no platform no longer
  // fails anything; the display-casing lookup skips it.)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const doc = createDocument();
  doc.querySelector = (qs => sel => (/:/.test(sel) ? null : qs(sel)))(doc.querySelector);
  doc.querySelectorAll = (qsa => sel => (/:/.test(sel) ? [] : qsa(sel)))(doc.querySelectorAll);
  doc.readyState = 'complete';
  doc.hasFocus = () => false;
  doc.add('div', 'active-lurk-tabs');
  doc.add('div', 'multi-lurk-grid', 'multi-lurk-grid');
  globalThis.document = doc;

  const invoked = [];
  const answers = {
    getConfig: {
      streamers: [{ platform: null, username: 'x' }, { platform: 'kick', username: 'Bar' }],
      watchTime: { streamers: {} },
      accounts: {},
      disabledAutoQuality: { get 'kick:bar'() { throw new Error('damaged quality entry'); } },
    },
    getActiveContainers: ['kick:bar'],
    getStatuses: undefined,              // an older main without the channel
    getRecentLogs: [],
  };
  globalThis.window.api = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (/^on[A-Z]/.test(name)) return () => {};
      return (...args) => { invoked.push([name, ...args]); return Promise.resolve(answers[name]); };
    },
  });
  const saved = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  t.after(() => Object.assign(console, saved));

  await import(`${pathToFileURL(path.join(ROOT, 'renderer.js')).href}?second-boot`);
  await flush();

  assert.equal(doc.getElementById('grid-cell-kick-bar'), null, 'the restore failed');
  assert.deepEqual(invoked.filter(c => c[0] === 'updateActiveTabs').map(c => c[1]), [[]],
    'main is told once that nothing is open, so it stops crediting kick:bar');
  const { state } = await import(pathToFileURL(path.join(ROOT, 'src/state.js')).href);
  assert.deepEqual(state.currentStatuses, [], 'a missing answer reads as "no scan yet"');
});

test('F83: the portal refresh buttons are gone from renderer.js and index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const dead of ['setupRefreshWebviewButtons', 'WEBVIEW_LABEL', 'Portal refresh buttons', 'refresh-webview-btn', '-login-webview']) {
    assert.ok(!RENDERER_SRC.includes(dead), `renderer.js still has ${dead}`);
    assert.ok(!html.includes(dead), `index.html still has ${dead}`);
  }
});

test('F32: renderer.js never hands the config or state to console.*', () => {
  const calls = [...RENDERER_SRC.matchAll(/console\.(log|info|debug|warn)\(([^;]*)\);/g)];
  assert.ok(calls.length > 0);
  for (const [, , args] of calls) {
    assert.doesNotMatch(args, /\bstate\b|currentConfig|activeContainers|currentStatuses|initialLogs/, args);
  }
});
