// Wiring tests for the companion extension: the manifest, popup.html, and the
// real background.js / popup.js executed in a sandbox with a fake chrome.* and a
// minimal fake DOM. connector.js logic is covered in extension-connector.test.js.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeStorage, makeCookieJar, makeLoopback, YT_COOKIES } = require('./extension-fakes.js');

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const CODE = 'ABCD1234';

async function waitFor(pred, what, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

const manifest = JSON.parse(read('manifest.json'));

// Chrome match-pattern host test (scheme "*", path "/*"). The cookies API checks
// a cookie against the pattern using its domain with the leading dot removed.
function hostAllowed(host) {
  return manifest.host_permissions.some((p) => {
    const m = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(p);
    if (!m) return false;
    const h = m[2];
    return h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h;
  });
}

test('manifest: version 1.3.0, worker is background.js', () => {
  assert.equal(manifest.version, '1.3.0');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('manifest host permissions grant exactly the YouTube cookie scope, not all of google.com', () => {
  assert.ok(!manifest.host_permissions.includes('*://*.google.com/*'));
  for (const h of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'google.com', 'accounts.google.com', 'twitch.tv', 'www.twitch.tv', 'kick.com', '127.0.0.1']) {
    assert.ok(hostAllowed(h), `needs ${h}`);
  }
  for (const h of ['mail.google.com', 'docs.google.com', 'myaccount.google.com', 'www.google.com', 'drive.google.com']) {
    assert.ok(!hostAllowed(h), `must not grant ${h}`);
  }
});

// ── popup.html ───────────────────────────────────────────────────────────────

test('popup.html loads connector.js before popup.js and has every element popup.js uses', () => {
  const html = read('popup.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['connector.js', 'popup.js']);
  assert.ok(!/<script>(?!<)/.test(html), 'no inline script (MV3 CSP)');
  for (const id of [...read('popup.js').matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1])) {
    assert.ok(html.includes(`id="${id}"`), `popup.html is missing #${id}`);
  }
  const maxlength = Number(/id="code"[^>]*maxlength="(\d+)"/.exec(html)[1]);
  assert.ok(maxlength >= 32, 'room for a longer pairing code');
});

test('background.js and popup.js keep no private copy of the protocol', () => {
  for (const f of ['background.js', 'popup.js']) {
    const src = read(f);
    assert.ok(!/async function (findApp|collectCookies)\b/.test(src), `${f} must use connector.js`);
    assert.ok(!/\/import|\/ping|google\.com/.test(src), `${f} must not talk to the app or pick cookie domains itself`);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), `${f} builds DOM with textContent only`);
  }
});

// ── background.js in a service-worker-like sandbox ───────────────────────────

function loadBackground({ storage, net, cookies }) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const alarms = [];
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, TextEncoder, URL,
    crypto: globalThis.crypto,
    fetch: net.fetch,
    chrome: {
      runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
      alarms: { onAlarm: on('alarm'), create: (name, info) => alarms.push({ name, info }) },
      storage: { local: storage },
      cookies,
    },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(read(f), ctx, { filename: f }); };
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
  return { ctx, listeners, alarms };
}

function sendMessage(listeners, msg) {
  return new Promise((resolve) => {
    const keepOpen = listeners.message(msg, { id: 'self' }, resolve);
    assert.equal(keepOpen, true, 'async listener must return true');
  });
}

test('background: registers its listeners at top level and schedules the 30-minute alarm', () => {
  const bg = loadBackground({ storage: makeStorage({}), net: makeLoopback({}), cookies: makeCookieJar([]) });
  for (const l of ['installed', 'startup', 'alarm', 'message']) assert.equal(typeof bg.listeners[l], 'function', l);
  assert.equal(typeof bg.ctx.SLConnector.runResync, 'function');
  bg.listeners.installed();
  // JSON round-trip: objects built inside the sandbox carry its own prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(bg.alarms)), [{ name: 'stream-lurker-resync', info: { periodInMinutes: 30, delayInMinutes: 1 } }]);
  assert.equal(bg.listeners.message({ type: 'connected', platform: 'twitch' }, {}, () => {}), undefined, 'unknown messages are ignored');
});

test('background: "Sync now" runs a real pass and answers the popup; overlapping triggers share one pass', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch', 'youtube'] });
  const net = makeLoopback({ 47100: { kind: 'outdated' }, 47101: { kind: 'app', code: CODE, signedOut: ['youtube'] } });
  const bg = loadBackground({ storage, net, cookies: makeCookieJar(YT_COOKIES) });

  bg.listeners.alarm({ name: 'stream-lurker-resync' });
  const r = await sendMessage(bg.listeners, { type: 'resync-now' });
  assert.equal(r.status, 'done');
  assert.equal(r.results.twitch.kind, 'ok');
  assert.equal(r.results.youtube.kind, 'signed-out');
  assert.equal(net.requests.filter(q => q.url.includes('/ping')).length, 2, 'one port walk, not two');
  assert.equal(net.imports.length, 2);
  assert.ok(net.imports.every(i => i.port === 47101 && i.headers['X-Pairing-Code'] === CODE && i.body.auto === true));
  assert.deepEqual(storage.data.connectedPlatforms, ['twitch'], 'SIGNED_OUT dropped youtube');
  assert.equal(storage.data.lastResyncStatus, 'done');

  const again = await sendMessage(bg.listeners, { type: 'resync-now' });
  assert.deepEqual(Object.keys(again.results), ['twitch'], 'a finished pass does not block the next one');
});

// ── popup.js against a fake DOM ──────────────────────────────────────────────

class FakeEl {
  constructor(tag, props = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], listeners: {}, dataset: {}, textContent: '', className: '', disabled: false, hidden: false, value: '', title: '' }, props);
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this }); }
  click() { if (!this.disabled) this.fire('click'); }
  append(...els) { this.children.push(...els); }
  replaceChildren(...els) { this.children = els; }
  get innerHTML() { throw new Error('popup.js must not use innerHTML'); }
  set innerHTML(_v) { throw new Error('popup.js must not use innerHTML'); }
}

function loadPopup({ storage, net, cookies }) {
  const byId = {};
  for (const id of ['code', 'dot', 'conn', 'result', 'sync-summary', 'sync-rows', 'sync-now']) byId[id] = new FakeEl(id === 'code' ? 'input' : 'div', { id });
  byId['sync-now'].hidden = true;
  const platformButtons = ['twitch', 'youtube', 'kick'].map(p => new FakeEl('button', { dataset: { platform: p } }));
  const timers = new Map();
  let timerId = 0;
  const bg = { handler: null };
  const ctx = {
    console, AbortController, TextEncoder, URL, Date, Promise,
    crypto: globalThis.crypto,
    fetch: net.fetch,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    document: {
      getElementById: (id) => byId[id] || null,
      querySelectorAll: (sel) => { assert.equal(sel, 'button[data-platform]'); return platformButtons; },
      createElement: (tag) => new FakeEl(tag),
    },
    chrome: {
      storage: { local: storage, onChanged: { addListener: (fn) => storage.listeners.push(fn) } },
      cookies,
      runtime: { sendMessage: async (msg) => bg.handler(msg) },
    },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('connector.js'), ctx, { filename: 'connector.js' });
  vm.runInContext(read('popup.js'), ctx, { filename: 'popup.js' });
  // The worker's side of "Sync now", driven by the same connector code.
  bg.handler = async (msg) => {
    assert.equal(msg.type, 'resync-now');
    return ctx.SLConnector.runResync({ storage, cookies, fetch: net.fetch, crypto: globalThis.crypto });
  };
  const flushTimers = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); };
  const btn = (p) => platformButtons.find(b => b.dataset.platform === p);
  const rows = () => byId['sync-rows'].children.map(r => ({
    name: r.children[0].textContent, text: r.children[1].textContent, tone: r.children[1].className.split(' ')[1], stop: r.children[2] || null,
  }));
  return { byId, platformButtons, btn, rows, flushTimers };
}

test('popup end to end: pair, connect, auto-sync, signed-out in app, reconnect, stop, wrong code', async () => {
  const storage = makeStorage({});
  const net = makeLoopback({ 47100: { kind: 'outdated' }, 47101: { kind: 'app', code: CODE } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  const conn = p.byId.conn;

  // 1. No code yet: the app is there, nothing can be verified, buttons stay off.
  await waitFor(() => /pairing code/.test(conn.textContent), 'no-code status');
  assert.equal(p.byId.dot.className, 'dot idle');
  assert.ok(p.platformButtons.every(b => b.disabled));
  assert.match(p.byId['sync-summary'].textContent, /Connect a platform/);
  assert.equal(p.byId['sync-now'].hidden, true);

  // 2. Typing the code (any case) stores it uppercased and re-checks the app.
  p.byId.code.value = 'abcd1234';
  p.byId.code.fire('input');
  await waitFor(() => storage.data.pairingCode === CODE, 'code stored');
  p.flushTimers();
  await waitFor(() => /Connected to Stream Lurker \(port 47101\)/.test(conn.textContent), 'verified status');
  assert.equal(p.byId.dot.className, 'dot ok');
  assert.ok(p.platformButtons.every(b => !b.disabled));

  // 3. Connect YouTube: re-verified, header-authenticated, scoped cookies only.
  p.btn('youtube').click();
  await waitFor(() => /connected as someone/.test(p.byId.result.textContent), 'connect result');
  assert.equal(p.byId.result.className, 'result ok');
  const manual = net.imports.at(-1);
  assert.equal(manual.port, 47101);
  assert.equal(manual.headers['X-Pairing-Code'], CODE);
  assert.ok(!('auto' in manual.body) && !('pairingCode' in manual.body));
  assert.ok(manual.body.cookies.every(c => !/mail|docs|myaccount|www\.google/.test(c.domain)));
  assert.ok(!net.requests.some(q => q.port === 47100 && (q.method !== 'GET' || JSON.stringify(q).includes(CODE))), 'squatter port only ever saw a nonce');
  assert.deepEqual(storage.data.connectedPlatforms, ['youtube']);
  await waitFor(() => p.rows().length === 1, 'sync row');
  assert.equal(p.rows()[0].name, 'YouTube');
  assert.match(p.rows()[0].text, /^Synced just now · \d+ cookies$/);
  assert.ok(p.rows()[0].stop, 'connected row has a Stop button');
  assert.equal(p.byId['sync-now'].hidden, false);

  // 4. The user signs YouTube out inside the app; the next auto-sync is refused.
  net.ports[47101].signedOut = ['youtube'];
  p.byId['sync-now'].click();
  await waitFor(() => !p.byId['sync-now'].disabled && p.rows()[0]?.text.startsWith('Signed out'), 'signed-out row');
  assert.deepEqual(storage.data.connectedPlatforms, []);
  assert.equal(p.rows()[0].stop, null, 'nothing to stop');
  assert.equal(net.imports.at(-1).body.auto, true);

  // 5. A manual connect lifts it.
  p.btn('youtube').click();
  await waitFor(() => storage.data.connectedPlatforms.includes('youtube'), 'reconnected');
  assert.equal(net.imports.at(-1).body.auto, undefined);

  // 6. Stop: the platform leaves auto-sync and its row disappears.
  await waitFor(() => p.rows()[0]?.stop, 'stop button');
  p.rows()[0].stop.click();
  await waitFor(() => p.rows().length === 0, 'row removed');
  assert.deepEqual(storage.data.connectedPlatforms, []);
  assert.ok(!('youtube' in storage.data.lastResyncResults));

  // 7. A wrong code: the app's proof fails, buttons go off, nothing is sent.
  const before = net.imports.length;
  p.byId.code.value = 'FFFF0000';
  p.byId.code.fire('input');
  p.flushTimers();
  await waitFor(() => /doesn't match/.test(conn.textContent), 'mismatch status');
  assert.equal(p.byId.dot.className, 'dot');
  assert.ok(p.platformButtons.every(b => b.disabled));
  assert.equal(net.imports.length, before);
});

test('popup: re-proves the app on click; a process that took the port after the popup opened gets nothing', async () => {
  const storage = makeStorage({ pairingCode: CODE });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /port 47100/.test(p.byId.conn.textContent), 'verified status');
  assert.ok(!p.btn('twitch').disabled);

  net.ports[47100] = { kind: 'outdated' }; // the app quit and something else bound 47100
  p.btn('twitch').click();
  await waitFor(() => p.byId.result.className === 'result err', 'connect refused');
  assert.match(p.byId.result.textContent, /needs updating/);
  assert.equal(net.imports.length, 0);
  assert.ok(!JSON.stringify(net.requests).includes(CODE));
  assert.ok(p.platformButtons.every(b => b.disabled));
});

test('popup: an app without proof support is reported as needing an update', async () => {
  const storage = makeStorage({ pairingCode: CODE });
  const net = makeLoopback({ 47100: { kind: 'outdated' } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar([]) });
  await waitFor(() => /needs updating/.test(p.byId.conn.textContent), 'outdated status');
  assert.ok(p.platformButtons.every(b => b.disabled));
  assert.equal(net.imports.length, 0);
});

test('popup: shows the stored auto-sync outcome on open, including a code mismatch', async () => {
  const now = Date.now();
  const storage = makeStorage({
    pairingCode: CODE,
    connectedPlatforms: ['twitch'],
    lastResync: now - 4 * 60_000,
    lastResyncStatus: 'code-mismatch',
    lastResyncResults: { twitch: { kind: 'ok', cookiesSet: 5, at: now - 3 * 3600_000 } },
  });
  const p = loadPopup({ storage, net: makeLoopback({}), cookies: makeCookieJar([]) });
  await waitFor(() => p.byId['sync-summary'].textContent.startsWith('Checked'), 'summary');
  assert.match(p.byId['sync-summary'].textContent, /Checked 4 min ago: the pairing code doesn't match/);
  assert.equal(p.byId['sync-summary'].className, 'sync-summary err');
  assert.deepEqual(p.rows().map(r => [r.name, r.text, r.tone]), [['Twitch', 'Synced 3 h ago · 5 cookies', 'ok']]);
  await waitFor(() => /not found/.test(p.byId.conn.textContent), 'not-found status');
});
