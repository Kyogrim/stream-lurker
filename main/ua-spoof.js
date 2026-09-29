// The Chrome identity the embedded browser presents. Tested in
// test/main-ua-spoof.test.js.
//
// The version is floor(engine, MIN_CHROME_MAJOR): it can raise an engine
// that platform login gates consider too old, and never lowers one. A
// hard-coded number fell behind the real engine after the Electron upgrade
// (Chrome 152 claiming to be 137), and a UA or client hint older than the JS
// engine behind it is exactly the mismatch bot detection flags as "browser not
// supported".
//
// Three places must agree: (1) the UA string, (2) the Sec-CH-UA request
// headers, and (3) navigator.userAgentData in src/twitch-preload.js, which
// derives its version from the UA string. The UA keeps Chrome's reduced
// MAJOR.0.0.0 form; a full build number there would itself look non-Chrome.

const MIN_CHROME_MAJOR = 137;

function spoofedChromeVersion(realChromeVersion, floor = MIN_CHROME_MAJOR) {
  const real = parseInt(realChromeVersion, 10);
  const major = String(Math.max(Number.isFinite(real) ? real : 0, floor));
  return { major, full: `${major}.0.0.0` };
}

// Electron's UA minus the app and Electron tokens, with the spoofed version.
function normalizeUserAgent(rawUA, fullVersion) {
  return String(rawUA || '')
    .replace(/stream-lurker\/\S+/i, '')
    .replace(/Electron\/\S+/i, '')
    .replace(/Chrome\/[\d.]+/i, `Chrome/${fullVersion}`)
    .replace(/\s+/g, ' ')
    .trim();
}

function osPlatformName(platform) {
  return platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows';
}

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

// Rewrites the client-hint headers of one request in place. The low-entropy
// three are always sent by Chromium. The full-version ones are only sent to a
// site that asked for them (Accept-CH), and would otherwise carry the real
// build and Chromium's own brand list; they are rewritten to the same brands,
// with the same full versions the preload's getHighEntropyValues reports.
function applyClientHints(headers, { major, full, platform }) {
  setHeader(headers, 'sec-ch-ua', `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`);
  setHeader(headers, 'sec-ch-ua-mobile', '?0');
  setHeader(headers, 'sec-ch-ua-platform', `"${osPlatformName(platform)}"`);
  if (hasHeader(headers, 'sec-ch-ua-full-version-list')) {
    setHeader(headers, 'sec-ch-ua-full-version-list', `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not-A.Brand";v="99.0.0.0"`);
  }
  if (hasHeader(headers, 'sec-ch-ua-full-version')) {
    setHeader(headers, 'sec-ch-ua-full-version', `"${full}"`);
  }
  return headers;
}

module.exports = {
  MIN_CHROME_MAJOR,
  spoofedChromeVersion,
  normalizeUserAgent,
  osPlatformName,
  applyClientHints,
};
