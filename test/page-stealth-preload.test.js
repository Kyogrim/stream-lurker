// src/twitch-preload.js must inject its stealth script exactly once per
// document (F46). Runs the real preload file in a vm with a fake document that
// starts without a root element, as a document-start preload sees it.
// Run: node --test test/page-stealth-preload.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeDocument, FakeMutationObserver, FakeEvent } = require('./page-fake-dom');

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'twitch-preload.js'), 'utf8');
const tick = () => new Promise(r => setImmediate(r));

function runPreload({ rootAtStart = false } = {}) {
  const doc = new FakeDocument();
  if (rootAtStart) doc.mountRoot();
  const injected = [];
  const createElement = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = createElement(tag);
    if (tag === 'script') {
      const append = el.appendChild.bind(el);
      el.appendChild = (node) => { injected.push(node.textContent); return append(node); };
    }
    return el;
  };
  const errors = [];
  const ctx = {
    document: doc,
    MutationObserver: class { constructor(cb) { return new FakeMutationObserver(doc, cb); } },
    require: (name) => {
      assert.equal(name, 'electron');
      return { ipcRenderer: { sendSync: () => 'uid-1234' }, webFrame: {} };
    },
    console: { error: (...a) => errors.push(a.join(' ')), warn() {}, log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(PRELOAD, ctx);
  const readyState = (s) => { doc.readyState = s; doc.dispatchEvent(new FakeEvent('readystatechange')); };
  return { doc, injected, errors, readyState };
}

test('no root at document-start: injected once when <html> appears, never again (F46)', async () => {
  const p = runPreload();
  assert.equal(p.injected.length, 0);
  p.doc.mountRoot();
  await tick();
  assert.equal(p.injected.length, 1);
  // The old readystatechange listener re-injected at both of these.
  p.readyState('interactive');
  p.readyState('complete');
  p.doc.body.appendChild(p.doc.el('div'));
  await tick();
  assert.equal(p.injected.length, 1);
  assert.equal(p.doc.observers.length, 0, 'observer disconnected');
  assert.equal(p.doc.listenerCount('readystatechange'), 0, 'listener removed');
  assert.deepEqual(p.errors, []);
});

test('root already present: injected immediately, no observer or listener left behind', async () => {
  const p = runPreload({ rootAtStart: true });
  assert.equal(p.injected.length, 1);
  p.readyState('interactive');
  p.readyState('complete');
  await tick();
  assert.equal(p.injected.length, 1);
  assert.equal(p.doc.observers.length, 0);
  assert.equal(p.doc.listenerCount('readystatechange'), 0);
});

test('if readystatechange wins the race, the observer still stands down', async () => {
  const p = runPreload();
  // Root exists but no mutation record was delivered yet.
  p.doc.documentElement = p.doc.createElement('html');
  p.readyState('interactive');
  assert.equal(p.injected.length, 1);
  p.doc.mountRoot();
  p.readyState('complete');
  await tick();
  assert.equal(p.injected.length, 1);
  assert.equal(p.doc.observers.length, 0);
  assert.equal(p.doc.listenerCount('readystatechange'), 0);
});

test('the injected script is the stealth payload, and leaves no marker on the page', () => {
  const p = runPreload({ rootAtStart: true });
  assert.match(p.injected[0], /const PRELOAD_UNIQUE_ID = "uid-1234";/);
  assert.match(p.injected[0], /defineNativeGetter\(Navigator\.prototype, 'plugins'/);
  // A global "already installed" flag would be visible to fingerprinting.
  assert.doesNotMatch(p.injected[0], /window\.__|Symbol\.for\(/);
});
