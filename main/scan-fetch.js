// One deadline for each network request the scanner makes. Chromium's network
// stack has no overall request timeout, so a server that accepted the
// connection and never finished answering (a Cloudflare tarpit, a half-open
// connection, a captive portal) used to hang that scan forever, and every
// platform with it. Tested against a real stalling server in
// test/main-scan-fetch.test.js.

const SCAN_REQUEST_TIMEOUT_MS = 15000;

// Fetches url and reads the whole body as text under a single deadline, so a
// body that stalls after the headers arrive is bounded too. Resolves to
// { status, ok, text }; rejects with "timed out after Ns" at the deadline.
//
// The abort is what frees the socket (racing a timer alone would leave the
// request open and, at six connections per host, starve later ones). The race
// is what guarantees this promise settles on time whatever the fetch
// implementation does with a body whose request was aborted mid-read.
async function fetchTextWithDeadline(fetchFn, url, init = {}, timeoutMs = SCAN_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`);
      err.code = 'ETIMEDOUT';
      reject(err);
      controller.abort(err);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetchFn(url, { ...init, signal: controller.signal }), deadline]);
    const text = await Promise.race([response.text(), deadline]);
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

// JSON.parse with an error that says which service sent the bad body.
function parseJsonBody(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} returned a response that is not JSON`);
  }
}

module.exports = { SCAN_REQUEST_TIMEOUT_MS, fetchTextWithDeadline, parseJsonBody };
