// Gate tests for main/cookie-receiver.js (contract C1; F16, F17, F52, F54,
// F55, G2.4): the real handler on a real 127.0.0.1 socket, driven by raw HTTP
// requests and by the extension's own client (extension/connector.js), so a
// drift on either side of the contract fails here. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const {
  pingProof, pingBody, isAllowedHost, isAllowedOrigin, isJsonContentType, codesMatch, maskCode,
  createPairingGuard, readBodyCapped, createReceiverHandler, createReceiverServer, listenOnFirstPort,
  MAX_IMPORT_BODY_BYTES, PING_PROOF_PREFIX, SIGNED_OUT_ERROR, APP_LOGIN_ERROR, autoSyncRefusalFor,
  MIN_PROOF_CODE_LENGTH, TRUNCATED_CODE_ERROR,
} = require('../main/cookie-receiver');
const connector = require('../extension/connector.js');

const CODE = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const WRONG_CODE_ERROR = 'Invalid pairing code. Copy the code shown in Stream Lurker into the extension.';

// A receiver on an ephemeral port, with recording importers. importerThrows:
// true throws Error('boom'), a function returns what to throw per platform.
// Every request's handler promise is kept: a test can wait for work that
// sends no answer (an abandoned upload), and a rejection, which main.js (it
// does not await the handler) would meet as an unhandled one, fails close().
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
    if (typeof overrides.importerThrows === 'function') throw overrides.importerThrows(platform);
    if (overrides.importerThrows) throw new Error('boom');
    if (overrides.importerResult) return overrides.importerResult(platform, opts);
    return { success: true, username: `${platform}-user`, cookiesSet: cookies.length };
  };
  const handler = createReceiverHandler({
    getPort: () => port,
    getPairingCode: () => ('code' in overrides ? overrides.code : CODE),
    guard: overrides.guard || createPairingGuard(),
    importers: overrides.importers || { twitch: importer('twitch'), youtube: importer('youtube'), kick: importer('kick') },
    isSignedOut: overrides.isSignedOut || ((p) => signedOut.has(p)),
    onManualImport: (p) => { manual.push(p); signedOut.delete(p); },
    onAutoAttempt: (a) => autoAttempts.push(a),
    onCodeRejected: () => { codeRejections++; },
    log: (t) => logs.push(t),
    maxBodyBytes: overrides.maxBodyBytes,
  });
  const pending = new Set();
  const rejections = [];
  let handled = 0;
  const server = createReceiverServer((req, res) => {
    handled++;
    const settled = handler(req, res).catch((err) => { rejections.push(err); });
    pending.add(settled);
    settled.then(() => pending.delete(settled));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    server, port, calls, logs, manual, signedOut, autoAttempts, rejections,
    codeRejections: () => codeRejections,
    handled: () => handled,
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
    close: async () => {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
      assert.deepEqual(rejections, [], 'the handler never rejects');
    },
  };
}

// A raw request, so Host, Origin and the body can be anything. With no
// agent the client itself asks for Connection: close; pass a keep-alive
// agent to see whether the server keeps or closes the connection. An
// unanswered request fails after timeoutMs instead of hanging the run.
function request(port, { method = 'GET', path = '/', headers = {}, body, host, agent = false, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    // A declared length, as browsers send it (the chunked case is tested apart).
    const length = body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {};
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent,
      headers: { Host: host || `127.0.0.1:${port}`, ...length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`no answer to ${method} ${path} within ${timeoutMs} ms`)), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// A POST /import with no Content-Length (chunked), so only the bytes received count.
function postChunked(port, parts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/import', agent: false,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Pairing-Code': CODE, 'Transfer-Encoding': 'chunked' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e); });
    for (const part of parts) req.write(part);
    req.end();
  });
}

// Polls until cond() holds: a request reaching the handler has no event to await.
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 5));
  }
}

// What a promise settles to, or NEVER if it has not within ms.
const NEVER = Symbol('never settled');
async function within(promise, ms = 1000) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(NEVER), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

// A stand-in for http.IncomingMessage: headers, and the events readBodyCapped listens to.
const fakeRequest = (headers = {}) => Object.assign(new EventEmitter(), { headers });

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
  const expected = crypto.createHmac('sha256', CODE).update(`stream-lurker-ping:${r.port}:${nonce}`).digest('hex');
  assert.deepEqual(res.json, { app: 'stream-lurker', proof: expected });
  assert.match(res.json.proof, /^[0-9a-f]{64}$/, 'lowercase hex');
  assert.equal(PING_PROOF_PREFIX, 'stream-lurker-ping:');
  for (const bad of ['abc', 'z'.repeat(32), 'a'.repeat(15), 'a'.repeat(65), '']) {
    const other = await request(r.port, { path: `/ping?nonce=${bad}` });
    assert.deepEqual(other.json, { app: 'stream-lurker' }, bad);
  }
  assert.equal(pingProof(CODE.toLowerCase(), r.port, nonce), expected, 'the key is the upper-case code');
  // The port is part of what is signed, so the app's answer on one port is
  // useless to a squatter replaying it from another (relay defence).
  assert.notEqual(pingProof(CODE, r.port + 1, nonce), expected);
  const unbound = crypto.createHmac('sha256', CODE).update(`stream-lurker-ping:${nonce}`).digest('hex');
  assert.notEqual(expected, unbound, 'the pre-amendment message is no longer what is signed');
});

// pingBody's own guard: the handler always hands it URLSearchParams, but a
// query that cannot answer get() is "no nonce": { app } alone, never a throw.
test('C1 /ping: pingBody treats a missing or foreign query as no nonce', () => {
  const nonce = 'a'.repeat(32);
  for (const query of [null, undefined, {}, `nonce=${nonce}`, { nonce }]) {
    assert.deepEqual(pingBody(query, CODE, 47100), { app: 'stream-lurker' }, String(query));
  }
  assert.match(pingBody(new URLSearchParams({ nonce }), CODE, 47100).proof, /^[0-9a-f]{64}$/, 'a real query with the same nonce signs');
});

test('F17/issue-6: a code shorter than 32 characters signs no proof (one would give it away offline)', async (t) => {
  assert.equal(MIN_PROOF_CODE_LENGTH, connector.MIN_CODE_LENGTH, 'the app and the extension agree on the floor');
  const r = await startReceiver({ code: 'DEADBEEF' });
  t.after(r.close);
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await request(r.port, { path: `/ping?nonce=${nonce}` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { app: 'stream-lurker' });
  // Just under the floor is still refused; the floor itself signs (the
  // 32-character proof test above covers the full answer).
  const url = new URL(`http://127.0.0.1/ping?nonce=${nonce}`);
  assert.equal(pingBody(url.searchParams, 'A'.repeat(31), r.port).proof, undefined);
  assert.equal(pingBody(url.searchParams, ` ${'A'.repeat(31)} `, r.port).proof, undefined, 'padding does not count');
  assert.match(pingBody(url.searchParams, 'A'.repeat(32), r.port).proof, /^[0-9a-f]{64}$/);
  for (const code of ['', null, undefined, 12345678]) {
    assert.deepEqual(pingBody(url.searchParams, code, r.port), { app: 'stream-lurker' }, String(code));
  }
  // A short-code install still imports from connector 1.2, which never pings
  // for a proof: only the proof is withheld.
  const ok = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: 'deadbeef' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.success, true);
});

test('C1 interop: the extension client verifies the proof and imports with the header code', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const deps = { fetch: globalThis.fetch, crypto: globalThis.crypto, ports: [r.port], timeoutMs: 2000 };
  assert.deepEqual(await connector.findApp({ ...deps, code: CODE.toLowerCase() }), { status: 'verified', port: r.port });
  assert.equal((await connector.findApp({ ...deps, code: 'DEADBEEF'.repeat(4) })).status, 'mismatch');
  // An 8-character code (every install before 32-character codes) is 32 bits,
  // brute-forceable from one proof, so the extension refuses to rely on it.
  assert.equal((await connector.findApp({ ...deps, code: 'DEADBEEF' })).status, 'short-code');
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
  // Node strips the whitespace around a header value before the handler sees
  // it; the helper tolerates it on its own too, and still compares exactly.
  assert.equal(isAllowedHost(` 127.0.0.1:${r.port} `, r.port), true);
  assert.equal(isAllowedHost(` 127.0.0.1:${r.port}0 `, r.port), false);
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
  // Whitespace before a parameter is allowed (OWS). Node keeps it inside the
  // value, so the helper's own trim is what lets this client in.
  assert.equal(isJsonContentType('application/json ; charset=utf-8'), true);
  const spaced = await request(r.port, { method: 'POST', path: '/import', headers: { 'Content-Type': 'application/json ; charset=utf-8', 'X-Pairing-Code': CODE }, body: importBody() });
  assert.equal(spaced.status, 200);
});

// The C1 answer to every refusal: its status, the exact { success: false,
// error } body (connector.postImport reads success === true as "imported",
// so a refusal claiming success would be believed), JSON marked no-store,
// Allow on each 405, and Connection: close so the rest of a refused upload
// is dropped rather than read. Asked over keep-alive, as the extension's
// fetch does; an answer that is not a refusal keeps the connection open.
test('C1 refusals: exact bodies, Allow on 405, no-store, and the connection closed', async (t) => {
  const r = await startReceiver({ maxBodyBytes: 1000 });
  t.after(r.close);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const post = (extra = {}) => ({ method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody(), ...extra });
  const refusals = [
    // [what, request, status, error, Allow]
    ['a foreign Host', { path: '/ping', host: 'attacker.example' }, 403, 'Forbidden'],
    ['a web Origin', { path: '/ping', headers: { Origin: 'https://evil.example' } }, 403, 'Forbidden'],
    ['a path the URL parser rejects', { path: '//' }, 400, 'Bad request'],
    ['POST /ping', { method: 'POST', path: '/ping' }, 405, 'Method not allowed', 'GET'],
    ['GET /import', { path: '/import' }, 405, 'Method not allowed', 'POST'],
    ['another route', { path: '/other' }, 404, 'Not found'],
    ['text/plain', post({ headers: { 'Content-Type': 'text/plain', 'X-Pairing-Code': CODE } }), 415, 'Expected application/json'],
    ['a wrong header code', post({ headers: jsonHeaders({ 'X-Pairing-Code': 'WRONG123' }) }), 403, WRONG_CODE_ERROR],
    ['a body over the cap', post({ body: importBody({ pad: 'x'.repeat(2000) }) }), 413, 'Request too large'],
    ['bad JSON', post({ body: '{nope' }), 400, 'Invalid JSON'],
    ['a JSON array', post({ body: '[1,2]' }), 400, 'Invalid request'],
  ];
  for (const [what, opts, status, error, allow] of refusals) {
    const res = await request(r.port, { agent, ...opts });
    assert.equal(res.status, status, what);
    assert.deepEqual(res.json, { success: false, error }, what);
    assert.equal(res.headers.connection, 'close', what);
    assert.equal(res.headers['content-type'], 'application/json', what);
    assert.equal(res.headers['cache-control'], 'no-store', what);
    assert.equal(res.headers.allow, allow, what);
  }
  assert.equal(r.calls.length, 0, 'no refusal reached an importer');
  for (const opts of [{ path: '/ping' }, post()]) {
    const ok = await request(r.port, { agent, ...opts });
    assert.equal(ok.status, 200, opts.path);
    assert.equal(ok.headers.connection, 'keep-alive', opts.path);
    assert.equal(ok.headers['content-type'], 'application/json', opts.path);
    assert.equal(ok.headers['cache-control'], 'no-store', opts.path);
  }
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
  assert.equal(await postChunked(r.port, Array(10).fill('x'.repeat(200))), 413);
  assert.equal(r.calls.length, 0);
  // Declared over the cap with only a sliver sent: answered from the header
  // alone. Waiting for the bytes would hold the socket until the timeout.
  const sliver = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: r.port, method: 'POST', path: '/import', agent: false,
      headers: { Host: `127.0.0.1:${r.port}`, 'Content-Type': 'application/json', 'X-Pairing-Code': CODE, 'Content-Length': '5000' },
    }, (response) => { resolve(response.statusCode); response.resume(); req.destroy(); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.write('{"platform":"twitch","cookies":[');
    setTimeout(() => reject(new Error('no answer without the body')), 3000).unref();
  });
  assert.equal(sliver, 413);
  // The cap itself is allowed: exactly maxBodyBytes imports, declared or chunked.
  const bare = JSON.stringify({ platform: 'twitch', cookies: [], pad: '' });
  const exact = JSON.stringify({ platform: 'twitch', cookies: [], pad: 'p'.repeat(1000 - bare.length) });
  assert.equal(Buffer.byteLength(exact), 1000);
  assert.equal((await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: exact })).status, 200);
  assert.equal(await postChunked(r.port, [exact.slice(0, 600), exact.slice(600)]), 200);
  assert.equal(r.calls.length, 2);
  assert.equal(MAX_IMPORT_BODY_BYTES, 2 * 1024 * 1024, 'C1: 2 MB');
});

// readBodyCapped's documented outcomes, on a stand-in request. The cap is
// inclusive; an over-cap Content-Length is refused before any event is
// awaited, and bytes past the cap are refused whatever arrives after.
test('F54: readBodyCapped allows exactly the cap and refuses one byte more, declared or received', async () => {
  assert.deepEqual(await within(readBodyCapped(fakeRequest({ 'content-length': '1001' }), 1000)), { tooLarge: true }, 'refused on the header alone');
  const exact = fakeRequest({ 'content-length': '1000' });
  const read = readBodyCapped(exact, 1000);
  exact.emit('data', Buffer.alloc(600, 'a'));
  exact.emit('data', Buffer.alloc(400, 'b'));
  exact.emit('end');
  assert.deepEqual(await within(read), { text: 'a'.repeat(600) + 'b'.repeat(400) });
  const over = fakeRequest();
  const refused = readBodyCapped(over, 1000);
  over.emit('data', Buffer.alloc(1000, 'a'));
  over.emit('data', Buffer.alloc(1, 'a'));
  over.emit('end');
  assert.deepEqual(await within(refused), { tooLarge: true });
});

// A client abort reaches the request as 'error' then 'close' (Node 24); a
// stream that ends either way before 'end' must settle as { aborted: true },
// each event on its own, or the handler would wait on it forever.
test('F54: readBodyCapped settles { aborted: true } on an error or a close before the end', async () => {
  for (const event of ['error', 'close']) {
    const req = fakeRequest();
    const read = readBodyCapped(req, 1000);
    req.emit('data', Buffer.from('{"platform":'));
    req.emit(event, event === 'error' ? new Error('aborted') : undefined);
    assert.deepEqual(await within(read), { aborted: true }, event);
  }
});

// An upload the client abandons mid-body is dropped: no import, no answer,
// and no wrong pairing code counted (an old extension sends its code in the
// body, so none has been seen yet). Counting it would let a flaky connection
// walk the real extension into the lockout.
test('F54: an upload abandoned mid-body is dropped, not counted as a wrong code', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const socket = net.connect(r.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`POST /import HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"platform":"twitch","pairingCode":"`);
  await until(() => r.handled() === 1);
  socket.destroy();
  await r.idle();
  assert.equal(r.codeRejections(), 0);
  assert.deepEqual(r.logs, []);
  assert.equal(r.calls.length, 0);
  const next = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: CODE }) });
  assert.equal(next.status, 200);
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

// The log line for an import that carries no code at all (none in the body,
// or a field that is not a string) says "no code", never a made-up length.
test('C1: an import with no pairing code at all is refused and logged as "no code"', async (t) => {
  for (const extra of [{}, { pairingCode: 12345678 }, { pairingCode: null }]) {
    // A receiver each, so each is the first failure of its streak (the one logged).
    const r = await startReceiver();
    t.after(r.close);
    const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody(extra) });
    assert.equal(res.status, 403, JSON.stringify(extra));
    assert.deepEqual(res.json, { success: false, error: WRONG_CODE_ERROR });
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /the wrong pairing code \(no code\)\./);
  }
});

test('issue-8: connector 1.2 with a code cut to 16 characters is told to reload the extension', async (t) => {
  // More attempts than the lockout allows; the lockout itself is tested below.
  const r = await startReceiver({ guard: createPairingGuard({ maxFailures: 100 }) });
  t.after(r.close);
  const generic = 'Invalid pairing code. Copy the code shown in Stream Lurker into the extension.';
  // 1.2's maxlength="16" field keeps the first 16 characters of the 32.
  const cut = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: CODE.slice(0, 16) }) });
  assert.equal(cut.status, 403);
  assert.equal(cut.json.error, TRUNCATED_CODE_ERROR);
  assert.match(cut.json.error, /Reload Stream Lurker Connector on your browser's Extensions page, then paste the code again\./);
  assert.equal(r.codeRejections(), 1, 'counted like any wrong code');
  assert.match(r.logs[0], /out-of-date copy of the browser extension that cut the pairing code to 16 characters/);
  assert.ok(!r.logs[0].includes(CODE.slice(0, 16)), 'the log line stays masked');
  // Header absence and length decide, not how much matches: any 16 characters
  // get the same answer, so it is no partial-match oracle.
  const other = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: 'Z'.repeat(16) }) });
  assert.equal(other.json.error, TRUNCATED_CODE_ERROR);
  // A 16-character code in the header (1.3 or later), a wrong full-length
  // body code, or any other length keeps the generic text.
  const header = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE.slice(0, 16) }), body: importBody() });
  assert.equal(header.status, 403);
  assert.equal(header.json.error, generic);
  for (const pairingCode of ['F'.repeat(32), CODE.slice(0, 15), CODE.slice(0, 17), '']) {
    const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode }) });
    assert.equal(res.status, 403, pairingCode);
    assert.equal(res.json.error, generic, pairingCode);
  }
  assert.equal(r.codeRejections(), 7);
  assert.equal(r.calls.length, 0);
  // The length is measured without the padding a paste can carry.
  const padded = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: ` ${CODE.slice(0, 16)} ` }) });
  assert.equal(padded.json.error, TRUNCATED_CODE_ERROR);
  // The whole code still imports through the same path.
  const ok = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: CODE }) });
  assert.equal(ok.status, 200);
});

test('issue-8: the reload hint still counts toward the lockout', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const cut = () => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: CODE.slice(0, 16) }) });
  for (let i = 0; i < 5; i++) assert.equal((await cut()).status, 403);
  assert.equal((await cut()).status, 429);
  assert.equal(r.logs.filter(l => /refusing imports for 60 s/.test(l)).length, 1);
});

test('issue-8: an install still on an 8- or 16-character code never gets the reload hint', async (t) => {
  for (const code of ['DEADBEEF', 'DEADBEEFDEADBEEF']) {
    const r = await startReceiver({ code });
    t.after(r.close);
    const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders(), body: importBody({ pairingCode: 'Q'.repeat(16) }) });
    assert.equal(res.status, 403, code);
    assert.notEqual(res.json.error, TRUNCATED_CODE_ERROR, `${code}: its own field held the whole code`);
  }
});

test('F17: five wrong codes in a row lock /import for the lockout period, even for the right code', async (t) => {
  let now = 1000000;
  const guard = createPairingGuard({ now: () => now });
  const r = await startReceiver({ guard });
  t.after(r.close);
  // Keep-alive, as the extension's fetch: the 429 itself must close it.
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const attempt = (code) => request(r.port, { agent, method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': code }), body: importBody() });
  for (let i = 0; i < 4; i++) assert.equal((await attempt(`BAD${i}`)).status, 403);
  // A success resets the streak.
  assert.equal((await attempt(CODE)).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await attempt(`BAD${i}`)).status, 403);
  const locked = await attempt(CODE);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['retry-after'], '60');
  assert.deepEqual(locked.json, { success: false, error: 'Too many wrong pairing codes. Try again in a minute.' });
  assert.equal(locked.headers.connection, 'close');
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

// The guard as main.js drives it: lockedForMs() is the time left and never
// negative (0 before any lockout and once one ends), and reset(), which the
// New code button calls, lifts a lockout and forgets a streak at once.
test('F17: lockedForMs never goes negative; reset() lifts the lockout and clears the streak', () => {
  let now = 5000000;
  const guard = createPairingGuard({ maxFailures: 3, lockMs: 1000, now: () => now });
  assert.equal(guard.lockedForMs(), 0, 'never locked');
  for (let i = 0; i < 3; i++) guard.fail();
  assert.equal(guard.lockedForMs(), 1000);
  now += 1500;
  assert.equal(guard.lockedForMs(), 0, 'ended 500 ms ago, not -500');
  for (let i = 0; i < 3; i++) guard.fail();
  assert.equal(guard.lockedForMs(), 1000);
  guard.reset();
  assert.equal(guard.lockedForMs(), 0, 'the new code is accepted at once');
  guard.fail();
  guard.fail();
  guard.reset();
  assert.deepEqual(guard.fail(), { failures: 1, lockedNow: false }, 'the streak starts over');
});

test('F17: codes compare in constant time, whatever their lengths', () => {
  assert.equal(codesMatch(CODE, CODE), true);
  assert.equal(codesMatch(` ${CODE.toLowerCase()} `, CODE), true);
  assert.equal(codesMatch('A1B2', CODE), false);
  assert.equal(codesMatch('x'.repeat(10000), CODE), false);
  assert.equal(codesMatch('', CODE), false);
  assert.equal(codesMatch(CODE, ''), false, 'no code configured matches nothing');
  assert.equal(codesMatch(undefined, CODE), false);
  // Not even an equally empty code, and a stored value that is not a string
  // is refused, not thrown on.
  assert.equal(codesMatch('', ''), false);
  assert.equal(codesMatch('  ', ''), false);
  assert.equal(codesMatch('12345678', 12345678), false);
  assert.equal(codesMatch(CODE, null), false);
  assert.equal(maskCode('ABCDEF12'), 'AB… (8 characters)');
  assert.equal(maskCode(''), 'no code');
  // A padded code is measured without the padding; no code at all says so.
  assert.equal(maskCode('  ABCDEF12  '), 'AB… (8 characters)');
  for (const none of [undefined, null, 12345678, '   ']) assert.equal(maskCode(none), 'no code', String(none));
});

// An install with no usable pairing code lets nothing in: every import is
// refused with the plain 403 (an empty or 16-character code included, and
// never a 500 from the reload-hint check) and /ping signs no proof.
test('F17: with no pairing code configured, every import is refused and /ping proves nothing', async (t) => {
  for (const code of ['', null]) {
    const r = await startReceiver({ code });
    t.after(r.close);
    const attempts = [
      { headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody() },
      { headers: jsonHeaders(), body: importBody() },
      { headers: jsonHeaders(), body: importBody({ pairingCode: '' }) },
      { headers: jsonHeaders(), body: importBody({ pairingCode: 'Q'.repeat(16) }) },
    ];
    for (const attempt of attempts) {
      const res = await request(r.port, { method: 'POST', path: '/import', ...attempt });
      assert.equal(res.status, 403, `${code}: ${attempt.body}`);
      assert.deepEqual(res.json, { success: false, error: WRONG_CODE_ERROR });
    }
    const ping = await request(r.port, { path: `/ping?nonce=${'a'.repeat(32)}` });
    assert.deepEqual(ping.json, { app: 'stream-lurker' });
    assert.equal(r.calls.length, 0);
  }
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
  // Exactly the up-front refusal: no username, and never success.
  assert.deepEqual(midFlight.json, { success: false, code: 'SIGNED_OUT', error: SIGNED_OUT_ERROR });
  const viaClient = await connector.postImport({ fetch: globalThis.fetch, port: r.port, code: CODE, platform: 'kick', cookies: [], auto: true });
  assert.equal(viaClient.code, 'SIGNED_OUT');
  assert.equal(viaClient.success, false);
  // Both kinds of 409 are recorded as failed re-syncs.
  assert.deepEqual(r.autoAttempts, [
    { platform: 'youtube', ok: false, error: APP_LOGIN_ERROR, status: 409 },
    { platform: 'kick', ok: false, error: SIGNED_OUT_ERROR, status: 409 },
    { platform: 'kick', ok: false, error: SIGNED_OUT_ERROR, status: 409 },
  ]);
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
  assert.deepEqual(res.json, { success: false, error: 'boom' });
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

// The re-sync record keeps at most 200 characters of the importer's error,
// and a failure the importer did not explain is recorded as "Import failed",
// never a blank that Platform Logins would show as no reason at all.
test('F96: a re-sync failure is recorded with its error capped at 200 characters, or "Import failed"', async (t) => {
  const r = await startReceiver({
    importerResult: (platform) => (platform === 'twitch' ? { success: false, error: 'x'.repeat(500) } : { success: false }),
  });
  t.after(r.close);
  const post = (platform) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ platform, auto: true }) });
  await post('twitch');
  await post('kick');
  assert.deepEqual(r.autoAttempts, [
    { platform: 'twitch', ok: false, error: 'x'.repeat(200), status: 200 },
    { platform: 'kick', ok: false, error: 'Import failed', status: 200 },
  ]);
});

// An importer that throws something other than an Error (a rejected
// executeJavaScript can) is answered with the fixed "Import failed": never
// an answer with no error, and never the 500 of a crash in the error path.
test('an importer throwing a non-Error is answered 500 "Import failed", and recorded so', async (t) => {
  const thrown = { twitch: 'a string', youtube: null, kick: { code: 42 } };
  const r = await startReceiver({ importerThrows: (platform) => thrown[platform] });
  t.after(r.close);
  for (const platform of ['twitch', 'youtube', 'kick']) {
    const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ platform, auto: true }) });
    assert.equal(res.status, 500, platform);
    assert.deepEqual(res.json, { success: false, error: 'Import failed' }, platform);
  }
  assert.deepEqual(r.autoAttempts.map(a => a.error), ['Import failed', 'Import failed', 'Import failed']);
});

// An importer result that is not an object is a plain failure: never an
// empty {}, never a string's characters spread into an object, never success.
test('an importer result that is not an object is answered { success: false, error: "Import failed" }', async (t) => {
  const results = [undefined, null, 'ok', 5, true];
  const r = await startReceiver({ importerResult: () => results.shift() });
  t.after(r.close);
  for (let i = 0; i < 5; i++) {
    const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody() });
    assert.equal(res.status, 200, String(i));
    assert.deepEqual(res.json, { success: false, error: 'Import failed' }, String(i));
  }
  assert.deepEqual(r.manual, [], 'no failure counts as a manual import');
});

// A result JSON cannot encode (a BigInt, a cycle) never escapes the handler:
// its promise settles and the failure is logged. main.js does not await the
// handler, so a rejection would be an unhandled one in the main process.
test('an importer result JSON cannot encode is logged and never escapes the handler', async (t) => {
  const r = await startReceiver({ importerResult: () => ({ success: true, cookiesSet: 1n }) });
  t.after(r.close);
  const req = http.request({
    host: '127.0.0.1', port: r.port, method: 'POST', path: '/import', agent: false,
    headers: { Host: `127.0.0.1:${r.port}`, ...jsonHeaders({ 'X-Pairing-Code': CODE }) },
  });
  req.on('error', () => { /* closed by the test */ });
  req.end(importBody());
  await until(() => r.handled() === 1);
  await r.idle();
  req.destroy();
  assert.deepEqual(r.rejections, []);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^\[Ext\] Cookie receiver error: Do not know how to serialize a BigInt/);
});

// The last-resort answer: whatever throws where nothing else catches it
// (here the sign-out lookup), Error or not, the client gets 500 "Internal
// error" on a closed connection, and the log carries the message itself.
test('a dependency that throws outside the importer gets 500 "Internal error", logged', async (t) => {
  const thrown = [new Error('config unreadable'), null];
  const r = await startReceiver({ isSignedOut: () => { throw thrown.shift(); } });
  t.after(r.close);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  for (let i = 0; i < 2; i++) {
    const res = await request(r.port, { agent, method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ auto: true }) });
    assert.equal(res.status, 500, String(i));
    assert.deepEqual(res.json, { success: false, error: 'Internal error' });
    assert.equal(res.headers.connection, 'close');
  }
  assert.deepEqual(r.logs, ['[Ext] Cookie receiver error: config unreadable', '[Ext] Cookie receiver error: null']);
  assert.equal(r.calls.length, 0);
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

// What counts as a request object: an empty body reads as {} (the header
// code alone decides, and no platform is named), while JSON null, a number,
// a string or a boolean is refused like an array, before a field is read.
test('an empty body reads as {}; JSON null, a number, a string or a boolean is 400 "Invalid request"', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const post = (body) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body });
  const empty = await post('');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { success: false, error: 'Unknown platform' });
  for (const body of ['null', '5', '"twitch"', 'true', 'false', '0']) {
    const res = await post(body);
    assert.equal(res.status, 400, body);
    assert.deepEqual(res.json, { success: false, error: 'Invalid request' }, body);
  }
  assert.equal(r.calls.length, 0);
});

// The platform allowlist, not the importers object, decides what may import:
// a name every object has ('constructor', 'toString', 'valueOf') must never
// call an Object.prototype method as an importer (constructor would echo the
// cookies back), and an allowlisted platform with no importer wired is
// unknown rather than a crash.
test('C1: only an allowlisted platform with a wired importer imports', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  const post = (body) => request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body });
  for (const platform of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'rumble', '']) {
    const res = await post(importBody({ platform }));
    assert.equal(res.status, 200, platform);
    assert.deepEqual(res.json, { success: false, error: 'Unknown platform' }, platform);
  }
  assert.equal(r.calls.length, 0);
  const partial = await startReceiver({ importers: { twitch: async () => ({ success: true, cookiesSet: 0 }) } });
  t.after(partial.close);
  const kick = await request(partial.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ platform: 'kick' }) });
  assert.equal(kick.status, 200);
  assert.deepEqual(kick.json, { success: false, error: 'Unknown platform' });
});

// An importer always receives an array: a cookies field that is not one
// arrives as [] (nothing to write), never as something made up.
test('C1: a cookies field that is not an array reaches the importer as []', async (t) => {
  const r = await startReceiver();
  t.after(r.close);
  for (const cookies of ['auth-token=x', { name: 'auth-token', value: 'x' }, null, 5]) {
    const res = await request(r.port, { method: 'POST', path: '/import', headers: jsonHeaders({ 'X-Pairing-Code': CODE }), body: importBody({ cookies }) });
    assert.equal(res.status, 200, JSON.stringify(cookies));
    assert.deepEqual(r.calls.at(-1).cookies, [], JSON.stringify(cookies));
  }
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

// A port listen() rejects outright (out of range: net throws synchronously,
// with no 'error' event) is skipped like one that fails to bind, not waited
// on forever and not reported as bound.
test('G2.4: a port listen() throws on is skipped too', async (t) => {
  const got = await within(listenOnFirstPort({ ports: [70000, 0], createServer: () => http.createServer() }), 2000);
  assert.notEqual(got, NEVER, 'the walk finished');
  t.after(() => got.server && got.server.close());
  assert.equal(got.port, 0);
  assert.ok(got.server.address().port > 0, 'bound on the next port');
  assert.deepEqual(got.errors, [{ port: 70000, code: 'ERR_SOCKET_BAD_PORT' }]);
});

// Why each port was skipped, as main logs it: the error's code, else its
// message, else 'error'. Real bind errors carry a code and a longer message.
test('G2.4: a skipped port is reported by its error code, else its message, else "error"', async () => {
  const failing = (err) => {
    const s = new EventEmitter();
    s.listen = () => setImmediate(() => s.emit('error', err));
    s.close = () => {};
    return s;
  };
  const errs = [
    Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:1'), { code: 'EACCES' }),
    new Error('no code on this one'),
    new Error(''),
  ];
  const got = await listenOnFirstPort({ ports: [1, 2, 3], createServer: () => failing(errs.shift()) });
  assert.equal(got.server, null);
  assert.deepEqual(got.errors, [{ port: 1, code: 'EACCES' }, { port: 2, code: 'no code on this one' }, { port: 3, code: 'error' }]);
});

test('F54: the server bounds slow and piled-up connections', () => {
  const s = createReceiverServer(() => {});
  assert.equal(s.headersTimeout, 10000);
  assert.equal(s.requestTimeout, 15000);
  assert.ok(s.maxConnections >= 4 && s.maxConnections <= 32, 'room for the real extension');
});
