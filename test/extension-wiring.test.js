// Wiring tests for the companion extension: the manifest, popup.html, and the
// real background.js / popup.js executed in a sandbox with a fake chrome.* and a
// minimal fake DOM. connector.js logic is covered in extension-connector.test.js.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeStorage, makeCookieJar, makeLoopback, YT_COOKIES, APP_LOGIN_TEXT } = require('./extension-fakes.js');

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8').replace(/\r\n/g, '\n');
// 128-bit codes, as the app makes them; 8-character ones are refused (F50).
const CODE = 'ABCD1234ABCD1234ABCD1234ABCD1234';
const OTHER_CODE = 'FFFF0000FFFF0000FFFF0000FFFF0000';

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
  const placeholder = /id="code"[^>]*placeholder="([^"]*)"/.exec(html)[1];
  assert.ok(!/^[X0-9]+$/i.test(placeholder), `placeholder "${placeholder}" implies a fixed-length code; codes are 32 to 64 characters`);
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

// fastTimers: long waits (the import timeout) fire after a few ms instead.
function loadBackground({ storage, net, cookies, fastTimers = false }) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const alarms = [];
  const ctx = {
    console, clearTimeout, AbortController, TextEncoder, URL,
    setTimeout: fastTimers ? (fn, ms) => setTimeout(fn, ms > 5000 ? 30 : ms) : setTimeout,
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
  // One walk (47100 then 47101), then each import right after a fresh proof
  // of the port it goes to. Two passes would double every line.
  assert.deepEqual(net.requests.map(q => `${q.port}${new URL(q.url).pathname}`),
    ['47100/ping', '47101/ping', '47101/ping', '47101/import', '47101/ping', '47101/import'], 'one port walk, not two');
  assert.equal(net.imports.length, 2);
  assert.ok(net.imports.every(i => i.port === 47101 && i.headers['X-Pairing-Code'] === CODE && i.body.auto === true));
  assert.deepEqual(storage.data.connectedPlatforms, ['twitch'], 'SIGNED_OUT dropped youtube');
  assert.equal(storage.data.lastResyncStatus, 'done');

  const again = await sendMessage(bg.listeners, { type: 'resync-now' });
  assert.deepEqual(Object.keys(again.results), ['twitch'], 'a finished pass does not block the next one');
});

test('background: an import the app never answers cannot wedge the shared pass', { timeout: 5000 }, async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch'], lastResyncStatus: 'done', lastResync: 1 });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE, stallImport: ['twitch'] } });
  const bg = loadBackground({ storage, net, cookies: makeCookieJar(YT_COOKIES), fastTimers: true });
  const r = await sendMessage(bg.listeners, { type: 'resync-now' });
  assert.equal(r.status, 'done');
  // The app finishes an import it started, so a wait the worker had to end
  // is recorded as unanswered, not as a failure.
  assert.equal(r.results.twitch.kind, 'unanswered');
  assert.equal(storage.data.lastResyncResults.twitch.kind, 'unanswered');
  assert.ok(storage.data.lastResync > 1, 'the pass recorded itself instead of leaving the last one on screen');

  // The next trigger is a new pass, not the stuck one: this time the app answers.
  net.ports[47100].stallImport = [];
  const again = await sendMessage(bg.listeners, { type: 'resync-now' });
  assert.equal(again.results.twitch.kind, 'ok');
  assert.equal(net.imports.length, 2);
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
  p.byId.code.value = CODE.toLowerCase();
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
  await waitFor(() => !p.byId['sync-now'].disabled && p.rows()[0]?.text.startsWith('You signed this platform out'), 'signed-out row');
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
  p.byId.code.value = OTHER_CODE;
  p.byId.code.fire('input');
  p.flushTimers();
  await waitFor(() => /accepted this pairing code/.test(conn.textContent), 'mismatch status');
  assert.equal(p.byId.dot.className, 'dot');
  assert.ok(p.platformButtons.every(b => b.disabled));
  assert.equal(net.imports.length, before);
});

test('popup: a YouTube connected inside the app reads as such, not as signed out (F53)', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['youtube'] });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE, signedOut: ['youtube'], signedOutError: APP_LOGIN_TEXT } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /port 47100/.test(p.byId.conn.textContent), 'verified status');
  p.byId['sync-now'].click();
  await waitFor(() => !p.byId['sync-now'].disabled && p.rows()[0]?.text === APP_LOGIN_TEXT, 'app-login row');
  assert.doesNotMatch(p.rows()[0].text, /signed (this platform )?out/i);
  assert.deepEqual(storage.data.connectedPlatforms, []);
});

test('popup: a short (8-character) code is refused before anything is pinged, and the popup says how to fix it', async () => {
  const storage = makeStorage({ pairingCode: 'ABCD1234' });
  // Even a listener that proves the short code perfectly.
  const net = makeLoopback({ 47100: { kind: 'app', code: 'ABCD1234' } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /too short/.test(p.byId.conn.textContent), 'short-code status');
  assert.match(p.byId.conn.textContent, /New code/);
  assert.ok(p.platformButtons.every(b => b.disabled));
  assert.equal(net.requests.length, 0);
});

test('popup: an import the app never answers ends with a clear message and the buttons come back', { timeout: 5000 }, async () => {
  const storage = makeStorage({ pairingCode: CODE });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE, stallImport: ['twitch'] } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /port 47100/.test(p.byId.conn.textContent), 'verified status');
  p.btn('twitch').click();
  await waitFor(() => net.imports.length === 1, 'import sent');
  assert.ok(p.platformButtons.every(b => b.disabled), 'busy while waiting');
  p.flushTimers(); // the import timeout fires
  await waitFor(() => p.byId.result.className === 'result err', 'timeout result');
  assert.equal(p.byId.result.textContent, 'Stream Lurker did not answer the import in time');
  assert.ok(p.platformButtons.every(b => !b.disabled));
  assert.deepEqual(storage.data.connectedPlatforms || [], [], 'an unanswered connect is not recorded as connected');
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

test('popup: an app from before proofs (its /ping carries a version) is reported as needing an update', async () => {
  const storage = makeStorage({ pairingCode: CODE });
  const net = makeLoopback({ 47100: { kind: 'outdated' } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar([]) });
  await waitFor(() => /needs updating/.test(p.byId.conn.textContent), 'outdated status');
  assert.ok(p.platformButtons.every(b => b.disabled));
  assert.equal(net.imports.length, 0);
});

test('popup: a current app still on its 8-character code asks for the code, then says New code, never "needs updating"', async () => {
  // Connector 1.3 installed fresh by someone whose app predates 32-character
  // codes: the app answers /ping with neither proof nor version.
  const storage = makeStorage({});
  const net = makeLoopback({ 47100: { kind: 'unsigned-app' } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  const conn = p.byId.conn;
  await waitFor(() => /Enter the pairing code/.test(conn.textContent), 'no-code status');
  assert.doesNotMatch(conn.textContent, /needs updating/);
  assert.equal(p.byId.dot.className, 'dot idle');
  assert.ok(p.platformButtons.every(b => b.disabled));

  // A 32-character code the app does not hold (a config restored from before
  // a New code click): the fix is New code, not an app update.
  p.byId.code.value = CODE;
  p.byId.code.fire('input');
  p.flushTimers();
  await waitFor(() => /New code/.test(conn.textContent), 'app-code-too-short status');
  assert.doesNotMatch(conn.textContent, /needs updating/);
  assert.equal(p.byId.dot.className, 'dot');
  p.btn('twitch').click();
  assert.equal(net.imports.length, 0);
  assert.ok(!JSON.stringify(net.requests).includes(CODE), 'the code went nowhere');

  // New code in the app, pasted here: paired.
  const NEW = OTHER_CODE;
  net.ports[47100] = { kind: 'app', code: NEW };
  p.byId.code.value = NEW;
  p.byId.code.fire('input');
  p.flushTimers();
  await waitFor(() => /Connected to Stream Lurker \(port 47100\)/.test(conn.textContent), 'verified status');
  assert.ok(p.platformButtons.every(b => !b.disabled));
});

test('popup: Stop during a running pass keeps that platform\'s cookies in the browser', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch', 'youtube'] });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /port 47100/.test(p.byId.conn.textContent), 'verified status');
  await waitFor(() => p.rows().length === 2, 'two sync rows');
  // While Twitch's import is in flight, the user clicks Stop on YouTube.
  net.ports[47100].beforeImportReply = async (body) => {
    if (body.platform !== 'twitch') return;
    p.rows().find(r => r.name === 'YouTube').stop.click();
    await waitFor(() => !storage.data.connectedPlatforms.includes('youtube'), 'youtube stopped');
  };
  p.byId['sync-now'].click();
  await waitFor(() => storage.data.lastResyncStatus === 'done' && !p.byId['sync-now'].dataset.running, 'pass finished');
  assert.deepEqual(net.imports.map(i => i.body.platform), ['twitch']);
  assert.ok(!JSON.stringify(net.requests).includes('__Secure-1PSID'), 'no YouTube cookie was sent');
  await waitFor(() => p.rows().length === 1, 'youtube row gone');
  assert.equal(p.rows()[0].name, 'Twitch');
});

test('popup: fixing the code clears a stored "code doesn\'t match" at once, not at the next alarm', async () => {
  const now = Date.now();
  const storage = makeStorage({
    pairingCode: OTHER_CODE,
    connectedPlatforms: ['twitch'],
    lastResync: now - 4 * 60_000,
    lastResyncStatus: 'code-mismatch',
    lastResyncResults: { twitch: { kind: 'ok', cookiesSet: 5, at: now - 3 * 3600_000 } },
  });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE } });
  const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /accepted this pairing code/.test(p.byId.conn.textContent), 'mismatch status');
  await waitFor(() => /accepted this pairing code/.test(p.byId['sync-summary'].textContent), 'stored mismatch summary');
  assert.equal(net.imports.length, 0, 'a mismatch on open triggers nothing');

  p.byId.code.value = CODE;
  p.byId.code.fire('input');
  p.flushTimers();
  await waitFor(() => /Connected to Stream Lurker/.test(p.byId.conn.textContent), 'verified status');
  await waitFor(() => storage.data.lastResyncStatus === 'done' && !p.byId['sync-now'].dataset.running, 'fresh pass');
  await waitFor(() => /^Last auto-sync just now\.$/.test(p.byId['sync-summary'].textContent), 'fresh summary');
  assert.doesNotMatch(p.byId['sync-summary'].textContent, /accepted this pairing code/);
  assert.equal(p.byId['sync-summary'].className, 'sync-summary idle');
  assert.equal(net.imports.length, 1);
  assert.equal(net.imports[0].body.auto, true);
  assert.equal(net.imports[0].headers['X-Pairing-Code'], CODE, 'the pass used the code just typed');
  await waitFor(() => /^Synced just now/.test(p.rows()[0]?.text || ''), 'fresh row');

  // Checking again (the popup reopened) with nothing left to fix runs nothing.
  p.byId.code.fire('input');
  p.flushTimers();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(net.imports.length, 1);
});

test('popup: an app updated since the last pass ("needs updating") is re-synced on open', async () => {
  for (const status of ['app-outdated', 'not-paired', 'code-too-short', 'app-code-too-short']) {
    const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch'], lastResync: Date.now() - 60_000, lastResyncStatus: status });
    const net = makeLoopback({ 47100: { kind: 'app', code: CODE } });
    const p = loadPopup({ storage, net, cookies: makeCookieJar(YT_COOKIES) });
    await waitFor(() => storage.data.lastResyncStatus === 'done', `${status} replaced by a fresh pass`);
    await waitFor(() => /^Last auto-sync just now\.$/.test(p.byId['sync-summary'].textContent), `${status}: fresh summary`);
    assert.equal(net.imports.length, 1, status);
  }
  // A stored "app wasn't running" is calm history, not an error: left alone.
  const calm = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch'], lastResync: Date.now() - 60_000, lastResyncStatus: 'app-not-running' });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE } });
  const p = loadPopup({ storage: calm, net, cookies: makeCookieJar(YT_COOKIES) });
  await waitFor(() => /port 47100/.test(p.byId.conn.textContent), 'verified status');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(net.imports.length, 0);
});

test('popup: an upgrade from 1.2.0 with the app closed keeps the old results dated, not "just now" (F96)', async () => {
  const threeDaysAgo = Date.now() - 3 * 24 * 3600_000;
  const storage = makeStorage({
    pairingCode: CODE,
    connectedPlatforms: ['youtube', 'twitch'],
    lastResync: threeDaysAgo,
    lastResyncResults: { youtube: 'ok (34 cookies)', twitch: 'no cookies in browser' },
  });
  const p = loadPopup({ storage, net: makeLoopback({}), cookies: makeCookieJar(YT_COOKIES) });
  const before = [['Twitch', 'Skipped (3 days ago): not signed in to Twitch in this browser.', 'idle'], ['YouTube', 'Last sync ok (34 cookies) (3 days ago)', 'ok']];
  await waitFor(() => p.rows().length === 2, 'rows from 1.2 state');
  assert.deepEqual(p.rows().map(r => [r.name, r.text, r.tone]), before);

  p.byId['sync-now'].click();
  await waitFor(() => storage.data.lastResyncStatus === 'app-not-running' && !p.byId['sync-now'].dataset.running, 'skip pass');
  await waitFor(() => /wasn't running/.test(p.byId['sync-summary'].textContent), 'calm summary');
  assert.deepEqual(p.rows().map(r => [r.name, r.text, r.tone]), before, 'the pass moved lastResync; the rows kept their own time');
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
  assert.match(p.byId['sync-summary'].textContent, /Checked 4 min ago: no Stream Lurker accepted this pairing code/);
  assert.equal(p.byId['sync-summary'].className, 'sync-summary err');
  assert.deepEqual(p.rows().map(r => [r.name, r.text, r.tone]), [['Twitch', 'Synced 3 h ago · 5 cookies', 'ok']]);
  await waitFor(() => /not found/.test(p.byId.conn.textContent), 'not-found status');
});
