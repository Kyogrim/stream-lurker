// Gate tests for extension/connector.js, the protocol shared by the companion
// extension's popup and background worker. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const SL = require('../extension/connector.js');
const { makeStorage, makeCookieJar, makeLoopback, proofFor, YT_COOKIES } = require('./extension-fakes.js');

const webcrypto = globalThis.crypto;
const CODE = 'ABCD1234';

// ── Cookie scope (F51 / contract C1) ─────────────────────────────────────────

test('YouTube scope: youtube.com and subdomains, exactly google.com and accounts.google.com', () => {
  const allowed = ['youtube.com', '.youtube.com', 'www.youtube.com', '.m.youtube.com', '.YouTube.com',
    'google.com', '.google.com', 'accounts.google.com', '.accounts.google.com'];
  const refused = ['mail.google.com', '.mail.google.com', 'docs.google.com', 'myaccount.google.com',
    'www.google.com', '.www.google.com', 'foo.accounts.google.com', 'evilyoutube.com', 'youtube.com.evil.com',
    'notgoogle.com', 'google.com.evil.com', 'google.co.uk', 'youtube-nocookie.com', '', null, undefined];
  for (const d of allowed) assert.equal(SL.isAllowedCookieDomain('youtube', d), true, `should allow ${d}`);
  for (const d of refused) assert.equal(SL.isAllowedCookieDomain('youtube', d), false, `should refuse ${d}`);
});

test('Twitch and Kick scope stays their own domain tree; unknown platforms get nothing', () => {
  assert.equal(SL.isAllowedCookieDomain('twitch', '.twitch.tv'), true);
  assert.equal(SL.isAllowedCookieDomain('twitch', 'www.twitch.tv'), true);
  assert.equal(SL.isAllowedCookieDomain('twitch', 'eviltwitch.tv'), false);
  assert.equal(SL.isAllowedCookieDomain('twitch', '.google.com'), false);
  assert.equal(SL.isAllowedCookieDomain('kick', '.kick.com'), true);
  assert.equal(SL.isAllowedCookieDomain('kick', 'kick.com.evil.io'), false);
  assert.equal(SL.isAllowedCookieDomain('rumble', '.rumble.com'), false);
  assert.equal(SL.isAllowedCookieDomain('__proto__', '.google.com'), false);
});

test('collectCookies drops Gmail/Docs cookies, dedupes, and copies only the cookie fields', async () => {
  const jar = makeCookieJar(YT_COOKIES);
  const out = await SL.collectCookies('youtube', jar);
  const domains = out.map(c => c.domain).sort();
  assert.deepEqual(domains, ['.accounts.google.com', '.google.com', '.google.com', '.youtube.com', 'accounts.google.com', 'm.youtube.com'].sort());
  assert.ok(!out.some(c => /mail|docs|myaccount|www\.google/.test(c.domain)), 'no other google.com subdomain leaves the browser');
  assert.deepEqual(jar.queries, ['youtube.com', 'google.com']);
  for (const c of out) {
    assert.deepEqual(Object.keys(c).sort(), ['domain', 'expirationDate', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']);
  }
});

test('collectCookies keeps going when one getAll query throws', async () => {
  const jar = makeCookieJar(YT_COOKIES, { throwFor: 'youtube.com' });
  const out = await SL.collectCookies('youtube', jar);
  assert.ok(out.length > 0);
  assert.ok(out.every(c => /google\.com$/.test(c.domain)));
  assert.deepEqual(await SL.collectCookies('nope', jar), []);
});

// ── Server proof (F50 / contract C1) ─────────────────────────────────────────

test('proof matches an independent Node HMAC-SHA256 of "stream-lurker-ping:" + nonce keyed by the code', async () => {
  const nonce = '00112233445566778899aabbccddeeff';
  const expected = nodeCrypto.createHmac('sha256', CODE).update('stream-lurker-ping:' + nonce).digest('hex');
  assert.equal(await SL.hmacSha256Hex(webcrypto.subtle, CODE, SL.PROOF_PREFIX + nonce), expected);
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce, expected), true);
  assert.equal(await SL.verifyPingProof(webcrypto, ' abcd1234 ', nonce, expected), true, 'code is trimmed and uppercased like the stored one');
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce, expected.toUpperCase()), true);
  assert.equal(await SL.verifyPingProof(webcrypto, 'ABCD1235', nonce, expected), false, 'wrong code');
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce.replace(/f$/, 'e'), expected), false, 'wrong nonce');
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce, expected.slice(0, 63)), false, 'truncated');
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce, expected.slice(0, 63) + 'z'), false, 'not hex');
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce, null), false);
  assert.equal(await SL.verifyPingProof(webcrypto, CODE, nonce, { toString: () => expected }), false);
  assert.equal(await SL.verifyPingProof(webcrypto, '', nonce, expected), false, 'no code, nothing verifies');
});

test('nonces are fresh 128-bit lowercase hex, inside the 16..64 range the app accepts', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const n = SL.makeNonce(webcrypto);
    assert.match(n, /^[0-9a-f]{32}$/);
    seen.add(n);
  }
  assert.equal(seen.size, 200);
});

test('constantTimeEqual only matches identical strings', () => {
  assert.equal(SL.constantTimeEqual('abc', 'abc'), true);
  assert.equal(SL.constantTimeEqual('abc', 'abd'), false);
  assert.equal(SL.constantTimeEqual('abc', 'abcd'), false);
  assert.equal(SL.constantTimeEqual('abc', null), false);
});

// ── Port walk ────────────────────────────────────────────────────────────────

test('a squatter on the first port gets only a nonce; the real app on the next port is used', async () => {
  const net = makeLoopback({ 47100: { kind: 'outdated' }, 47101: { kind: 'app', code: CODE } });
  const r = await SL.findApp({ fetch: net.fetch, crypto: webcrypto, code: CODE });
  assert.deepEqual(r, { status: 'verified', port: 47101 });
  const squatterSaw = net.requests.filter(q => q.port === 47100);
  assert.equal(squatterSaw.length, 1);
  assert.match(squatterSaw[0].url, /^http:\/\/127\.0\.0\.1:47100\/ping\?nonce=[0-9a-f]{32}$/);
  assert.equal(squatterSaw[0].method, 'GET');
  assert.ok(!JSON.stringify(net.requests).includes(CODE), 'the pairing code went nowhere during discovery');
});

test('a listener with a forged or replayed proof is skipped', async () => {
  // The squatter replays a genuine (nonce, proof) pair it harvested earlier.
  const harvestedNonce = 'aa'.repeat(16);
  const replay = proofFor(CODE, harvestedNonce);
  const net = makeLoopback({
    47100: { kind: 'forged', proof: replay },
    47101: { kind: 'forged', proof: 'not-even-hex' },
    47103: { kind: 'app', code: CODE },
  });
  const r = await SL.findApp({ fetch: net.fetch, crypto: webcrypto, code: CODE });
  assert.deepEqual(r, { status: 'verified', port: 47103 });
});

test("two users on one PC: the other user's app (different code) is skipped, ours is found", async () => {
  const net = makeLoopback({ 47100: { kind: 'app', code: 'FFFF0000' }, 47101: { kind: 'app', code: CODE } });
  assert.deepEqual(await SL.findApp({ fetch: net.fetch, crypto: webcrypto, code: CODE }), { status: 'verified', port: 47101 });
});

test('status when nothing verifies: mismatch, outdated, not-found, no-code', async () => {
  const find = (ports, code) => SL.findApp({ fetch: makeLoopback(ports).fetch, crypto: webcrypto, code });
  assert.equal((await find({ 47100: { kind: 'app', code: 'FFFF0000' } }, CODE)).status, 'mismatch');
  assert.equal((await find({ 47100: { kind: 'outdated' } }, CODE)).status, 'outdated');
  assert.equal((await find({ 47100: { kind: 'outdated' }, 47101: { kind: 'app', code: 'FFFF0000' } }, CODE)).status, 'mismatch');
  assert.equal((await find({ 47100: { kind: 'other-json' } }, CODE)).status, 'not-found');
  assert.equal((await find({}, CODE)).status, 'not-found');
  const noCode = await find({ 47100: { kind: 'app', code: CODE } }, '');
  assert.deepEqual(noCode, { status: 'no-code', port: null }, 'without a code nothing can be verified');
  assert.equal((await find({ 47100: { kind: 'outdated' } }, '')).status, 'outdated');
});

test('a listener that accepts and never answers cannot stall the walk', async () => {
  const net = makeLoopback({ 47100: { kind: 'hang' }, 47101: { kind: 'app', code: CODE } });
  const t0 = Date.now();
  const r = await SL.findApp({ fetch: net.fetch, crypto: webcrypto, code: CODE, timeoutMs: 60 });
  assert.deepEqual(r, { status: 'verified', port: 47101 });
  assert.ok(Date.now() - t0 < 2000);
});

// ── Import request ───────────────────────────────────────────────────────────

test('postImport sends the code in X-Pairing-Code, not the body, and flags auto only when asked', async () => {
  const net = makeLoopback({ 47101: { kind: 'app', code: CODE } });
  const manual = await SL.postImport({ fetch: net.fetch, port: 47101, code: 'abcd1234', platform: 'kick', cookies: [{ name: 'session_token', domain: '.kick.com' }] });
  assert.equal(manual.success, true);
  assert.equal(manual.username, 'someone');
  await SL.postImport({ fetch: net.fetch, port: 47101, code: CODE, platform: 'kick', cookies: [], auto: true });
  const [m, a] = net.imports;
  assert.equal(m.headers['X-Pairing-Code'], CODE);
  assert.equal(m.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(m.body).sort(), ['cookies', 'platform']);
  assert.equal(a.body.auto, true);
  assert.ok(!('pairingCode' in a.body));
});

test('postImport surfaces SIGNED_OUT, HTTP errors and non-JSON replies without throwing', async () => {
  const net = makeLoopback({ 47101: { kind: 'app', code: CODE, signedOut: ['twitch'] } });
  const so = await SL.postImport({ fetch: net.fetch, port: 47101, code: CODE, platform: 'twitch', cookies: [{}], auto: true });
  assert.deepEqual([so.httpStatus, so.success, so.code], [409, false, 'SIGNED_OUT']);
  const bad = await SL.postImport({ fetch: net.fetch, port: 47101, code: 'WRONG', platform: 'kick', cookies: [{}] });
  assert.deepEqual([bad.httpStatus, bad.success], [403, false]);
  assert.match(bad.error, /pairing code/i);
  const html = await SL.postImport({ fetch: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('bad'); } }), port: 1, code: CODE, platform: 'kick', cookies: [] });
  assert.deepEqual([html.httpStatus, html.success, html.error, html.cookiesSet], [502, false, '', null]);
});

// ── Background resync (F53, F96) ─────────────────────────────────────────────

function resyncDeps(storage, net, cookies = makeCookieJar(YT_COOKIES), clock = { t: 1_000_000 }) {
  return { storage, cookies, fetch: net.fetch, crypto: webcrypto, now: () => clock.t, findOptions: { timeoutMs: 200 } };
}

test('resync records its early skips so the popup never shows a stale "ok" as current', async () => {
  const empty = makeStorage({});
  assert.deepEqual(await SL.runResync(resyncDeps(empty, makeLoopback({}))), { status: 'idle' });
  assert.equal(empty.data.lastResyncStatus, 'idle');

  const oldOk = { kind: 'ok', cookiesSet: 30, at: 5 };
  const noCode = makeStorage({ connectedPlatforms: ['youtube'], lastResyncResults: { youtube: oldOk } });
  const net1 = makeLoopback({ 47100: { kind: 'app', code: CODE } });
  assert.equal((await SL.runResync(resyncDeps(noCode, net1))).status, 'not-paired');
  assert.equal(net1.requests.length, 0, 'no code: nothing is even pinged');

  const closed = makeStorage({ pairingCode: CODE, connectedPlatforms: ['youtube'], lastResyncResults: { youtube: oldOk } });
  assert.equal((await SL.runResync(resyncDeps(closed, makeLoopback({})))).status, 'app-not-running');
  assert.equal(closed.data.lastResyncStatus, 'app-not-running');
  assert.equal(closed.data.lastResync, 1_000_000);
  assert.deepEqual(closed.data.lastResyncResults.youtube, oldOk, 'the per-platform entry keeps its own, older timestamp');
});

test('resync sends nothing to an unproven or mismatched listener', async () => {
  for (const [ports, status] of [
    [{ 47100: { kind: 'outdated' } }, 'app-outdated'],
    [{ 47100: { kind: 'app', code: 'FFFF0000' } }, 'code-mismatch'],
    [{ 47100: { kind: 'forged', proof: 'ab'.repeat(32) } }, 'code-mismatch'],
  ]) {
    const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch', 'youtube'] });
    const net = makeLoopback(ports);
    assert.equal((await SL.runResync(resyncDeps(storage, net))).status, status);
    assert.equal(net.imports.length, 0);
    assert.ok(!JSON.stringify(net.requests).includes(CODE));
    assert.equal(storage.data.lastResyncStatus, status);
  }
});

test('happy path: auto imports with the header, only scoped YouTube cookies, results stored per platform', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['youtube', 'twitch', 'kick'] });
  const net = makeLoopback({ 47100: { kind: 'outdated' }, 47102: { kind: 'app', code: CODE } });
  const r = await SL.runResync(resyncDeps(storage, net));
  assert.equal(r.status, 'done');
  assert.deepEqual(net.imports.map(i => i.body.platform), ['twitch', 'youtube'], 'kick has no browser cookies, so it is not pushed');
  for (const i of net.imports) {
    assert.equal(i.port, 47102);
    assert.equal(i.body.auto, true);
    assert.equal(i.headers['X-Pairing-Code'], CODE);
  }
  const yt = net.imports.find(i => i.body.platform === 'youtube').body.cookies;
  assert.ok(yt.every(c => SL.isAllowedCookieDomain('youtube', c.domain)));
  assert.ok(yt.some(c => c.name === '__Secure-1PSID' && c.domain === '.google.com'), 'root google.com auth cookies still go');
  const res = storage.data.lastResyncResults;
  assert.deepEqual(res.twitch, { kind: 'ok', cookiesSet: 2, at: 1_000_000 });
  assert.equal(res.youtube.kind, 'ok');
  assert.deepEqual(res.kick, { kind: 'no-cookies', at: 1_000_000 });
  assert.deepEqual(storage.data.connectedPlatforms.sort(), ['kick', 'twitch', 'youtube']);
});

test('SIGNED_OUT removes only that platform from auto-sync; a later manual connect restores it', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch', 'youtube'] });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE, signedOut: ['twitch'] } });
  const clock = { t: 2_000_000 };
  await SL.runResync(resyncDeps(storage, net, undefined, clock));
  assert.deepEqual(storage.data.connectedPlatforms, ['youtube']);
  assert.deepEqual(storage.data.lastResyncResults.twitch, { kind: 'signed-out', at: 2_000_000 });

  // Next pass: twitch is not pushed at all.
  net.imports.length = 0;
  await SL.runResync(resyncDeps(storage, net, undefined, clock));
  assert.deepEqual(net.imports.map(i => i.body.platform), ['youtube']);

  // Manual connect from the popup (what popup.js does on success).
  await SL.updatePlatform(storage, 'twitch', { connected: true, result: { kind: 'ok', cookiesSet: 2, at: 3 } });
  assert.deepEqual(storage.data.connectedPlatforms.sort(), ['twitch', 'youtube']);
});

test('errors are recorded with their HTTP status; a network failure mid-import is caught', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch', 'youtube'] });
  const net = makeLoopback({ 47100: { kind: 'app', code: CODE, failImport: { twitch: 429 }, dropImport: ['youtube'] } });
  const r = await SL.runResync(resyncDeps(storage, net));
  assert.equal(r.status, 'done');
  assert.equal(storage.data.lastResyncResults.twitch.kind, 'error');
  assert.equal(storage.data.lastResyncResults.twitch.httpStatus, 429);
  assert.equal(storage.data.lastResyncResults.youtube.kind, 'error');
  assert.match(storage.data.lastResyncResults.youtube.message, /^Could not reach Stream Lurker/);
  assert.deepEqual(storage.data.connectedPlatforms, ['twitch', 'youtube'], 'errors never disconnect a platform');
});

test('a platform the user stops while its import is in flight does not reappear', async () => {
  const storage = makeStorage({ pairingCode: CODE, connectedPlatforms: ['twitch'] });
  const net = makeLoopback({
    47100: { kind: 'app', code: CODE, beforeImportReply: () => SL.updatePlatform(storage, 'twitch', { connected: false, result: null }) },
  });
  await SL.runResync(resyncDeps(storage, net));
  assert.deepEqual(storage.data.connectedPlatforms, []);
  assert.ok(!('twitch' in storage.data.lastResyncResults));
});

test('concurrent read-modify-writes do not lose updates', async () => {
  const storage = makeStorage({}, { delayMs: 5 });
  await Promise.all(SL.PLATFORMS.map(p => SL.updatePlatform(storage, p, { connected: true, result: { kind: 'ok', at: 1 } })));
  assert.deepEqual([...storage.data.connectedPlatforms].sort(), ['kick', 'twitch', 'youtube']);
  assert.deepEqual(Object.keys(storage.data.lastResyncResults).sort(), ['kick', 'twitch', 'youtube']);
});

// ── Popup text (F96) ─────────────────────────────────────────────────────────

const NOW = 10_000_000;
const MIN = 60_000;

test('relativeTime', () => {
  assert.equal(SL.relativeTime(NOW - 10_000, NOW), 'just now');
  assert.equal(SL.relativeTime(NOW - 12 * MIN, NOW), '12 min ago');
  assert.equal(SL.relativeTime(NOW - 3 * 60 * MIN, NOW), '3 h ago');
  assert.equal(SL.relativeTime(NOW - 24 * 60 * MIN, NOW), '24 h ago');
  assert.equal(SL.relativeTime(NOW - 3 * 24 * 60 * MIN, NOW), '3 days ago');
  assert.equal(SL.relativeTime(null, NOW), '');
});

test('"app not running" is calm; a code mismatch, an outdated app or a missing code are errors with a fix', () => {
  const base = { connectedPlatforms: ['twitch'], lastResync: NOW - 5 * MIN };
  const s = (status) => SL.describeSync({ ...base, lastResyncStatus: status }, NOW).summary;
  assert.equal(s('app-not-running').tone, 'idle');
  assert.match(s('app-not-running').text, /wasn't running/);
  assert.equal(s('code-mismatch').tone, 'err');
  assert.match(s('code-mismatch').text, /Paste the current code/);
  assert.equal(s('app-outdated').tone, 'err');
  assert.match(s('app-outdated').text, /needs updating/);
  assert.equal(s('not-paired').tone, 'err');
  assert.deepEqual(s('done'), { tone: 'idle', text: 'Last auto-sync 5 min ago.' });
  assert.match(SL.describeSync({ connectedPlatforms: [] }, NOW).summary.text, /Connect a platform/);
  assert.match(SL.describeSync({ connectedPlatforms: ['kick'] }, NOW).summary.text, /every 30 min/);
});

test('rows: one per connected platform, plus signed-out ones; per-kind text and tone', () => {
  const view = SL.describeSync({
    connectedPlatforms: ['kick', 'twitch'],
    lastResync: NOW,
    lastResyncStatus: 'done',
    lastResyncResults: {
      twitch: { kind: 'error', httpStatus: 403, message: 'Invalid pairing code.', at: NOW - 2 * MIN },
      youtube: { kind: 'signed-out', at: NOW - MIN },
      kick: { kind: 'ok', cookiesSet: 12, at: NOW - 30 * MIN },
    },
  }, NOW);
  assert.deepEqual(view.rows.map(r => [r.platform, r.connected, r.tone]), [
    ['twitch', true, 'err'], ['youtube', false, 'idle'], ['kick', true, 'ok'],
  ]);
  assert.match(view.rows[0].text, /Pairing code rejected \(2 min ago\)\. Paste the current code/);
  assert.match(view.rows[1].text, /Signed out in Stream Lurker.*Connect YouTube to resume/);
  assert.equal(view.rows[2].text, 'Synced 30 min ago · 12 cookies');

  const more = SL.describeSync({
    connectedPlatforms: ['twitch', 'youtube', 'kick'],
    lastResyncResults: {
      twitch: { kind: 'no-cookies', at: NOW },
      youtube: { kind: 'error', httpStatus: 429, at: NOW },
    },
  }, NOW).rows;
  assert.equal(more[0].tone, 'idle');
  assert.match(more[0].text, /not signed in to Twitch in this browser/);
  assert.match(more[1].text, /too many wrong codes/);
  assert.match(more[2].text, /First sync within 30 min/);
  const stale = SL.describeSync({ connectedPlatforms: [], lastResyncResults: { kick: { kind: 'ok', at: NOW } } }, NOW);
  assert.deepEqual(stale.rows, [], 'a stopped platform shows no row');
});

test('results stored by version 1.2.0 (plain strings) still render', () => {
  const view = SL.describeSync({
    connectedPlatforms: ['twitch', 'youtube'],
    lastResync: NOW - 3 * 24 * 60 * MIN,
    lastResyncResults: { twitch: 'ok (34 cookies)', youtube: 'Invalid pairing code. Copy the code shown in Stream Lurker into the extension.' },
  }, NOW);
  assert.equal(view.summary.text, 'Last auto-sync 3 days ago.');
  assert.deepEqual(view.rows.map(r => r.tone), ['ok', 'err']);
  assert.equal(view.rows[0].text, 'Last sync ok (34 cookies) (3 days ago)');
  assert.match(view.rows[1].text, /^Invalid pairing code/);
});

test('connection line: outdated app says it needs updating; only verified is ok', () => {
  assert.deepEqual(SL.describeConnection({ status: 'verified', port: 47101 }), { tone: 'ok', text: 'Connected to Stream Lurker (port 47101)' });
  assert.match(SL.describeConnection({ status: 'outdated' }).text, /app needs updating/);
  assert.equal(SL.describeConnection({ status: 'mismatch' }).tone, 'err');
  assert.equal(SL.describeConnection({ status: 'no-code' }).tone, 'idle');
  assert.match(SL.describeConnection({ status: 'not-found' }).text, /not found/);
});
