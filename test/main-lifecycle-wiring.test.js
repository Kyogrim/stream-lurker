// Static guards for how main.js wires the lifecycle, persistence and startup
// fixes. main.js cannot load outside Electron; the decisions themselves are
// tested in main-app-log, main-config-store, main-dashboard-health,
// main-live-alerts, main-login-item, main-session-stats, main-ua-spoof and
// main-dialog-dirs. These make sure main.js keeps routing through them.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const preloadJs = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

// Source of a top-level function or handler: from its opening line to the
// next line that is exactly "}" or "});".
function block(startMarker) {
  const start = mainJs.indexOf(startMarker);
  assert.ok(start >= 0, `found ${startMarker}`);
  const end = mainJs.slice(start).search(/\n\}\)?;?\n/);
  assert.ok(end > 0, `end of ${startMarker}`);
  return mainJs.slice(start, start + end + 3);
}

const before = (text, a, b) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  assert.ok(i >= 0, `found ${a}`);
  assert.ok(j >= 0, `found ${b}`);
  return i < j;
};

test('G2.1: both process error sinks are registered before any startup work', () => {
  const ready = mainJs.indexOf('app.whenReady()');
  for (const ev of ["process.on('uncaughtException'", "process.on('unhandledRejection'"]) {
    const at = mainJs.indexOf(ev);
    assert.ok(at > 0 && at < ready, ev);
    assert.ok(at < mainJs.indexOf('migrateProfileCookies(app.getPath'), `${ev} before the cookie migration`);
  }
  // Never the blocking boxes the handler exists to avoid, once the app runs:
  // the one error box is for main.js failing to load (next test).
  assert.doesNotMatch(mainJs, /showMessageBoxSync/);
  assert.equal((mainJs.match(/showErrorBox\(/g) || []).length, 1);
});

test('issue-11: a throw while main.js itself loads is fatal and visible, and releases the instance lock', () => {
  // The behaviour is createLoadGuard's (main-app-log, in real processes);
  // this checks main.js wires it: before anything can throw, and loaded()
  // as the file's very last statement.
  const guard = mainJs.slice(mainJs.indexOf('const mainScript = createLoadGuard({'), mainJs.indexOf("process.on('unhandledRejection'"));
  assert.match(guard, /report: reportFatal,/);
  const failure = guard.slice(guard.indexOf('onLoadFailure:'));
  assert.ok(failure.indexOf('dialog.showErrorBox(') > 0 && failure.indexOf('dialog.showErrorBox(') < failure.indexOf('app.exit(1);'), 'says so, then exits');
  assert.match(guard, /process\.on\('uncaughtException', \(err, origin\) => mainScript\.uncaught\(err, origin\)\);/);
  assert.ok(mainJs.indexOf('const mainScript = createLoadGuard(') < mainJs.indexOf('migrateProfileCookies(app.getPath'));
  const code = mainJs.trimEnd().split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));
  assert.equal(code[code.length - 1].trim(), 'mainScript.loaded();', 'the very last statement');
  assert.equal((mainJs.match(/mainScript\.loaded\(\)/g) || []).length, 1);
});

test('issue-10: nothing can start the runtime before the config is loaded or writes are locked', () => {
  const body = mainJs.slice(mainJs.indexOf('app.whenReady().then(async () => {'));
  const code = body.split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  // protocol.handle (item 3) cannot throw into a half-set config; loadConfig
  // is next, before the menu, the migration log loop and everything else.
  assert.deepEqual(code.slice(0, 3), [
    'protocol.handle(DASHBOARD_SCHEME, createDashboardHandler(__dirname));',
    'loadConfig();',
    'installApplicationMenu();',
  ]);
  assert.equal((body.slice(0, body.indexOf('}).catch(')).match(/loadConfig\(\);/g) || []).length, 1, 'loaded once on ready');
  const failure = body.slice(body.indexOf('}).catch((err) => {'), body.indexOf('\n});'));
  assert.ok(failure.indexOf('if (!configLoadAttempted) loadConfig();') > 0, 'the failure path loads it if the ready handler never got there');
  assert.ok(failure.indexOf('if (!configLoadAttempted) loadConfig();') < failure.indexOf('startRuntime();'));
  assert.ok(failure.indexOf('installApplicationMenu()') < failure.indexOf('startRuntime();'));
  const load = block('function loadConfig(');
  assert.match(load, /^function loadConfig\(\) \{\s*configLoadAttempted = true;\s*try \{\s*const configPath = getConfigPath\(\);/, 'flagged first; nothing outside the try can throw');
  // And saveConfig writes nothing before a load was attempted.
  const save = block('function saveConfig(');
  assert.ok(save.indexOf('if (!configLoadAttempted) return;') > 0);
  assert.ok(save.indexOf('if (!configLoadAttempted) return;') < save.indexOf('saveConfigFile('));
});

test('G2.1/G2.3: a startup failure cannot leave a process with no window or tray', () => {
  const ready = mainJs.indexOf('app.whenReady().then(');
  const chain = mainJs.slice(ready, mainJs.indexOf('\nlet runtimeStarted', ready));
  assert.match(chain, /try \{\s*await loadExtensions\(\);\s*\} catch \(err\) \{\s*reportFatal\('loadExtensions', err\);/);
  // Logged first; the prerequisites the ready handler may not have reached
  // are covered in issue-10.
  assert.match(chain, /\}\)\.catch\(\(err\) => \{\s*[\s\S]*reportFatal\('startup', err\);[\s\S]*?startRuntime\(\);/);
  const runtime = block('function startRuntime(');
  assert.match(runtime, /if \(runtimeStarted\) return;\s*runtimeStarted = true;/);
  for (const step of ['createMainWindow();', 'createTray();', 'startCookieReceiver();', 'resetPoller();', 'startWatchTimeTracking();']) {
    assert.match(runtime, new RegExp(`step\\('[^']+', \\(\\) => \\{ ${step.replace(/[()]/g, '\\$&')} \\}\\);`), step);
  }
  // Fire-and-forget background work cannot surface as an unhandled rejection.
  for (const fn of ['validateSavedSessions', 'checkYouTubeSessionHealth', 'refreshPlaceholderAccountNames', 'retryUnavailableExtensions']) {
    assert.match(runtime, new RegExp(`runSafely\\('${fn}', ${fn}\\)`), fn);
  }
  assert.match(block("ipcMain.handle('save-config'"), /loadExtensions\(\)\.then\([\s\S]*?\}\)\.catch\(/);
  assert.match(block('function flushCookies('), /flushStore\(\)\)\.catch\(failed\)/);
});

test('G2.3/G4.10: loadExtensions reads a snapshot and never edits or saves the list', () => {
  const load = block('async function loadExtensions(');
  assert.match(load, /const paths = Array\.isArray\(config\.extensions\)/);
  assert.match(load, /for \(const extPath of paths\)/);
  assert.doesNotMatch(load, /saveConfig\(|config\.extensions\s*=/);
  assert.match(load, /unavailableExtensions\.add\(extPath\)/);
  assert.match(mainJs, /ipcMain\.handle\('get-extension-status', \(\) => \(\{\s*unavailable: \[\.\.\.unavailableExtensions\],/);
  assert.match(preloadJs, /getExtensionStatus: \(\) => ipcRenderer\.invoke\('get-extension-status'\)/);
});

test('C7/G4.1-G4.3: the application menu is set before any window; no view menu; zoom levels reset', () => {
  const body = mainJs.slice(mainJs.indexOf('app.whenReady().then('));
  assert.ok(before(body, 'installApplicationMenu();', "addLog('Initializing"), 'among the first things on ready');
  assert.ok(before(body, 'installApplicationMenu();', 'startRuntime();'), 'before any window');
  assert.match(block('function installApplicationMenu('), /Menu\.setApplicationMenu\(process\.platform === 'darwin'\s*\? Menu\.buildFromTemplate\(\[\{ role: 'appMenu' \}, \{ role: 'editMenu' \}\]\)\s*: null\);/);
  assert.doesNotMatch(mainJs, /role:\s*'(viewMenu|reload|forceReload|toggleDevTools|zoomIn|zoomOut|resetZoom)'/);
  // Every surface clears a saved zoom level: the reset sits above the
  // webview-only return, so the dashboard, clip and login windows, OAuth
  // popups and pop-outs get it as well as the cells (G4.3).
  const wcc = mainJs.slice(mainJs.indexOf("app.on('web-contents-created'"));
  const wccBody = wcc.slice(0, wcc.indexOf('\n});'));
  const reset = wccBody.search(/contents\.on\('did-finish-load', \(\) => \{\s*try \{ contents\.setZoomLevel\(0\);/);
  assert.ok(reset > 0, 'zoom reset registered in web-contents-created');
  assert.ok(reset < wccBody.indexOf("if (contents.getType() !== 'webview') return;"), 'before the webview-only return');
  assert.equal((mainJs.match(/setZoomLevel\(0\)/g) || []).length, 1, 'one reset for everything, no per-window copies left to drift');
});

test('G4.2: DevTools cannot open in a packaged build on the dashboard or a stream guest', () => {
  assert.match(block('function createMainWindow('), /devTools: !app\.isPackaged/);
  const wcc = mainJs.slice(mainJs.indexOf("app.on('web-contents-created'"));
  assert.match(wcc.slice(0, wcc.indexOf('\n});')), /if \(app\.isPackaged\) webPreferences\.devTools = false;/);
});

test('saved clips: loadDashboard reads the old store through a page it writes under userData', () => {
  const fn = block('async function loadDashboard()');
  const readerAt = fn.indexOf("const reader = path.join(app.getPath('userData'), 'legacy-storage-reader.html');");
  const writeAt = fn.indexOf('fs.writeFileSync(reader,');
  const callAt = fn.indexOf('migrateFileOriginStorage({');
  assert.ok(readerAt > 0, 'the reader lives under userData, outside app.asar');
  assert.ok(writeAt > readerAt && callAt > writeAt, 'written before the import runs');
  const call = fn.slice(callAt, fn.indexOf('});', callAt));
  assert.match(call, /sourceFile: reader,/);
  assert.doesNotMatch(call, /__dirname|appRoot/, 'never a file inside the app');
  const fin = fn.slice(fn.indexOf('} finally {', callAt));
  assert.match(fin, /^\} finally \{\s*try \{ fs\.unlinkSync\(reader\); \}/, 'removed whatever happened');
});

test('a development run never writes a login item (it would register bare electron.exe)', () => {
  const fn = block('function applyStartupSettings()');
  const guard = fn.indexOf('if (!app.isPackaged) return;');
  assert.ok(guard > 0, 'isPackaged guard present');
  assert.ok(guard < fn.indexOf('syncLoginItem('), 'checked before any login item is read or written');
});

test('F27: the startup setting goes through syncLoginItem', () => {
  assert.match(block('function applyStartupSettings('), /syncLoginItem\(app, !!config\.launchOnStartup\)/);
  assert.doesNotMatch(mainJs, /getLoginItemSettings\(\)/);
});

test('F28: each go-live toast is kept referenced before it is shown', () => {
  const notify = block('function notifyGoLive(');
  assert.ok(before(notify, 'liveAlerts.keep(', 'notif.show()'));
});

test('F29: saveConfig refuses to write while the config is locked; loadConfig never salvages on existence alone', () => {
  const save = block('function saveConfig(');
  const lockCheck = save.indexOf('if (configWriteLocked)');
  assert.ok(lockCheck > 0, 'lock check present');
  for (const touch of ['saveConfigFile(', 'mkdirSync']) {
    assert.ok(lockCheck < save.indexOf(touch), `checked before ${touch}`);
  }
  // Every write goes through saveConfigFile, which flushes before it renames
  // (a crash once turned config.json into zeros; see config-store.js).
  assert.doesNotMatch(save, /writeFileSync|copyFileSync|renameSync/);
  // What the save could not do is said once, not on every save.
  assert.match(save, /if \(backupError && !configBackupWarned\) \{\s*configBackupWarned = true;/);
  assert.match(save, /if \(flushSkipped && !configFlushWarned\) \{\s*configFlushWarned = true;/);
  assert.match(save, /if \(configWriteLocked\) \{[\s\S]*?return;\s*\}/);
  const load = block('function loadConfig(');
  assert.match(load, /loadConfigFromDisk\(configPath/);
  assert.match(load, /result\.status === 'defaults'/);
  assert.doesNotMatch(load, /existsSync/);
  assert.match(load, /catch \(err\) \{[\s\S]*lockConfigWrites\(/, 'an unexpected throw also locks');
  assert.match(block('function startRuntime('), /if \(configWriteLocked\) promptConfigUnreadable\(\);/);
  assert.match(block("ipcMain.handle('import-config'"), /if \(configWriteLocked\) \{\s*return \{ success: false/);
  // The recovery copies are flushed like the config itself.
  assert.match(block("ipcMain.handle('import-config'"), /writeFileDurably\(`\$\{configPath\}\.preimport-/);
  assert.match(block("ipcMain.handle('export-config'"), /writeFileDurably\(filePath, /);
  assert.match(block('function sanitizeIncomingConfig('), /writeFileDurably\(salvagePath, /);
  // Issue 12: exporting in-memory defaults would be an empty "backup".
  const exp = block("ipcMain.handle('export-config'");
  assert.match(exp, /^ipcMain\.handle\('export-config', async \(\) => \{\s*(\/\/[^\n]*\n\s*)*if \(configWriteLocked\) \{\s*return \{ success: false, error: '[^']*nothing to export[^']*' \};/);
  assert.ok(exp.indexOf('if (configWriteLocked)') < exp.indexOf('showSaveDialog'), 'refused before the dialog');
  // Defaults must not overwrite user state outside config.json either.
  assert.match(block('function applyStartupSettings('), /if \(configWriteLocked\) return;/);
  assert.match(block('async function loadDashboard('), /if \(!config\.dashboardStorageMigrated && !configWriteLocked\)/);
});

test('r4-1: a Retry that reads the file scans the real list at once, not an interval later', () => {
  const retry = block('function retryConfigLoad(');
  const locked = retry.indexOf('if (configWriteLocked) {');
  const lockedReturn = retry.indexOf('return;', locked);
  assert.ok(locked > retry.indexOf('loadConfig();') && lockedReturn > locked, 'a failed retry asks again and stops');
  const scan = retry.indexOf('requestScan();');
  assert.ok(scan > lockedReturn, 'only once the file was read');
  // After the extensions and the reload: a cell opened before its extension
  // loaded never gets the content scripts, and the reloaded page picks up
  // what the scan opens through get-active-containers.
  assert.ok(before(retry, 'loadExtensions()', 'requestScan();'));
  assert.ok(before(retry, 'mainWindow.reload();', 'requestScan();'));
  assert.equal((retry.match(/requestScan\(\)/g) || []).length, 1);
  // A fresh scan: performScan would join one already reading the empty
  // default list, and the cards would stay 'Checking...'.
  assert.doesNotMatch(retry.replace(/\/\/[^\n]*/g, ''), /performScan/);
  // The reloaded dashboard reads the scan's results; one finishing during the
  // reload is not lost (renderer.js reads them again once its listeners exist).
  assert.match(mainJs, /ipcMain\.handle\('get-statuses', \(\) => \{\s*return lastScanResults;/);
  assert.match(mainJs, /ipcMain\.handle\('get-active-containers', \(\) => \{\s*return Array\.from\(activeWindows\.keys\(\)\);/);
});

test('F30/F76: every exit path finalizes sessions, saves, then flushes cookies', () => {
  const exit = block('function persistOnExit(');
  assert.ok(before(exit, 'finalizeAllSessions();', 'saveConfig();'), 'finalize before save or the numbers never reach disk');
  assert.ok(before(exit, 'saveConfig();', 'flushCookies();'), 'save first: the process may be killed any moment');
  assert.doesNotMatch(exit, /await|showMessageBox/);
  assert.match(mainJs, /app\.on\('before-quit', \(\) => persistOnExit\(\)\);/);
  assert.match(block('function createMainWindow('), /mainWindow\.on\('session-end', \(\) => \{[\s\S]*?persistOnExit\(\);/);
  const all = block('function finalizeAllSessions(');
  assert.match(all, /for \(const \[key, start\] of sessionStarts\)/, 'not activeWindows: the closed handler empties it first');
  assert.match(all, /sessionStarts\.clear\(\);/);
  // One-minute dirty flush instead of five.
  const runtime = block('function startRuntime(');
  assert.match(runtime, /if \(watchTimeDirty\) \{\s*saveConfig\(\);\s*watchTimeDirty = false;\s*\}\s*\}, 60000\);/);
});

test('F31: nothing is credited or opened while the dashboard renderer is dead', () => {
  assert.match(block('function startWatchTimeTracking('), /if \(!dashboardHealth\.creditsWatchTime \|\| activeWindows\.size === 0\) return;/);
  const spawn = block('function spawnStreamContainer(');
  assert.ok(before(spawn, 'if (!dashboardHealth.canOpenStreams)', 'activeWindows.set(key, true)'));
  assert.ok(before(spawn, 'if (!dashboardHealth.canOpenStreams)', 'config.watchTime.sessions ='));
  assert.match(block('async function doScan('), /config: dashboardHealth\.canOpenStreams \? config : \{ \.\.\.config, autoOpen: false \}/);
  const win = block('function createMainWindow(');
  const giveUp = win.slice(win.indexOf("plan.action === 'give-up'"));
  for (const call of ['finalizeAllSessions();', 'closeAllStreamContainers();', 'openedSessions.clear();']) {
    assert.ok(giveUp.includes(call), call);
  }
  assert.doesNotMatch(mainJs, /not reloading again/, 'no permanent give-up');
});

test('issue-13: bringing a dead dashboard forward reloads it at once (no menu, no Ctrl+R)', () => {
  const reload = block('function reloadDeadDashboardOnShow(');
  assert.match(reload, /!dashboardHealth\.reloadOnShow\) return;/);
  assert.match(reload, /clearTimeout\(dashboardReloadTimer\);\s*dashboardReloadTimer = null;/, 'the scheduled retry is dropped, not doubled');
  assert.match(reload, /mainWindow\.reload\(\);/);
  // Every way the user brings the window forward.
  const tray = block('function createTray(');
  assert.match(tray.slice(tray.indexOf("tray.on('click'")), /reloadDeadDashboardOnShow\(\);/);
  const menu = block('function buildTrayMenu(');
  assert.match(menu.slice(menu.indexOf("label: 'Show Dashboard'"), menu.indexOf("label: 'Force Scan Now'")), /reloadDeadDashboardOnShow\(\);/);
  const second = mainJs.slice(mainJs.indexOf("app.on('second-instance'"), mainJs.indexOf('app.whenReady()'));
  assert.ok(second.indexOf('reloadDeadDashboardOnShow();') > second.indexOf("argv.includes('--hidden')"), 'not for an autostart relaunch');
  // issue-3: clicking a go-live toast brings the window forward too. A dead
  // dashboard cannot open the stream, and the toast is gone after the click,
  // so the stream waits for the reload instead of being dropped.
  const notify = block('function notifyGoLive(');
  const click = notify.slice(notify.indexOf("notif.on('click'"), notify.indexOf("notif.on('failed'"));
  assert.ok(before(click, 'mainWindow.focus();', 'reloadDeadDashboardOnShow();'));
  assert.ok(before(click, 'reloadDeadDashboardOnShow();', 'if (!dashboardHealth.canOpenStreams) {'));
  assert.match(click, /if \(!dashboardHealth\.canOpenStreams\) \{\s*pendingAlertOpens\.add\(stream\.platform, stream\.username, Date\.now\(\)\);[\s\S]*?return;\s*\}\s*spawnStreamContainer\(stream\.platform, stream\.username\);/);
  const win = block('function createMainWindow(');
  const loaded = win.slice(win.indexOf("mainWindow.webContents.on('did-finish-load'"));
  const drain = loaded.slice(0, loaded.indexOf('});') + 3);
  assert.ok(before(drain, 'dashboardHealth.loaded();', 'pendingAlertOpens.take(Date.now())'), 'opened only once it can hold cells');
  assert.match(drain, /for \(const s of clicked\.open\) spawnStreamContainer\(s\.platform, s\.username\);/);
  // spawnStreamContainer marks the stream active before it sends, which is
  // what lets the renderer's get-active-containers restore pick it up.
  const spawn = block('function spawnStreamContainer(');
  assert.ok(before(spawn, 'activeWindows.set(key, true);', "webContents.send('open-stream-tab'"));
});

test('F32: no debugger is attached to the dashboard', () => {
  assert.doesNotMatch(mainJs, /debugger\.attach|Runtime\.enable|debugger\.sendCommand/);
});

test('F56/F70: the spoofed version comes from the engine; no dead raw-UA global', () => {
  assert.match(mainJs, /const SPOOF_CHROME = spoofedChromeVersion\(process\.versions\.chrome\);/);
  assert.doesNotMatch(mainJs, /'137(\.0\.0\.0)?'/);
  assert.doesNotMatch(mainJs, /defaultElectronUA/);
  assert.match(mainJs, /normalizedUserAgent = normalizeUserAgent\(rawUA, SPOOF_CHROME\.full\);/);
  assert.match(mainJs, /applyClientHints\(details\.requestHeaders \|\| \{\}, clientHints\)/);
});

test('F71: no console-message listener declares the deprecated positional arguments', () => {
  const listeners = [...mainJs.matchAll(/on\('console-message',\s*\(([^)]*)\)/g)].map(m => m[1]);
  // The dashboard's; the hidden Drops window had the other one (removed, F83).
  assert.ok(listeners.length >= 1);
  for (const params of listeners) assert.equal(params.trim(), 'event', params);
});

test('F74: the tray menu is built when opened (stored only on Linux, and refreshed there)', () => {
  const tray = block('function createTray(');
  assert.match(tray, /if \(process\.platform === 'linux'\) \{\s*tray\.setContextMenu\(buildTrayMenu\(\)\);\s*\} else \{\s*tray\.on\('right-click', \(\) => tray\.popUpContextMenu\(buildTrayMenu\(\)\)\);/);
  assert.equal((tray.match(/\.setContextMenu\(/g) || []).length, 1);
  assert.match(block('function buildTrayMenu('), /label: `Active Streams: \$\{activeWindows\.size\}`/);
  for (const fn of ['function spawnStreamContainer(', 'function sendStreamStatusToUI(', 'function closeAllStreamContainers(']) {
    assert.match(block(fn), /refreshTrayMenu\(\);/, fn);
  }
});

test('F106: packaged Linux builds ship icon.png and use it for the window and the tray', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8').replace(/\r\n/g, '\n'));
  // Both in app.asar: path.join(__dirname, ...) looks there. (linux.icon only
  // feeds the .desktop / AppImage icon; extraResources lands outside the asar.)
  assert.ok(pkg.build.files.includes('icon.png'), 'icon.png is packaged');
  assert.ok(pkg.build.files.includes('icon.ico'), 'icon.ico stays: the Windows tray wants its 16x16 frame');
  // nativeImage decodes .ico only on Windows.
  assert.match(block('function appIconPath('), /path\.join\(__dirname, process\.platform === 'win32' \? 'icon\.ico' : 'icon\.png'\)/);
  assert.match(block('function createMainWindow('), /icon: appIconPath\(\),/);
  const tray = block('function createTray(');
  assert.match(tray, /nativeImage\.createFromPath\(appIconPath\(\)\)/);
  assert.doesNotMatch(mainJs, /path\.join\(__dirname, 'icon\.ico'\)/, 'no hard-coded .ico left for other platforms');
  // The 16 px resize is for the Windows tray; an AppIndicator wants 22-24 px.
  assert.match(tray, /\} else if \(process\.platform !== 'linux'\) \{[\s\S]*?icon\.resize\(\{ width: 16, height: 16 \}\)/);
});

test('F76: the session length counter follows the credited minutes', () => {
  const ticker = block('function startWatchTimeTracking(');
  assert.ok(before(ticker, 'if (!verdict.credit) continue;', 'sessionMinutes.set(key, sessionMinutes.get(key) + 1)'));
  assert.match(block('function spawnStreamContainer('), /sessionMinutes\.set\(key, 0\);/);
  assert.match(block("ipcMain.handle('update-active-tabs'"), /sessionMinutes\.set\(t, 0\);/);
  assert.match(block('function finalizeSession('), /sessionLengthMs\(\{ startMs, endMs, creditedMinutes: sessionMinutes\.get\(key\) \}\)/);
  assert.match(block('function loadConfig('), /capLongestSessions\(config\.watchTime\)/);
});

test('F78: closing a stream by hand, auto-close, preemption or shutdown closes its pop-out', () => {
  assert.match(block('async function doScan('), /closeTab: \(platform, username\) => \{[\s\S]*?closePopout\(platform, username\);/);
  assert.match(block("ipcMain.handle('close-stream-container'"), /closePopout\(platform, username\);/);
  assert.match(block('function closeAllStreamContainers('), /closePopout\(/);
  const close = block('function closePopout(');
  assert.match(close, /String\(platform\)\.toLowerCase\(\)\}:\$\{String\(username\)\.toLowerCase\(\)/, 'lowercased like popoutWindows keys');
  assert.ok(before(close, 'popoutWindows.delete(key);', 'win.close()'));
});

test('F98: both Open dialogs pass a starting folder', () => {
  assert.match(block("ipcMain.handle('select-extension-folder'"), /defaultPath: extensionPickerDir\(/);
  assert.match(block("ipcMain.handle('import-config'"), /defaultPath: existingDir\(lastConfigDir\) \|\| app\.getPath\('documents'\)/);
  assert.match(block("ipcMain.handle('export-config'"), /lastConfigDir = path\.dirname\(filePath\);/);
});

test('F99: no invented switch or webPreferences key', () => {
  assert.doesNotMatch(mainJs, /disable-extension-sandbox|allFrames/);
  // nodeIntegrationInSubFrames was only on the hidden Drops window, which F83
  // removed with the rest of that dead subsystem.
  assert.doesNotMatch(mainJs, /nodeIntegrationInSubFrames/);
  assert.match(mainJs, /appendSwitch\('disable-renderer-backgrounding'/);
});
