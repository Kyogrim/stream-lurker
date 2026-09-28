// Shared by the background worker (importScripts), the popup (<script>) and the
// Node tests (require). Anything that touches chrome.*, fetch or crypto comes in
// as an argument, so the tests drive this exact code with fakes.
(function (global) {
  'use strict';

  // 47100-47104 stay first and in this order: Chrome never reloads an unpacked
  // extension when the app updates, so older copies only ever try those. The
  // rest sit thousands apart because Hyper-V, WSL and Docker reserve ports in
  // runs of 100-port blocks that can cover all five first ones at once (G2.4).
  // The app's RECEIVER_PORTS (main.js) must only use ports from this list;
  // test/extension-contract.test.js checks it.
  const PORTS = [47100, 47101, 47102, 47103, 47104, 43100, 39100, 35100, 31100];
  const PLATFORMS = ['twitch', 'youtube', 'kick'];
  const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
  // cookies.getAll({ domain }) also returns every subdomain, so these are only
  // the queries; isAllowedCookieDomain decides what actually leaves the browser.
  const QUERY_DOMAINS = { twitch: ['twitch.tv'], youtube: ['youtube.com', 'google.com'], kick: ['kick.com'] };
  const PING_TIMEOUT_MS = 2500;
  // Chrome terminates a service worker whose fetch() response takes more than
  // 30 s, and a worker killed mid-pass records nothing at all. So the worker's
  // imports give up first and say so. A click from the popup (no such limit)
  // may wait out the app's slowest path: a YouTube import loads a hidden page
  // for the account name, bounded at 45 s on the app side.
  const AUTO_IMPORT_TIMEOUT_MS = 25000;
  const MANUAL_IMPORT_TIMEOUT_MS = 120000;
  const IMPORT_TIMEOUT_MESSAGE = 'Stream Lurker did not answer the import in time';
  const PROOF_PREFIX = 'stream-lurker-ping:';
  // Codes made before 32-character ones are 8 hex characters: 32 bits, which
  // any local process can brute-force offline from a single /ping proof, and
  // which version 1.2 of this extension sent to whatever answered /ping. A
  // listener proving such a code proves nothing, so none is checked against.
  const MIN_CODE_LENGTH = 32;
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
        const cookie = {
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          expirationDate: c.expirationDate,
        };
        // Tells the app to write a host-only cookie without a Domain attribute
        // (F39). Left out, never guessed, when the browser gives no boolean:
        // a wrong false would widen the cookie, while a missing one makes the
        // app fall back to its leading-dot rule.
        if (typeof c.hostOnly === 'boolean') cookie.hostOnly = c.hostOnly;
        out.push(cookie);
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

  // The port is the one the extension dialed, and the app signs the port it
  // is bound to (contract C1). Without it, a squatter on one port could pass
  // our nonce to the real app on another and hand back the app's genuine
  // proof; with it, that proof names the app's port and fails for its own.
  function proofMessage(port, nonce) {
    return `${PROOF_PREFIX}${port}:${nonce}`;
  }

  async function verifyPingProof(cryptoObj, code, port, nonce, proof) {
    const key = normalizeCode(code);
    if (key.length < MIN_CODE_LENGTH || typeof proof !== 'string' || !/^[0-9a-f]{64}$/i.test(proof)) return false;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const expected = await hmacSha256Hex(cryptoObj.subtle, key, proofMessage(port, nonce));
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
  //   verified   - proof checked out; safe to send the code and cookies to port
  //   no-code    - the app is there, but we have no code to check its proof with
  //   short-code - our code is too short to prove anything; nothing is pinged
  //   mismatch   - listeners answered with a proof our code does not match
  //   outdated   - only listeners too old to prove anything
  //   not-found  - nothing answered as Stream Lurker
  async function findApp({ fetch: fetchFn, crypto: cryptoObj, code, ports = PORTS, timeoutMs = PING_TIMEOUT_MS }) {
    const key = normalizeCode(code);
    if (key && key.length < MIN_CODE_LENGTH) return { status: 'short-code', port: null };
    let sawProof = false;
    let sawOutdated = false;
    for (const port of ports) {
      const nonce = makeNonce(cryptoObj);
      let j;
      try { j = await getJson(fetchFn, `http://127.0.0.1:${port}/ping?nonce=${nonce}`, timeoutMs); } catch (e) { continue; }
      if (!j || typeof j !== 'object' || j.app !== 'stream-lurker') continue;
      if (!('proof' in j)) { sawOutdated = true; continue; }
      sawProof = true;
      if (key && await verifyPingProof(cryptoObj, key, port, nonce, j.proof)) return { status: 'verified', port };
    }
    if (sawProof) return { status: key ? 'mismatch' : 'no-code', port: null };
    return { status: sawOutdated ? 'outdated' : 'not-found', port: null };
  }

  // Only ever called with a port findApp just verified. The code rides in a
  // header so the app can reject a bad one before reading the body. The app
  // bounds how long it takes to receive a request, not how long an importer
  // runs, so the wait is bounded here; like getJson, the abort also covers
  // the body. A timeout throws an error with code 'IMPORT_TIMEOUT'.
  async function postImport({ fetch: fetchFn, port, code, platform, cookies, auto, timeoutMs }) {
    const body = { platform, cookies };
    if (auto) body.auto = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || (auto ? AUTO_IMPORT_TIMEOUT_MS : MANUAL_IMPORT_TIMEOUT_MS));
    let r;
    let j = {};
    try {
      r = await fetchFn(`http://127.0.0.1:${port}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': normalizeCode(code) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      try { j = (await r.json()) || {}; } catch (e) { if (ctrl.signal.aborted) throw e; /* non-JSON error page */ }
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
      const err = new Error(IMPORT_TIMEOUT_MESSAGE);
      err.code = 'IMPORT_TIMEOUT';
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return {
      httpStatus: r.status,
      success: j.success === true,
      code: typeof j.code === 'string' ? j.code : '',
      error: typeof j.error === 'string' ? j.error : '',
      cookiesSet: Number.isFinite(j.cookiesSet) ? j.cookiesSet : null,
      username: typeof j.username === 'string' ? j.username : '',
    };
  }

  // What the user reads when an import throws: a timeout says so, anything
  // else is the network failing to reach the app.
  function importFailureText(e) {
    if (e && e.code === 'IMPORT_TIMEOUT') return IMPORT_TIMEOUT_MESSAGE;
    return 'Could not reach Stream Lurker: ' + (e && e.message ? e.message : e);
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
  // unlessResultAfter: a time; change nothing if the stored result for this
  // platform is newer, i.e. a manual Connect landed while a resync ran.
  function updatePlatform(storage, platform, { connected, result, onlyIfConnected = false, unlessResultAfter } = {}) {
    return withLock(async () => {
      const d = await storage.get({ connectedPlatforms: [], lastResyncResults: {} });
      const set = new Set(Array.isArray(d.connectedPlatforms) ? d.connectedPlatforms : []);
      const results = { ...(d.lastResyncResults && typeof d.lastResyncResults === 'object' ? d.lastResyncResults : {}) };
      if (onlyIfConnected && !set.has(platform)) return;
      const prev = results[platform];
      if (Number.isFinite(unlessResultAfter) && prev && typeof prev === 'object' && Number.isFinite(prev.at) && prev.at > unlessResultAfter) return;
      if (connected === true) set.add(platform);
      if (connected === false) set.delete(platform);
      if (result === null) delete results[platform];
      else if (result !== undefined) results[platform] = result;
      await storage.set({ connectedPlatforms: [...set], lastResyncResults: results });
    });
  }

  const SKIP_STATUS = { 'no-code': 'not-paired', 'short-code': 'code-too-short', mismatch: 'code-mismatch', outdated: 'app-outdated', 'not-found': 'app-not-running' };

  // One background pass. Every outcome, including the early skips, is written
  // to storage so the popup never shows a days-old "ok" as if it were current.
  async function runResync({ storage, cookies, fetch: fetchFn, crypto: cryptoObj, now = Date.now, findOptions = {}, importTimeoutMs }) {
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
      const sentAt = now();
      try {
        const list = await collectCookies(platform, cookies);
        // No cookies means signed out in the browser too. Pushing an empty set
        // would only overwrite a possibly-working session with nothing.
        if (!list.length) {
          entry = { kind: 'no-cookies' };
        } else {
          const r = await postImport({ fetch: fetchFn, port: app.port, code, platform, cookies: list, auto: true, timeoutMs: importTimeoutMs });
          // The app says why (signed out there, or connected inside it); only
          // a listener that proved our code gets here, and the popup renders
          // it as text.
          if (r.code === 'SIGNED_OUT') entry = { kind: 'signed-out', message: r.error.slice(0, 300) };
          else if (r.success) entry = { kind: 'ok', cookiesSet: r.cookiesSet };
          else entry = { kind: 'error', httpStatus: r.httpStatus, message: r.error || `HTTP ${r.httpStatus}` };
        }
      } catch (e) {
        entry = { kind: 'error', message: importFailureText(e) };
      }
      entry.at = now();
      results[platform] = entry;
      // The user signed this platform out inside the app. Stop re-pushing it
      // until they connect it again by hand from the popup. A manual Connect
      // that finished after this import went out lifted the app's refusal, so
      // it wins over this answer.
      if (entry.kind === 'signed-out') await updatePlatform(storage, platform, { connected: false, result: entry, unlessResultAfter: sentAt });
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
      case 'short-code': return { tone: 'err', text: 'That pairing code is too short. Copy the current one from Platform Logins in the app; if it shows only 8 characters, click New code there first.' };
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
      // The app's own reason: signed out there, or connected inside it,
      // where a re-sync would replace that session with this browser's.
      case 'signed-out':
        if (typeof r.message === 'string' && r.message.trim()) return { tone: 'idle', text: r.message };
        return { tone: 'idle', text: `Stream Lurker turned auto-sync off for ${name} (signed out or connected in the app). Click Connect ${name} to turn it back on.` };
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
        case 'code-too-short': summary = { tone: 'err', text: 'The saved pairing code is too short, so auto-sync is paused. Paste the current code from Stream Lurker.' }; break;
        default: summary = { tone: 'idle', text: `Last auto-sync ${when}.` };
      }
    }
    return { summary, rows };
  }

  const api = {
    PORTS, PLATFORMS, PLATFORM_NAMES, QUERY_DOMAINS, PROOF_PREFIX, MIN_CODE_LENGTH,
    AUTO_IMPORT_TIMEOUT_MS, MANUAL_IMPORT_TIMEOUT_MS, IMPORT_TIMEOUT_MESSAGE,
    normalizeCode, isAllowedCookieDomain, collectCookies,
    makeNonce, hmacSha256Hex, constantTimeEqual, verifyPingProof,
    findApp, postImport, importFailureText, updatePlatform, runResync,
    relativeTime, describeConnection, describeSync,
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else global.SLConnector = api;
})(typeof self !== 'undefined' ? self : globalThis);
