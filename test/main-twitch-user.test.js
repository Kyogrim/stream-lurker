// G4.9: a Twitch session check that could not reach Twitch must not be
// reported as Twitch rejecting the session. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  classifyTwitchUserResponse, resolveTwitchUser, twitchUserFailureMessage, describeTwitchUserResult, TWITCH_USER_TIMEOUT_MS,
} = require('../main/twitch-user');

const OK_BODY = JSON.stringify([{ data: { currentUser: { id: '1', login: 'alice', displayName: 'Alice' } } }]);

test('a user comes back as ok', () => {
  assert.deepEqual(classifyTwitchUserResponse(200, OK_BODY), { login: 'alice', reason: 'ok', status: 200 });
});

test('Twitch answering "no user" is a rejection', () => {
  assert.equal(classifyTwitchUserResponse(200, JSON.stringify([{ data: { currentUser: null } }])).reason, 'rejected');
  // A bad OAuth token: 401 with a JSON object, not the array.
  assert.equal(classifyTwitchUserResponse(401, '{"error":"Unauthorized","status":401,"message":"The \\"Authorization\\" token is invalid."}').reason, 'rejected');
  assert.equal(classifyTwitchUserResponse(403, 'forbidden').reason, 'rejected');
  assert.equal(classifyTwitchUserResponse(200, '{"errors":[{"message":"x"}]}').reason, 'rejected', 'not the expected array');
});

test('no usable answer is a network failure, not a rejection', () => {
  assert.equal(classifyTwitchUserResponse(502, '<html>Bad Gateway</html>').reason, 'network');
  assert.equal(classifyTwitchUserResponse(503, '').reason, 'network');
  assert.equal(classifyTwitchUserResponse(429, '{}').reason, 'network', 'rate limited');
  // A captive portal or proxy page answering 200 with HTML.
  const portal = classifyTwitchUserResponse(200, '<html>Sign in to the hotel Wi-Fi</html>');
  assert.equal(portal.reason, 'network');
  assert.match(portal.detail, /not JSON/);
});

test('other statuses are neither the user\'s fault nor a network error', () => {
  assert.equal(classifyTwitchUserResponse(400, '{"error":"bad request"}').reason, 'unexpected');
});

test('a fetch that throws (offline, DNS, proxy) is a network failure', async () => {
  const r = await resolveTwitchUser('t'.repeat(30), {
    fetch: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); },
    clientId: 'cid', userAgent: 'ua',
  });
  assert.equal(r.reason, 'network');
  assert.equal(r.login, '');
  assert.match(describeTwitchUserResult(r), /network \(no response, net::ERR_INTERNET_DISCONNECTED\)/);
});

test('the request carries the token and client id; a user resolves', async () => {
  let seen;
  const r = await resolveTwitchUser('abc', {
    fetch: async (url, init) => { seen = { url, init }; return { status: 200, ok: true, text: async () => OK_BODY }; },
    clientId: 'cid', userAgent: 'ua',
  });
  assert.equal(r.login, 'alice');
  assert.equal(seen.url, 'https://gql.twitch.tv/gql');
  assert.equal(seen.init.headers.Authorization, 'OAuth abc');
  assert.equal(seen.init.headers['Client-ID'], 'cid');
  assert.ok(seen.init.signal, 'abortable, so a timeout frees the socket');
});

test('a server that accepts and never answers times out as a network failure', async () => {
  assert.equal(TWITCH_USER_TIMEOUT_MS, 15000);
  const sockets = new Set();
  const server = http.createServer(() => { /* never respond */ });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const started = Date.now();
    const r = await resolveTwitchUser('abc', {
      fetch: (url, init) => fetch(`http://127.0.0.1:${port}/gql`, init),
      clientId: 'cid', userAgent: 'ua', timeoutMs: 300,
    });
    assert.equal(r.reason, 'network');
    assert.match(r.detail, /timed out/);
    assert.ok(Date.now() - started < 5000, 'bounded');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('the user is told the right thing', () => {
  const network = twitchUserFailureMessage({ reason: 'network', status: 0 }, 'token');
  assert.match(network, /Could not reach Twitch/);
  assert.match(network, /Nothing was changed/);
  assert.doesNotMatch(network, /did not accept/);
  assert.match(twitchUserFailureMessage({ reason: 'rejected', status: 401 }, 'token'), /did not accept that token/);
  assert.equal(twitchUserFailureMessage({ reason: 'rejected', status: 200 }, 'session'), 'Twitch did not accept that session.');
  assert.match(twitchUserFailureMessage({ reason: 'unexpected', status: 400 }, 'session'), /HTTP 400/);
});
