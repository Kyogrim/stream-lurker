// Twitch live checks: Helix (the user's own app credentials) and the key-free
// GQL fallback. Network access is injected (`request` resolves to
// { status, ok, text }), so every rule here runs under plain Node in
// test/main-twitch-scan.test.js.
//
// The rule both paths follow: a login is reported offline without an `error`
// only when Twitch positively said so. The scanner auto-closes an open cell on
// exactly that shape, so anything the code did not understand (a rejected
// batch, a missing entry, a new response shape) must come back as an error.

const { parseJsonBody } = require('./scan-fetch');

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const HELIX_STREAMS_URL = 'https://api.twitch.tv/helix/streams';

// Twitch answers a GQL batch of more than 35 operations with HTTP 200 and a
// non-array {"errors":[{"extensions":{"code":"BATCH_LIMIT_EXCEEDED"}}]}.
// Kept under that with headroom in case the limit is lowered.
const TWITCH_GQL_BATCH_LIMIT = 30;
// Helix /streams takes at most 100 user_login values. With first=100 every
// live channel in a chunk fits on one page (the default page is 20).
const HELIX_LOGIN_LIMIT = 100;

const STREAM_QUERY = `query StreamRefetchManager($channelLogin: String!) {
        user(login: $channelLogin) {
          stream {
            id
            title
            viewersCount
            game {
              name
            }
            createdAt
          }
        }
      }`;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function twitchResult(username, fields) {
  return { platform: 'twitch', username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', ...fields };
}

function failedResult(username, message) {
  return twitchResult(username, { error: message });
}

function gqlOperation(login) {
  return { operationName: 'StreamRefetchManager', variables: { channelLogin: String(login).toLowerCase() }, query: STREAM_QUERY };
}

// A failed response body as it may appear in an error: tags stripped,
// whitespace collapsed, 200 characters at most. A Cloudflare or 5xx page is
// kilobytes of HTML, and the message lands in the activity log and on every
// Twitch card of the scan.
function bodyExcerpt(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function describeGqlErrors(errors) {
  if (!Array.isArray(errors)) return '';
  return errors.map((e) => {
    const message = e && e.message;
    const code = e && e.extensions && e.extensions.code;
    return message && code ? `${message} (${code})` : (message || code || '');
  }).filter(Boolean).join('; ');
}

// One GQL entry. Only `user: null` (an unknown, renamed or banned login) and
// `stream: null` are offline; any other shape is an error.
function parseGqlEntry(entry, username) {
  if (!entry || typeof entry !== 'object') return failedResult(username, 'missing GQL response entry');
  if (Array.isArray(entry.errors) && entry.errors.length) {
    return failedResult(username, describeGqlErrors(entry.errors) || 'GQL error');
  }
  const data = entry.data;
  if (!data || typeof data !== 'object' || !('user' in data)) return failedResult(username, 'unexpected GQL response shape');
  if (data.user === null) return twitchResult(username);
  if (typeof data.user !== 'object' || !('stream' in data.user)) return failedResult(username, 'unexpected GQL response shape');
  const s = data.user.stream;
  if (s === null) return twitchResult(username);
  if (typeof s !== 'object') return failedResult(username, 'unexpected GQL response shape');
  return twitchResult(username, {
    isLive: true,
    title: s.title || 'Live Stream',
    viewerCount: s.viewersCount || 0,
    category: s.game ? s.game.name : 'Just Chatting',
    // Never the scan time: the scanner keys go-live dedupe on this.
    liveSince: s.createdAt || '',
  });
}

// A whole batch response. HTTP 200 does not mean success here: a rejected
// batch is a 200 with a non-array body.
function parseGqlBatch(data, logins) {
  if (!Array.isArray(data)) {
    throw new Error(`GQL batch rejected: ${describeGqlErrors(data && data.errors) || 'non-array response'}`);
  }
  if (data.length !== logins.length) {
    throw new Error(`GQL batch answered ${data.length} of ${logins.length} operations`);
  }
  return logins.map((username, i) => parseGqlEntry(data[i], username));
}

function helixStreamsUrl(logins) {
  const params = new URLSearchParams({ first: String(HELIX_LOGIN_LIMIT) });
  for (const login of logins) params.append('user_login', String(login).toLowerCase());
  return `${HELIX_STREAMS_URL}?${params}`;
}

// Helix lists only the live channels; a requested login missing from the
// list is offline.
function parseHelixStreams(data, logins) {
  if (!data || !Array.isArray(data.data)) throw new Error('unexpected Helix response shape');
  const live = new Map();
  for (const s of data.data) {
    if (s && typeof s.user_login === 'string') live.set(s.user_login.toLowerCase(), s);
  }
  return logins.map((username) => {
    const s = live.get(String(username).toLowerCase());
    if (!s) return twitchResult(username);
    return twitchResult(username, {
      isLive: true,
      title: s.title || 'Live Stream',
      viewerCount: s.viewer_count || 0,
      category: s.game_name || 'Just Chatting',
      liveSince: s.started_at || '',
    });
  });
}

// Key-free check. Batches go out one after another, never all at once, and a
// failed batch marks only its own logins.
async function checkTwitchGql(logins, { request, log, clientId, userAgent }) {
  const batches = chunk(logins, TWITCH_GQL_BATCH_LIMIT);
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const res = await request(TWITCH_GQL_URL, {
        method: 'POST',
        headers: { 'Client-ID': clientId, 'Content-Type': 'application/json', 'User-Agent': userAgent },
        body: JSON.stringify(batch.map(gqlOperation)),
      });
      if (!res.ok) {
        const excerpt = bodyExcerpt(res.text);
        throw new Error(`GQL request failed: ${res.status}${excerpt ? ` - ${excerpt}` : ''}`);
      }
      results.push(...parseGqlBatch(parseJsonBody(res.text, 'Twitch GQL'), batch));
    } catch (err) {
      const which = batches.length > 1 ? ` (batch ${i + 1}/${batches.length})` : '';
      log(`Twitch key-free GQL check failed${which}: ${err.message}`);
      results.push(...batch.map(u => failedResult(u, err.message)));
    }
  }
  return results;
}

// Helix check with the user's app token. getToken() resolves to
// { token, cached }. An app token dies early when the user rotates the secret,
// so a 401 on a cached token gets exactly one retry with a new one; a freshly
// minted token that is refused is not retried, or bad credentials would loop.
async function checkTwitchHelix(logins, { request, log, clientId, getToken, invalidateToken }) {
  if (!logins.length) return [];
  let auth;
  try {
    auth = await getToken();
  } catch (err) {
    log(`Twitch check failed: ${err.message}`);
    return logins.map(u => failedResult(u, err.message));
  }

  const batches = chunk(logins, HELIX_LOGIN_LIMIT);
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const send = () => request(helixStreamsUrl(batch), {
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${auth.token}` },
    });
    try {
      let res = await send();
      if (res.status === 401 && auth.cached) {
        log('[Twitch] Helix rejected the cached app token. Requesting a new one...');
        invalidateToken();
        auth = await getToken();
        res = await send();
      }
      if (!res.ok) throw new Error(`Helix request failed: ${res.status}`);
      results.push(...parseHelixStreams(parseJsonBody(res.text, 'Twitch Helix'), batch));
    } catch (err) {
      const which = batches.length > 1 ? ` (batch ${i + 1}/${batches.length})` : '';
      log(`Twitch check failed${which}: ${err.message}`);
      results.push(...batch.map(u => failedResult(u, err.message)));
    }
  }
  return results;
}

// Helix results with each errored login replaced by its fallback (GQL)
// result, in the original order.
function mergeFallbackResults(primary, fallback) {
  const byLogin = new Map(fallback.map(r => [String(r.username).toLowerCase(), r]));
  return primary.map((r) => {
    if (!r.error) return r;
    return byLogin.get(String(r.username).toLowerCase()) || r;
  });
}

// The app-token cache, keyed to the credentials that minted it, so a token is
// never sent alongside a Client ID it does not belong to after the user saves
// or imports new credentials.
function twitchCredentialKey(clientId, clientSecret) {
  return `${clientId}\n${clientSecret}`;
}

function createTwitchTokenCache() {
  let entry = { token: null, expiresAt: 0, key: null };
  return {
    get(key, now = Date.now()) {
      return entry.token && entry.key === key && now < entry.expiresAt ? entry.token : null;
    },
    // True when a token is held for credentials other than these.
    heldForOther(key) {
      return !!entry.token && entry.key !== key;
    },
    // One-minute margin before the real expiry.
    set(key, token, expiresInSec, now = Date.now()) {
      const seconds = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600;
      entry = { token, key, expiresAt: now + seconds * 1000 - 60000 };
    },
    clear() {
      entry = { token: null, expiresAt: 0, key: null };
    },
  };
}

module.exports = {
  TWITCH_GQL_BATCH_LIMIT,
  HELIX_LOGIN_LIMIT,
  chunk,
  bodyExcerpt,
  parseGqlBatch,
  parseHelixStreams,
  helixStreamsUrl,
  checkTwitchGql,
  checkTwitchHelix,
  mergeFallbackResults,
  twitchCredentialKey,
  createTwitchTokenCache,
};
