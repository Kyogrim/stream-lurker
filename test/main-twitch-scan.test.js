// Gate tests for main/twitch-scan.js against a fake Twitch that behaves like
// the real one where it matters: GQL rejects a batch over 35 operations with
// HTTP 200 and a non-array body, Helix takes at most 100 logins and lists
// only live channels. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TWITCH_GQL_BATCH_LIMIT, HELIX_LOGIN_LIMIT, chunk, bodyExcerpt, parseGqlBatch, parseHelixStreams, helixStreamsUrl,
  checkTwitchGql, checkTwitchHelix, mergeFallbackResults, twitchCredentialKey, createTwitchTokenCache,
} = require('../main/twitch-scan');

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: typeof body === 'string' ? body : JSON.stringify(body) });
const liveEntry = (login) => ({ data: { user: { stream: { id: `s-${login}`, title: `${login} title`, viewersCount: 5, game: { name: 'Game' }, createdAt: '2026-09-27T07:00:00Z' } } } });
const offlineEntry = () => ({ data: { user: { stream: null } } });
const BATCH_LIMIT_EXCEEDED = { errors: [{ message: 'Invalid GraphQL request', extensions: { code: 'BATCH_LIMIT_EXCEEDED' } }] };

// Real GQL's batch behaviour; `entry` decides each operation's answer.
function fakeGql(entry = liveEntry) {
  const calls = [];
  const request = async (url, init) => {
    const ops = JSON.parse(init.body);
    calls.push(ops.map(o => o.variables.channelLogin));
    if (ops.length > 35) return reply(200, BATCH_LIMIT_EXCEEDED);
    return reply(200, ops.map(o => entry(o.variables.channelLogin)));
  };
  return { calls, request };
}

const gqlDeps = (request, logs = []) => ({ request, log: t => logs.push(t), clientId: 'public', userAgent: 'ua' });
const names = (n, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// The invariant the auto-close depends on: offline without an error only
// when Twitch positively said offline.
function assertNoSilentOffline(results, positivelyOffline = new Set()) {
  for (const r of results) {
    if (!r.isLive && !r.error) assert.ok(positivelyOffline.has(r.username), `${r.username} silently offline`);
  }
}

test('F13: 36 and 80 live channels all come back live, in order, in batches under the limit', async () => {
  assert.ok(TWITCH_GQL_BATCH_LIMIT <= 35);
  for (const n of [1, 30, 31, 36, 80]) {
    const gql = fakeGql();
    const logins = names(n);
    const results = await checkTwitchGql(logins, gqlDeps(gql.request));
    assert.equal(gql.calls.length, Math.ceil(n / TWITCH_GQL_BATCH_LIMIT), `requests for ${n}`);
    assert.ok(gql.calls.every(c => c.length <= TWITCH_GQL_BATCH_LIMIT));
    assert.deepEqual(results.map(r => r.username), logins);
    assert.ok(results.every(r => r.isLive && !r.error), `all live for ${n}`);
    assert.equal(results[0].liveSince, '2026-09-27T07:00:00Z');
  }
});

test('F13: a rejected batch (HTTP 200, non-array) errors only that batch and logs the cause', async () => {
  const logs = [];
  let call = 0;
  const request = async (url, init) => {
    const ops = JSON.parse(init.body);
    call++;
    if (call === 2) return reply(200, BATCH_LIMIT_EXCEEDED);
    return reply(200, ops.map(o => liveEntry(o.variables.channelLogin)));
  };
  const logins = names(70);
  const results = await checkTwitchGql(logins, gqlDeps(request, logs));
  const batch2 = new Set(logins.slice(TWITCH_GQL_BATCH_LIMIT, 2 * TWITCH_GQL_BATCH_LIMIT));
  for (const r of results) {
    if (batch2.has(r.username)) {
      assert.equal(r.isLive, false);
      assert.match(r.error, /BATCH_LIMIT_EXCEEDED/);
    } else {
      assert.equal(r.isLive, true, r.username);
    }
  }
  assert.ok(logs.some(l => /batch 2\/3/.test(l) && /BATCH_LIMIT_EXCEEDED/.test(l)), logs.join('\n'));
});

test('F13: short arrays, missing entries and unknown shapes are errors, never offline', () => {
  assert.throws(() => parseGqlBatch(BATCH_LIMIT_EXCEEDED, ['a']), /Invalid GraphQL request \(BATCH_LIMIT_EXCEEDED\)/);
  assert.throws(() => parseGqlBatch(null, ['a']), /non-array response/);
  assert.throws(() => parseGqlBatch([liveEntry('a')], ['a', 'b']), /answered 1 of 2/);

  const logins = ['nul', 'nodata', 'nouser', 'nostream', 'weird', 'errs', 'gone', 'off', 'on'];
  const results = parseGqlBatch([
    null,
    {},
    { data: {} },
    { data: { user: {} } },
    { data: { user: { stream: 'x' } } },
    { errors: [{ message: 'service timeout' }], data: { user: null } },
    { data: { user: null } },
    offlineEntry(),
    liveEntry('on'),
  ], logins);
  const by = Object.fromEntries(results.map(r => [r.username, r]));
  for (const u of ['nul', 'nodata', 'nouser', 'nostream', 'weird']) assert.ok(by[u].error, u);
  assert.equal(by.errs.error, 'service timeout');
  assert.equal(by.gone.error, undefined, 'unknown/renamed login: offline, not an error that pins cells open');
  assert.equal(by.off.error, undefined);
  assert.equal(by.on.isLive, true);
  assertNoSilentOffline(results, new Set(['gone', 'off']));
});

test('F13: HTTP errors, bad JSON and thrown requests mark the batch errored', async () => {
  for (const request of [
    async () => reply(500, 'upstream'),
    async () => reply(200, '<html>not json'),
    async () => { throw new Error('timed out after 15s'); },
  ]) {
    const results = await checkTwitchGql(['a', 'b'], gqlDeps(request));
    assert.ok(results.every(r => r.error && !r.isLive));
  }
  assert.deepEqual(await checkTwitchGql([], gqlDeps(async () => { throw new Error('no call expected'); })), []);
});

test('F13: a mixed fleet never produces a silent offline', async () => {
  const gql = fakeGql(login => (login.endsWith('7') ? offlineEntry() : login.endsWith('3') ? undefined : liveEntry(login)));
  const results = await checkTwitchGql(names(100), gqlDeps(gql.request));
  assertNoSilentOffline(results, new Set(names(100).filter(n => n.endsWith('7'))));
  assert.ok(results.filter(r => r.username.endsWith('3')).every(r => r.error === 'missing GQL response entry'));
});

// Helix: lists the live ones among ≤100 logins, first page only.
function fakeHelix({ liveLogins = () => true, status = () => 200 } = {}) {
  const calls = [];
  const request = async (url, init) => {
    const u = new URL(url);
    const logins = u.searchParams.getAll('user_login');
    calls.push({ logins, first: u.searchParams.get('first'), auth: init.headers.Authorization });
    const s = status(calls.length, init.headers.Authorization);
    if (s !== 200) return reply(s, { message: 'nope' });
    if (logins.length > 100) return reply(400, { message: 'too many' });
    const first = Number(u.searchParams.get('first') || 20);
    const data = logins.filter(liveLogins).slice(0, first).map(l => ({ user_login: l, title: `${l} t`, viewer_count: 3, game_name: 'G', started_at: '2026-09-27T06:00:00Z' }));
    return reply(200, { data, pagination: {} });
  };
  return { calls, request };
}

function helixDeps(request, { tokens = [{ token: 'cached', cached: true }], logs = [] } = {}) {
  const state = { tokenCalls: 0, invalidations: 0 };
  return {
    state,
    deps: {
      request,
      log: t => logs.push(t),
      clientId: 'client',
      getToken: async () => {
        const t = tokens[Math.min(state.tokenCalls, tokens.length - 1)];
        state.tokenCalls++;
        if (t instanceof Error) throw t;
        return t;
      },
      invalidateToken: () => { state.invalidations++; },
    },
  };
}

test('F24: Helix is chunked at 100 logins with first=100, so no live channel is dropped', async () => {
  assert.equal(HELIX_LOGIN_LIMIT, 100);
  for (const n of [0, 1, 20, 21, 100, 101, 250]) {
    const helix = fakeHelix();
    const { deps } = helixDeps(helix.request);
    const logins = names(n);
    const results = await checkTwitchHelix(logins, deps);
    assert.equal(helix.calls.length, Math.ceil(n / 100), `requests for ${n}`);
    assert.ok(helix.calls.every(c => c.first === '100' && c.logins.length <= 100));
    assert.deepEqual(results.map(r => r.username), logins);
    assert.ok(results.every(r => r.isLive), `all ${n} live`);
  }
});

test('F24: 25 live of 40 all come back live; the rest are positively offline', async () => {
  const logins = names(40);
  const liveSet = new Set(logins.slice(0, 25));
  const helix = fakeHelix({ liveLogins: l => liveSet.has(l) });
  const results = await checkTwitchHelix(logins, helixDeps(helix.request).deps);
  assert.equal(results.filter(r => r.isLive).length, 25);
  assert.ok(results.every(r => !r.error));
  assert.equal(results[0].liveSince, '2026-09-27T06:00:00Z');
});

test('F24: logins are URL-encoded and a failed chunk marks only its own logins', async () => {
  assert.equal(new URL(helixStreamsUrl(['A&b', 'c#d'])).searchParams.getAll('user_login').join('|'), 'a&b|c#d');
  const helix = fakeHelix({ status: n => (n === 2 ? 503 : 200) });
  const logins = names(250);
  const results = await checkTwitchHelix(logins, helixDeps(helix.request).deps);
  results.forEach((r, i) => {
    if (i >= 100 && i < 200) assert.equal(r.error, 'Helix request failed: 503');
    else assert.equal(r.isLive, true);
  });
  assert.throws(() => parseHelixStreams({ nope: 1 }, ['a']), /unexpected Helix response shape/);
});

test('F65: a 401 on a cached token refreshes once and retries; a refused fresh token does not loop', async () => {
  const logs = [];
  const helix = fakeHelix({ status: (n, auth) => (auth === 'Bearer cached' ? 401 : 200) });
  const { deps, state } = helixDeps(helix.request, { tokens: [{ token: 'cached', cached: true }, { token: 'fresh', cached: false }], logs });
  const results = await checkTwitchHelix(names(150), deps);
  assert.ok(results.every(r => r.isLive));
  assert.equal(state.invalidations, 1);
  assert.equal(state.tokenCalls, 2);
  assert.deepEqual(helix.calls.map(c => c.auth), ['Bearer cached', 'Bearer fresh', 'Bearer fresh']);
  assert.ok(logs.some(l => l.includes('Requesting a new one')));

  const always401 = fakeHelix({ status: () => 401 });
  const again = helixDeps(always401.request, { tokens: [{ token: 'cached', cached: true }, { token: 'fresh', cached: false }] });
  const r2 = await checkTwitchHelix(['a'], again.deps);
  assert.equal(r2[0].error, 'Helix request failed: 401');
  assert.equal(again.state.tokenCalls, 2, 'one refresh, no loop');
  assert.equal(always401.calls.length, 2);

  const fresh401 = fakeHelix({ status: () => 401 });
  const noRetry = helixDeps(fresh401.request, { tokens: [{ token: 'fresh', cached: false }] });
  await checkTwitchHelix(['a'], noRetry.deps);
  assert.equal(noRetry.state.invalidations, 0);
  assert.equal(fresh401.calls.length, 1);

  // 400 and 429 are not token problems.
  const limited = fakeHelix({ status: () => 429 });
  const noRefresh = helixDeps(limited.request);
  await checkTwitchHelix(['a'], noRefresh.deps);
  assert.equal(noRefresh.state.invalidations, 0);
});

test('Helix: a token failure errors every login (so the scan falls back to GQL)', async () => {
  const helix = fakeHelix();
  const { deps } = helixDeps(helix.request, { tokens: [new Error('Auth failed with status 403')] });
  const results = await checkTwitchHelix(['a', 'b'], deps);
  assert.ok(results.every(r => r.error === 'Auth failed with status 403'));
  assert.equal(helix.calls.length, 0);
});

test('mergeFallbackResults replaces only the errored logins, in order', () => {
  const primary = [{ username: 'a', isLive: true }, { username: 'B', error: 'x' }, { username: 'c', error: 'y' }];
  const fallback = [{ username: 'b', isLive: true }];
  assert.deepEqual(mergeFallbackResults(primary, fallback), [{ username: 'a', isLive: true }, { username: 'b', isLive: true }, { username: 'c', error: 'y' }]);
});

test('F65: the token cache is keyed to the credentials that minted it', () => {
  const cache = createTwitchTokenCache();
  const k1 = twitchCredentialKey('id', 'secret1');
  const k2 = twitchCredentialKey('id', 'secret2');
  const now = 1000;
  assert.equal(cache.get(k1, now), null);
  cache.set(k1, 'tok', 3600, now);
  assert.equal(cache.get(k1, now + 1), 'tok');
  assert.equal(cache.get(k2, now + 1), null, 'new secret: the old token is not reused');
  assert.equal(cache.heldForOther(k2), true);
  assert.equal(cache.heldForOther(k1), false);
  assert.equal(cache.get(k1, now + 3600 * 1000 - 60000), null, 'expires a minute early');
  cache.set(k1, 'tok2', undefined, now);
  assert.equal(cache.get(k1, now + 3500 * 1000), 'tok2', 'missing expires_in: an hour');
  cache.clear();
  assert.equal(cache.get(k1, now), null);
});

test('chunk', () => {
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2, 3, 4], 3), [[1, 2, 3], [4]]);
});

test('F02 layer 2: an HTML error page never reaches the error, the log or the cards as markup', async () => {
  const page = `<!DOCTYPE html><html><head><title>502</title><script>alert(1)</script></head>
    <body><h1>Bad   gateway</h1><img src=x onerror=alert(2)>${'<p>filler</p>'.repeat(500)}</body></html>`;
  const logs = [];
  const results = await checkTwitchGql(['a', 'b'], gqlDeps(async () => reply(502, page), logs));
  for (const r of results) {
    assert.doesNotMatch(r.error, /[<>]/, r.error);
    assert.match(r.error, /^GQL request failed: 502 - /);
    assert.ok(r.error.length <= 'GQL request failed: 502 - '.length + 200, `${r.error.length} characters`);
    assert.match(r.error, /Bad gateway/, 'the readable text survives, whitespace collapsed');
  }
  assert.ok(logs.length === 1 && !/[<>]/.test(logs[0]), logs[0]);
  // An empty body leaves no dangling separator.
  const empty = await checkTwitchGql(['a'], gqlDeps(async () => reply(503, '')));
  assert.equal(empty[0].error, 'GQL request failed: 503');
  assert.equal(bodyExcerpt(null), '');
  assert.equal(bodyExcerpt('a<b>c</b>  d'), 'a c d');
});
