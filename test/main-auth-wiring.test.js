// Static guards for the account/login wiring in main.js, which cannot run
// outside Electron. The logic itself is tested in main-hidden-page,
// main-login-flow, main-cookie-import, main-account-state, main-kick-user and
// main-twitch-user; these check main.js still routes through it. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// From a top-level declaration to the next one (good enough for this file:
// every top-level declaration starts at column 0).
function section(startPattern) {
  const start = mainJs.search(startPattern);
  assert.ok(start >= 0, `found ${startPattern}`);
  const rest = mainJs.slice(start + 1);
  const next = rest.search(/\n(?:ipcMain\.handle\(|async function |function |const |let |app\.)/);
  return next < 0 ? mainJs.slice(start) : mainJs.slice(start, start + 1 + next);
}

test('F14: hidden pages are run under a deadline, and background callers share a probe', () => {
  const hidden = section(/async function runInHiddenPage\(/);
  assert.match(hidden, /runPageScript\(win,/);
  assert.doesNotMatch(hidden, /executeJavaScript/);
  // Only the gates call the probes directly.
  const direct = [...mainJs.matchAll(/(?<!function )\b(probeYouTubeLogin|resolveKickUser)\(\)/g)].map(m => m[1]);
  assert.deepEqual(direct, [], 'callers go through youtubeProbe / kickNameProbe');
  assert.match(mainJs, /createProbeGate\(probeYouTubeLogin\)/);
  assert.match(mainJs, /createProbeGate\(resolveKickUser\)/);
  // One health check at a time, whoever calls it.
  assert.match(section(/function checkYouTubeSessionHealth\(/), /return youtubeHealthCheck\.run\(\);/);
  assert.match(mainJs, /const youtubeHealthCheck = createSingleFlight\(runYouTubeSessionHealthCheck,/);
  assert.match(section(/async function importGoogleSession\(/), /youtubeProbe\.fresh\(\)/);
  assert.match(section(/async function importKickSession\(/), /kickNameProbe\.fresh\(\)/);
});

test('F35/F85/F36: the login modal runs through createLoginFlow with bounded scripts and Kick proof', () => {
  const modal = section(/ipcMain\.handle\('open-login-modal'/);
  assert.match(modal, /createLoginFlow\(/);
  assert.match(modal, /loginWin\.on\('closed', \(\) => flow\.windowClosed\(\)\)/);
  assert.doesNotMatch(modal, /setInterval\(/, 'polls must not overlap');
  assert.doesNotMatch(modal, /\.executeJavaScript\(/, 'every script goes through runScriptWithin');
  assert.doesNotMatch(modal, /kickNoLoginStreak|loginButtons/, 'a missing Log in button proves nothing');
  assert.match(modal, /hasKickSessionToken\(cookies\)/);
  assert.match(modal, /kickNameFrom\(res, \{ requireApi: true \}\)/);
  assert.match(modal, /\.loadURL\(loginUrl, \{ userAgent: uaToUse \}\)\.catch\(/);
});

test('F33: Kick counts as signed in only with session_token, everywhere', () => {
  const validate = section(/async function validateSavedSessions\(/);
  const kickBranch = validate.slice(validate.indexOf("platform === 'kick'"), validate.indexOf("platform === 'youtube'"));
  assert.match(kickBranch, /hasKickSessionToken\(/);
  assert.doesNotMatch(kickBranch, /includes\('session'\)|=== 'kick_session'/);
  const importKick = section(/async function importKickSession\(/);
  assert.ok(importKick.indexOf('hasKickSessionToken(relevant)') < importKick.indexOf('writeCookieList('), 'checked before anything is written');
  assert.doesNotMatch(importKick, /\/session\/i/);
  assert.match(section(/async function refreshPlaceholderAccountNames\(/), /hasKickSessionToken\(/);
});

test('F34: an expiry leaves a fingerprint that validateSavedSessions honours', () => {
  const health = section(/async function runYouTubeSessionHealthCheck\(/);
  assert.match(health, /config\.youtubeExpiredFingerprint = expiredFingerprint/);
  const validate = section(/async function validateSavedSessions\(/);
  assert.match(validate, /youtubeAuthFingerprint\(cookies\) === config\.youtubeExpiredFingerprint/);
  assert.match(validate, /placeholderName\(platform\)/);
  // A marker is a heuristic verdict: re-asked silently once per launch, and
  // it can only reconnect, never announce an expiry.
  assert.match(validate, /setTimeout\(runSafely\('recheckExpiredYouTube', recheckExpiredYouTube\)/);
  const recheck = section(/async function recheckExpiredYouTube\(/);
  assert.match(recheck, /state !== 'live' \|\| !accountEpochs\.isCurrent\(snap, config\.accounts\)/);
  assert.doesNotMatch(recheck, /Notification|session-expired/);
  assert.match(section(/async function importGoogleSession\(/), /delete config\.youtubeExpiredFingerprint/);
  assert.match(section(/ipcMain\.handle\('logout-platform'/), /delete config\.youtubeExpiredFingerprint/);
  // The dashboard's save can only carry the keys it owns (F18/F22), so the
  // marker, like every main-owned key, always comes from main's config.
  const save = section(/ipcMain\.handle\('save-config'/);
  assert.ok(save.indexOf('rendererConfigPatch(newConfig, config') >= 0);
  assert.ok(save.indexOf('const next = { ...config, ...patch };') < save.indexOf('saveConfig(next)'));
  assert.ok(!require('../main/config-boundary').RENDERER_KEYS.includes('youtubeExpiredFingerprint'));
});

test('F73: background checks drop results when the account changed under them', () => {
  const health = section(/async function runYouTubeSessionHealthCheck\(/);
  const probeAt = health.indexOf('await youtubeProbe.run()');
  const guardAt = health.indexOf('accountEpochs.isCurrent(snap, config.accounts)');
  assert.ok(probeAt > 0 && guardAt > probeAt, 'checked after the await, before either branch');
  assert.ok(guardAt < health.indexOf("state === 'live'"));
  assert.match(health, /isPlaceholderName\(snap\.name\)/);
  const refresh = section(/async function refreshPlaceholderAccountNames\(/);
  assert.ok(refresh.indexOf('accountEpochs.isCurrent') > refresh.indexOf('await kickNameProbe.run()'));
  assert.match(section(/ipcMain\.handle\('logout-platform'/), /accountEpochs\.bump\(p\)/);
  for (const fn of [/async function importGoogleSession\(/, /async function importKickSession\(/, /async function importTwitchSession\(/]) {
    assert.match(section(fn), /accountEpochs\.bump\(/);
  }
});

test('F38/F39/F40: pastes and imports go through the shared parser and shaped writes', () => {
  assert.doesNotMatch(mainJs, /\nfunction parseCookieBlob\(|\nfunction normalizeSameSite\(/, 'one parser, in cookie-import.js');
  const write = section(/async function writeCookieList\(/);
  assert.match(write, /planCookieWrites\(/);
  assert.doesNotMatch(write, /domain: domain \|\| undefined/);
  const paste = section(/ipcMain\.handle\('set-google-cookies'/);
  assert.match(paste, /assignPastedYouTubeDomains\(parseCookieBlob\(blob\)\)/);
  assert.match(paste, /importGoogleSession\(parsed, \{ paste: true \}\)/);
  assert.doesNotMatch(paste, /net\.fetch|LOGGED_IN|'YouTube User'/);
  const importGoogle = section(/async function importGoogleSession\(/);
  assert.match(importGoogle, /isYouTubeCookieDomain\(c\.domain\)/);
  assert.match(importGoogle, /hasGoogleSessionCookies\(relevant\)/);
  assert.match(importGoogle, /youtubeSignedOutStreak = 0/);
});

test('G4.9: both Twitch paths use the one bounded resolver and tell network from rejection', () => {
  const paste = section(/ipcMain\.handle\('set-twitch-token'/);
  assert.doesNotMatch(paste, /gql\.twitch\.tv/);
  assert.match(paste, /twitchUserFailureMessage\(check, 'token'\)/);
  assert.ok(paste.indexOf('resolveTwitchUser(token)') < paste.indexOf('ses.cookies.remove'), 'validated before cookies are touched');
  const ext = section(/async function importTwitchSession\(/);
  assert.match(ext, /twitchUserFailureMessage\(check, 'session'\)/);
  assert.ok(ext.indexOf('resolveTwitchUser(token)') < ext.indexOf('writeCookieList('));
  assert.match(section(/function resolveTwitchUser\(/), /resolveTwitchUserVia\(/);
});
