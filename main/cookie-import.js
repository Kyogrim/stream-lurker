// Turning an imported cookie list (the companion extension, a pasted
// Cookie-Editor / cookies.txt export, a Cookie header) into the exact
// ses.cookies.set calls that reproduce it. Pure, so every rule below is tested
// in Node: test/main-cookie-import.test.js.

const ONE_YEAR_S = 60 * 60 * 24 * 365;

// Map various sameSite spellings to the values Electron's cookies.set accepts.
function normalizeSameSite(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'lax') return 'lax';
  if (v === 'strict') return 'strict';
  if (v === 'no_restriction' || v === 'none') return 'no_restriction';
  return 'unspecified';
}

// Epoch seconds, or undefined for "no usable expiry" (the writer then gives it
// a year). Exporters disagree: Chrome and Cookie-Editor write seconds,
// Puppeteer/Playwright write -1 for a session cookie, some write milliseconds
// or a date string. -1 must never reach cookies.set: Chromium stores it as
// already expired and drops the cookie on the spot.
function normalizeExpiry(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    n = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s) / 1000;
  } else return undefined;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1e11) n /= 1000; // milliseconds
  return n;
}

// Parse a pasted cookie blob from a cookie-export extension. Supports JSON
// (Cookie-Editor / EditThisCookie / Puppeteer), Netscape cookies.txt, and a
// plain "name=value; name=value" header string. Returns normalized cookie
// objects; hostOnly is only set when the source says so.
function parseCookieBlob(raw) {
  raw = String(raw || '').trim();
  const out = [];
  if (!raw) return out;

  // JSON array/object
  if (raw[0] === '[' || raw[0] === '{') {
    try {
      let arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = arr.cookies || [arr];
      for (const c of arr) {
        if (!c || !c.name) continue;
        const cookie = {
          name: String(c.name),
          value: c.value != null ? String(c.value) : '',
          domain: c.domain || '',
          path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: !!(c.httpOnly || c.httponly),
          sameSite: normalizeSameSite(c.sameSite),
          expirationDate: c.session === true ? undefined : normalizeExpiry(c.expirationDate != null ? c.expirationDate : c.expires),
        };
        if (typeof c.hostOnly === 'boolean') cookie.hostOnly = c.hostOnly;
        out.push(cookie);
      }
      if (out.length) return out;
    } catch (e) { /* fall through to other formats */ }
  }

  // Netscape cookies.txt (tab-separated): domain, includeSub, path, secure, expiry, name, value
  if (/\t/.test(raw) || /^#\s*(HTTP Cookie File|Netscape)/im.test(raw)) {
    for (const rawLine of raw.split(/\r?\n/)) {
      let line = rawLine;
      // curl-style exporters write httpOnly cookies as "#HttpOnly_<domain>".
      // Those are exactly Google's session cookies (SID, HSID, SSID,
      // __Secure-1PSID), so they must not be skipped as comments.
      let httpOnly = false;
      if (/^#HttpOnly_/i.test(line)) {
        line = line.slice('#HttpOnly_'.length);
        httpOnly = true;
      } else if (!line.trim() || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length < 7) continue;
      const domain = f[0].trim();
      const expirationDate = normalizeExpiry(f[4].trim());
      out.push({
        domain,
        // includeSubdomains FALSE on a dotless domain is a host-only cookie.
        // A leading dot always means a domain cookie, whatever the flag says.
        hostOnly: /^false$/i.test(f[1].trim()) && !domain.startsWith('.'),
        path: f[2].trim() || '/',
        secure: /true/i.test(f[3]),
        expirationDate,
        name: f[5].trim(),
        value: f.slice(6).join('\t').trim(),
        httpOnly,
        sameSite: 'no_restriction',
      });
    }
    if (out.length) return out;
  }

  // Plain header string
  for (const part of raw.split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out.push({ name: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim(), domain: '', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction' });
  }
  return out;
}

// Whether a cookie must be written without a Domain attribute. Chromium
// rejects a __Host- cookie that has one, and a host-only cookie written with
// one silently widens to every subdomain. The leading-dot rule is what makes
// this work for senders that do not pass hostOnly (extensions already
// installed, every paste): Chrome, Cookie-Editor and cookies.txt all write a
// host-only cookie's domain without the dot and a domain cookie's with it.
function isHostOnlyCookie(c) {
  if (!c || !c.name) return false;
  if (String(c.name).startsWith('__Host-')) return true;
  if (c.hostOnly === true) return true;
  if (c.hostOnly === false) return false;
  const d = String(c.domain || '').trim();
  return !!d && !d.startsWith('.');
}

const hostOf = (domain) => String(domain || '').trim().replace(/^\./, '').toLowerCase();

// Registrable domain, good enough for the hosts imports are filtered to
// (twitch.tv, kick.com, youtube.com, google.com).
const regDomain = (h) => hostOf(h).split('.').slice(-2).join('.');

// The details for ses.cookies.set, or null for a cookie with nowhere to go.
// defaultDomain is for cookies that carry no domain of their own (a pasted
// header string, a synthesized cookie): those stay domain cookies, as before.
function cookieSetDetails(c, { defaultDomain = '', nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (!c || !c.name) return null;
  const name = String(c.name);
  const ownDomain = String(c.domain || '').trim();
  const domain = ownDomain || String(defaultDomain || '').trim();
  const host = hostOf(domain);
  if (!host) return null;
  const hostPrefixed = name.startsWith('__Host-');
  const hostOnly = hostPrefixed || (!!ownDomain && isHostOnlyCookie(c));
  // __Host- requires Path=/ and Secure; __Secure- requires Secure.
  const path = hostPrefixed ? '/' : ((c.path && String(c.path).startsWith('/')) ? String(c.path) : '/');
  const secure = hostPrefixed || name.startsWith('__Secure-') || c.secure !== false;
  let sameSite = normalizeSameSite(c.sameSite);
  // SameSite=None without Secure is rejected outright; cookies.txt has no
  // SameSite column, so a non-secure line would otherwise always fail.
  if (sameSite === 'no_restriction' && !secure) sameSite = 'unspecified';
  const details = {
    url: `https://${host}${path}`,
    name,
    value: String(c.value == null ? '' : c.value),
    path,
    secure,
    httpOnly: !!c.httpOnly,
    sameSite,
    expirationDate: normalizeExpiry(c.expirationDate) || (nowS + ONE_YEAR_S),
  };
  // Omitted, not undefined: Electron treats any domain key as a Domain attribute.
  if (!hostOnly) details.domain = domain;
  return details;
}

// Plans one import: every cookie's set details, plus which existing cookies to
// clear first. Chromium will not let a JS-readable cookie overwrite an httpOnly
// one, so same-named cookies on the same site are removed before anything is
// written. Clearing the whole batch BEFORE the first write matters: clearing
// per cookie deleted the copy of a name written a moment earlier on another
// host of the same site (a host-only www.youtube.com cookie and a .youtube.com
// one), leaving only whichever came last.
function planCookieWrites(cookieList, opts = {}) {
  const writes = [];
  const clear = new Map(); // name -> Set of registrable domains
  for (const c of cookieList || []) {
    const details = cookieSetDetails(c, opts);
    if (!details) continue;
    writes.push(details);
    const site = regDomain(details.domain || new URL(details.url).hostname);
    if (!clear.has(details.name)) clear.set(details.name, new Set());
    clear.get(details.name).add(site);
  }
  return { writes, clear };
}

// Whether an existing cookie (from ses.cookies.get) is cleared by a plan. It
// also catches the ".www.youtube.com"-style copies older builds wrote for what
// should have been host-only cookies.
function shouldClearExisting(existing, plan) {
  if (!existing || !existing.name) return false;
  const sites = plan.clear.get(existing.name);
  const host = hostOf(existing.domain);
  return !!sites && !!host && sites.has(regDomain(host));
}

function removalUrl(existing) {
  return `https://${hostOf(existing.domain)}${existing.path || '/'}`;
}

// C1: what a YouTube import may write. youtube.com and any subdomain, and
// exactly google.com / accounts.google.com, which carry the Google sign-in.
function isYouTubeCookieDomain(domain) {
  const d = hostOf(domain);
  if (!d) return false;
  return d === 'youtube.com' || d.endsWith('.youtube.com') || d === 'google.com' || d === 'accounts.google.com';
}

// The cookies of a YouTube session as the jar holds them (ses.cookies.get
// results for youtube.com and google.com), reduced to the hosts an import
// writes to, each cookie once. A paste YouTube rejects is undone by writing
// these back, so a working session the paste replaced is not lost.
function youtubeJarCookies(cookies) {
  const seen = new Set();
  const out = [];
  for (const c of cookies || []) {
    if (!c || !c.name || !isYouTubeCookieDomain(c.domain)) continue;
    const key = `${String(c.domain).toLowerCase()}|${c.path || '/'}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// A pasted header string has no domains. Those cookies were copied from a
// youtube.com page, so they belong on .youtube.com: the apex host-only cookie
// they used to become is never sent to www.youtube.com. A __Host- cookie can
// have no Domain at all, so it stays host-only on www.
function assignPastedYouTubeDomains(cookies) {
  return (cookies || []).map((c) => {
    if (!c || String(c.domain || '').trim()) return c;
    if (String(c.name || '').startsWith('__Host-')) return { ...c, domain: 'www.youtube.com', hostOnly: true, path: '/' };
    return { ...c, domain: '.youtube.com', hostOnly: false };
  });
}

// A Google sign-in needs the httpOnly session identifiers. SID, APISID and
// SAPISID alone are what document.cookie (or a cookies.txt whose #HttpOnly_
// lines were dropped) yields, and YouTube treats that as signed out.
function hasGoogleSessionCookies(cookies) {
  const names = new Set((cookies || []).filter(c => c && c.name && c.value).map(c => String(c.name)));
  if (names.has('__Secure-1PSID') || names.has('__Secure-3PSID')) return true;
  return names.has('SID') && names.has('HSID') && names.has('SSID');
}

module.exports = {
  normalizeSameSite,
  normalizeExpiry,
  parseCookieBlob,
  isHostOnlyCookie,
  regDomain,
  cookieSetDetails,
  planCookieWrites,
  shouldClearExisting,
  removalUrl,
  isYouTubeCookieDomain,
  youtubeJarCookies,
  assignPastedYouTubeDomains,
  hasGoogleSessionCookies,
};
