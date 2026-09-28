// F93: a render step that throws during startup must not leave the dashboard
// deaf to main. Boots the real renderer.js (init runs on import) against the
// fake DOM from renderer-fake-dom.js, with a config whose extension list and
// calendar throw when read, as a damaged import used to make them.
// Run: node --test test/renderer-init-isolation.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, FakeElement } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

test('F93: a throwing render still leaves listeners registered and open streams restored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  Object.defineProperty(FakeElement.prototype, 'isConnected', {
    configurable: true,
    get() { for (let n = this; n; n = n.parentNode) if (n.tagName === 'HTML') return true; return false; },
  });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} };
  globalThis.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };

  const doc = createDocument();
  doc.readyState = 'complete';
  doc.hasFocus = () => false;
  const consoleEl = doc.add('div', 'console-logs');
  doc.add('div', 'active-lurk-tabs');
  doc.add('div', 'multi-lurk-grid', 'multi-lurk-grid');
  doc.add('section', 'tab-multi-lurk', 'tab-content');
  doc.add('section', 'tab-dashboard', 'tab-content active');
  doc.add('div', null, 'days-columns');
  const extList = doc.add('div', 'extensions-list');
  globalThis.document = doc;

  // A config as a damaged import leaves it: reading these throws, the way
  // renderExtensionsList and renderCalendar used to on a null list or an
  // event without a time.
  // The entry with no platform sits before kick:bar's: the display-casing
  // lookup skips it (monitoredStreamers) instead of throwing, so kick:bar is
  // restored. youtube:@baz's auto-quality flag throws when read, so that one
  // stream fails to rebuild; twitch:foo, after it, must be restored anyway.
  const config = {
    streamers: [{ platform: 'twitch', username: 'Foo' }, { platform: null, username: 'broken' }, { platform: 'kick', username: 'Bar' }],
    watchTime: { streamers: {} },
    accounts: {},
    disabledAutoQuality: { get 'youtube:@baz'() { throw new Error('damaged quality entry'); } },
  };
  Object.defineProperty(config, 'extensions', { enumerable: true, get() { throw new Error('extensions is not iterable'); } });
  Object.defineProperty(config, 'calendarEvents', { enumerable: true, get() { throw new Error("reading 'localeCompare'"); } });

  const registered = new Set();
  const invoked = [];
  const answers = {
    getConfig: config,
    getActiveContainers: ['kick:bar', 'youtube:@baz', 'twitch:foo'],
    getRecentLogs: ['[Scan] earlier line'],
    syncPlatformSchedules: [],
  };
  globalThis.window = {
    api: new Proxy({}, {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        if (/^on[A-Z]/.test(name)) return () => { registered.add(name); };
        return (...args) => { invoked.push([name, ...args]); return Promise.resolve(answers[name]); };
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };

  const errors = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args) => errors.push(args.map(String).join(' '));
  t.after(() => Object.assign(console, saved));

  await import(pathToFileURL(path.join(ROOT, 'renderer.js')).href);
  await flush();

  const logs = consoleEl.children.map(c => c.textContent);
  // Both failures are reported, by step name...
  assert.ok(logs.some(l => /^\[ERROR\] Extensions list failed during startup: extensions is not iterable/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /^\[ERROR\] Calendar failed during startup/.test(l)), logs.join('\n'));
  assert.ok(!logs.some(l => /Initialization failed/.test(l)), 'the config itself loaded fine');
  // ...and everything after them still ran.
  for (const name of ['onLogMessage', 'onStatusUpdate', 'onActiveContainersUpdate', 'onOpenStreamTab', 'onCloseStreamTab', 'onWatchTimeUpdate']) {
    assert.ok(registered.has(name), `${name} was never registered`);
  }
  // A malformed streamer entry costs no stream its cell...
  assert.ok(!logs.some(l => /Restoring kick:bar failed/.test(l)), logs.join('\n'));
  assert.ok(doc.getElementById('grid-cell-kick-bar'), 'kick:bar restored past the entry with no platform');
  assert.equal(doc.getElementById('grid-cell-kick-bar').dataset.username, 'Bar', 'with its display casing');
  // ...and one stream that cannot be rebuilt costs only its own.
  assert.ok(logs.some(l => /^\[ERROR\] Restoring youtube:@baz failed during startup: damaged quality entry/.test(l)), logs.join('\n'));
  assert.equal(doc.getElementById('grid-cell-youtube-@baz'), null);
  assert.ok(doc.getElementById('grid-cell-twitch-foo'), 'the stream after the failed one was restored');
  assert.equal(doc.getElementById('grid-cell-twitch-foo').dataset.username, 'Foo', 'with its display casing');
  assert.ok(logs.includes('[Scan] earlier line'), 'recent logs were replayed');
  assert.deepEqual(invoked.filter(c => c[0] === 'updateActiveTabs').map(c => c[1]), [['kick:bar', 'twitch:foo']],
    'main hears once, without the stream that failed');

  // The calendar keeps syncing on its own timer.
  t.mock.timers.tick(5000);
  await flush();
  assert.ok(invoked.some(c => c[0] === 'syncPlatformSchedules'), 'background calendar sync never started');

  // The null list from the finding itself no longer throws at all.
  const { state } = await import(pathToFileURL(path.join(ROOT, 'src/state.js')).href);
  const { renderExtensionsList } = await import(pathToFileURL(path.join(ROOT, 'src/extensions.js')).href);
  for (const extensions of [null, undefined, 'C:/x', {}, [null, 5, 'C:/exts/ublock']]) {
    state.currentConfig = { extensions };
    assert.doesNotThrow(() => renderExtensionsList(), String(extensions));
  }
  assert.equal(extList.querySelectorAll('.ext-item').length, 1, 'only the string entry is listed');
  assert.equal(extList.querySelector('.ext-item-title').textContent, 'ublock');
});
