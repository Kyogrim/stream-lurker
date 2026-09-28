// Shared by the background worker (importScripts), the popup (<script>) and the
// Node tests (require). Anything that touches chrome.*, fetch or crypto comes in
// as an argument, so the tests drive this exact code with fakes.
(function (global) {
  'use strict';

  const PORTS = [47100, 47101, 47102, 47103, 47104];
  const PLATFORMS = ['twitch', 'youtube', 'kick'];
  const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
  // cookies.getAll({ domain }) also returns every subdomain, so these are only
  // the queries; isAllowedCookieDomain decides what actually leaves the browser.
  const QUERY_DOMAINS = { twitch: ['twitch.tv'], youtube: ['youtube.com', 'google.com'], kick: ['kick.com'] };
  const PING_TIMEOUT_MS = 2500;
  const PROOF_PREFIX = 'stream-lurker-ping:';
  const LOCK_NAME = 'stream-lurker-sync-state';

  function normalizeCode(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function isAllowedCookieDomain(platform, domain) {
    const d = String(domain || '').trim().toLowerCase().replace(/^\./, '');
    if (!d) return false;
    const within = (base) => d === base || d.endsWith('.' + base);
    if (platform === 'twitch') return within('twitch.tv');
    if (platform === 'kick') return within('kick.com');
    // The root .google.com cookies (SID, __Secure-1PSID, ...) are what signs
    // YouTube in; Gmail, Docs and the rest of *.google.com are never needed.
    if (platform === 'youtube') return within('youtube.com') || d === 'google.com' || d === 'accounts.google.com';
    return false;
  }

  async function collectCookies(platform, cookiesApi) {
    const seen = new Set();
    const out = [];
    for (const domain of QUERY_DOMAINS[platform] || []) {
      let cookies = [];
      try { cookies = await cookiesApi.getAll({ domain }); } catch (e) { continue; }
      for (const c of cookies || []) {
        if (!c || !isAllowedCookieDomain(platform, c.domain)) continue;
        const key = `${c.name}|${c.domain}|${c.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          expirationDate: c.expirationDate,
        });
      }
    }
    return out;
  }

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
  }

  function makeNonce(cryptoObj) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return toHex(bytes);
  }

  async function hmacSha256Hex(subtle, key, message) {
    const enc = new TextEncoder();
    const k = await subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toHex(await subtle.sign('HMAC', k, enc.encode(message)));
  }

  function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function verifyPingProof(cryptoObj, code, nonce, proof) {
    const key = normalizeCode(code);
    if (!key || typeof proof !== 'string' || !/^[0-9a-f]{64}$/i.test(proof)) return false;
    const expected = await hmacSha256Hex(cryptoObj.subtle, key, PROOF_PREFIX + nonce);
    return constantTimeEqual(expected, proof.toLowerCase());
  }

  // The abort also covers reading the body, so a listener that sends headers
  // and then stalls cannot hang the port walk either.
  async function getJson(fetchFn, url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchFn(url, { method: 'GET', signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Walks every port and returns the first listener that proves it holds our
  // pairing code. Claiming to be Stream Lurker proves nothing: any local
  // process, or another Windows user's copy of the app, can answer /ping. So an
  // unproven listener gets a fresh random nonce and nothing else, and the walk
  // moves on to the next port.
  //   verified  - proof checked out; safe to send the code and cookies to port
  //   no-code   - the app is there, but we have no code to check its proof with
  //   mismatch  - listeners answered with a proof our code does not match
  //   outdated  - only listeners too old to prove anything
  //   not-found - nothing answered as Stream Lurker
  async function findApp({ fetch: fetchFn, crypto: cryptoObj, code, ports = PORTS, timeoutMs = PING_TIMEOUT_MS }) {
    const key = normalizeCode(code);
    let sawProof = false;
    let sawOutdated = false;
    for (const port of ports) {
      const nonce = makeNonce(cryptoObj);
      let j;
      try { j = await getJson(fetchFn, `http://127.0.0.1:${port}/ping?nonce=${nonce}`, timeoutMs); } catch (e) { continue; }
      if (!j || typeof j !== 'object' || j.app !== 'stream-lurker') continue;
      if (!('proof' in j)) { sawOutdated = true; continue; }
      sawProof = true;
      if (key && await verifyPingProof(cryptoObj, key, nonce, j.proof)) return { status: 'verified', port };
    }
    if (sawProof) return { status: key ? 'mismatch' : 'no-code', port: null };
    return { status: sawOutdated ? 'outdated' : 'not-found', port: null };
  }

  // Only ever called with a port findApp just verified. The code rides in a
  // header so the app can reject a bad one before reading the body.
  async function postImport({ fetch: fetchFn, port, code, platform, cookies, auto }) {
    const body = { platform, cookies };
    if (auto) body.auto = true;
    const r = await fetchFn(`http://127.0.0.1:${port}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': normalizeCode(code) },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = (await r.json()) || {}; } catch (e) { /* non-JSON error page */ }
    return {
      httpStatus: r.status,
      success: j.success === true,
      code: typeof j.code === 'string' ? j.code : '',
      error: typeof j.error === 'string' ? j.error : '',
      cookiesSet: Number.isFinite(j.cookiesSet) ? j.cookiesSet : null,
      username: typeof j.username === 'string' ? j.username : '',
    };
  }

  // The popup and the worker both edit connectedPlatforms / lastResyncResults.
  // Web Locks are shared across every page of the extension origin, so the
  // read-modify-write below cannot interleave between the two.
  function withLock(fn) {
    const locks = typeof navigator !== 'undefined' && navigator && navigator.locks;
    return locks && typeof locks.request === 'function' ? locks.request(LOCK_NAME, fn) : fn();
  }

  // connected: true/false to add/remove, undefined to leave alone.
  // result: an entry to store, null to forget it, undefined to leave alone.
  // onlyIfConnected: drop the result if the user stopped this platform while a
  // resync was in flight, so it does not reappear in the popup.
  function updatePlatform(storage, platform, { connected, result, onlyIfConnected = false } = {}) {
    return withLock(async () => {
      const d = await storage.get({ connectedPlatforms: [], lastResyncResults: {} });
      const set = new Set(Array.isArray(d.connectedPlatforms) ? d.connectedPlatforms : []);
      const results = { ...(d.lastResyncResults && typeof d.lastResyncResults === 'object' ? d.lastResyncResults : {}) };
      if (onlyIfConnected && !set.has(platform)) return;
      if (connected === true) set.add(platform);
      if (connected === false) set.delete(platform);
      if (result === null) delete results[platform];
      else if (result !== undefined) results[platform] = result;
      await storage.set({ connectedPlatforms: [...set], lastResyncResults: results });
    });
  }

  const SKIP_STATUS = { 'no-code': 'not-paired', mismatch: 'code-mismatch', outdated: 'app-outdated', 'not-found': 'app-not-running' };

  // One background pass. Every outcome, including the early skips, is written
  // to storage so the popup never shows a days-old "ok" as if it were current.
  async function runResync({ storage, cookies, fetch: fetchFn, crypto: cryptoObj, now = Date.now, findOptions = {} }) {
    const d = await storage.get({ pairingCode: '', connectedPlatforms: [] });
    const platforms = PLATFORMS.filter(p => Array.isArray(d.connectedPlatforms) && d.connectedPlatforms.includes(p));
    const code = normalizeCode(d.pairingCode);
    const finish = async (status, results) => {
      await storage.set({ lastResync: now(), lastResyncStatus: status });
      return results ? { status, results } : { status };
    };
    if (!platforms.length) return finish('idle');
    if (!code) return finish('not-paired');

    const app = await findApp({ ...findOptions, fetch: fetchFn, crypto: cryptoObj, code });
    if (app.status !== 'verified') return finish(SKIP_STATUS[app.status] || 'app-not-running');

    const results = {};
    for (const platform of platforms) {
      let entry;
      try {
        const list = await collectCookies(platform, cookies);
        // No cookies means signed out in the browser too. Pushing an empty set
        // would only overwrite a possibly-working session with nothing.
        if (!list.length) {
          entry = { kind: 'no-cookies' };
        } else {
          const r = await postImport({ fetch: fetchFn, port: app.port, code, platform, cookies: list, auto: true });
          if (r.code === 'SIGNED_OUT') entry = { kind: 'signed-out' };
          else if (r.success) entry = { kind: 'ok', cookiesSet: r.cookiesSet };
          else entry = { kind: 'error', httpStatus: r.httpStatus, message: r.error || `HTTP ${r.httpStatus}` };
        }
      } catch (e) {
        entry = { kind: 'error', message: 'Could not reach Stream Lurker: ' + (e && e.message ? e.message : e) };
      }
      entry.at = now();
      results[platform] = entry;
      // The user signed this platform out inside the app. Stop re-pushing it
      // until they connect it again by hand from the popup.
      if (entry.kind === 'signed-out') await updatePlatform(storage, platform, { connected: false, result: entry });
      else await updatePlatform(storage, platform, { result: entry, onlyIfConnected: true });
    }
    return finish('done', results);
  }

  function relativeTime(at, now) {
    if (!Number.isFinite(at)) return '';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    const days = Math.round(h / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // tone: ok | err | idle
  function describeConnection(app) {
    switch (app && app.status) {
      case 'verified': return { tone: 'ok', text: `Connected to Stream Lurker (port ${app.port})` };
      case 'no-code': return { tone: 'idle', text: 'Stream Lurker found. Enter the pairing code shown in the app.' };
      case 'mismatch': return { tone: 'err', text: "That pairing code doesn't match Stream Lurker. Copy the current one from Platform Logins in the app." };
      case 'outdated': return { tone: 'err', text: 'The Stream Lurker app needs updating to work with this extension. Update it, then reopen this popup.' };
      default: return { tone: 'err', text: 'Stream Lurker not found. Is the app running?' };
    }
  }

  // Version 1.2.0 stored results as strings like "ok (34 cookies)".
  function normalizeResult(raw, fallbackAt) {
    if (typeof raw === 'string') {
      return /^ok\b/.test(raw) ? { kind: 'ok', text: raw, at: fallbackAt } : { kind: 'error', message: raw, at: fallbackAt };
    }
    return raw && typeof raw === 'object' ? raw : null;
  }

  function describeRow(platform, raw, now, fallbackAt) {
    const name = PLATFORM_NAMES[platform] || platform;
    const r = normalizeResult(raw, fallbackAt);
    const when = r ? relativeTime(r.at, now) : '';
    const suffix = when ? ` (${when})` : '';
    if (!r) return { tone: 'idle', text: 'Auto-sync on. First sync within 30 min.' };
    switch (r.kind) {
      case 'ok':
        if (r.text) return { tone: 'ok', text: `Last sync ${r.text}${suffix}` };
        return { tone: 'ok', text: `Synced ${when || 'recently'}${Number.isFinite(r.cookiesSet) ? ` · ${r.cookiesSet} cookies` : ''}` };
      case 'no-cookies':
        return { tone: 'idle', text: `Skipped${suffix}: not signed in to ${name} in this browser.` };
      case 'signed-out':
        return { tone: 'idle', text: `Signed out in Stream Lurker, so auto-sync stopped. Click Connect ${name} to resume.` };
      default:
        if (r.httpStatus === 403) return { tone: 'err', text: `Pairing code rejected${suffix}. Paste the current code from the app.` };
        if (r.httpStatus === 429) return { tone: 'err', text: `The app is refusing imports after too many wrong codes${suffix}. Check the code, then try again in a minute.` };
        return { tone: 'err', text: `${r.message || 'Sync failed'}${suffix}` };
    }
  }

  // Everything the popup's auto-sync panel shows, from the stored state alone.
  function describeSync(state, now) {
    const connected = Array.isArray(state.connectedPlatforms) ? state.connectedPlatforms : [];
    const results = state.lastResyncResults && typeof state.lastResyncResults === 'object' ? state.lastResyncResults : {};
    const rows = [];
    for (const platform of PLATFORMS) {
      const isConnected = connected.includes(platform);
      const r = normalizeResult(results[platform], state.lastResync);
      if (!isConnected && !(r && r.kind === 'signed-out')) continue;
      rows.push({ platform, name: PLATFORM_NAMES[platform], connected: isConnected, ...describeRow(platform, results[platform], now, state.lastResync) });
    }

    const when = relativeTime(state.lastResync, now);
    let summary;
    if (!connected.length) {
      summary = { tone: 'idle', text: 'Connect a platform above and it stays fresh, re-synced every 30 min.' };
    } else if (!when) {
      summary = { tone: 'idle', text: 'Auto-sync runs every 30 min.' };
    } else {
      switch (state.lastResyncStatus) {
        // Normal whenever the app is closed; nothing for the user to fix.
        case 'app-not-running': summary = { tone: 'idle', text: `Checked ${when}: Stream Lurker wasn't running. It syncs once the app is open.` }; break;
        case 'code-mismatch': summary = { tone: 'err', text: `Checked ${when}: the pairing code doesn't match the app. Paste the current code from Stream Lurker.` }; break;
        case 'app-outdated': summary = { tone: 'err', text: `Checked ${when}: the Stream Lurker app needs updating before it can sync.` }; break;
        case 'not-paired': summary = { tone: 'err', text: 'No pairing code saved, so auto-sync is paused.' }; break;
        default: summary = { tone: 'idle', text: `Last auto-sync ${when}.` };
      }
    }
    return { summary, rows };
  }

  const api = {
    PORTS, PLATFORMS, PLATFORM_NAMES, QUERY_DOMAINS, PROOF_PREFIX,
    normalizeCode, isAllowedCookieDomain, collectCookies,
    makeNonce, hmacSha256Hex, constantTimeEqual, verifyPingProof,
    findApp, postImport, updatePlatform, runResync,
    relativeTime, describeConnection, describeSync,
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else global.SLConnector = api;
})(typeof self !== 'undefined' ? self : globalThis);
