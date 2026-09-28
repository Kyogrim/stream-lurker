// The local receiver the companion browser extension talks to (contract C1).
// It listens on 127.0.0.1 only, but that is not a boundary on its own: every
// web page in the user's browser, and every page in the app's own webviews,
// can send requests to it. So each request is checked here, before any byte
// of its body is read:
//
//   Host     127.0.0.1:<port> or localhost:<port> only (DNS rebinding)
//   Origin   absent, or a browser extension's (web pages always send one)
//   /import  POST, application/json, pairing code in X-Pairing-Code
//            (older extensions: body.pairingCode, body capped at 2 MB),
//            compared in constant time, 5 wrong in a row locks it for 60 s
//
// There is no Access-Control-Allow-Origin at all: the extension's
// host_permissions for http://127.0.0.1/* exempt it from CORS, and nothing
// else has any business reading these answers. /ping proves the app holds
// the extension's pairing code (an HMAC over a nonce the extension picks)
// without revealing it, so the extension never sends cookies to some other
// local process squatting on the port. The proof also names the port the app
// is bound to: otherwise a squatter on one port could forward the nonce to the
// real app on another and replay the app's genuine answer. A code too short
// to survive an offline guess (MIN_PROOF_CODE_LENGTH) gets no proof at all.
// Tested end to end over real sockets in test/main-cookie-receiver.test.js.

const crypto = require('crypto');
const http = require('http');

const MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024;
const LOCKOUT_AFTER_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;
const PING_PROOF_PREFIX = 'stream-lurker-ping:';
const NONCE = /^[0-9a-f]{16,64}$/i;
const IMPORT_PLATFORMS = ['twitch', 'youtube', 'kick'];
// No proof is signed with a shorter code. An 8-character code (every install
// from before 32-character codes, kept for connector 1.2) is 32 bits: one
// proof lets whoever can reach /ping (another Windows user's process on the
// shared loopback, another extension's service worker) recover it offline in
// hours, bypassing the lockout, and then import over the app's sessions. No
// client uses such a proof: 1.2 predates proofs, and 1.3 refuses these codes
// before it pings. Mirrors extension/connector.js MIN_CODE_LENGTH.
const MIN_PROOF_CODE_LENGTH = 32;
// Connector 1.2's code field has maxlength="16", so it cuts a 32-character
// code to this. Only 1.2 and older send the code in the body alone.
const LEGACY_CODE_FIELD_LENGTH = 16;
const TRUNCATED_CODE_ERROR = 'This copy of the extension is out of date and cut the pairing code to 16 characters. Reload Stream Lurker Connector on your browser\'s Extensions page, then paste the code again.';

// Message: "stream-lurker-ping:<port>:<nonce>", keyed by the upper-case code.
// extension/connector.js proofMessage() must build the identical string.
function pingProof(code, port, nonce) {
  return crypto.createHmac('sha256', String(code).toUpperCase()).update(`${PING_PROOF_PREFIX}${port}:${nonce}`).digest('hex');
}

// { app } plus, for a well-formed nonce and a code long enough to sign with
// (MIN_PROOF_CODE_LENGTH), the proof. No version: the extension needs
// neither, and a page probing the port learns nothing it can use.
function pingBody(query, code, port) {
  const body = { app: 'stream-lurker' };
  const nonce = query && typeof query.get === 'function' ? query.get('nonce') : null;
  const signable = typeof code === 'string' && code.trim().length >= MIN_PROOF_CODE_LENGTH;
  if (nonce && NONCE.test(nonce) && signable && port) body.proof = pingProof(code, port, nonce);
  return body;
}

function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !port) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// Browsers attach Origin to every cross-origin POST, and a page cannot forge
// it. An extension's own requests carry its chrome-extension:// or
// moz-extension:// origin, or none at all.
function isAllowedOrigin(origin) {
  if (origin === undefined) return true;
  const o = String(origin);
  return o.startsWith('chrome-extension://') || o.startsWith('moz-extension://');
}

// A text/plain POST needs no CORS preflight, so it is exactly what a page
// would use; a JSON content type is refused to it without a preflight.
function isJsonContentType(value) {
  return typeof value === 'string' && value.split(';')[0].trim().toLowerCase() === 'application/json';
}

// Hashing both sides first makes the comparison length-independent:
// timingSafeEqual throws on different lengths, which would leak the length.
function codesMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given.trim().toUpperCase()).digest();
  const b = crypto.createHash('sha256').update(expected.toUpperCase()).digest();
  return crypto.timingSafeEqual(a, b);
}

// For the log: enough to tell an old code from a new one, never the code.
function maskCode(code) {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) return 'no code';
  return `${c.slice(0, 2)}… (${c.length} characters)`;
}

// Consecutive wrong codes. Only callers that got past the Host and Origin
// checks are counted, so a web page cannot lock the real extension out.
function createPairingGuard({ maxFailures = LOCKOUT_AFTER_FAILURES, lockMs = LOCKOUT_MS, now = Date.now } = {}) {
  let failures = 0;
  let lockedUntil = 0;
  return {
    lockedForMs() {
      const left = lockedUntil - now();
      return left > 0 ? left : 0;
    },
    // Returns { failures, lockedNow }.
    fail() {
      failures++;
      if (failures < maxFailures) return { failures, lockedNow: false };
      const count = failures;
      failures = 0;
      lockedUntil = now() + lockMs;
      return { failures: count, lockedNow: true };
    },
    succeed() { failures = 0; },
    reset() { failures = 0; lockedUntil = 0; },
  };
}

// Reads a request body into memory, refusing past maxBytes: by the declared
// Content-Length before reading anything, or by the bytes actually received.
// Resolves { text } | { tooLarge: true } | { aborted: true }. Chunks are joined
// as bytes, so a UTF-8 character split across two chunks survives.
function readBodyCapped(req, maxBytes = MAX_IMPORT_BODY_BYTES) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { resolve({ tooLarge: true }); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) { chunks.length = 0; finish({ tooLarge: true }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ aborted: true }));
    req.on('close', () => finish({ aborted: true }));
  });
}

const SIGNED_OUT_ERROR = 'You signed this platform out in Stream Lurker, so automatic re-sync is off for it. Connect it again from the extension to turn it back on.';
const APP_LOGIN_ERROR = 'You connected this platform inside Stream Lurker, so automatic re-sync is off for it: it would replace that session with this browser\'s. Connect it again from the extension to turn it back on.';

// The 409 text for a platform whose auto re-sync is off, by why it is off
// (config-boundary.js signedOutReasonIn), or null when it is on.
function autoSyncRefusalFor(reason) {
  if (reason === 'app-login') return APP_LOGIN_ERROR;
  return reason ? SIGNED_OUT_ERROR : null;
}

// The request handler. deps:
//   getPort()               the port actually bound
//   getPairingCode()        the current code (upper-case)
//   guard                   createPairingGuard()
//   importers               { twitch, youtube, kick }: (cookies, { auto }) => result;
//                           a result with code 'SIGNED_OUT' (the user signed out
//                           while it ran) is answered like a refusal up front
//   isSignedOut(platform)   auto re-sync is refused for it (C1 SIGNED_OUT); a
//                           string is the error to send, anything else truthy
//                           sends SIGNED_OUT_ERROR
//   onManualImport(platform, result)  after a manual import succeeded
//   onAutoAttempt({ platform, ok, error, status })  after every automatic
//                           re-sync that got past the pairing code, platform
//                           from the allowlist, error a fixed server-side text
//   onCodeRejected()        after an import with a wrong pairing code
//   log(text)
function createReceiverHandler(deps) {
  const { getPort, getPairingCode, guard, importers, log = () => {} } = deps;
  const isSignedOut = deps.isSignedOut || (() => false);
  const onManualImport = deps.onManualImport || (() => {});
  const onAutoAttempt = deps.onAutoAttempt || (() => {});
  const onCodeRejected = deps.onCodeRejected || (() => {});
  const maxBodyBytes = deps.maxBodyBytes || MAX_IMPORT_BODY_BYTES;
  const signedOutError = (refusal) => (typeof refusal === 'string' && refusal ? refusal : SIGNED_OUT_ERROR);

  return async function handleReceiverRequest(req, res) {
    const send = (status, obj, { close = false, headers = {} } = {}) => {
      if (res.headersSent) return;
      // A refusal is answered without reading what the client still sends;
      // closing the connection discards the rest instead of parsing it.
      if (close) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(obj));
    };
    try {
      if (!isAllowedHost(req.headers.host, getPort())) return send(403, { success: false, error: 'Forbidden' }, { close: true });
      if (!isAllowedOrigin(req.headers.origin)) return send(403, { success: false, error: 'Forbidden' }, { close: true });

      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(400, { success: false, error: 'Bad request' }, { close: true }); }

      if (url.pathname === '/ping') {
        if (req.method !== 'GET') return send(405, { success: false, error: 'Method not allowed' }, { close: true, headers: { Allow: 'GET' } });
        return send(200, pingBody(url.searchParams, getPairingCode(), getPort()));
      }
      if (url.pathname !== '/import') return send(404, { success: false, error: 'Not found' }, { close: true });
      if (req.method !== 'POST') return send(405, { success: false, error: 'Method not allowed' }, { close: true, headers: { Allow: 'POST' } });
      if (!isJsonContentType(req.headers['content-type'])) return send(415, { success: false, error: 'Expected application/json' }, { close: true });

      const locked = guard.lockedForMs();
      if (locked > 0) {
        return send(429, { success: false, error: 'Too many wrong pairing codes. Try again in a minute.' },
          { close: true, headers: { 'Retry-After': String(Math.ceil(locked / 1000)) } });
      }

      const expected = getPairingCode();
      // truncated: see the body-code check below. Counted and locked out
      // exactly like any other wrong code; only the words differ.
      const rejectCode = (given, { truncated = false } = {}) => {
        const r = guard.fail();
        try { onCodeRejected(); } catch (e) { /* bookkeeping must not change the answer */ }
        if (r.failures === 1) {
          log(truncated
            ? `[Ext] Refused an import from an out-of-date copy of the browser extension that cut the pairing code to ${LEGACY_CODE_FIELD_LENGTH} characters (${maskCode(given)}). Reload Stream Lurker Connector on the browser's Extensions page, then paste the code from Platform Logins into it again.`
            : `[Ext] Refused an import with the wrong pairing code (${maskCode(given)}). If that was your browser extension, paste the current code from Platform Logins into it.`);
        }
        if (r.lockedNow) log(`[Ext] ${r.failures} wrong pairing codes in a row; refusing imports for ${Math.round(LOCKOUT_MS / 1000)} s.`);
        const error = truncated ? TRUNCATED_CODE_ERROR : 'Invalid pairing code. Copy the code shown in Stream Lurker into the extension.';
        return send(403, { success: false, error }, { close: true });
      };

      // Checked before a single body byte is read.
      const headerCode = typeof req.headers['x-pairing-code'] === 'string' ? req.headers['x-pairing-code'] : '';
      if (headerCode && !codesMatch(headerCode, expected)) return rejectCode(headerCode);

      const body = await readBodyCapped(req, maxBodyBytes);
      if (body.tooLarge) return send(413, { success: false, error: 'Request too large' }, { close: true });
      if (body.aborted) return undefined;
      let payload;
      try { payload = JSON.parse(body.text || '{}'); } catch (e) { return send(400, { success: false, error: 'Invalid JSON' }, { close: true }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(400, { success: false, error: 'Invalid request' }, { close: true });

      // Extensions before 1.3.0 send the code in the body only.
      if (!headerCode) {
        const bodyCode = typeof payload.pairingCode === 'string' ? payload.pairingCode : '';
        if (!codesMatch(bodyCode, expected)) {
          // Connector 1.2 (no header) holding a longer code cut by its
          // 16-character field: the generic text would send the user back to
          // the same truncating paste, and it is all 1.2's popup shows.
          // Decided on header absence and lengths only, never on how much of
          // the code matches, which would be a partial-match oracle.
          const truncated = bodyCode.trim().length === LEGACY_CODE_FIELD_LENGTH
            && typeof expected === 'string' && expected.trim().length > LEGACY_CODE_FIELD_LENGTH;
          return rejectCode(bodyCode, { truncated });
        }
      }
      guard.succeed();

      const platform = String(payload.platform || '').toLowerCase();
      const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
      // The extension's periodic background re-sync, as opposed to a click.
      const auto = payload.auto === true;
      if (!IMPORT_PLATFORMS.includes(platform) || typeof importers[platform] !== 'function') {
        return send(200, { success: false, error: 'Unknown platform' });
      }
      // Only automatic re-syncs are recorded (F96): the popup already shows
      // the user the answer to a click.
      const noteAuto = (status, ok, error) => {
        if (!auto) return;
        try {
          onAutoAttempt({ platform, ok, error: ok ? '' : String(error || 'Import failed').slice(0, 200), status });
        } catch (e) { /* bookkeeping must not change the answer */ }
      };
      const refusal = auto ? isSignedOut(platform) : false;
      if (refusal) {
        const error = signedOutError(refusal);
        noteAuto(409, false, error);
        return send(409, { success: false, code: 'SIGNED_OUT', error });
      }

      let result;
      try {
        result = await importers[platform](cookies, { auto });
      } catch (err) {
        log(`[Ext] ${platform} import failed: ${err && err.message}`);
        const error = err && err.message ? err.message : 'Import failed';
        noteAuto(500, false, error);
        return send(500, { success: false, error });
      }
      const out = result && typeof result === 'object' ? { ...result } : { success: false, error: 'Import failed' };
      // Signed out (or connected in the app) while this re-sync was running:
      // the same answer as if it had arrived a moment later.
      if (out.code === 'SIGNED_OUT' && !out.success) {
        const error = signedOutError(out.error);
        noteAuto(409, false, error);
        return send(409, { success: false, code: 'SIGNED_OUT', error });
      }
      if (!auto && out.success) onManualImport(platform, out);
      // A background re-sync never needs to learn whose account the app holds.
      if (auto) delete out.username;
      noteAuto(200, !!out.success, out.error);
      return send(200, out);
    } catch (err) {
      log(`[Ext] Cookie receiver error: ${err && err.message}`);
      return send(500, { success: false, error: 'Internal error' }, { close: true });
    }
  };
}

// An HTTP server with limits suited to a local, single-client endpoint: a
// slow or stalled client cannot hold sockets open, and a handful of held
// sockets still leaves room for the real extension.
function createReceiverServer(handler, { headersTimeoutMs = 10000, requestTimeoutMs = 15000, maxConnections = 16 } = {}) {
  const server = http.createServer(handler);
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.maxConnections = maxConnections;
  return server;
}

// Binds the first port in `ports` that works, on `host`. Any bind error moves
// on to the next port: on Windows a port inside a Hyper-V/WSL/Docker reserved
// range fails with EACCES, not EADDRINUSE, and used to stop the walk at the
// first port. Resolves { server, port, errors } (errors: the ports skipped on
// the way) or { server: null, errors }. Errors after a successful bind go to
// onRuntimeError.
async function listenOnFirstPort({ ports, host = '127.0.0.1', createServer, onRuntimeError = () => {} }) {
  const errors = [];
  for (const port of ports) {
    const server = createServer();
    const bound = await new Promise((resolve) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        resolve({ err });
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve({});
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port, host);
      } catch (err) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        resolve({ err });
      }
    });
    if (!bound.err) {
      server.on('error', onRuntimeError);
      return { server, port, errors };
    }
    errors.push({ port, code: (bound.err && bound.err.code) || (bound.err && bound.err.message) || 'error' });
    try { server.close(); } catch (e) { /* never listened */ }
  }
  return { server: null, errors };
}

module.exports = {
  MAX_IMPORT_BODY_BYTES,
  LOCKOUT_AFTER_FAILURES,
  LOCKOUT_MS,
  PING_PROOF_PREFIX,
  MIN_PROOF_CODE_LENGTH,
  TRUNCATED_CODE_ERROR,
  pingProof,
  pingBody,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
  codesMatch,
  maskCode,
  createPairingGuard,
  readBodyCapped,
  createReceiverHandler,
  createReceiverServer,
  listenOnFirstPort,
  SIGNED_OUT_ERROR,
  APP_LOGIN_ERROR,
  autoSyncRefusalFor,
};
