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
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const preloadJs = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

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
  const receiverSrc = fs.readFileSync(path.join(REPO, 'main', 'cookie-receiver.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(receiverSrc.replace(/^\s*\/\/.*$/gm, ''), /Access-Control-Allow/);
  const receiverArea = mainJs.slice(mainJs.indexOf('function getPairingCode('), mainJs.indexOf("ipcMain.handle('open-extension-folder'"));
  assert.doesNotMatch(receiverArea, /Access-Control-Allow|setHeader\(/);
  assert.doesNotMatch(mainJs, /http\.createServer\(/, 'only createReceiverServer builds it');
  const wiring = mainJs.slice(mainJs.indexOf('const handleReceiverRequest = createReceiverHandler('), mainJs.indexOf('function startCookieReceiver('));
  assert.match(wiring, /importers: \{ twitch: importTwitchSession, youtube: importGoogleSession, kick: importKickSession \}/);
  assert.match(wiring, /isSignedOut: \(platform\) => autoSyncRefusalFor\(signedOutReasonIn\(config\.signedOutPlatforms, platform\)\)/);
  assert.match(wiring, /onManualImport: \(platform\) => setSignedOut\(platform, false\)/);
  assert.match(wiring, /onAutoAttempt: recordAutoSync,/);
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

test('C1 SIGNED_OUT / F53: signing out, or connecting inside the app, turns auto re-sync off; only a click in the extension turns it on', () => {
  const logout = block("ipcMain.handle('logout-platform'");
  assert.match(logout, /setSignedOut\(p, true\);/);
  assert.ok(before(logout, 'setSignedOut(p, true);', 'await purgePlatformCookies(p);'), 'set before the purge awaits anything');
  // F53 item 3: an account connected in the app is not overwritten by the
  // browser's on the next re-sync.
  assert.match(mainJs, /function commitLogin\(username\) \{[\s\S]*?setSignedOut\(p, true, 'app-login'\);[\s\S]*?\n {4}\}/);
  const paste = block("ipcMain.handle('set-twitch-token'");
  assert.match(paste, /setSignedOut\('twitch', true, 'app-login'\);/);
  assert.ok(before(paste, "setSignedOut('twitch', true, 'app-login');", 'ses.cookies.remove('), 'before its own writes, so a running re-sync stops first');
  assert.ok(before(paste, 'resolveTwitchUser(token)', "setSignedOut('twitch', true, 'app-login');"), 'only once the token proved valid');
  assert.match(block("ipcMain.handle('set-google-cookies'"), /if \(result && result\.success\) setSignedOut\('youtube', true, 'app-login'\);/);
  assert.doesNotMatch(mainJs.replace(/onManualImport: \(platform\) => setSignedOut\(platform, false\)/, ''), /setSignedOut\([^)]*false\)/, 'nothing else re-enables it');
  const set = block('function setSignedOut(');
  assert.match(set, /SIGN_OUT_PLATFORMS\.includes\(p\)/);
  assert.match(set, /if \(signedOut\) syncTickets\.bump\(p\);/);
});

test('F53 item 4: an automatic import checks its ticket before writing, and again before saving the account', () => {
  for (const [fn, p] of [['async function importTwitchSession(', 'twitch'], ['async function importGoogleSession(', 'youtube'], ['async function importKickSession(', 'kick']]) {
    const src = block(fn);
    assert.match(src, new RegExp(`const ticket = autoImportTicket\\('${p}', opts\\);`), fn);
    assert.ok(before(src, 'if (!ticket.valid()) return ticket.refuse();', 'await writeCookieList('), `${fn} checks before writing`);
    // r4-2: and before every cookie it removes or sets, so one ended mid-write
    // stops there instead of interleaving with a paste or an in-app login.
    assert.match(src, /await writeCookieList\([^;]*, \{ stillValid: ticket\.valid \}\);/, `${fn} hands its ticket to the writes`);
    const write = src.indexOf('await writeCookieList(');
    const after = src.indexOf('if (!ticket.valid()) return ticket.undo();', write);
    assert.ok(after > write, `${fn} checks after writing`);
    assert.ok(after < src.indexOf('config.accounts = config.accounts || {};', write) || src.indexOf('config.accounts = config.accounts || {};', write) < 0, `${fn} before touching the account`);
    // Every await between the write and the account assignment is followed by
    // a check: the account-name probe, awaited whole or within the budget.
    for (const probe of ['await settleWithin(', 'await pending', 'await lookup', 'await youtubeProbe.fresh()', 'await kickNameProbe.fresh()']) {
      const at = src.indexOf(probe);
      if (at < 0) continue;
      assert.ok(src.indexOf('if (!ticket.valid()) return ticket.undo();', at) > at, `${fn}: ${probe}`);
    }
  }
  // writeCookieList runs the tested loop (main-cookie-import, r4-2) with it.
  const writer = block('async function writeCookieList(');
  assert.match(writer, /^async function writeCookieList\(cookieList, defaultDomain, \{ stillValid \} = \{\}\) \{/);
  assert.match(writer, /await applyCookiePlan\(plan, ses\.cookies, \{\s*stillValid,/);
  assert.doesNotMatch(writer, /ses\.cookies\.(remove|set)\(/, 'no write outside the checked loop');
  // The probes are awaited somewhere; a rename of the pattern must not skip the loop above.
  assert.match(block('async function importGoogleSession('), /await settleWithin\(pending, AUTO_IMPORT_PROBE_BUDGET_MS\)/);
  assert.match(block('async function importKickSession('), /await settleWithin\(lookup, AUTO_IMPORT_PROBE_BUDGET_MS\)/);
  const ticket = block('function autoImportTicket(');
  assert.match(ticket, /=== 'signed-out'\) \{\s*try \{\s*await purgePlatformCookies\(platform, \{ quiet: true \}\);/);
  // SIGNED_OUT (the extension drops the platform) only while re-sync is off.
  assert.match(ticket, /return reason\s*\? \{ success: false, code: 'SIGNED_OUT', error: autoSyncRefusalFor\(reason\) \}\s*: \{ success: false, error:/);
});

test('r2-7: a YouTube paste holds re-sync off while it runs, and ends one already running before it writes', () => {
  const paste = block("ipcMain.handle('set-google-cookies'");
  assert.ok(before(paste, 'youtubePastesRunning++;', 'await importGoogleSession('), 'held off before the import starts');
  assert.match(paste, /\} finally \{\s*youtubePastesRunning--;\s*\}/, 'released on every path, a throw included');
  // A successful paste turns re-sync off for good before the hold is released.
  assert.ok(before(paste, "setSignedOut('youtube', true, 'app-login');", 'youtubePastesRunning--;'));
  const google = block('async function importGoogleSession(');
  const bump = google.indexOf("if (opts.paste) syncTickets.bump('youtube');");
  assert.ok(bump > google.indexOf('if (!ticket.valid()) return ticket.refuse();'), 'once the paste has proved usable');
  assert.ok(bump < google.indexOf('jarBefore = await readYouTubeJar()'), 'before the jar is copied');
  assert.ok(bump < google.indexOf('await writeCookieList('), 'before the paste writes');
  // Checked on every valid(), so a re-sync already past its first check stops too.
  assert.match(block('function autoImportTicket('), /isBlocked: \(p\) => isSignedOutIn\(config\.signedOutPlatforms, p\) \|\| \(p === 'youtube' && youtubePastesRunning > 0\),/);
});

test('r2-17: an automatic import answers within its budget and applies a late probe under the same checks', () => {
  // The budget sits below what the extension waits, with room for the writes.
  const connector = fs.readFileSync(path.join(REPO, 'extension', 'connector.js'), 'utf8').replace(/\r\n/g, '\n');
  const extensionTimeout = Number((connector.match(/AUTO_IMPORT_TIMEOUT_MS = (\d+)/) || [])[1]);
  const budget = Number((mainJs.match(/const AUTO_IMPORT_PROBE_BUDGET_MS = (\d+);/) || [])[1]);
  assert.ok(extensionTimeout > 0 && budget > 0, 'both constants found');
  assert.ok(budget + 5000 <= extensionTimeout, `a ${budget} ms budget leaves 5 s of the extension's ${extensionTimeout} ms for the cookie writes`);
  // Only an automatic import takes the budget: a click or a paste waits for the page.
  for (const [fn, p] of [['async function importGoogleSession(', 'pending'], ['async function importKickSession(', 'lookup']]) {
    assert.match(block(fn), new RegExp(`const answer = opts\\.auto \\? await settleWithin\\(${p}, AUTO_IMPORT_PROBE_BUDGET_MS\\) : \\{ settled: true, value: await ${p} \\};`), fn);
  }
  const google = block('async function importGoogleSession(');
  assert.match(google, /if \(answer\.settled\) probe = answer\.value;\s*else lateProbe = pending;/);
  // No account and no verdict yet: connected only once the verdict says so.
  assert.match(google, /const awaitingVerdict = !!lateProbe && !config\.accounts\.youtube;\s*if \(!config\.accounts\.youtube && !awaitingVerdict\) config\.accounts\.youtube = placeholderName\('youtube'\);/);
  const handOff = google.indexOf('if (lateProbe) applyLateYouTubeProbe(lateProbe, ticket, setCount);');
  assert.ok(handOff > google.lastIndexOf('saveConfig();'), 'handed off after the import saved its own state');
  const kick = block('async function importKickSession(');
  assert.match(kick, /\} else \{\s*lateLookup = lookup;\s*\}/);
  const kickHandOff = kick.indexOf('if (lateLookup) applyLateKickName(lateLookup, ticket);');
  assert.ok(kickHandOff > kick.lastIndexOf('saveConfig();'));
  // A late answer is dropped after a sign-in, a sign-out or another re-sync.
  for (const fn of ['function applyLateYouTubeProbe(', 'function applyLateKickName(']) {
    const late = block(fn);
    const snapAt = late.indexOf('accountEpochs.snapshot(');
    assert.ok(snapAt > 0 && snapAt < late.indexOf('.then('), `${fn} snapshots before it waits`);
    assert.match(late, /!ticket\.valid\(\) \|\| !accountEpochs\.isCurrent\(snap, config\.accounts\)/, fn);
    assert.match(late, /\.catch\(\(err\) => addLog\(/, `${fn} leaves no unhandled rejection`);
  }
  const lateYt = block('function applyLateYouTubeProbe(');
  // The in-time verdicts: signed out keeps it disconnected, with the marker,
  // re-checked after its own await.
  const signedOut = lateYt.slice(lateYt.indexOf("if (state === 'signed-out') {"));
  assert.ok(before(signedOut, 'await readYouTubeAuthCookies()', 'if (stale()) return;'));
  assert.ok(before(signedOut, 'if (stale()) return;', 'config.youtubeExpiredFingerprint = fingerprint;'));
  assert.ok(signedOut.indexOf('return;') < signedOut.indexOf("config.accounts.youtube = name || placeholderName('youtube');"), 'never connected after a signed-out verdict');
  assert.match(block('function applyLateKickName('), /const resolved = kickNameToStore\(snap\.name, found\);/);
});

test('F96: automatic re-sync results reach Platform Logins and the log, rate-limited', () => {
  const record = block('function recordAutoSync(');
  assert.match(record, /autoSyncLogThrottle\.shouldLog\(`\$\{platform\}\|\$\{entry\.error\}`\)/);
  // A refusal the user caused is logged but never shown as a failing sync.
  assert.ok(before(record, 'autoSyncLogThrottle.shouldLog(', 'if (status === 409) return;'));
  assert.ok(before(record, 'if (status === 409) return;', 'extensionLastAutoSync = { platform, ...entry };'));
  assert.match(mainJs, /const autoSyncLogThrottle = createLogThrottle\(\{ intervalMs: AUTO_SYNC_LOG_INTERVAL_MS, maxKeys: 50 \}\);/);
  const info = block("ipcMain.handle('get-extension-info'");
  assert.match(info, /lastAutoSync: extensionLastAutoSync,/);
  assert.match(info, /autoSync: \{ \.\.\.extensionAutoSync \},/);
  assert.match(info, /codeRejectedAt: extensionCodeRejectedAt,/);
  // The importers no longer log a failed re-sync every 30 minutes themselves.
  assert.doesNotMatch(block('async function importKickSession('), /Kick re-sync skipped/);
  assert.match(block('async function importTwitchSession('), /if \(!opts\.auto\) addLog\(`\[Ext\] Twitch import not applied/);
});

test('G2.4: every receiver port is one the extension looks on, the original five first', () => {
  const ports = JSON.parse(mainJs.match(/const RECEIVER_PORTS = (\[[\d,\s]+\]);/)[1]);
  const connectorSrc = fs.readFileSync(path.join(REPO, 'extension', 'connector.js'), 'utf8').replace(/\r\n/g, '\n');
  const extPorts = JSON.parse(connectorSrc.match(/const PORTS = (\[[\d,\s]+\]);/)[1]);
  assert.deepEqual(ports.slice(0, 5), [47100, 47101, 47102, 47103, 47104]);
  for (const p of ports) assert.ok(extPorts.includes(p), `port ${p} is not in extension/connector.js PORTS`);
  // Fallbacks at least 100 apart from each other and from the first block.
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const blocks = sorted.filter(p => p < 47100 || p > 47104);
  for (const p of blocks) {
    for (const q of sorted) if (q !== p) assert.ok(Math.abs(p - q) >= 100, `${p} and ${q}`);
  }
  assert.ok(blocks.length >= 2, 'at least two fallbacks');
});

test('F18/F22: save-config merges a validated patch; extension additions need the dialog', () => {
  const save = block("ipcMain.handle('save-config'");
  assert.match(save, /rendererConfigPatch\(newConfig, config, \{\s*approvedExtensions: approvedExtensionPaths,\s*dashboardExtensions: dashboardExtensionsSeen,\s*\}\)/);
  // What the dashboard's copy holds: its last fetch, then its own last save.
  assert.match(block("ipcMain.handle('get-config'"), /noteDashboardExtensions\(config\.extensions\);\s*return config;/);
  assert.match(save, /if \(patch\.extensions\) noteDashboardExtensions\(newConfig\.extensions\);/);
  assert.ok(before(save, 'const oldExtensions =', 'saveConfig(next)'), 'the old list is taken before the merge');
  assert.doesNotMatch(save, /saveConfig\(newConfig\)/, 'never the page\'s object itself');
  assert.match(block("ipcMain.handle('select-extension-folder'"), /approvedExtensionPaths\.add\(selectedPath\);/);
  // Main tells the dashboard about account names it finds on its own.
  const validate = block('async function validateSavedSessions(');
  assert.match(validate, /notifyLoginSuccess\(platform, username\);/);
  assert.match(validate, /notifyLoginSuccess\(platform, config\.accounts\[platform\]\);/);
});

test('F89 layer 2: add-streamer refuses a name the platform cannot have, before storing anything', () => {
  const add = block("ipcMain.handle('add-streamer'");
  assert.match(add, /const nameProblem = channelNameProblem\(platform, cleanUsername\);\s*if \(nameProblem\) return \{ success: false, error: nameProblem \};/);
  assert.ok(before(add, 'channelNameProblem(', 'config.streamers.push('));
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
  // The device-id handshake is gone from both ends. They go together: a
  // sendSync nothing answers blocks the page until the event is collected.
  assert.doesNotMatch(mainJs, /get-twitch-unique-id-sync/);
  const loginPreload = fs.readFileSync(path.join(REPO, 'src', 'twitch-preload.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(loginPreload, /sendSync|get-twitch-unique-id-sync/);
});

test('F57: the catalog no longer promises ad blocking the app cannot deliver', () => {
  const catalog = mainJs.slice(mainJs.indexOf('const EXTENSION_CATALOG = ['), mainJs.indexOf('];', mainJs.indexOf('const EXTENSION_CATALOG = [')));
  assert.doesNotMatch(catalog, /pre-roll|mid-roll|Recommended for hiding/i);
  assert.match(catalog, /does not let extensions block network requests/);
  // Nor does the package metadata or the README (F57's own evidence).
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8').replace(/\r\n/g, '\n'));
  assert.doesNotMatch(pkg.description, /adblock|ad block|ad-block/i);
  assert.ok(!(pkg.keywords || []).some(k => /adblock|ad block|ad-block/i.test(k)), 'no adblock keyword');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(readme, /adblock support|ad-?block(ing)? (support|extensions?)/i, 'README.md does not advertise ad blocking');
});

test('F69: loaded extensions follow the list; catalog changes unload first', () => {
  const load = block('async function loadExtensions(');
  assert.match(load, /planExtensionSync\(loadedExts, paths\)/);
  assert.match(load, /removeLoadedExtension\(ses, id\)/);
  assert.match(load, /return changed;/);
  assert.doesNotMatch(load, /Clear pre-existing loaded extensions/);
  const install = block('async function installCatalogEntry(');
  // The swap (and the manifest check before it) is promoteStaged, tested on
  // real folders in main-extension-sync; the running copy is unloaded in its
  // beforeSwap hook, so only once the staged copy checked out.
  assert.match(install, /promoteStaged\(staging, installRoot, \{[\s\S]*?beforeSwap: \(\) => \{ unloaded = unloadExtensionsUnder\(installRoot\); \}/);
  assert.match(install, /for \(const p of unloaded\) \{\s*await loadSingleExtension\(p\)/, 'a failed swap puts the old version back');
  assert.match(block("ipcMain.handle('install-catalog-extension'"), /catalogInstallLocks\.run\(entry\.id, \(\) => installCatalogEntry\(entry\)\)/);
  const uninstall = block("ipcMain.handle('uninstall-catalog-extension'");
  assert.match(uninstall, /catalogInstallLocks\.has\(entry\.id\)/);
  assert.ok(before(uninstall, 'unloadExtensionsUnder(installRoot)', 'rmrf(installRoot)'));
  assert.match(uninstall, /try \{\s*rmrf\(installRoot\);\s*\} catch/);
  assert.doesNotMatch(mainJs, /p\.startsWith\(installRoot\)/, 'F37: exact folder match');
  assert.match(block("ipcMain.handle('save-config'"), /send\('reload-stream-containers'\)/);
});

test('F37: the download is checked against the release before it is unpacked', () => {
  const install = block('async function installCatalogEntry(');
  assert.ok(before(install, 'checkReleaseAsset(zip, asset)', 'extractZipBuffer(zip, staging)'));
  assert.match(install, /if \(!integrity\.ok\) throw new Error\(/);
});

test('F37: the manifest is checked before the swap and never re-read after it; a failure says what was kept', () => {
  const install = block('async function installCatalogEntry(');
  assert.ok(before(install, 'promoteStaged(', 'config.extensions.push(manifestRoot)'), 'config changes only after the swap');
  const afterSwap = install.slice(install.indexOf('swapped = true;'));
  assert.doesNotMatch(afterSwap, /JSON\.parse|readFileSync|findManifestRoot/, 'the checked manifest is what is reported');
  assert.match(install, /const keptNote = fs\.existsSync\(installRoot\) \? 'The previously installed version is still installed\.' : 'Nothing was installed\.';/);
  assert.match(install, /swapped \|\| err\.oldCopyAt \? err\.message : `\$\{err\.message\}\. \$\{keptNote\}`/);
  // The patch and the catalog list read manifests the way the install checks them.
  assert.match(block('function patchSevenTVManifestForKick('), /readStagedManifest\(manifestRoot\)/);
  assert.match(block('function getInstalledManifestForCatalogEntry('), /readStagedManifest\(manifestRoot\)/);
  assert.doesNotMatch(mainJs, /\nfunction (swapDirectory|findManifestRoot)\(/, 'one copy, in extension-sync.js');
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
  assert.match(block("ipcMain.handle('sync-platform-schedules'"), /await scheduleSync\.syncSchedules\(\{/);
  assert.doesNotMatch(mainJs, /fetchKickSchedule|does not natively support weekly schedules/);
});

test('G4.5/F97: main stores the merged schedule itself, and never after a sync where every fetch failed', () => {
  const sync = block("ipcMain.handle('sync-platform-schedules'");
  assert.match(sync, /previous: config\.syncedCalendarEvents,/);
  assert.match(sync, /const saved = shouldStoreSchedule\(result\);\s*if \(saved\) \{\s*config\.syncedCalendarEvents = result\.events;\s*saveConfig\(\);\s*\}/);
  assert.match(sync, /return \{ \.\.\.result, saved \};/);
  // The dashboard reads exactly this shape (src/calendar.js readScheduleSync).
  const calendar = fs.readFileSync(path.join(REPO, 'src', 'calendar.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(calendar, /persisted: res\.saved === true/);
});

test('F52: re-syncs announce only a different account; YouTube\'s health check compares names', () => {
  assert.match(block('async function importTwitchSession('), /if \(!opts\.auto \|\| !sameAccountName\(previous, username\)\) notifyLoginSuccess\('twitch', username\);/);
  assert.match(block('async function importGoogleSession('), /if \(!opts\.auto \|\| !sameAccountName\(previous, config\.accounts\.youtube\)\) notifyLoginSuccess/);
  const kick = block('async function importKickSession(');
  assert.match(kick, /Date\.now\(\) - kickNameCheckedAt >= KICK_NAME_RECHECK_MS/);
  assert.match(kick, /if \(!opts\.auto \|\| !sameAccountName\(previous, config\.accounts\.kick\)\) notifyLoginSuccess/);
  // The comparison (placeholder, same name, trusted source, twice in a row)
  // is youtubeRenameDecision, tested in main-account-state.
  const health = block('async function runYouTubeSessionHealthCheck(');
  assert.match(health, /youtubeRenameDecision\(\{ stored: snap\.name, name, source: nameSource, pending \}\)/);
  assert.ok(before(health, 'youtubeRenameDecision(', 'config.accounts.youtube = name;'));
  assert.match(health, /if \(decision\.rename\) \{\s*config\.accounts\.youtube = name;/);
  // Kick: a page-read name never renames a known account (kickNameToStore).
  assert.match(kick, /const resolved = kickNameToStore\(config\.accounts\.kick, found\);/);
  assert.match(block('async function refreshPlaceholderAccountNames('), /const name = kickNameToStore\(snap\.name, found\);/);
});
