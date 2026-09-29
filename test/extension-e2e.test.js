// End to end over real sockets: the shipped extension/connector.js against the
// shipped main/cookie-receiver.js, with a hostile local listener between them.
// extension-fakes.js models the app for the unit tests; this checks the two
// real sides agree on contract C1, and that a squatter relaying /ping to the
// real app gets nothing (F50). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const SL = require('../extension/connector.js');
const rx = require('../main/cookie-receiver.js');

const CODE = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const PLATFORMS = ['twitch', 'youtube', 'kick'];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

// The real receiver, wired like main.js: signedOut maps a platform to its
// refusal reason ('signed-out' or 'app-login'); a manual import clears it.
// setCode is the app's New code button.
async function startApp({ signedOut = {}, code = CODE } = {}) {
  const imported = [];
  let port = 0;
  let pairingCode = code;
  const handler = rx.createReceiverHandler({
    getPort: () => port,
    getPairingCode: () => pairingCode,
    guard: rx.createPairingGuard(),
    importers: Object.fromEntries(PLATFORMS.map((p) => [p, async (cookies, { auto }) => {
      imported.push({ platform: p, auto, cookies });
      return { success: true, username: 'alice', cookiesSet: cookies.length };
    }])),
    isSignedOut: (p) => rx.autoSyncRefusalFor(signedOut[p] || null),
    onManualImport: (p) => { delete signedOut[p]; },
  });
  const server = rx.createReceiverServer(handler);
  port = await listen(server);
  return { server, port, imported, signedOut, setCode: (c) => { pairingCode = c; } };
}

// A squatter that bound a port while the app was closed. It passes the
// extension's /ping on to the real app as a plain local client (the app's
// own Host, no Origin, both of which the receiver accepts) and returns the
// app's genuine answer unchanged. Anything else it keeps.
async function startRelay(appPort) {
  const seen = [];
  const relayed = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body: '' };
    seen.push(entry);
    if (new URL(req.url, 'http://relay').pathname === '/ping') {
      http.get({ host: '127.0.0.1', port: appPort, path: req.url, headers: { Host: `127.0.0.1:${appPort}` } }, (up) => {
        let b = '';
        up.on('data', (d) => { b += d; });
        up.on('end', () => {
          relayed.push(JSON.parse(b));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(b);
        });
      }).on('error', () => { res.writeHead(502); res.end(); });
      return;
    }
    req.on('data', (d) => { entry.body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true,"cookiesSet":2}');
    });
  });
  const port = await listen(server);
  return { server, port, seen, relayed };
}

function memoryStorage(initial) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    data,
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults)) out[k] = k in data ? JSON.parse(JSON.stringify(data[k])) : v;
      return out;
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
  };
}

const cookieJar = {
  async getAll({ domain }) {
    if (domain === 'twitch.tv') return [{ name: 'auth-token', value: 'SECRET-TWITCH', domain: '.twitch.tv', path: '/', hostOnly: false }];
    if (domain === 'youtube.com') return [{ name: 'SID', value: 'SECRET-YT', domain: '.youtube.com', path: '/', hostOnly: false }];
    return [];
  },
};

const deps = { fetch: globalThis.fetch, crypto: globalThis.crypto };

test('a relay on the first port gets a genuine proof from the app, yet is never verified and never sees the code or a cookie', async (t) => {
  const app = await startApp();
  const relay = await startRelay(app.port);
  t.after(async () => { await close(relay.server); await close(app.server); });

  const found = await SL.findApp({ ...deps, code: CODE.toLowerCase(), ports: [relay.port, app.port], timeoutMs: 2000 });
  assert.deepEqual(found, { status: 'verified', port: app.port });
  assert.equal(relay.relayed.length, 1);
  assert.match(relay.relayed[0].proof || '', /^[0-9a-f]{64}$/, 'the relay really handed back the app\'s own proof');

  // Only the relay is tried: a well-formed, genuine proof for the wrong port.
  assert.deepEqual(await SL.findApp({ ...deps, code: CODE, ports: [relay.port], timeoutMs: 2000 }), { status: 'mismatch', port: null });

  // A full background pass across both ports.
  const storage = memoryStorage({ pairingCode: CODE, connectedPlatforms: ['twitch', 'youtube'] });
  const r = await SL.runResync({ ...deps, storage, cookies: cookieJar, findOptions: { ports: [relay.port, app.port], timeoutMs: 2000 } });
  assert.equal(r.status, 'done');
  assert.deepEqual(app.imported.map((i) => [i.platform, i.auto]), [['twitch', true], ['youtube', true]]);
  assert.deepEqual(storage.data.lastResyncResults.twitch.kind, 'ok');

  const everything = JSON.stringify(relay.seen);
  assert.ok(relay.seen.length >= 3 && relay.seen.every((q) => q.method === 'GET' && /^\/ping\?nonce=[0-9a-f]{32}$/.test(q.url)), `relay saw only pings: ${everything}`);
  assert.ok(relay.seen.every((q) => !('x-pairing-code' in q.headers)));
  for (const secret of [CODE, CODE.toLowerCase(), 'SECRET-TWITCH', 'SECRET-YT']) assert.ok(!everything.includes(secret), `relay saw ${secret}`);
});

test('a relay alone ends the pass as a code mismatch with nothing sent', async (t) => {
  const app = await startApp();
  const relay = await startRelay(app.port);
  t.after(async () => { await close(relay.server); await close(app.server); });
  const storage = memoryStorage({ pairingCode: CODE, connectedPlatforms: ['twitch'] });
  const r = await SL.runResync({ ...deps, storage, cookies: cookieJar, findOptions: { ports: [relay.port], timeoutMs: 2000 } });
  assert.equal(r.status, 'code-mismatch');
  assert.equal(app.imported.length, 0);
  assert.ok(relay.seen.every((q) => q.method === 'GET' && !JSON.stringify(q).includes(CODE)));
});

test('the real sides agree: proof, manual import with the name, auto import without it', async (t) => {
  const app = await startApp();
  t.after(() => close(app.server));
  assert.deepEqual(await SL.findApp({ ...deps, code: ` ${CODE.toLowerCase()} `, ports: [app.port], timeoutMs: 2000 }), { status: 'verified', port: app.port });
  assert.equal((await SL.findApp({ ...deps, code: 'F'.repeat(32), ports: [app.port], timeoutMs: 2000 })).status, 'mismatch');
  const cookies = [{ name: 'auth-token', value: 'x', domain: '.twitch.tv', path: '/' }];
  const manual = await SL.postImport({ ...deps, port: app.port, code: CODE, platform: 'twitch', cookies });
  assert.deepEqual([manual.success, manual.username], [true, 'alice']);
  const auto = await SL.postImport({ ...deps, port: app.port, code: CODE, platform: 'twitch', cookies, auto: true });
  assert.deepEqual([auto.success, auto.username], [true, '']);
});

test('an app still on its 8-character code: a fresh extension asks for the code, then says New code, never "needs updating" (C1 code-length rule)', async (t) => {
  // Every install from before 32-character codes, meeting connector 1.3.
  const SHORT = 'ABCD1234';
  const NEW = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';
  const app = await startApp({ code: SHORT });
  t.after(() => close(app.server));
  const find = (code) => SL.findApp({ ...deps, code, ports: [app.port], timeoutMs: 2000 });
  const neverUpdate = (text, what) => assert.doesNotMatch(text, /needs updating|update (it|the app)/i, `${what}: ${text}`);

  // What the real receiver answers: no proof for a code that short, and no
  // version (apps from before proofs always sent one).
  const raw = await (await fetch(`http://127.0.0.1:${app.port}/ping?nonce=${'ab'.repeat(16)}`)).json();
  assert.deepEqual(raw, { app: 'stream-lurker' });

  // 1. Connector 1.3 installed fresh, nothing in its storage yet.
  const fresh = await find('');
  assert.notEqual(fresh.status, 'outdated');
  assert.deepEqual(fresh, { status: 'no-code', port: null });
  assert.match(SL.describeConnection(fresh).text, /Enter the pairing code/);
  neverUpdate(SL.describeConnection(fresh).text, 'no code yet');

  // 2. The user pastes what Platform Logins shows: 8 characters.
  const pasted = await find(SHORT);
  assert.equal(pasted.status, 'short-code');
  assert.match(SL.describeConnection(pasted).text, /New code/);
  neverUpdate(SL.describeConnection(pasted).text, '8-character code');

  // 3. A 32-character code the app no longer holds: config.json restored from
  // a .bak older than a New code click. Nothing is sent, the fix is named.
  const restored = await find(CODE);
  assert.deepEqual(restored, { status: 'app-code-too-short', port: null });
  assert.match(SL.describeConnection(restored).text, /Click New code in Platform Logins/);
  neverUpdate(SL.describeConnection(restored).text, 'restored config');
  const storage = memoryStorage({ pairingCode: CODE, connectedPlatforms: ['twitch'] });
  const passDeps = { ...deps, storage, cookies: cookieJar, findOptions: { ports: [app.port], timeoutMs: 2000 } };
  assert.equal((await SL.runResync(passDeps)).status, 'app-code-too-short');
  assert.equal(app.imported.length, 0);
  const summary = SL.describeSync(storage.data, Date.now()).summary;
  assert.equal(summary.tone, 'err');
  assert.match(summary.text, /Click New code in Platform Logins/);
  neverUpdate(summary.text, 'auto-sync summary');

  // 4. New code in the app, pasted into the extension: paired, and it syncs.
  // The receiver still sends no version: connector 1.3 reads a /ping version
  // as an app from before proofs.
  app.setCode(NEW);
  const signed = await (await fetch(`http://127.0.0.1:${app.port}/ping?nonce=${'cd'.repeat(16)}`)).json();
  assert.deepEqual(Object.keys(signed).sort(), ['app', 'proof']);
  storage.data.pairingCode = NEW;
  assert.deepEqual(await find(NEW), { status: 'verified', port: app.port });
  assert.equal((await SL.runResync(passDeps)).status, 'done');
  assert.deepEqual(app.imported.map((i) => [i.platform, i.auto]), [['twitch', true]]);
});

test('SIGNED_OUT end to end: the popup shows the app\'s reason, app-login included, and a manual connect lifts it (F53)', async (t) => {
  const app = await startApp({ signedOut: { youtube: 'app-login', twitch: 'signed-out' } });
  t.after(() => close(app.server));
  const storage = memoryStorage({ pairingCode: CODE, connectedPlatforms: ['youtube', 'twitch'] });
  const r = await SL.runResync({ ...deps, storage, cookies: cookieJar, findOptions: { ports: [app.port], timeoutMs: 2000 } });
  assert.equal(r.status, 'done');
  assert.deepEqual(storage.data.connectedPlatforms, []);
  assert.equal(app.imported.length, 0, 'refused before any importer ran');

  const rows = SL.describeSync(storage.data, Date.now()).rows;
  const yt = rows.find((x) => x.platform === 'youtube');
  const tw = rows.find((x) => x.platform === 'twitch');
  assert.equal(yt.text, rx.APP_LOGIN_ERROR);
  assert.doesNotMatch(yt.text, /signed (this platform )?out/i, 'connected inside the app is not "signed out"');
  assert.equal(tw.text, rx.SIGNED_OUT_ERROR);

  // What the popup's Connect button does: a manual import, then recorded.
  const manual = await SL.postImport({ ...deps, port: app.port, code: CODE, platform: 'youtube', cookies: [{ name: 'SID', value: 'v', domain: '.youtube.com', path: '/' }] });
  assert.equal(manual.success, true);
  assert.equal(app.signedOut.youtube, undefined);
});
