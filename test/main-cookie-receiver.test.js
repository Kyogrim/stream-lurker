// Gate tests for main/cookie-receiver.js (contract C1; F16, F17, F52, F54,
// F55, G2.4): the real handler on a real 127.0.0.1 socket, driven by raw HTTP
// requests and by the extension's own client (extension/connector.js), so a
// drift on either side of the contract fails here. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  pingProof, isAllowedHost, isAllowedOrigin, isJsonContentType, codesMatch, maskCode,
  createPairingGuard, createReceiverHandler, createReceiverServer, listenOnFirstPort,
  MAX_IMPORT_BODY_BYTES, PING_PROOF_PREFIX, SIGNED_OUT_ERROR, APP_LOGIN_ERROR, autoSyncRefusalFor,
} = require('../main/cookie-receiver');
const connector = require('../extension/connector.js');

const CODE = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

// A receiver on an ephemeral port, with recording importers.
async function startReceiver(overrides = {}) {
  const calls = [];
  const logs = [];
  const manual = [];
  let port = 0;
  const signedOut = new Set(overrides.signedOut || []);
  const autoAttempts = [];
  let codeRejections = 0;
  const importer = (platform) => async (cookies, opts) => {
    calls.push({ platform, cookies, opts });
    if (overrides.importerThrows) throw new Error('boom');
    if (overrides.importerResult) return overrides.importerResult(platform, opts);
    return { success: true, username: `${platform}-user`, cookiesSet: cookies.length };
  };
  const handler = createReceiverHandler({
    getPort: () => port,
    getPairingCode: () => overrides.code || CODE,
    guard: overrides.guard || createPairingGuard(),
    importers: { twitch: importer('twitch'), youtube: importer('youtube'), kick: importer('kick') },
    isSignedOut: overrides.isSignedOut || ((p) => signedOut.has(p)),
    onManualImport: (p) => { manual.push(p); signedOut.delete(p); },
    onAutoAttempt: (a) => autoAttempts.push(a),
    onCodeRejected: () => { codeRejections++; },
    log: (t) => logs.push(t),
    maxBodyBytes: overrides.maxBodyBytes,
  });
  const server = createReceiverServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    server, port, calls, logs, manual, signedOut, autoAttempts,
    codeRejections: () => codeRejections,
    close: () => new Promise(r => server.close(r)),
  };
}

// A raw request, so Host, Origin and the body can be anything.
function request(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    // A declared length, as browsers send it (the chunked case is tested apart).
    const length = body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {};
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: { Host: host || `127.0.0.1:${port}`, ...length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra });
const importBody = (extra = {}) => JSON.stringify({ platform: 'twitch', cookies: [{ name: 'auth-token', value: 'x' }], ...extra });

test('C1 /ping: exactly { app } without a nonce, no version, no CORS header', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const res = await request(r.port, { path: '/ping' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { app: 'stream-lurker' });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('C1 /ping: a 16-64 hex nonce gets the HMAC proof; anything else gets none', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await request(r.port, { path: `/ping?nonce=${nonce}` });
  const expected = crypto.createHmac('sha256', CODE).update(`stream-lurker-ping:${nonce}`).digest('hex');
  assert.deepEqual(res.json, { app: 'stream-lurker', proof: expected });
  assert.match(res.json.proof, /^[0-9a-f]{64}$/, 'lowercase hex');
  assert.equal(PING_PROOF_PREFIX, 'stream-lurker-ping:');
  for (const bad of ['abc', 'z'.repeat(32), 'a'.repeat(15), 'a'.repeat(65), '']) {
    const other = await request(r.port, { path: `/ping?nonce=${bad}` });
    assert.deepEqual(other.json, { app: 'stream-lurker' }, bad);
  }
  assert.equal(pingProof(CODE.toLowerCase(), nonce), expected, 'the key is the upper-case code');
});

test('C1 interop: the extension client verifies the proof and imports with the header code', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const deps = { fetch: globalThis.fetch, crypto: globalThis.crypto, ports: [r.port], timeoutMs: 2000 };
  assert.deepEqual(await connector.findApp({ ...deps, code: CODE.toLowerCase() }), { status: 'verified', port: r.port });
  assert.equal((await connector.findApp({ ...deps, code: 'DEADBEEF' })).status, 'mismatch');
  assert.equal((await connector.findApp({ ...deps, code: '' })).status, 'no-code');

  const manual = await connector.postImport({ fetch: globalThis.fetch, port: r.port, code: CODE, platform: 'kick', cookies: [{ name: 'session_token', value: 'v' }] });
  assert.equal(manual.httpStatus, 200);
  assert.equal(manual.success, true);
  assert.equal(manual.username, 'kick-user', 'a manual import may name the account');
  const auto = await connector.postImport({ fetch: globalThis.fetch, port: r.port, code: CODE, platform: 'kick', cookies: [], auto: true });
  assert.equal(auto.success, true);
  assert.equal(auto.username, '', 'an automatic re-sync never learns the account name');
  assert.deepEqual(r.calls.map(c => c.opts), [{ auto: false }, { auto: true }]);
});

test('F16: a Host other than 127.0.0.1:<port> or localhost:<port> is refused (DNS rebinding)', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  for (const host of ['attacker.example', `attacker.example:${r.port}`, '127.0.0.1', `127.0.0.1:${r.port + 1}`, `0.0.0.0:${r.port}`]) {
    const ping = await request(r.port, { path: '/ping', host });
    assert.equal(ping.status, 403, host);
    const imp = await request(r.port, { method: 'POST', path: '/import', host, headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody() });
    assert.equal(imp.status, 403, host);
  }
  assert.equal((await request(r.port, { path: '/ping', host: `LOCALHOST:${r.port}` })).status, 200);
  assert.equal(r.calls.length, 0);
  assert.equal(isAllowedHost(undefined, 1), false);
  assert.equal(isAllowedHost('127.0.0.1:0', 0), false, 'not bound yet');
});

test('F16: a web Origin is refused; an extension origin or none is accepted', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  for (const origin of ['https://evil.example', 'http://127.0.0.1:8080', 'null', 'file://', 'chrome-extension-evil://x']) {
    const imp = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ Origin: origin, 'X-Pairing-Code': CODE }), body: importBody() });
    assert.equal(imp.status, 403, origin);
    assert.equal(imp.headers['access-control-allow-origin'], undefined);
    assert.equal((await request(r.port, { path: '/ping', headers: { Origin: origin } })).status, 403, origin);
  }
  assert.equal(r.calls.length, 0, 'nothing reached an importer');
  for (const origin of ['chrome-extension://abcdefghijklmnop', 'moz-extension://1234-5678']) {
    const imp = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ Origin: origin, 'X-Pairing-Code': CODE }), body: importBody() });
    assert.equal(imp.status, 200, origin);
  }
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), false);
});

test('F16: OPTIONS, text/plain and other routes are refused without CORS headers', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const pre = await request(r.port, { method: 'OPTIONS', path: '/import', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 405);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  assert.equal(pre.headers['access-control-allow-methods'], undefined);
  // The simple request a page can send with no preflight.
  const plain = await request(r.port, { method: 'POST', path: '/import', headers: { 'Content-Type': 'text/plain', 'X-Pairing-Code': CODE }, body: importBody() });
  assert.equal(plain.status, 415);
  const noType = await request(r.port, { method: 'POST', path: '/import', headers: { 'X-Pairing-Code': CODE }, body: importBody() });
  assert.equal(noType.status, 415);
  assert.equal((await request(r.port, { method: 'POST', path: '/ping' })).status, 405);
  assert.equal((await request(r.port, { path: '/import' })).status, 405);
  assert.equal((await request(r.port, { path: '/other' })).status, 404);
  assert.equal(r.calls.length, 0);
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType('Application/JSON'), true);
  assert.equal(isJsonContentType('application/jsonx'), false);
});

test('F54: a wrong header code is refused before the body is read', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  // Headers and a sliver of a 1 MB body; the rest never comes. A handler that
  // waited for the body would never answer.
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: r.port, method: 'POST', path: '/import', agent: false,
      headers: { Host: `127.0.0.1:${r.port}`, 'Content-Type': 'application/json', 'X-Pairing-Code': 'WRONG123', 'Content-Length': String(1e6) },
    }, (response) => { resolve(response.statusCode); response.resume(); req.destroy(); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.write('{"platform":"twitch","cookies":[');
    setTimeout(() => reject(new Error('no answer without the body')), 3000).unref();
  });
  assert.equal(res, 403);
  assert.equal(r.calls.length, 0);
});

test('F54: bodies over 2 MB get 413, by Content-Length or by bytes received', async (t) => {
  const r = await startReceiver({ maxBodyBytes: 1000 });
  t.after(r.close);
  const big = JSON.stringify({ platform: 'twitch', cookies: [{ name: 'x', value: 'y'.repeat(2000) }] });
  const declared = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: big });
  assert.equal(declared.status, 413);
  // Chunked: no Content-Length, so it is the byte count that trips.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: r.port, method: 'POST', path: '/import', agent: false,
      headers: { Host: `127.0.0.1:${r.port}`, 'Content-Type': 'application/json', 'X-Pairing-Code': CODE, 'Transfer-Encoding': 'chunked' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e); });
    for (let i = 0; i < 10; i++) req.write('x'.repeat(200));
    req.end();
  });
  assert.equal(chunked, 413);
  assert.equal(r.calls.length, 0);
  assert.equal(MAX_IMPORT_BODY_BYTES, 2 * 1024 * 1024, 'C1: 2 MB');
});

test('C1: an old extension (code in the body only) still imports; a wrong body code is refused', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const ok = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: CODE.toLowerCase() }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.success, true);
  const bad = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: 'NOPE' }) });
  assert.equal(bad.status, 403);
  const none = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody() });
  assert.equal(none.status, 403);
  assert.equal(r.calls.length, 1);
  // A correct header wins over a wrong body field.
  const both = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ pairingCode: 'WRONG' }) });
  assert.equal(both.status, 200);
});

test('F17: five wrong codes in a row lock /import for the lockout period, even for the right code', async (t) => {
  let now = 1000000;
  const guard = createPairingGuard({ now: () => now });
  const r = await startReceiver({ guard });
  t.after(r.close);
  const attempt = (code) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': code }), body: importBody() });
  for (let i = 0; i < 4; i++) assert.equal((await attempt(`BAD${i}`)).status, 403);
  // A success resets the streak.
  assert.equal((await attempt(CODE)).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await attempt(`BAD${i}`)).status, 403);
  const locked = await attempt(CODE);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['retry-after'], '60');
  now += 59 * 1000;
  assert.equal((await attempt(CODE)).status, 429);
  now += 2 * 1000;
  assert.equal((await attempt(CODE)).status, 200, 'unlocked after 60 s');
  // Two streaks: one masked line at each streak's first failure, one at the lockout.
  const wrong = r.logs.filter(l => /Refused an import with the wrong pairing code/.test(l));
  assert.equal(wrong.length, 2);
  assert.equal(r.logs.filter(l => /refusing imports for 60 s/.test(l)).length, 1);
  for (const line of r.logs) assert.ok(!line.includes(CODE) && !line.includes('BAD0'), line);
});

test('F17: codes compare in constant time, whatever their lengths', () => {
  assert.equal(codesMatch(CODE, CODE), true);
  assert.equal(codesMatch(` ${CODE.toLowerCase()} `, CODE), true);
  assert.equal(codesMatch('A1B2', CODE), false);
  assert.equal(codesMatch('x'.repeat(10000), CODE), false);
  assert.equal(codesMatch('', CODE), false);
  assert.equal(codesMatch(CODE, ''), false, 'no code configured matches nothing');
  assert.equal(codesMatch(undefined, CODE), false);
  assert.equal(maskCode('ABCDEF12'), 'AB… (8 characters)');
  assert.equal(maskCode(''), 'no code');
});

test('C1 SIGNED_OUT: an automatic re-sync of a signed-out platform gets 409; a manual import reconnects it', async (t) => {
  const r = await startReceiver({ signedOut: ['youtube'] });
  t.after(r.close);
  const post = (extra) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ platform: 'youtube', ...extra }) });
  const refused = await post({ auto: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.success, false);
  assert.equal(refused.json.code, 'SIGNED_OUT');
  assert.equal(typeof refused.json.error, 'string');
  assert.equal(r.calls.length, 0, 'no cookie was written');
  // The extension's client reads it the way its resync expects.
  const viaClient = await connector.postImport({ fetch: globalThis.fetch, port: r.port, code: CODE, platform: 'youtube', cookies: [], auto: true });
  assert.equal(viaClient.code, 'SIGNED_OUT');
  // Other platforms are unaffected.
  assert.equal((await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ auto: true }) })).status, 200);
  // A click in the extension connects it and clears the state.
  const manual = await post({});
  assert.equal(manual.status, 200);
  assert.deepEqual(r.manual, ['youtube']);
  assert.equal((await post({ auto: true })).status, 200);
});

test('F53: the 409 carries why re-sync is off; an import that sees a sign-out mid-flight answers 409 too', async (t) => {
  const refusals = { youtube: APP_LOGIN_ERROR };
  const r = await startReceiver({
    isSignedOut: (p) => refusals[p] || null,
    importerResult: (platform, opts) => (platform === 'kick' && opts.auto
      ? { success: false, code: 'SIGNED_OUT', error: SIGNED_OUT_ERROR }
      : { success: true, username: `${platform}-user`, cookiesSet: 1 }),
  });
  t.after(r.close);
  const post = (platform, extra = {}) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ platform, ...extra }) });
  const appLogin = await post('youtube', { auto: true });
  assert.equal(appLogin.status, 409);
  assert.deepEqual(appLogin.json, { success: false, code: 'SIGNED_OUT', error: APP_LOGIN_ERROR });
  assert.equal(r.calls.length, 0, 'refused before the importer ran');
  // Signed out while the import was running: the extension must drop the
  // platform exactly as if the refusal had come first.
  const midFlight = await post('kick', { auto: true });
  assert.equal(midFlight.status, 409);
  assert.equal(midFlight.json.code, 'SIGNED_OUT');
  assert.equal(midFlight.json.username, undefined);
  const viaClient = await connector.postImport({ fetch: globalThis.fetch, port: r.port, code: CODE, platform: 'kick', cookies: [], auto: true });
  assert.equal(viaClient.code, 'SIGNED_OUT');
  // The truthy-but-not-a-string form still sends the sign-out text.
  assert.equal(autoSyncRefusalFor('signed-out'), SIGNED_OUT_ERROR);
  assert.equal(autoSyncRefusalFor('app-login'), APP_LOGIN_ERROR);
  assert.equal(autoSyncRefusalFor(null), null);
});

test('F96: every automatic re-sync is reported with its outcome; clicks and unknown platforms are not', async (t) => {
  const r = await startReceiver({
    signedOut: ['kick'],
    importerResult: (platform) => (platform === 'youtube'
      ? { success: false, error: 'Missing the Google sign-in session cookies (e.g. __Secure-1PSID/SID).' }
      : { success: true, username: 'someone', cookiesSet: 3 }),
  });
  t.after(r.close);
  const post = (body, code = CODE) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': code }), body });
  await post(importBody({ platform: 'twitch', auto: true }));
  await post(importBody({ platform: 'youtube', auto: true }));
  await post(importBody({ platform: 'kick', auto: true }));
  await post(importBody({ platform: 'myspace', auto: true }));
  await post(importBody({ platform: 'twitch' }));
  assert.deepEqual(r.autoAttempts, [
    { platform: 'twitch', ok: true, error: '', status: 200 },
    { platform: 'youtube', ok: false, error: 'Missing the Google sign-in session cookies (e.g. __Secure-1PSID/SID).', status: 200 },
    { platform: 'kick', ok: false, error: SIGNED_OUT_ERROR, status: 409 },
  ]);
  // A wrong code is counted, and nothing from the request is echoed anywhere.
  const secret = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
  assert.equal((await post(importBody({ auto: true }), secret)).status, 403);
  assert.equal(r.codeRejections(), 1);
  assert.equal(r.autoAttempts.length, 3);
  assert.ok(!JSON.stringify(r.autoAttempts).includes(secret) && !r.logs.join('\n').includes(secret));
});

test('F96: a throwing importer on a re-sync is reported, and a throwing recorder changes no answer', async (t) => {
  const r = await startReceiver({ importerThrows: true });
  t.after(r.close);
  const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ auto: true }) });
  assert.equal(res.status, 500);
  assert.deepEqual(r.autoAttempts, [{ platform: 'twitch', ok: false, error: 'boom', status: 500 }]);

  let port = 0;
  const handler = createReceiverHandler({
    getPort: () => port, getPairingCode: () => CODE, guard: createPairingGuard(),
    importers: { twitch: async () => ({ success: true, cookiesSet: 1 }) },
    onAutoAttempt: () => { throw new Error('recorder broke'); },
  });
  const server = createReceiverServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => new Promise(done => server.close(done)));
  const ok = await request(port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ auto: true }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.success, true);
});

test('F52: auto responses never carry the username; a failed manual import does not reconnect', async (t) => {
  const r = await startReceiver({ importerThrows: true, signedOut: ['kick'] });
  t.after(r.close);
  const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ platform: 'kick' }) });
  assert.equal(res.status, 500);
  assert.deepEqual(r.manual, [], 'still signed out');
  assert.ok(r.logs.some(l => /kick import failed: boom/.test(l)));
});

test('bad JSON, a non-object body and an unknown platform are answered, not thrown', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const post = (body) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body });
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post('[1,2]')).status, 400);
  const unknown = await post(importBody({ platform: 'myspace' }));
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, { success: false, error: 'Unknown platform' });
  // A split multi-byte character survives the byte-wise body read.
  const name = 'café-\u{1F600}';
  const res = await post(JSON.stringify({ platform: 'twitch', cookies: [{ name, value: 'v' }] }));
  assert.equal(res.status, 200);
  assert.equal(r.calls.at(-1).cookies[0].name, name);
});

test('G2.4: any bind error moves on to the next port (EADDRINUSE and EACCES alike)', async (t) => {
  // A real port in use.
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  const busy = blocker.address().port;
  const free = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const runtime = [];
  const got = await listenOnFirstPort({ ports: [busy, free], createServer: () => http.createServer(), onRuntimeError: (e) => runtime.push(e) });
  t.after(() => got.server && got.server.close());
  assert.equal(got.port, free);
  // An error after a successful bind is a runtime error, not a failed bind.
  got.server.emit('error', new Error('later'));
  assert.equal(runtime.length, 1);

  // A reserved port: Windows reports EACCES.
  const fakeServer = (code) => {
    const s = new EventEmitter();
    s.listen = () => setImmediate(() => (code ? s.emit('error', Object.assign(new Error(code), { code })) : s.emit('listening')));
    s.close = () => {};
    return s;
  };
  const codes = ['EACCES', 'EADDRINUSE', 'EPERM', null];
  const walked = await listenOnFirstPort({ ports: [1, 2, 3, 4], createServer: () => fakeServer(codes.shift()) });
  assert.equal(walked.port, 4);
  // What it skipped on the way, so main can say why it is on a fallback port.
  assert.deepEqual(walked.errors.map(e => e.port), [1, 2, 3]);
  const none = await listenOnFirstPort({ ports: [1, 2], createServer: () => fakeServer('EACCES') });
  assert.equal(none.server, null);
  assert.deepEqual(none.errors, [{ port: 1, code: 'EACCES' }, { port: 2, code: 'EACCES' }]);
});

test('F54: the server bounds slow and piled-up connections', () => {
  const s = createReceiverServer(() => {});
  assert.equal(s.headersTimeout, 10000);
  assert.equal(s.requestTimeout, 15000);
  assert.ok(s.maxConnections >= 4 && s.maxConnections <= 32, 'room for the real extension');
});
