// Static guards for how main.js wires the receiver, config-boundary,
// extension, clip and calendar modules. main.js cannot load outside Electron;
// the decisions are tested directly in main-cookie-receiver,
// main-config-boundary, main-extension-sync, main-clip-download and
// main-schedule-sync. These make sure main.js keeps routing through them.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8');

// Source of a top-level function or handler: from its opening line to the
// next line that is exactly "}" or "});" (or "}));").
function block(startMarker) {
  const start = mainJs.indexOf(startMarker);
  assert.ok(start >= 0, `found ${startMarker}`);
  const end = mainJs.slice(start).search(/\n\}\)?\)?;?\n/);
  assert.ok(end > 0, `end of ${startMarker}`);
  return mainJs.slice(start, start + end + 4);
}

const before = (text, a, b) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  assert.ok(i >= 0, `found ${a}`);
  assert.ok(j >= 0, `found ${b}`);
  return i < j;
};

test('F16/F54/C1: the receiver is the checked handler, with no CORS and no pairing code in the log', () => {
  // (The gql.twitch.tv response rewrite for stream cells sets one; that is not the receiver.)
  const receiverSrc = fs.readFileSync(path.join(REPO, 'main', 'cookie-receiver.js'), 'utf8');
  assert.doesNotMatch(receiverSrc.replace(/^\s*\/\/.*$/gm, ''), /Access-Control-Allow/);
  const receiverArea = mainJs.slice(mainJs.indexOf('function getPairingCode('), mainJs.indexOf("ipcMain.handle('open-extension-folder'"));
  assert.doesNotMatch(receiverArea, /Access-Control-Allow|setHeader\(/);
  assert.doesNotMatch(mainJs, /http\.createServer\(/, 'only createReceiverServer builds it');
  const wiring = mainJs.slice(mainJs.indexOf('const handleReceiverRequest = createReceiverHandler('), mainJs.indexOf('function startCookieReceiver('));
  assert.match(wiring, /importers: \{ twitch: importTwitchSession, youtube: importGoogleSession, kick: importKickSession \}/);
  assert.match(wiring, /isSignedOut: \(platform\) => isSignedOutIn\(config\.signedOutPlatforms, platform\)/);
  assert.match(wiring, /onManualImport: \(platform\) => setSignedOut\(platform, false\)/);
  const start = block('function startCookieReceiver(');
  assert.match(start, /createServer: \(\) => createReceiverServer\(handleReceiverRequest\)/);
  assert.match(start, /listenOnFirstPort\(\{/);
  // F55: the code is never written to the activity log.
  for (const m of mainJs.matchAll(/addLog\(`[^`]*`\)/g)) assert.doesNotMatch(m[0], /getPairingCode|extensionPairingCode/, m[0]);
  assert.doesNotMatch(mainJs, /version: app\.getVersion\(\)\s*\}\)\);/, '/ping carries no version');
});

test('G2.4: a failed bind walk is logged with the reason and retried on a timer', () => {
  const start = block('function startCookieReceiver(');
  assert.match(start, /setTimeout\(startCookieReceiver, RECEIVER_RETRY_MS\)/);
  assert.doesNotMatch(start, /EADDRINUSE/);
  assert.match(block("ipcMain.handle('get-extension-info'"), /receiverError: cookieReceiverError/);
});

test('F17: codes are validated and 128-bit when new; the rotate channel exists in main and preload', () => {
  const get = block('function getPairingCode(');
  assert.match(get, /normalizePairingCode\(config\.extensionPairingCode\)/);
  assert.match(get, /newPairingCode\(crypto\.randomBytes\)/);
  assert.doesNotMatch(mainJs, /randomBytes\(4\)/);
  assert.match(block("ipcMain.handle('rotate-pairing-code'"), /pairingGuard\.reset\(\);/);
  assert.match(preloadJs, /rotatePairingCode: \(\) => ipcRenderer\.invoke\('rotate-pairing-code'\)/);
});

test('C1 SIGNED_OUT: signing out sets it; every manual reconnect clears it', () => {
  assert.match(block("ipcMain.handle('logout-platform'"), /setSignedOut\(p, true\);/);
  assert.match(mainJs, /function commitLogin\(username\) \{[\s\S]*?setSignedOut\(p, false\);[\s\S]*?\n {4}\}/);
  assert.match(block("ipcMain.handle('set-twitch-token'"), /setSignedOut\('twitch', false\);/);
  assert.match(block("ipcMain.handle('set-google-cookies'"), /if \(result && result\.success\) setSignedOut\('youtube', false\);/);
  assert.match(block('function setSignedOut('), /SIGN_OUT_PLATFORMS\.includes\(p\)/);
});

test('F18/F22: save-config merges a validated patch; extension additions need the dialog', () => {
  const save = block("ipcMain.handle('save-config'");
  assert.match(save, /rendererConfigPatch\(newConfig, config, \{ approvedExtensions: approvedExtensionPaths \}\)/);
  assert.ok(before(save, 'const oldExtensions =', 'saveConfig(next)'), 'the old list is taken before the merge');
  assert.doesNotMatch(save, /saveConfig\(newConfig\)/, 'never the page\'s object itself');
  assert.match(block("ipcMain.handle('select-extension-folder'"), /approvedExtensionPaths\.add\(selectedPath\);/);
  // Main tells the dashboard about account names it finds on its own.
  const validate = block('async function validateSavedSessions(');
  assert.match(validate, /notifyLoginSuccess\(platform, username\);/);
  assert.match(validate, /notifyLoginSuccess\(platform, config\.accounts\[platform\]\);/);
});

test('F11/F55: import takes only the portable keys; export leaves the secrets out', () => {
  const imp = block("ipcMain.handle('import-config'");
  assert.match(imp, /importedConfig\(incoming, config\)/);
  assert.doesNotMatch(imp, /\.\.\.incoming/);
  assert.ok(before(imp, 'if (watchTimeDirty) {', '.preimport-'), 'pending minutes are in the snapshot');
  assert.match(imp, /sanitizeIncomingConfig\(config, source, imported\.dropped\)/);
  assert.match(imp, /capLongestSessions\(config\.watchTime\)/);
  assert.match(block("ipcMain.handle('export-config'"), /JSON\.stringify\(exportableConfig\(config\), null, 2\)/);
  assert.match(block('function loadConfig('), /repairWatchTime\(config\)/);
});

test('F83: the dead Drops / page-GQL subsystem is gone', () => {
  for (const name of ['twitchGqlAuthed', 'getLiveFollowsWithGames', 'getTwitchPageWindow', 'getTwitchUniqueId', 'twitchPageWin',
    'twitchPageReady', 'cachedTwitchUniqueId', 'resetTwitchPageWindow', 'clearTwitchTelemetryCookies', 'getTwitchAuthToken',
    'prioritize-streamer', '[Drops', 'onBeforeRequest(']) {
    assert.ok(!mainJs.includes(name), name);
  }
  assert.doesNotMatch(preloadJs, /prioritize/);
  // Still answered (twitch-preload.js asks with sendSync, which blocks), always null.
  assert.match(mainJs, /ipcMain\.on\('get-twitch-unique-id-sync', \(event\) => \{\s*event\.returnValue = null;\s*\}\);/);
});

test('F57: the catalog no longer promises ad blocking the app cannot deliver', () => {
  const catalog = mainJs.slice(mainJs.indexOf('const EXTENSION_CATALOG = ['), mainJs.indexOf('];', mainJs.indexOf('const EXTENSION_CATALOG = [')));
  assert.doesNotMatch(catalog, /pre-roll|mid-roll|Recommended for hiding/i);
  assert.match(catalog, /does not let extensions block network requests/);
});

test('F69: loaded extensions follow the list; catalog changes unload first', () => {
  const load = block('async function loadExtensions(');
  assert.match(load, /planExtensionSync\(loadedExts, paths\)/);
  assert.match(load, /removeLoadedExtension\(ses, id\)/);
  assert.match(load, /return changed;/);
  assert.doesNotMatch(load, /Clear pre-existing loaded extensions/);
  const install = block("ipcMain.handle('install-catalog-extension'");
  assert.ok(before(install, 'unloaded = unloadExtensionsUnder(installRoot);', 'swapDirectory(staging, installRoot);'));
  assert.match(install, /for \(const p of unloaded\) \{\s*await loadSingleExtension\(p\)/, 'a failed swap puts the old version back');
  const uninstall = block("ipcMain.handle('uninstall-catalog-extension'");
  assert.match(uninstall, /catalogInstallsInFlight\.has\(entry\.id\)/);
  assert.ok(before(uninstall, 'unloadExtensionsUnder(installRoot)', 'rmrf(installRoot)'));
  assert.match(uninstall, /try \{\s*rmrf\(installRoot\);\s*\} catch/);
  assert.doesNotMatch(mainJs, /p\.startsWith\(installRoot\)/, 'F37: exact folder match');
  assert.match(block("ipcMain.handle('save-config'"), /send\('reload-stream-containers'\)/);
});

test('F37: the download is checked against the release before it is unpacked', () => {
  const install = block("ipcMain.handle('install-catalog-extension'");
  assert.ok(before(install, 'checkReleaseAsset(zip, asset)', 'extractZipBuffer(zip, staging)'));
  assert.match(install, /if \(!integrity\.ok\) throw new Error\(/);
});

test('F75: clip downloads and the clip window take only Twitch https URLs', () => {
  const dl = block("ipcMain.handle('download-clip'");
  assert.match(dl, /const clipUrl = clipDownloadUrl\(url\);/);
  assert.match(dl, /clipFileName\(filename\)/);
  assert.match(dl, /path\.join\(app\.getPath\('downloads'\), name\)/);
  assert.match(dl, /downloadURL\(clipUrl\)/);
  assert.doesNotMatch(dl, /https\?/);
  const win = block("ipcMain.handle('open-clip-window'");
  assert.match(win, /const pageUrl = clipPageUrl\(url\);/);
  assert.match(win, /clipWin\.loadURL\(pageUrl\)/);
});

test('F82: open-extension-folder reports what shell.openPath says', () => {
  const open = block("ipcMain.handle('open-extension-folder'");
  assert.match(open, /const err = await shell\.openPath\(p\);\s*if \(err\) \{/);
  assert.match(open, /return \{ success: true, path: p \};/);
});

test('F79/F80: the calendar sync runs through schedule-sync, bounded and deadlined', () => {
  assert.match(mainJs, /const scheduleSync = createScheduleSync\(\{[\s\S]*?runParallel: checkStreamersParallel,[\s\S]*?\}\);/);
  assert.match(mainJs, /ipcMain\.handle\('sync-platform-schedules', async \(\) => scheduleSync\.syncSchedules\(\{/);
  assert.doesNotMatch(mainJs, /fetchKickSchedule|does not natively support weekly schedules/);
});

test('F52: re-syncs announce only a different account; YouTube\'s health check compares names', () => {
  assert.match(block('async function importTwitchSession('), /if \(!opts\.auto \|\| !sameAccountName\(previous, username\)\) notifyLoginSuccess\('twitch', username\);/);
  assert.match(block('async function importGoogleSession('), /if \(!opts\.auto \|\| !sameAccountName\(previous, config\.accounts\.youtube\)\) notifyLoginSuccess/);
  const kick = block('async function importKickSession(');
  assert.match(kick, /Date\.now\(\) - kickNameCheckedAt >= KICK_NAME_RECHECK_MS/);
  assert.match(kick, /if \(!opts\.auto \|\| !sameAccountName\(previous, config\.accounts\.kick\)\) notifyLoginSuccess/);
  assert.match(block('async function runYouTubeSessionHealthCheck('), /isPlaceholderName\(snap\.name\) \|\| !sameAccountName\(name, snap\.name\)/);
});
