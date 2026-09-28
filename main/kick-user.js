// Kick's own API, asked from inside a kick.com page so it carries the session
// cookies and is not turned away by Cloudflare. Shared by the hidden-page name
// lookup and the login modal, where an API answer is the proof of a sign-in.
// The script is evaluated against a fake page in test/main-kick-user.test.js.
//
// Resolves to { name, source: 'api' | 'next-data' | 'dom' | null, tried, ... }.
// Only 'api' proves a session: the other two read the page, and without a
// session the page is kick.com's home page, full of featured streamers' slugs.

const { isPlaceholderName } = require('./account-state');

const KICK_USER_SCRIPT = `
  (async () => {
    const pick = (o) => (o && (o.username || o.slug || o.name
      || (o.user && (o.user.username || o.user.name))
      || (o.data && (o.data.username || o.data.slug || o.data.name)))) || null;
    const tried = [];

    // Kick runs Laravel: an authenticated API call needs the X-XSRF-TOKEN
    // header echoing the XSRF-TOKEN cookie, or it answers 200 with no body.
    const xsrf = (document.cookie.match(/(?:^|;\\s*)XSRF-TOKEN=([^;]+)/) || [])[1];
    const headers = { 'Accept': 'application/json' };
    if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);

    // The cookie alone isn't enough: Kick's own frontend replays session_token
    // as a bearer, and without it the API answers 200 with an empty object.
    const sess = (document.cookie.match(/(?:^|;\\s*)session_token=([^;]+)/) || [])[1];
    if (sess) headers['Authorization'] = 'Bearer ' + decodeURIComponent(sess);
    tried.push('xsrf=' + (xsrf ? 'present' : 'MISSING') + ' bearer=' + (sess ? 'present' : 'MISSING'));

    let apiAnswered = false;
    for (const path of ['/api/v1/user', '/api/v2/user']) {
      try {
        // Bounded, so a stalled request returns what was tried instead of
        // holding the page (and whoever waits on it) open.
        const r = await fetch(path, { credentials: 'include', headers, signal: AbortSignal.timeout(5000) });
        const body = await r.text();
        let j = null;
        try { j = JSON.parse(body); } catch (e) {}
        // 401 (Laravel's Unauthenticated) and 419 (session/CSRF expired) are
        // Kick's API answering about the session just as much as a 2xx
        // without a user. 403 and 5xx stay unanswered: those are Cloudflare
        // challenges and outages, which say nothing about the session.
        if (r.ok || r.status === 401 || r.status === 419) apiAnswered = true;
        const n = r.ok ? pick(j) : null;
        tried.push(path + ' -> ' + r.status + (n ? ' name=' + n : ' len=' + body.length));
        if (n) return { name: n, source: 'api', tried };
      } catch (e) { tried.push(path + ' -> threw ' + e.message); }
    }

    // The page-scraping fallbacks only mean something with a live session.
    // Signed out, or with a stale session_token (the API answering 2xx with
    // no user, or 401/419, is Kick saying so), they name a featured streamer
    // from the home page as the account. So they run only when the API could
    // not be asked.
    if (sess && apiAnswered) tried.push('API answered without a user: the session is stale');
    if (sess && !apiAnswered) {
      // Next.js page state often carries the signed-in user.
      try {
        const raw = document.getElementById('__NEXT_DATA__');
        if (raw) {
          const found = JSON.stringify(JSON.parse(raw.textContent))
            .match(/"(?:username|slug)":"([A-Za-z0-9_\\-]{2,30})"/);
          if (found) { tried.push('__NEXT_DATA__ hit'); return { name: found[1], source: 'next-data', tried }; }
          tried.push('__NEXT_DATA__ no match');
        } else { tried.push('no __NEXT_DATA__'); }
      } catch (e) { tried.push('__NEXT_DATA__ threw'); }
      // Fall back to whatever the page itself exposes about the signed-in user.
      try {
        const a = document.querySelector('a[href^="/"][class*="username" i], [data-testid*="user" i] a[href^="/"]');
        if (a && a.getAttribute('href')) {
          const slug = a.getAttribute('href').replace(/^\\//, '').split(/[/?#]/)[0];
          if (slug) return { name: slug, source: 'dom', tried };
        }
      } catch (e) {}
    }
    // Nothing worked — report whether the page considers us signed in at all,
    // so a dead Kick session is distinguishable from a naming problem.
    const bodyText = (document.body && document.body.innerText || '').slice(0, 4000);
    tried.push('pageLooksLoggedOut=' + /\\b(log in|sign up)\\b/i.test(bodyText));
    return { name: null, source: null, tried, url: location.href, title: document.title };
  })()
`;

// The account name a script result proves, or null. requireApi is for the
// login modal, where the name is also the evidence that a sign-in happened.
function kickNameFrom(res, { requireApi = false } = {}) {
  if (!res || typeof res !== 'object' || !res.name) return null;
  if (requireApi && res.source !== 'api') return null;
  const name = String(res.name).trim();
  return name || null;
}

// What a background lookup may store over `stored`: a placeholder (or
// nothing) takes any name the page gave, a real account name only one Kick's
// API confirmed. The page fallbacks read whatever slug comes first, so they
// must never rename a known account. `res` is { name, source } or null.
function kickNameToStore(stored, res) {
  const name = kickNameFrom(res);
  if (!name) return null;
  if (!isPlaceholderName(stored) && res.source !== 'api') return null;
  return name;
}

module.exports = { KICK_USER_SCRIPT, kickNameFrom, kickNameToStore };
