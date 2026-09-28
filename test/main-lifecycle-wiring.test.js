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
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8');

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
  // Never the blocking boxes the handler exists to avoid.
  assert.doesNotMatch(mainJs, /showErrorBox|showMessageBoxSync/);
});

test('G2.1/G2.3: a startup failure cannot leave a process with no window or tray', () => {
  const ready = mainJs.indexOf('app.whenReady().then(');
  const chain = mainJs.slice(ready, mainJs.indexOf('\nlet runtimeStarted', ready));
  assert.match(chain, /try \{\s*await loadExtensions\(\);\s*\} catch \(err\) \{\s*reportFatal\('loadExtensions', err\);/);
  assert.match(chain, /\}\)\.catch\(\(err\) => \{\s*[\s\S]*reportFatal\('startup', err\);\s*startRuntime\(\);/);
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

test('C7/G4.1-G4.3: the application menu is set first; no view menu; zoom levels reset', () => {
  const body = mainJs.slice(mainJs.indexOf('app.whenReady().then('));
  assert.ok(before(body, 'Menu.setApplicationMenu(', "addLog('Initializing"), 'the very first thing on ready');
  assert.match(body, /Menu\.setApplicationMenu\(process\.platform === 'darwin'\s*\? Menu\.buildFromTemplate\(\[\{ role: 'appMenu' \}, \{ role: 'editMenu' \}\]\)\s*: null\);/);
  assert.doesNotMatch(mainJs, /role:\s*'(viewMenu|reload|forceReload|toggleDevTools|zoomIn|zoomOut|resetZoom)'/);
  // Dashboard, every webview guest, and pop-outs clear saved zoom levels.
  assert.match(block('function createMainWindow('), /on\('did-finish-load', \(\) => \{\s*dashboardHealth\.loaded\(\);[\s\S]*?setZoomLevel\(0\)/);
  const wcc = mainJs.slice(mainJs.indexOf("app.on('web-contents-created'"));
  const guestPart = wcc.slice(wcc.indexOf("contents.getType() !== 'webview'"), wcc.indexOf('\n});'));
  assert.match(guestPart, /contents\.on\('did-finish-load', \(\) => \{\s*try \{ contents\.setZoomLevel\(0\);/);
  assert.match(block("ipcMain.handle('popout-stream'"), /win\.webContents\.setZoomLevel\(0\)/);
});

test('G4.2: DevTools cannot open in a packaged build on the dashboard or a stream guest', () => {
  assert.match(block('function createMainWindow('), /devTools: !app\.isPackaged/);
  const wcc = mainJs.slice(mainJs.indexOf("app.on('web-contents-created'"));
  assert.match(wcc.slice(0, wcc.indexOf('\n});')), /if \(app\.isPackaged\) webPreferences\.devTools = false;/);
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
  for (const touch of ['writeFileSync', 'copyFileSync', 'renameSync', 'mkdirSync']) {
    assert.ok(lockCheck < save.indexOf(touch), `checked before ${touch}`);
  }
  assert.match(save, /if \(configWriteLocked\) \{[\s\S]*?return;\s*\}/);
  const load = block('function loadConfig(');
  assert.match(load, /loadConfigFromDisk\(configPath/);
  assert.match(load, /result\.status === 'defaults'/);
  assert.doesNotMatch(load, /existsSync/);
  assert.match(load, /catch \(err\) \{[\s\S]*lockConfigWrites\(/, 'an unexpected throw also locks');
  assert.match(block('function startRuntime('), /if \(configWriteLocked\) promptConfigUnreadable\(\);/);
  assert.match(block("ipcMain.handle('import-config'"), /if \(configWriteLocked\) \{\s*return \{ success: false/);
  // Defaults must not overwrite user state outside config.json either.
  assert.match(block('function applyStartupSettings('), /if \(configWriteLocked\) return;/);
  assert.match(block('async function loadDashboard('), /if \(!config\.dashboardStorageMigrated && !configWriteLocked\)/);
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
