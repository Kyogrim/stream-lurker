// Static guards for the account/login wiring in main.js, which cannot run
// outside Electron. The logic itself is tested in main-hidden-page,
// main-login-flow, main-cookie-import, main-account-state, main-kick-user and
// main-twitch-user; these check main.js still routes through it. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

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
  // Issue 17: signed in means a fingerprint exists, so an expiry always has
  // a marker to leave (rotating cookies alone used to count and never match).
  const ytBranch = validate.slice(validate.indexOf("platform === 'youtube'"), validate.indexOf("platform === 'rumble'"));
  assert.match(ytBranch, /const fingerprint = youtubeAuthFingerprint\(cookies\);\s*isValid = fingerprint !== null;/);
  assert.match(ytBranch, /if \(fingerprint === config\.youtubeExpiredFingerprint\)/);
  assert.doesNotMatch(mainJs, /YOUTUBE_AUTH_COOKIE/);
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

test('issue-16: the login modal counts a YouTube cookie hit only for a session that is new since it opened', () => {
  const modal = section(/ipcMain\.handle\('open-login-modal'/);
  const atOpen = modal.indexOf('const youtubeAtOpen = ');
  assert.ok(atOpen > 0 && atOpen < modal.indexOf('loginWin.loadURL(loginUrl'), 'read before the page loads');
  assert.match(modal, /readYouTubeAuthCookies\(\)\.then\(youtubeAuthFingerprint\)\.catch\(\(\) => undefined\)/);
  const detect = modal.slice(modal.indexOf('async function detectLogin('));
  const yt = detect.slice(detect.indexOf("} else if (p === 'youtube') {"), detect.indexOf("} else if (p === 'rumble') {"));
  assert.match(yt, /isNewYouTubeSignIn\(youtubeAuthFingerprint\(await readYouTubeAuthCookies\(ses\)\), \{\s*atOpen: await youtubeAtOpen,\s*expired: config\.youtubeExpiredFingerprint,/);
  assert.match(yt, /\) return \{\};/);
});

test('issue-19: a paste YouTube rejects puts the previous cookies back, or disconnects; the error says which', () => {
  const importGoogle = section(/async function importGoogleSession\(/);
  assert.ok(importGoogle.indexOf('jarBefore = await readYouTubeJar()') < importGoogle.indexOf('writeCookieList(relevant'), 'copied before anything is written');
  assert.ok(importGoogle.indexOf('const markerBefore = config.youtubeExpiredFingerprint;') < importGoogle.indexOf('delete config.youtubeExpiredFingerprint'));
  assert.match(importGoogle, /probe\.state === 'signed-out' && opts\.paste\) \{[\s\S]*?await restorePastedOver\(jarBefore, markerBefore\);[\s\S]*?\$\{restored\.userMessage\}/);
  assert.match(importGoogle, /const restored = opts\.paste \? await restorePastedOver\(jarBefore, markerBefore\) : null;/, 'a paste nothing of which could be written also restores');
  const restore = section(/async function restorePastedOver\(/);
  assert.ok(restore.indexOf('ses.cookies.remove(removalUrl(c), c.name)') < restore.indexOf('writeCookieList(jarBefore'), 'the pasted and probe cookies go first');
  assert.match(restore, /if \(back === jarBefore\.length\) \{/);
  // The fallback: the card must match the jar.
  const fallback = restore.slice(restore.lastIndexOf('youtubeAuthFingerprint('));
  for (const step of ['delete config.accounts.youtube', "accountEpochs.bump('youtube')", 'saveConfig()', "send('session-expired', { platform: 'youtube' })"]) {
    assert.ok(fallback.includes(step), step);
  }
  assert.match(section(/async function readYouTubeJar\(/), /youtubeJarCookies\(\[/);
});

test('F73: background checks drop results when the account changed under them', () => {
  const health = section(/async function runYouTubeSessionHealthCheck\(/);
  const probeAt = health.indexOf('await youtubeProbe.run()');
  const guardAt = health.indexOf('accountEpochs.isCurrent(snap, config.accounts)');
  assert.ok(probeAt > 0 && guardAt > probeAt, 'checked after the await, before either branch');
  assert.ok(guardAt < health.indexOf("state === 'live'"));
  assert.match(health, /isPlaceholderName\(snap\.name\)/);
  const refresh = section(/async function refreshPlaceholderAccountNames\(/);
  const kickProbeAt = refresh.indexOf('await kickNameProbe.run()');
  assert.ok(refresh.indexOf('accountEpochs.isCurrent(snap, config.accounts)', kickProbeAt) > kickProbeAt, 'checked after the probe');
  // r2-6: the snapshot is taken before the first await (the cookie read), or
  // a Sign Out during that read becomes the starting state; and it is
  // checked again after that read, before any page is loaded.
  const snapAt = refresh.indexOf("const snap = accountEpochs.snapshot('kick', config.accounts);");
  const readAt = refresh.indexOf('await readKickSessionCookies()');
  assert.ok(snapAt > 0 && readAt > snapAt, 'r2-6: snapshot before the cookie read');
  assert.equal(refresh.indexOf('await '), readAt, 'r2-6: nothing awaited before the snapshot');
  const recheck = refresh.indexOf('accountEpochs.isCurrent(snap, config.accounts)', readAt);
  assert.ok(recheck > readAt && recheck < kickProbeAt, 'r2-6: re-checked between the cookie read and the probe');
  assert.match(section(/ipcMain\.handle\('logout-platform'/), /accountEpochs\.bump\(p\)/);
  for (const fn of [/async function importGoogleSession\(/, /async function importKickSession\(/, /async function importTwitchSession\(/]) {
    assert.match(section(fn), /accountEpochs\.bump\(/);
  }
});

test('F73 (Twitch writers): the startup check and the follows sync never write over a Sign Out', () => {
  // validateSavedSessions: snapshot before the platform's first await, then
  // checked after the name lookup and again before the tail's writes.
  const validate = section(/async function validateSavedSessions\(/);
  const snapAt = validate.indexOf('let snap = accountEpochs.snapshot(platform, config.accounts);');
  const firstAwait = validate.indexOf('await ', validate.indexOf('for (const platform of platformsToCheck)'));
  assert.ok(snapAt > 0 && snapAt < firstAwait, 'snapshot before the first await of each platform');
  const lookupAt = validate.indexOf('await fetchTwitchUsername(tokenCookie.value)');
  const lookupGuard = validate.indexOf('accountEpochs.isCurrent(snap, config.accounts)', lookupAt);
  assert.ok(lookupAt > 0 && lookupGuard > lookupAt, 'checked after the name lookup');
  assert.ok(lookupGuard < validate.indexOf('config.accounts[platform] = username;'), 'before the recovery write');
  const tailGuard = validate.indexOf('accountEpochs.isCurrent(snap, config.accounts)', validate.indexOf('if (checkErrored) continue;'));
  assert.ok(tailGuard > 0, 'the tail is guarded');
  assert.ok(tailGuard < validate.indexOf('delete config.accounts[platform];'), 'before the expiry delete');
  assert.ok(tailGuard < validate.indexOf('config.accounts[platform] = placeholderName(platform);'), 'before the placeholder write');
  // Its own recovery write re-bases the snapshot, or the tail would refuse it.
  assert.ok(validate.indexOf('snap = accountEpochs.snapshot(platform, config.accounts);', validate.indexOf('config.accounts[platform] = username;')) > 0);

  // get-twitch-follows: bounded request, snapshot before it, and the name is
  // written only while the same, still-connected account is current.
  const follows = section(/ipcMain\.handle\('get-twitch-follows'/);
  const fSnap = follows.indexOf("const snap = accountEpochs.snapshot('twitch', config.accounts);");
  const fFetch = follows.indexOf('await fetchTextWithDeadline(net.fetch');
  assert.ok(fSnap > 0 && fFetch > fSnap, 'snapshot before the request');
  assert.doesNotMatch(follows, /await net\.fetch\(/, 'no unbounded request');
  const fWrite = follows.indexOf('config.accounts.twitch = username;');
  const fGuard = follows.lastIndexOf('snap.name && accountEpochs.isCurrent(snap, config.accounts)', fWrite);
  assert.ok(fGuard > fFetch && fGuard < fWrite, 'guarded after the request, before the write');
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
