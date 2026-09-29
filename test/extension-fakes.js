// Fakes for the companion-extension tests: chrome.storage.local, chrome.cookies,
// and a loopback "network" of listeners on the receiver ports. The app side is
// modelled on contract C1 and computes its proof with Node's own crypto, so the
// extension's WebCrypto code is checked against an independent implementation.
const nodeCrypto = require('node:crypto');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeStorage(initial = {}, { delayMs = 0 } = {}) {
  const data = clone(initial);
  const listeners = [];
  const pick = (keys) => {
    if (keys == null) return clone(data);
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) { for (const k of keys) if (k in data) out[k] = clone(data[k]); return out; }
    for (const [k, def] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : clone(def);
    return out;
  };
  return {
    data,
    listeners,
    async get(keys, cb) {
      if (delayMs) await sleep(delayMs);
      const out = pick(keys);
      if (cb) cb(out);
      return out;
    },
    async set(obj, cb) {
      if (delayMs) await sleep(delayMs);
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(data[k]), newValue: clone(v) }; data[k] = clone(v); }
      for (const fn of listeners) fn(changes, 'local');
      if (cb) cb();
    },
  };
}

function makeCookieJar(list, { throwFor } = {}) {
  const queries = [];
  return {
    queries,
    async getAll({ domain }) {
      queries.push(domain);
      if (domain === throwFor) throw new Error('boom');
      // Chrome: "cookies whose domains match or are subdomains of this one".
      // Like Chrome, a host-only cookie's domain has no leading dot.
      return list
        .filter(c => { const d = c.domain.replace(/^\./, ''); return d === domain || d.endsWith('.' + domain); })
        .map(c => ({ path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2e9, value: 'v', hostOnly: !c.domain.startsWith('.'), session: false, storeId: '0', ...c }));
    },
  };
}

const YT_COOKIES = [
  { name: 'PREF', domain: '.youtube.com' },
  { name: 'VISITOR_INFO1_LIVE', domain: 'm.youtube.com' },
  { name: '__Secure-1PSID', domain: '.google.com' },
  { name: 'SAPISID', domain: '.google.com' },
  { name: 'SAPISID', domain: '.google.com' }, // same name/domain/path: sent once
  { name: 'LSID', domain: 'accounts.google.com' },
  { name: '__Host-GAPS', domain: 'accounts.google.com' },
  { name: 'ACCOUNT_CHOOSER', domain: '.accounts.google.com' },
  { name: 'GMAIL_AT', domain: 'mail.google.com' },
  { name: 'OSID', domain: '.mail.google.com' },
  { name: 'WRITELY_SID', domain: 'docs.google.com' },
  { name: 'OSID', domain: 'myaccount.google.com' },
  { name: 'NID', domain: 'www.google.com' },
  { name: 'auth-token', domain: '.twitch.tv' },
  { name: 'login', domain: '.twitch.tv' },
];

// C1: the app signs the port it is bound to along with the nonce.
function proofFor(code, port, nonce) {
  return nodeCrypto.createHmac('sha256', code).update(`stream-lurker-ping:${port}:${nonce}`).digest('hex');
}

// The app's two 409 SIGNED_OUT texts (main/cookie-receiver.js), kept apart
// from the app's module so these fakes never depend on it.
const SIGNED_OUT_TEXT = 'You signed this platform out in Stream Lurker, so automatic re-sync is off for it. Connect it again from the extension to turn it back on.';
const APP_LOGIN_TEXT = "You connected this platform inside Stream Lurker, so automatic re-sync is off for it: it would replace that session with this browser's. Connect it again from the extension to turn it back on.";

// Never settles on its own; rejects like fetch once the caller aborts.
function untilAborted(signal) {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => clone(body) };
}

// ports: { [port]: { kind, ...options } }
//   app       real Stream Lurker with `code`; options signedOut[], signedOutError,
//             failImport{}, dropImport[], stallImport[] (never answers),
//             stallImportBody[] (headers, then no body), beforeImportReply()
//   outdated  answers /ping with no proof and its version (an app from before
//             proofs: every one sent its version)
//   unsigned-app  a current app still holding a code under 32 characters:
//             /ping answers { app } alone, no proof and no version, exactly as
//             main/cookie-receiver.js pingBody does
//   forged    answers /ping with a fixed `proof`
//   relay     a squatter that forwards /ping to the app on port `to` and hands
//             back its reply unchanged, genuine proof included
//   other-json, hang
function makeLoopback(ports) {
  const requests = [];
  const imports = [];
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const port = Number(u.port);
    const headers = { ...(init.headers || {}) };
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ port, url, method: init.method || 'GET', headers, body });
    const l = ports[port];
    if (!l) throw new TypeError('Failed to fetch');
    if (l.kind === 'hang') return untilAborted(init.signal);
    if (u.pathname === '/ping' && (init.method || 'GET') === 'GET') {
      const nonce = u.searchParams.get('nonce') || '';
      if (l.kind === 'other-json') return reply(200, { app: 'something-else' });
      if (l.kind === 'outdated') return reply(200, { app: 'stream-lurker', version: '0.14.0-beta' });
      if (l.kind === 'unsigned-app') return reply(200, { app: 'stream-lurker' });
      if (l.kind === 'forged') return reply(200, { app: 'stream-lurker', proof: l.proof });
      if (l.kind === 'relay') return fetch(`http://127.0.0.1:${l.to}${u.pathname}${u.search}`, { method: 'GET', signal: init.signal });
      return reply(200, /^[0-9a-f]{16,64}$/i.test(nonce) ? { app: 'stream-lurker', proof: proofFor(l.code, port, nonce) } : { app: 'stream-lurker' });
    }
    if (u.pathname === '/import' && init.method === 'POST') {
      imports.push({ port, headers, body });
      if (l.kind !== 'app') return reply(200, { success: true, cookiesSet: 1 });
      if (headers['Content-Type'] !== 'application/json') return reply(415, { success: false, error: 'json only' });
      if (headers['X-Pairing-Code'] !== l.code) return reply(403, { success: false, error: 'Invalid pairing code. Copy the code shown in Stream Lurker into the extension.' });
      if ((l.dropImport || []).includes(body.platform)) throw new TypeError('Failed to fetch');
      if ((l.stallImport || []).includes(body.platform)) return untilAborted(init.signal);
      if ((l.stallImportBody || []).includes(body.platform)) return { ok: true, status: 200, json: () => untilAborted(init.signal) };
      if (l.beforeImportReply) await l.beforeImportReply(body);
      const fail = (l.failImport || {})[body.platform];
      if (fail) return reply(fail, { success: false, error: 'Too many attempts' });
      l.signedOut = l.signedOut || [];
      if (l.signedOut.includes(body.platform)) {
        if (body.auto === true) return reply(409, { success: false, code: 'SIGNED_OUT', error: l.signedOutError || SIGNED_OUT_TEXT });
        l.signedOut = l.signedOut.filter(p => p !== body.platform); // a manual connect lifts it
      }
      return reply(200, body.auto ? { success: true, cookiesSet: body.cookies.length } : { success: true, cookiesSet: body.cookies.length, username: 'someone' });
    }
    return reply(404, {});
  }
  return { fetch, requests, imports, ports };
}

module.exports = { makeStorage, makeCookieJar, makeLoopback, proofFor, YT_COOKIES, SIGNED_OUT_TEXT, APP_LOGIN_TEXT, sleep };
