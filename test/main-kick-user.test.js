// F14 / F33 / F36: the Kick account script, evaluated exactly as shipped
// against a fake kick.com page. Only Kick's API, asked with the session as the
// bearer, proves a sign-in; the page-scraping fallbacks only run with a
// session; every request is bounded. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { KICK_USER_SCRIPT, kickNameFrom } = require('../main/kick-user');
const { hasKickSessionToken } = require('../main/account-state');

// cookie: the page's document.cookie. api: path -> { status, body } or
// 'hang' (never answers until aborted). nextData: __NEXT_DATA__ JSON.
function runOnPage({ cookie = '', api = {}, nextData = null, userLink = null, bodyText = '' }) {
  const requests = [];
  const timeouts = [];
  const page = {
    document: {
      cookie,
      title: 'Kick',
      body: { innerText: bodyText },
      getElementById: (id) => (id === '__NEXT_DATA__' && nextData ? { textContent: JSON.stringify(nextData) } : null),
      querySelector: () => (userLink ? { getAttribute: () => userLink } : null),
    },
    location: { href: 'https://kick.com/' },
    AbortSignal: {
      // Real signals, shortened so a hung request fails in milliseconds.
      timeout: (ms) => { timeouts.push(ms); return AbortSignal.timeout(20); },
    },
    fetch: (path, init) => {
      requests.push({ path, init });
      const a = api[path] || { status: 200, body: '{}' };
      if (a === 'hang') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout'))));
      }
      return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body });
    },
    JSON, decodeURIComponent, Promise, Error,
  };
  return vm.runInNewContext(KICK_USER_SCRIPT, page).then((res) => ({ res, requests, timeouts }));
}

const FEATURED = { props: { pageProps: { featured: [{ slug: 'bigstreamer', username: 'bigstreamer' }] } } };

test('F33: signed out, the home page\'s featured streamer is never taken for the account', async () => {
  const { res, requests } = await runOnPage({
    cookie: 'XSRF-TOKEN=x%3D; kick_session=visitor',
    nextData: FEATURED,
    userLink: '/bigstreamer',
    bodyText: 'Log in  Sign up',
  });
  assert.equal(res.name, null);
  assert.equal(res.source, null);
  assert.equal(kickNameFrom(res), null);
  assert.ok(res.tried.includes('pageLooksLoggedOut=true'));
  assert.equal(requests[0].init.headers.Authorization, undefined);
});

test('F36: session plus an API answer is a sign-in, with the real name', async () => {
  const { res, requests } = await runOnPage({
    cookie: 'XSRF-TOKEN=abc%3D; session_token=123%7Csecret; kick_session=v',
    api: { '/api/v1/user': { status: 200, body: JSON.stringify({ id: 1, username: 'alice' }) } },
  });
  assert.equal(res.name, 'alice');
  assert.equal(res.source, 'api');
  assert.equal(kickNameFrom(res, { requireApi: true }), 'alice');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer 123|secret');
  assert.equal(requests[0].init.headers['X-XSRF-TOKEN'], 'abc=');
});

test('F36: a stale session whose API answers {} is not a sign-in, even if the page has a slug', async () => {
  const { res } = await runOnPage({
    cookie: 'session_token=stale',
    api: { '/api/v1/user': { status: 200, body: '{}' }, '/api/v2/user': { status: 200, body: '{}' } },
    nextData: FEATURED,
  });
  // The page fallback may name it (useful for naming a known account)...
  assert.equal(res.source, 'next-data');
  // ...but the login modal requires the API.
  assert.equal(kickNameFrom(res, { requireApi: true }), null);
  assert.equal(kickNameFrom(res), 'bigstreamer');
});

test('an error response is never read as a user', async () => {
  const { res } = await runOnPage({
    cookie: 'session_token=t',
    api: { '/api/v1/user': { status: 401, body: '{"name":"Unauthenticated"}' }, '/api/v2/user': { status: 500, body: '{"username":"x"}' } },
  });
  assert.equal(kickNameFrom(res, { requireApi: true }), null);
});

test('F14: a request that stalls is aborted and the script still returns', async () => {
  const { res, timeouts } = await runOnPage({
    cookie: 'session_token=t',
    api: { '/api/v1/user': 'hang', '/api/v2/user': { status: 200, body: JSON.stringify({ data: { username: 'bob' } }) } },
  });
  assert.deepEqual(timeouts, [5000, 5000], 'each request gets its own 5 s bound');
  assert.ok(res.tried.some(t => /\/api\/v1\/user -> threw .*aborted/.test(t)));
  assert.equal(kickNameFrom(res, { requireApi: true }), 'bob');
});

test('F36: the four login-modal cases', async () => {
  // What detectLogin does for Kick: the cookie, then the API proof.
  const verdict = async (jar, page) => {
    if (!hasKickSessionToken(jar)) return null;
    return kickNameFrom((await runOnPage(page)).res, { requireApi: true });
  };
  // A Cloudflare/Kasada challenge: no "Log in" button, no session.
  assert.equal(await verdict([{ name: 'kick_session', value: 'v' }, { name: '__cf_bm', value: 'b' }], {}), null);
  // Signed out, header shows Log In.
  assert.equal(await verdict([{ name: 'kick_session', value: 'v' }], { bodyText: 'Log in' }), null);
  // session_token present but the API answers {}.
  assert.equal(await verdict([{ name: 'session_token', value: 's' }], { cookie: 'session_token=s' }), null);
  // session_token present and the API names the account.
  assert.equal(await verdict([{ name: 'session_token', value: 's' }], {
    cookie: 'session_token=s',
    api: { '/api/v1/user': { status: 200, body: JSON.stringify({ user: { username: 'carol' } }) } },
  }), 'carol');
});

test('kickNameFrom trims and rejects junk', () => {
  assert.equal(kickNameFrom({ name: '  dave ', source: 'api' }, { requireApi: true }), 'dave');
  assert.equal(kickNameFrom({ name: '   ', source: 'api' }), null);
  assert.equal(kickNameFrom(null), null);
  assert.equal(kickNameFrom({ name: 'x', source: 'dom' }, { requireApi: true }), null);
});
