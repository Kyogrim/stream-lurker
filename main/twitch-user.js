// Who a Twitch auth-token belongs to, and whether "no user" means Twitch said
// no or Twitch could not be asked. The token paste and the extension import
// both validate here before touching any cookie, so a network blip must not be
// reported as a rejected session: the user would sign out and back in on
// twitch.tv to fix a session that was fine. Tested in
// test/main-twitch-user.test.js.

const { fetchTextWithDeadline } = require('./scan-fetch');

const TWITCH_USER_TIMEOUT_MS = 15000;

// reason: 'ok' | 'rejected' (Twitch answered and the token is not signed in)
//       | 'network' (no usable answer: offline, timeout, 5xx, 429, a captive
//         portal's HTML) | 'unexpected' (any other status; not the user's fault
//         either, and nothing suggests signing in again would help).
function classifyTwitchUserResponse(status, text) {
  if (status === 401 || status === 403) return { login: '', reason: 'rejected', status };
  if (status === 429 || status >= 500) return { login: '', reason: 'network', status };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { login: '', reason: 'network', status, detail: 'response was not JSON' };
  }
  if (status >= 200 && status < 300) {
    const login = Array.isArray(data) && data[0] && data[0].data && data[0].data.currentUser
      ? data[0].data.currentUser.login : '';
    if (typeof login === 'string' && login) return { login, reason: 'ok', status };
    // No user because the query itself failed ("service timeout") is Twitch
    // failing, not Twitch saying the token is signed out; unless the error
    // is about the token.
    const errors = Array.isArray(data) && data[0] && Array.isArray(data[0].errors) ? data[0].errors : [];
    if (errors.length) {
      const messages = errors.map(e => (e && typeof e.message === 'string' ? e.message : '')).filter(Boolean);
      const detail = messages.join('; ').slice(0, 200) || 'GraphQL errors';
      if (messages.some(m => /unauthori[sz]ed|authoriz|token|login required|not logged in/i.test(m))) {
        return { login: '', reason: 'rejected', status, detail };
      }
      return { login: '', reason: 'unexpected', status, detail };
    }
    return { login: '', reason: 'rejected', status };
  }
  return { login: '', reason: 'unexpected', status };
}

async function resolveTwitchUser(token, { fetch, clientId, userAgent, timeoutMs = TWITCH_USER_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchTextWithDeadline(fetch, 'https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': clientId, 'Authorization': `OAuth ${token}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify([{ operationName: 'CurrentUserCheck', query: 'query CurrentUserCheck { currentUser { id login displayName } }' }]),
    }, timeoutMs);
  } catch (e) {
    return { login: '', reason: 'network', status: 0, detail: e && e.message ? e.message : String(e) };
  }
  return classifyTwitchUserResponse(response.status, response.text);
}

// What the user is told when validation did not produce a user. what is
// 'token' (the paste) or 'session' (the extension).
function twitchUserFailureMessage(result, what) {
  if (result.reason === 'network') {
    return 'Could not reach Twitch (check your connection). Nothing was changed, try again.';
  }
  if (result.reason === 'unexpected') {
    return `Twitch gave an unexpected answer (HTTP ${result.status}). Nothing was changed, try again in a minute.`;
  }
  return what === 'token'
    ? 'Twitch did not accept that token. Make sure you copied it while logged in, then try again.'
    : 'Twitch did not accept that session.';
}

// For the activity log: tells the cases apart.
function describeTwitchUserResult(result) {
  if (result.reason === 'ok') return `OK as ${result.login} (http ${result.status})`;
  const status = result.status ? `http ${result.status}` : 'no response';
  return `${result.reason} (${status}${result.detail ? `, ${result.detail}` : ''})`;
}

module.exports = {
  TWITCH_USER_TIMEOUT_MS,
  classifyTwitchUserResponse,
  resolveTwitchUser,
  twitchUserFailureMessage,
  describeTwitchUserResult,
};
