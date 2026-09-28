const { app, BrowserWindow, ipcMain, session, dialog, net, Notification, Tray, Menu, nativeImage, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { extractZipBuffer } = require('./main/safe-unzip');
const { migrateProfileCookies } = require('./main/cookie-migration');
const {
  DASHBOARD_SCHEME, DASHBOARD_URL, DASHBOARD_SCHEME_PRIVILEGES,
  createDashboardHandler, migrateFileOriginStorage,
} = require('./main/dashboard-protocol');
const {
  isPlatformUrl, isOAuthPopupUrl, isAllowedTopLevelUrl, isAllowedFrameUrl, mayOpenExternally,
  sanitizeWebviewAttach, isPermissionAllowed, isTrustedDashboardSender,
  createExternalOpenGate, createLogThrottle, createDownloadAllowlist,
} = require('./main/web-security');
const { sanitizeConfig, scanIntervalMs, streamerPlatform, streamerName } = require('./main/config-sanitize');
const { SCAN_REQUEST_TIMEOUT_MS, fetchTextWithDeadline, parseJsonBody } = require('./main/scan-fetch');
const {
  checkTwitchGql, checkTwitchHelix, mergeFallbackResults, twitchCredentialKey, createTwitchTokenCache,
} = require('./main/twitch-scan');
const { parseYoutubeLivePage } = require('./main/youtube-live');
const { createStreamLiveness } = require('./main/stream-liveness');
const { applyScanResults } = require('./main/scan-planner');
const { createSingleFlight } = require('./main/scan-runner');
const { createFatalReporter, formatConsoleMessage } = require('./main/app-log');
const { loadConfigFromDisk, readConfigFileResult } = require('./main/config-store');
const { syncLoginItem } = require('./main/login-item');
const { createAlertKeeper } = require('./main/live-alerts');
const { spoofedChromeVersion, normalizeUserAgent, applyClientHints } = require('./main/ua-spoof');
const { createDashboardHealth } = require('./main/dashboard-health');
const { sessionLengthMs, capLongestSessions } = require('./main/session-stats');
const { existingDir, extensionPickerDir } = require('./main/dialog-dirs');
const { runPageScript, runScriptWithin, createProbeGate } = require('./main/hidden-page');
const {
  parseCookieBlob, planCookieWrites, shouldClearExisting, removalUrl,
  isYouTubeCookieDomain, assignPastedYouTubeDomains, hasGoogleSessionCookies,
} = require('./main/cookie-import');
const {
  placeholderName, isPlaceholderName, sameAccountName, hasKickSessionToken, youtubeAuthFingerprint,
  createAccountEpochs,
} = require('./main/account-state');
const { resolveTwitchUser: resolveTwitchUserVia, twitchUserFailureMessage, describeTwitchUserResult } = require('./main/twitch-user');
const { createLoginFlow } = require('./main/login-flow');
const { KICK_USER_SCRIPT, kickNameFrom } = require('./main/kick-user');
const {
  rendererConfigPatch, importedConfig, repairWatchTime, exportableConfig,
  normalizePairingCode, newPairingCode, isSignedOutIn, withSignedOut,
} = require('./main/config-boundary');
const { createReceiverHandler, createReceiverServer, createPairingGuard, listenOnFirstPort } = require('./main/cookie-receiver');
const { extensionPathKey, planExtensionSync, isInsideDir, checkReleaseAsset } = require('./main/extension-sync');
const { clipDownloadUrl, clipPageUrl, clipFileName } = require('./main/clip-download');
const { createScheduleSync } = require('./main/schedule-sync');

// One process per profile. Two Electron processes sharing a profile race the
// cookie store (a real one was wiped this way) and overwrite each other's
// config.json. A second launch just brings the running window forward (see the
// 'second-instance' handler); it must exit before touching anything.
if (!app.requestSingleInstanceLock()) {
  process.exit(0);
}

// Any stray main-process error is logged and the app keeps running. Without a
// listener Electron shows a modal error box that stops every scan, save and
// tray click until someone dismisses it (see app-log.js). Registered before
// anything else can throw.
const reportFatal = createFatalReporter({
  log: (text) => addLog(text),
  filePath: () => path.join(app.getPath('userData'), 'logs', 'main-errors.log'),
});
process.on('uncaughtException', (err, origin) => reportFatal(origin || 'uncaughtException', err));
process.on('unhandledRejection', (reason) => reportFatal('unhandledRejection', reason));

// For fire-and-forget work (timers, background checks): a throw or rejection
// is logged under its name instead of surfacing as an unhandled error.
function runSafely(label, fn) {
  return (...args) => {
    try {
      return Promise.resolve(fn(...args)).catch((err) => reportFatal(label, err));
    } catch (err) {
      reportFatal(label, err);
      return Promise.resolve();
    }
  };
}

// Must run before any session exists and before 'ready': Electron 42+ deletes a
// cookie database it considers too old to migrate, taking every platform login
// with it. See cookie-migration.js. Logged once addLog is usable.
const cookieMigrationResults = migrateProfileCookies(app.getPath('userData'));

// The dashboard is served from app://bundle (see dashboard-protocol.js). A
// scheme's privileges can only be registered before 'ready'.
protocol.registerSchemesAsPrivileged([{ scheme: DASHBOARD_SCHEME, privileges: DASHBOARD_SCHEME_PRIVILEGES }]);

// Disable backgrounding, occlusion, and timer throttling for hidden windows to ensure Kasada challenges run correctly
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'true');
app.commandLine.appendSwitch('disable-renderer-backgrounding', 'true');
app.commandLine.appendSwitch('disable-background-timer-throttling', 'true');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Constants
const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Cookie names that indicate a live Google/YouTube session. Covers the legacy
// pair (SID/SSID/HSID/APISID/SAPISID), the modern __Secure-1P/3P families that
// Google rotates on its own schedule, and YouTube's own LOGIN_INFO.
const YOUTUBE_AUTH_COOKIE = /^(SID|SSID|HSID|APISID|SAPISID|LOGIN_INFO|__Secure-[13]PSID(TS|CC)?|__Secure-[13]PAPISID)$/;

// Global variables
let mainWindow = null;
let tray = null;
const activeWindows = new Map(); // Key: platform:username -> true
const sessionStarts = new Map(); // Key: platform:username -> session start timestamp (ms), for duration tracking
// Key: platform:username -> minutes the ticker credited to the open session,
// which is what a session's length is measured in (see session-stats.js).
const sessionMinutes = new Map();
const popoutWindows = new Map(); // Key: platform:username -> always-on-top BrowserWindow (pop-out / PiP)
// Renderer crash recovery, and whether minutes currently count (see
// dashboard-health.js).
const dashboardHealth = createDashboardHealth();
let dashboardReloadTimer = null;
// Go-live toasts stay referenced until clicked, or their click would be lost
// (see live-alerts.js).
const liveAlerts = createAlertKeeper();
// Extension folders that were not reachable at the last load (an unmounted
// drive). They stay in config.extensions; only the user removes an entry.
const unavailableExtensions = new Set();
// Where the Open dialogs start next time (see dialog-dirs.js). In memory only:
// a config field would travel in every exported backup for no benefit.
let lastExtensionPickDir = null;
let lastConfigDir = null;
// Folders the user picked in select-extension-folder and main vetted. The
// dashboard adds an extension by saving its list with the new path in it;
// save-config accepts a new path only from here (see config-boundary.js).
const approvedExtensionPaths = new Set();
// Set when config.json exists but could not be read: the app runs on defaults
// in memory and saveConfig writes nothing, so the user's file is never
// overwritten (see config-store.js).
let configWriteLocked = false;
let configLockReason = '';
let configSkipLogged = false;
let configPromptOpen = false;
let config = {
  streamers: [],
  checkInterval: 3, // in minutes
  autoOpen: true,
  twitchClientId: '',
  twitchClientSecret: '',
  extensions: [], // List of absolute paths to unpacked extensions
  maxTwitchTabs: 2,
  maxKickTabs: 2,
  maxYoutubeTabs: 2,
  maxRumbleTabs: 2,
  twitchEnabled: true,
  kickEnabled: true,
  youtubeEnabled: true,
  rumbleEnabled: false, // Coming soon — Rumble support is not yet available; locked off in the UI.
  disabledAutoQuality: {},
  calendarEvents: [],
  syncedCalendarEvents: [],
  seventvLastUpdated: null
};
// Pristine copy, so a retried load does not merge over what the app did while
// it was running on defaults.
const CONFIG_DEFAULTS_JSON = JSON.stringify(config);

// Map of already opened stream session identifiers to prevent opening duplicate tabs/windows
// We store "platform:username:<broadcast id | liveSince | dateString>" (see scan-planner.js)
const openedSessions = new Map(); // key -> last seen timestamp, for time-based eviction
const notifiedSessions = new Map(); // key -> last seen timestamp; alert dedupe, separate from opening
// Per open stream: when a scan last confirmed it live. Gates auto-close and
// watch-time credit (see stream-liveness.js).
const streamLiveness = createStreamLiveness();
// The last scan's statuses, for a dashboard that (re)loads between scans.
let lastScanResults = [];

let pollIntervalId = null;
let countdownTimerId = null;
let nextScanTime = 0;
const logs = [];

// Spoofed Chrome identity for the embedded browser: Electron's UA without the
// Electron and app tokens, at floor(engine, 137), so it only ever raises the
// version and follows every Electron upgrade on its own. The UA string, the
// Sec-CH-UA headers and the preload's navigator.userAgentData must agree, or
// bot detection flags the mismatch as "browser not supported" (see
// ua-spoof.js). Every persist:default window, login included, uses
// normalizedUserAgent.
const SPOOF_CHROME = spoofedChromeVersion(process.versions.chrome);

let normalizedUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${SPOOF_CHROME.full} Safari/537.36`;

// Twitch OAuth app token, keyed to the credentials that minted it
const twitchTokens = createTwitchTokenCache();

// Watch time save debouncing
let watchTimeDirty = false;

// Helper to add a log entry and send it to the UI
function addLog(text) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] ${text}`;
  logs.push(logEntry);
  if (logs.length > 200) logs.shift(); // Keep last 200 logs

  console.log(logEntry);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', logEntry);
  }
}

// Get config path in appData
function getConfigPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'config.json');
}

// Read and parse a JSON object file (an imported backup). null if it is
// missing, unreadable, or not a JSON object.
function readConfigFile(filePath) {
  const r = readConfigFileResult(filePath);
  return r.status === 'ok' ? r.data : null;
}

// Load configuration, preferring config.json and falling back to the .bak copy
// written by saveConfig. A damaged file is always preserved as
// config.json.corrupt-<timestamp>. Defaults are written only when nothing is
// on disk; a file that exists but cannot be read (locked by a backup or sync
// tool, an unreachable drive) turns saving off instead, so it is never
// overwritten (see config-store.js).
function loadConfig() {
  const configPath = getConfigPath();
  try {
    const result = loadConfigFromDisk(configPath, { log: addLog });
    const loaded = result.status === 'loaded' || result.status === 'recovered' ? result.data : null;
    const recovered = result.status === 'recovered';
    configWriteLocked = false;
    configLockReason = '';

    if (loaded) {
      config = { ...config, ...loaded };

      // Initialize defaults for new settings. A watch-time container that is
      // not a plain object is replaced: `[]` passed the old falsy checks, and
      // every minute set on it was then dropped by JSON.stringify.
      const repairedWatch = repairWatchTime(config);
      if (repairedWatch.length) addLog(`[Config] Repaired unusable watch-time data: ${repairedWatch.join(', ')}.`);
      if (!config.calendarEvents) config.calendarEvents = [];
      if (!config.syncedCalendarEvents) config.syncedCalendarEvents = [];
      if (!config.seventvLastUpdated) config.seventvLastUpdated = null;
      if (!config.defaultQuality) config.defaultQuality = '160p';
      if (!config.disabledAutoQuality) config.disabledAutoQuality = {};
      if (!config.accounts) config.accounts = {};
      // Anyone with an existing config has already found their way around, so
      // don't greet upgraders with the first-run guide.
      if (config.onboardingComplete == null) config.onboardingComplete = true;

      // Rumble is a "coming soon" feature — force it off regardless of any
      // stale saved value so the scanner never polls it.
      config.rumbleEnabled = false;

      // Before anything reads the list or the interval: one bad entry used to
      // make every scan throw, and a null interval a 1 ms scan loop.
      sanitizeIncomingConfig(config, 'config.json');

      // Longest sessions used to be wall-clock time, sleep included; one
      // session can never exceed that streamer's total (see session-stats.js).
      const repaired = capLongestSessions(config.watchTime);
      if (repaired.length) addLog(`[Config] Corrected ${repaired.length} longest-session record(s) that exceeded the streamer's total watch time.`);

      if (recovered) {
        addLog('[Config] Recovered configuration from config.json.bak — watch history and streamers are intact.');
        saveConfig(); // rewrite a healthy config.json from the recovered data
      } else {
        addLog('Configuration loaded successfully.');
      }
    } else if (result.status === 'defaults') {
      addLog('No existing configuration found. Creating defaults...');
      applyFreshConfigDefaults();
      config.onboardingComplete = false; // fresh install → run the setup guide
      saveConfig(config);
    } else {
      lockConfigWrites(`${result.reason}${result.error ? ` (${result.error})` : ''}`);
    }
  } catch (err) {
    // State unknown (possibly half-merged): never write it over the file.
    lockConfigWrites(`loading it failed: ${err.message}`);
  }
}

function applyFreshConfigDefaults() {
  config.watchTime = { streamers: {}, platforms: { twitch: 0, kick: 0, youtube: 0, rumble: 0 }, sessions: 0, streamerSessions: {}, daily: {}, longestSessionMs: 0, streamerLongestMs: {}, streamerLastSeen: {} };
  config.calendarEvents = [];
  config.syncedCalendarEvents = [];
  config.seventvLastUpdated = null;
  config.defaultQuality = '160p';
  config.disabledAutoQuality = {};
  config.accounts = {};
}

// config.json exists but could not be used: run on defaults in memory, write
// nothing. The user is asked to retry (promptConfigUnreadable) once the
// window exists.
function lockConfigWrites(reason) {
  configWriteLocked = true;
  configLockReason = reason;
  configSkipLogged = false;
  config = JSON.parse(CONFIG_DEFAULTS_JSON);
  applyFreshConfigDefaults();
  // Their setup is still in the file; the first-run guide would mislead.
  config.onboardingComplete = true;
  addLog(`[Config] Could not read your settings: ${reason}. Running on defaults and saving nothing, so config.json is left untouched.`);
}

// Asynchronous on purpose: a blocking dialog would stop every timer and IPC
// call while it waits.
function promptConfigUnreadable() {
  if (!configWriteLocked || configPromptOpen) return;
  configPromptOpen = true;
  const options = {
    type: 'error',
    title: 'Stream Lurker',
    message: 'Stream Lurker could not read its settings file.',
    detail: `${configLockReason.charAt(0).toUpperCase()}${configLockReason.slice(1)}.\n\n${getConfigPath()}\n\n`
      + 'Your streamers and watch history are still in that file. Until it can be read, Stream Lurker runs without them and saves nothing, so the file is not overwritten.\n\n'
      + 'This usually means a backup, sync or antivirus program is holding the file, or the drive it is on is not available yet.',
    buttons: ['Retry', 'Keep running without saving', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    .then(({ response }) => {
      configPromptOpen = false;
      if (response === 0) retryConfigLoad();
      else if (response === 2) { app.isQuitting = true; app.quit(); }
      else addLog('[Config] Running without your saved settings. Nothing will be saved until Stream Lurker is restarted and can read the file.');
    })
    .catch((err) => {
      configPromptOpen = false;
      reportFatal('config prompt', err);
    });
}

function retryConfigLoad() {
  config = JSON.parse(CONFIG_DEFAULTS_JSON);
  loadConfig();
  if (configWriteLocked) {
    promptConfigUnreadable();
    return;
  }
  addLog('[Config] Settings file read. Reloading the dashboard with your saved settings.');
  applyStartupSettings();
  resetPoller();
  // Extensions first: a cell created before its extension loaded never gets
  // the content scripts.
  loadExtensions()
    .catch((err) => reportFatal('loadExtensions', err))
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    });
}

// Save configuration
// config.json holds everything the user can't get back — monitored streamers,
// watch history, streaks, credentials, calendar. Write it atomically (temp file
// + rename) and keep the previous good copy as .bak, so a crash or kill during
// a write can never leave a truncated file behind.
function saveConfig(newConfig) {
  if (newConfig) config = newConfig;
  // Before .tmp, .bak or config.json is touched: defaults in memory must never
  // replace a config that exists but could not be read.
  if (configWriteLocked) {
    if (!configSkipLogged) {
      configSkipLogged = true;
      addLog('[Config] Not saving: your settings file could not be read at startup, so changes made now are kept in memory only.');
    }
    return;
  }
  const configPath = getConfigPath();
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(config, null, 2);
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, json, 'utf8');

    // Roll the current file to .bak only once the replacement is safely on disk.
    if (fs.existsSync(configPath)) {
      try { fs.copyFileSync(configPath, `${configPath}.bak`); } catch (e) { /* best effort */ }
    }

    fs.renameSync(tmpPath, configPath); // atomic replace
  } catch (err) {
    addLog(`Error saving config: ${err.message}`);
  }
}

// Normalizes a config arriving from disk, an import or the dashboard (see
// config-sanitize.js), in place. The streamer list is irreplaceable, so any
// entry it cannot use is written to config.json.dropped-streamers-<time>.json
// before the next save can lose it, together with any the caller already
// refused (`alreadyDropped`, from an import).
function sanitizeIncomingConfig(cfg, source, alreadyDropped = []) {
  const { clamped, dropped: normalizerDropped } = sanitizeConfig(cfg);
  const dropped = [...alreadyDropped, ...normalizerDropped];
  for (const c of clamped) {
    addLog(`[Config] ${c.key} from ${source} was ${JSON.stringify(c.from)}; using ${c.to}.`);
  }
  if (!dropped.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const salvagePath = `${getConfigPath()}.dropped-streamers-${stamp}.json`;
  try {
    fs.writeFileSync(salvagePath, JSON.stringify({ source, dropped }, null, 2), 'utf8');
    addLog(`[Config] Set aside ${dropped.length} unusable monitored-streamer entr${dropped.length === 1 ? 'y' : 'ies'} from ${source}; preserved in ${path.basename(salvagePath)}.`);
  } catch (e) {
    addLog(`[Config] Could not preserve unusable streamer entries from ${source}: ${e.message}`);
  }
  for (const d of dropped) {
    let shown;
    try { shown = JSON.stringify(d.entry); } catch (e) { shown = String(d.entry); }
    addLog(`[Config] Skipped streamer entry (${d.reason}): ${String(shown).slice(0, 120)}`);
  }
}

// Load a SINGLE extension into the live persist:default session so a freshly
// installed addon takes effect without an app restart. Returns the loaded
// extension info or throws. Open stream containers must be reloaded to pick it up.
async function loadSingleExtension(extPath) {
  const ses = session.fromPartition('persist:default');
  if (!fs.existsSync(extPath)) throw new Error(`Extension path does not exist: ${extPath}`);
  // Already loaded from this folder (a late retry, a reconcile): keep the
  // running copy. An update unloads the old copy first (unloadExtensionsUnder),
  // so this never keeps an outdated version.
  const key = extensionPathKey(extPath);
  const already = getLoadedExtensions(ses).find(e => e.path && extensionPathKey(e.path) === key);
  if (already) return already;

  if (ses.extensions) {
    return await ses.extensions.loadExtension(extPath, { allowFileAccess: true });
  }
  return await ses.loadExtension(extPath, { allowFileAccess: true });
}

// Extension API moved onto session.extensions; older Electron had it on the
// session itself.
function getLoadedExtensions(ses) {
  try {
    if (ses.extensions) return ses.extensions.getAllExtensions();
    if (typeof ses.getAllExtensions === 'function') return ses.getAllExtensions();
  } catch (e) { /* session going away */ }
  return [];
}

function removeLoadedExtension(ses, id) {
  if (ses.extensions) ses.extensions.removeExtension(id);
  else ses.removeExtension(id);
}

// Unloads every extension loaded from `dir` or below it, before its files are
// replaced or deleted: Chromium keeps serving a loaded extension's files (and
// on Windows its service worker holds them open, so the folder cannot be
// renamed). Returns the paths it unloaded.
function unloadExtensionsUnder(dir) {
  const ses = session.fromPartition('persist:default');
  const unloaded = [];
  for (const ext of getLoadedExtensions(ses)) {
    if (!ext || !ext.path || !isInsideDir(ext.path, dir)) continue;
    try {
      removeLoadedExtension(ses, ext.id);
      unloaded.push(ext.path);
    } catch (err) {
      addLog(`Could not unload extension ${ext.name || ext.id}: ${err.message}`);
    }
  }
  return unloaded;
}

// Load Chrome extensions into the persistent stream session.
// Stream cell webviews use partition="persist:default", so that's the only
// session that needs them. Loading into defaultSession as well races the
// same extension ID against itself and the service worker registration fails
// with "File currently in use" — which kills 7TV's background functionality.
// Makes the loaded set match config.extensions: unloads what is no longer
// configured, leaves what is already running, loads the rest. Resolves
// { loaded, unloaded } counts, so a caller can reload the stream cells when
// something changed (content scripts only come and go on a page load).
async function loadExtensions() {
  const targets = [
    session.fromPartition('persist:default')
  ];
  const changed = { loaded: 0, unloaded: 0 };

  for (const ses of targets) {
    const sesName = ses === session.defaultSession ? 'default' : 'persist:default';

    // A snapshot, and only real paths: a non-list here used to throw before
    // the window and tray existed (the normalizer should have caught it).
    const paths = Array.isArray(config.extensions) ? config.extensions.filter(p => typeof p === 'string' && p) : [];
    const loadedExts = getLoadedExtensions(ses);
    const plan = planExtensionSync(loadedExts, paths);
    if (loadedExts.length) addLog(`Currently loaded extensions in session (${sesName}): ${loadedExts.length}`);

    for (const id of plan.unload) {
      const ext = loadedExts.find(e => e.id === id);
      try {
        removeLoadedExtension(ses, id);
        changed.unloaded++;
        addLog(`Unloaded extension ${ext && ext.name ? ext.name : id}: it is no longer in the list.`);
      } catch (err) {
        addLog(`Could not unload extension ${id}: ${err.message}`);
      }
    }

    unavailableExtensions.clear();
    // Once each: a folder listed twice (or in two spellings) loads once.
    const toLoad = new Set(plan.load);
    for (const extPath of paths) {
      if (!toLoad.delete(extPath)) continue;
      try {
        if (fs.existsSync(extPath)) {
          const extName = path.basename(extPath);
          addLog(`Loading extension into ${sesName} from: ${extPath}...`);
          
          let ext;
          if (ses.extensions) {
            ext = await ses.extensions.loadExtension(extPath, { allowFileAccess: true });
          } else {
            ext = await ses.loadExtension(extPath, { allowFileAccess: true });
          }
          
          const name = ext.manifest ? ext.manifest.name : (ext.name || extName);
          const version = ext.version || '1.0';
          changed.loaded++;
          addLog(`Successfully loaded extension in ${sesName}: ${name} (${version})`);
        } else {
          // Never removed here: a network drive, USB stick or locked volume
          // that is not mounted yet at sign-in reads exactly like a deleted
          // folder. Only the user's Remove button drops an entry.
          unavailableExtensions.add(extPath);
          addLog(`Extension folder not reachable, skipping it this launch: ${extPath}`);
        }
      } catch (err) {
        addLog(`Failed to load extension at ${extPath} in ${sesName}: ${err.message}`);
      }
    }
  }
  return changed;
}

// One late pass for folders that were not reachable at startup: mapped drives
// reconnect lazily after sign-in. Loads only those that have appeared since
// (loadSingleExtension skips one already loaded), then reloads the open cells
// so the late extension's content scripts inject.
async function retryUnavailableExtensions() {
  if (!unavailableExtensions.size) return;
  let loadedAny = false;
  for (const extPath of [...unavailableExtensions]) {
    if (!fs.existsSync(extPath)) continue;
    try {
      await loadSingleExtension(extPath);
      unavailableExtensions.delete(extPath);
      loadedAny = true;
      addLog(`Extension folder is reachable now; loaded it: ${extPath}`);
    } catch (err) {
      addLog(`Failed to load extension at ${extPath} on retry: ${err.message}`);
    }
  }
  if (loadedAny && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reload-stream-containers');
  }
}



// ── Web content security ───────────────────────────────────────────────────
// Every page the app hosts is created through web-contents-created, so the
// policy is installed there once rather than per window. The rules themselves
// are in main/web-security.js.

// Which kind of surface a webContents is (see isAllowedTopLevelUrl). Webview
// guests are always 'stream'; windows are tagged right after they are created.
const contentsRoles = new WeakMap();
function setContentsRole(contents, role) {
  if (contents) contentsRoles.set(contents, role);
}
function contentsRole(contents) {
  try {
    if (contents.getType() === 'webview') return 'stream';
  } catch (e) { /* destroyed */ }
  return contentsRoles.get(contents) || 'other';
}

const externalOpenGate = createExternalOpenGate();
const securityLogThrottle = createLogThrottle();
const clipDownloads = createDownloadAllowlist();

// Input that means the user asked for something, as opposed to a page script.
const USER_GESTURE_INPUTS = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap', 'touchEnd']);

function logSecurityOnce(key, text) {
  if (securityLogThrottle.shouldLog(key)) addLog(`[Security] ${text}`);
}

// For log lines: the origin, or just the scheme for a non-web URL
// (ms-settings:, file:), whose origin would print as "null".
function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin !== 'null' ? u.origin : u.protocol;
  } catch (e) {
    return String(url || '').slice(0, 80);
  }
}

function frameUrlOf(event) {
  try { return event.senderFrame ? event.senderFrame.url : ''; } catch (e) { return ''; }
}

// The window the user would have clicked in: a webview's host window, or the
// contents' own window.
function isOpenerFocused(contents) {
  try {
    const owner = contents.getType() === 'webview' ? contents.hostWebContents : contents;
    const win = owner && BrowserWindow.fromWebContents(owner);
    return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  } catch (e) {
    return false;
  }
}

// Send a link a page tried to open to the user's real browser, but only right
// after they clicked it (createExternalOpenGate), never from a hidden window,
// and only http(s): any other scheme would reach ShellExecute.
function openExternallyIfClicked(contents, url, what) {
  const role = contentsRole(contents);
  const verdict = mayOpenExternally(role)
    ? externalOpenGate.decide(contents, url, { focused: isOpenerFocused(contents) })
    : { open: false, reason: 'hidden window' };
  if (verdict.open) {
    setImmediate(() => shell.openExternal(verdict.href).catch(() => {}));
    addLog(`[Security] Opened ${what} from a ${role} page in your browser: ${verdict.href.slice(0, 160)}`);
  } else {
    logSecurityOnce(`${what}|${role}|${originOf(url)}|${verdict.reason}`, `Blocked ${what} from a ${role} page to ${originOf(url)} (${verdict.reason}).`);
  }
}

function handleWindowOpen(contents, { url }) {
  // Kick's "Continue with Google / Apple" may need a real popup. Allow exactly
  // those hosts, from a login window only; the child is sandboxed and closes
  // with its opener.
  if (contentsRole(contents) === 'login' && isOAuthPopupUrl(url)) {
    addLog(`[Auth] Allowed sign-in popup to ${originOf(url)}.`);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: BrowserWindow.fromWebContents(contents) || undefined,
        width: 500,
        height: 700,
        autoHideMenuBar: true,
        backgroundColor: '#09090b',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      },
    };
  }
  openExternallyIfClicked(contents, url, 'a popup');
  return { action: 'deny' };
}

// Keeps each surface on the sites it exists for, so an off-platform page never
// sits inside the app's chrome looking like part of it. A blocked link the user
// clicked goes to their browser instead.
function guardTopLevelNavigation(contents, url, how) {
  const role = contentsRole(contents);
  if (isAllowedTopLevelUrl(role, url)) return true;
  if (how === 'link') openExternallyIfClicked(contents, url, 'a link');
  else logSecurityOnce(`redirect|${role}|${originOf(url)}`, `Blocked a ${role} page from redirecting to ${originOf(url)}.`);
  return false;
}

app.on('web-contents-created', (event, contents) => {
  // Three routes to the same fact (the user clicked or typed here), so gesture
  // detection does not hinge on any one of them reaching a webview guest.
  const noteGesture = (e, input) => {
    if (input && USER_GESTURE_INPUTS.has(input.type)) externalOpenGate.noteGesture(contents);
  };
  contents.on('input-event', noteGesture);
  contents.on('before-mouse-event', noteGesture);
  contents.on('before-input-event', noteGesture);

  // Webviews keep allowpopups: without it a target=_blank link dies inside
  // Chromium before this handler runs and cannot be sent to the browser.
  contents.setWindowOpenHandler((details) => handleWindowOpen(contents, details));

  contents.on('did-create-window', (child) => {
    setContentsRole(child.webContents, contentsRole(contents));
    child.setMenuBarVisibility(false);
  });

  // Fires on the EMBEDDER. Only the dashboard embeds pages, only stream pages
  // on the stream partition, and never with a preload, Node or web security
  // off, whatever the <webview> markup asked for.
  contents.on('will-attach-webview', (e, webPreferences, params) => {
    const verdict = sanitizeWebviewAttach(webPreferences, params);
    if (contentsRole(contents) !== 'dashboard') {
      verdict.allow = false;
      verdict.reason = 'only the dashboard may embed pages';
    }
    if (!verdict.allow) {
      e.preventDefault();
      addLog(`[Security] Refused to attach a <webview>: ${verdict.reason}.`);
    }
    // No DevTools on the signed-in platform pages in a shipped build.
    if (app.isPackaged) webPreferences.devTools = false;
  });

  contents.on('will-navigate', (e, legacyUrl) => {
    if (!guardTopLevelNavigation(contents, e.url || legacyUrl, 'link')) e.preventDefault();
  });

  // Server redirects skip will-navigate. Only stream surfaces are held to the
  // list here: login and probe windows legitimately bounce through Google's
  // cookie-setting hosts.
  contents.on('will-redirect', (e, legacyUrl, isInPlace, legacyIsMainFrame) => {
    const isMainFrame = e.isMainFrame !== undefined ? e.isMainFrame : legacyIsMainFrame;
    if (!isMainFrame || contentsRole(contents) !== 'stream') return;
    if (!guardTopLevelNavigation(contents, e.url || legacyUrl, 'redirect')) e.preventDefault();
  });

  // Any frame of a third-party page: web schemes only, so an iframe cannot be
  // pointed at file:, app: or a registered protocol handler.
  contents.on('will-frame-navigate', (e) => {
    const role = contentsRole(contents);
    if (isAllowedFrameUrl(role, e.url)) return;
    e.preventDefault();
    const scheme = String(e.url || '').split(':')[0].slice(0, 40);
    logSecurityOnce(`frame|${role}|${scheme}`, `Blocked a frame in a ${role} page from opening ${scheme}: (only web addresses are allowed).`);
  });

  // Mute every stream webview the instant its webContents exists. The renderer
  // also mutes on dom-ready, but on a heavy page (Twitch/YouTube) that can fire
  // seconds after audio starts, so a newly auto-opened stream would blast sound
  // until then. Muting here happens before the page loads and can't be overridden
  // by page JS. Grid cells always start muted; the cell's unmute button still
  // works normally. Only webviews are affected — pop-out/clip/login windows are
  // BrowserWindows and keep their own audio.
  if (contents.getType() !== 'webview') return;
  try { contents.setAudioMuted(true); } catch (e) { /* already gone */ }

  // The old default menu's Ctrl+/- zoomed a cell's site and saved that level
  // per host in the profile, reflowing every cell of that platform, with no
  // way back in the UI. The menu is gone; this clears what it left behind
  // (level 0 removes the saved entry).
  contents.on('did-finish-load', () => {
    try { contents.setZoomLevel(0); } catch (e) { /* already gone */ }
  });
});

// Every ipcMain.handle channel is the dashboard's privileged API (config,
// cookies, logins, downloads). Wrapping registration once means each handler,
// including any added later in this file, refuses calls from anything but the
// dashboard's own top frame on app://bundle.
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => registerIpcHandler(channel, (event, ...args) => {
  const dashboard = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!isTrustedDashboardSender(event, dashboard)) {
    logSecurityOnce(`ipc|${channel}`, `Refused IPC "${channel}" from ${originOf(frameUrlOf(event)) || 'a closed frame'}.`);
    throw new Error(`"${channel}" is only available to the Stream Lurker dashboard`);
  }
  return listener(event, ...args);
});

// Deny-by-default permissions and downloads for a session. Must run before any
// page loads on it: with no handler Electron grants every permission, including
// camera, microphone, screen capture and launching external protocol handlers.
const lockedSessions = new WeakSet();
function lockDownSession(ses) {
  if (!ses || lockedSessions.has(ses)) return;
  lockedSessions.add(ses);

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const from = (details && details.requestingUrl) || '';
    const allowed = isPermissionAllowed(permission, from);
    if (!allowed) {
      try {
        const target = permission === 'openExternal' && details && details.externalURL
          ? ` (a ${String(details.externalURL).split(':')[0].slice(0, 40)}: link)`
          : '';
        logSecurityOnce(`perm|${permission}|${originOf(from)}`, `Denied "${permission}"${target} to ${originOf(from) || 'an unknown page'}.`);
      } catch (e) { /* logging must never leave the page's request hanging */ }
    }
    callback(allowed);
  });
  // Checks default to granted too (permissions.query, clipboard reads,
  // notifications), and must agree with the request handler.
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => isPermissionAllowed(permission, requestingOrigin));
  // WebHID / WebUSB / Web Serial.
  ses.setDevicePermissionHandler(() => false);

  ses.on('will-download', handleWillDownload);
}

// Downloads go through only when the dashboard asked for them (download-clip).
// Anything a page starts, in a stream cell, pop-out, probe or clip window, is
// cancelled rather than popping a native Save dialog over the app.
function handleWillDownload(event, item, contents) {
  const fromDashboard = !!mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents;
  const filename = fromDashboard ? clipDownloads.take(item.getURLChain()) : null;
  if (filename) {
    item.setSaveDialogOptions({ defaultPath: filename });
    return;
  }
  event.preventDefault();
  logSecurityOnce(`download|${originOf(item.getURL())}`, `Blocked a download the app did not ask for: ${String(item.getFilename()).slice(0, 80)} from ${item.getURL().slice(0, 120)}`);
}

// Covers any session created later (a new partition, an extension's) too.
app.on('session-created', lockDownSession);

// Create Main Dashboard Window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#09090b',
    icon: path.join(__dirname, 'icon.ico'),
    // Keep the player's fullscreen button contained: with the window not
    // fullscreenable, an HTML5 fullscreen request still expands the <webview>
    // to fill the app window, but Electron won't also throw the window into
    // OS fullscreen. (Maximize is unaffected; see webview:fullscreen in
    // style.css, which cancels the grid's scaling transform while expanded.)
    fullscreenable: false,
    // Held back until ready-to-show so the dashboard never paints half-built —
    // and so a startup/tray launch can skip showing it altogether.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The dashboard renders network data (titles, clip cards), so a renderer
      // bug there must stay inside Chromium's sandbox. preload.js only needs
      // require('electron'), which a sandboxed preload provides.
      sandbox: true,
      webviewTag: true,
      // Nothing opens DevTools in a shipped build (no menu, no accelerator);
      // this makes it impossible rather than merely unreachable.
      devTools: !app.isPackaged
    }
  });
  setContentsRole(mainWindow.webContents, 'dashboard');

  // Also the only sink for uncaught dashboard errors ("Uncaught ..." at level
  // 'error'), since no debugger is attached (it pinned every logged object in
  // the renderer heap for the whole uptime).
  mainWindow.webContents.on('console-message', (event) => {
    addLog(formatConsoleMessage('MainWindow', event));
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    addLog(`[System - MainWindow] Renderer process gone! Reason: ${details.reason}, Exit Code: ${details.exitCode}`);

    // A dead renderer leaves a blank, unresponsive window forever (reported
    // after multi-day uptime). Reload it so the dashboard comes back on its
    // own; the renderer re-creates any stream containers still tracked here.
    // Back off if it keeps dying so we never spin in a crash-reload loop.
    // Until it has loaded again no minute is credited and nothing is opened
    // (see dashboard-health.js).
    const plan = dashboardHealth.gone(details.reason, Date.now(), { quitting: !!app.isQuitting });
    if (plan.action === 'none') return;

    if (plan.action === 'give-up') {
      // Nothing will be watched for a long while: end every session now at
      // its real length, and forget what was opened, so the scanner reopens
      // live streams once the dashboard is back.
      addLog(`[System - MainWindow] Dashboard crashed repeatedly. Watch time is stopped; trying again in ${Math.round(plan.delayMs / 60000)} minutes.`);
      finalizeAllSessions();
      closeAllStreamContainers();
      openedSessions.clear();
    } else {
      addLog(`[System - MainWindow] Reloading dashboard to recover (attempt ${plan.attempt}/${plan.max})...`);
    }
    if (dashboardReloadTimer) clearTimeout(dashboardReloadTimer);
    dashboardReloadTimer = setTimeout(() => {
      dashboardReloadTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, plan.delayMs);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    dashboardHealth.loaded();
    // A zoom level the old default menu saved for the dashboard (it also
    // cascaded onto every attached cell).
    try { mainWindow.webContents.setZoomLevel(0); } catch (e) { /* closing */ }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    addLog(`[System - MainWindow] Load failed! Error Code: ${errorCode}, Description: ${errorDescription}, URL: ${validatedURL}`);
  });

  // Windows shutdown, restart and sign-out never emit before-quit, and are
  // this tray app's normal way to exit. Must stay synchronous: Windows may end
  // the process as soon as the handler returns.
  mainWindow.on('session-end', () => {
    addLog('[System] Windows is ending the session. Saving watch time.');
    persistOnExit();
  });

  // Remove default menu bar
  mainWindow.setMenuBarVisibility(false);

  // Load dashboard
  loadDashboard().catch((err) => addLog(`[System - MainWindow] Dashboard load error: ${err.message}`));

  mainWindow.once('ready-to-show', () => {
    if (shouldStartHidden()) {
      addLog('[System] Started minimised — running in the system tray.');
      return; // tray icon (and its Show Dashboard item) is the way back in
    }
    mainWindow.show();
  });

  // Open DevTools only in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (event) => {
    // Minimize to tray instead of quitting when tray exists
    if (tray && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      addLog('[System] Minimized to system tray. Right-click tray icon for options.');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Close all open stream containers when the main dashboard is closed
    closeAllStreamContainers();
  });
}

// Loads app://bundle/index.html. The first launch on app:// carries the old
// file:// localStorage (saved clips) across first, while mainWindow already
// exists: the import window is the only other one, and destroying the last
// window would quit the app. A failed import leaves the flag unset so the next
// launch retries; it merges rather than overwrites, so nothing saved meanwhile
// is lost.
async function loadDashboard() {
  // Not while running on defaults: the real flag is in the unreadable file.
  if (!config.dashboardStorageMigrated && !configWriteLocked) {
    const r = await migrateFileOriginStorage({
      BrowserWindow,
      appRoot: __dirname,
      flushStorage: () => session.defaultSession.flushStorageData(),
    });
    if (r.status === 'failed') {
      addLog(`[Upgrade] Could not carry dashboard data (saved clips) over to the new app origin: ${r.error}. Will retry next launch.`);
    } else {
      if (r.status === 'imported' && r.keys.length) {
        addLog(`[Upgrade] Carried dashboard data over to the new app origin: ${r.keys.join(', ')}.`);
      }
      config.dashboardStorageMigrated = true;
      saveConfig();
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(DASHBOARD_URL).catch((err) => {
      addLog(`[System - MainWindow] Dashboard failed to load from ${DASHBOARD_URL}: ${err.message}`);
    });
  }
}

// Close all active stream containers
function closeAllStreamContainers() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('close-all-stream-tabs');
  }
  activeWindows.clear();
  for (const key of [...popoutWindows.keys()]) {
    const i = key.indexOf(':');
    closePopout(key.slice(0, i), key.slice(i + 1));
  }
  refreshTrayMenu();
}

// Closing a stream closes every surface it has. A pop-out left behind kept
// playing always-on-top, outside the tab limits and uncredited.
function closePopout(platform, username) {
  const key = `${String(platform).toLowerCase()}:${String(username).toLowerCase()}`;
  const win = popoutWindows.get(key);
  // Deleted first; the window's own 'closed' handler stays as the backstop and
  // still tells the dashboard.
  popoutWindows.delete(key);
  if (win && !win.isDestroyed()) win.close();
}

// Spawns a dedicated browser container window for a live streamer
function spawnStreamContainer(platform, username) {
  const key = `${platform.toLowerCase()}:${username.toLowerCase()}`;

  if (activeWindows.has(key)) {
    addLog(`Tab for ${platform}:${username} is already active.`);
    return;
  }

  // A dead dashboard drops open-stream-tab: nothing would play, yet a session
  // would be counted and its minutes credited.
  if (!dashboardHealth.canOpenStreams) {
    addLog(`Not opening ${platform}:${username}: the dashboard is recovering from a crash.`);
    return;
  }

  addLog(`Spawning stream tab for ${platform}:${username}...`);
  activeWindows.set(key, true);

  // Count this as a new lurk session for leaderboard stats (global + per-streamer)
  // and record the start time so we can measure this session's duration on close.
  if (!config.watchTime) {
    config.watchTime = { streamers: {}, platforms: { twitch: 0, kick: 0, youtube: 0, rumble: 0 }, sessions: 0, streamerSessions: {} };
  }
  if (!config.watchTime.streamerSessions) config.watchTime.streamerSessions = {};
  if (!config.watchTime.streamerLastSeen) config.watchTime.streamerLastSeen = {};
  config.watchTime.sessions = (config.watchTime.sessions || 0) + 1;
  config.watchTime.streamerSessions[key] = (config.watchTime.streamerSessions[key] || 0) + 1;
  config.watchTime.streamerLastSeen[key] = Date.now();
  sessionStarts.set(key, Date.now());
  sessionMinutes.set(key, 0);
  streamLiveness.start(key, Date.now());
  watchTimeDirty = true;
  refreshTrayMenu();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-stream-tab', { platform, username });
    mainWindow.webContents.send('watch-time-update', config.watchTime);
  }
}

// Send current open streams list to dashboard
function sendStreamStatusToUI() {
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    const openStreams = Array.from(activeWindows.keys());
    mainWindow.webContents.send('active-containers-update', openStreams);
  }
}

// Per-streamer alert/open behaviour. Entries saved before this feature existed
// have no `mode`, so treat a missing value as 'auto' — those users keep exactly
// the behaviour they had.
function getStreamerMode(platform, username) {
  const p = (platform || '').toLowerCase();
  const u = (username || '').toLowerCase();
  const entry = config.streamers.find(
    s => streamerPlatform(s) === p && streamerName(s).toLowerCase() === u
  );
  const mode = entry && entry.mode;
  return mode === 'notify' || mode === 'ignore' ? mode : 'auto';
}

// Desktop alert for a streamer going live. Clicking it brings the dashboard
// forward and starts watching, which is what makes notify-only mode useful.
function notifyGoLive(stream) {
  if (config.notificationsEnabled === false) return;
  if (!Notification.isSupported()) return;

  try {
    const notif = new Notification({
      title: `${stream.username} is LIVE!`,
      body: `${stream.title || 'Live now'} on ${stream.platform.toUpperCase()}`,
      silent: false,
    });
    notif.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      spawnStreamContainer(stream.platform, stream.username);
    });
    notif.on('failed', (e, error) => addLog(`[Alerts] Notification failed: ${error}`));
    // Referenced until clicked, or the click is lost once it is collected.
    liveAlerts.keep(`${String(stream.platform).toLowerCase()}:${String(stream.username).toLowerCase()}`, notif, Date.now());
    notif.show();
  } catch (err) {
    addLog(`[Alerts] Could not show notification: ${err.message}`);
  }
}

// Mirror config.launchOnStartup into the OS login items. Started this way the
// app passes --hidden so it comes up in the tray instead of stealing focus at
// sign-in; startMinimized does the same for normal launches. See
// login-item.js for why the args must be passed when reading the setting.
function applyStartupSettings() {
  try {
    if (process.platform === 'linux') return; // setLoginItemSettings is a no-op there
    // Running on defaults because config.json could not be read: the user's
    // real choice is unknown, so the OS entry is left as it is.
    if (configWriteLocked) return;
    const outcome = syncLoginItem(app, !!config.launchOnStartup);
    if (outcome !== 'unchanged') addLog(`[System] Launch on startup ${outcome}.`);
  } catch (err) {
    addLog(`[System] Could not update startup setting: ${err.message}`);
  }
}

// True when this launch should stay in the tray rather than showing the window.
function shouldStartHidden() {
  return process.argv.includes('--hidden') || !!config.startMinimized;
}

// Persist pending cookie writes to disk now, instead of waiting for Chromium's
// lazy flush (which an unclean shutdown would lose along with any rotated
// platform session tokens).
function flushCookies() {
  const failed = (e) => addLog(`[Auth] Cookie flush failed: ${e && e.message}`);
  try {
    // Best effort and never awaited (the exit path must not wait); the
    // promises are caught so a failure is not an unhandled rejection.
    Promise.resolve(session.fromPartition('persist:default').cookies.flushStore()).catch(failed);
    Promise.resolve(session.defaultSession.cookies.flushStore()).catch(failed);
  } catch (e) {
    failed(e);
  }
}

// Local calendar date key (YYYY-MM-DD) for the daily watch-time buckets that
// power the activity heatmap and streaks.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Record a finished lurk session's duration into the longest-session
// aggregates (global + per-streamer). Sub-second blips are ignored. A cell
// that scans had stopped confirming live (an outage, a stream that ended
// before auto-close caught up) ends at its last confirmed-live scan plus one
// interval, not whenever the cell finally closed; and a session is never
// longer than the minutes the ticker credited it, so sleep does not count
// (see session-stats.js).
function finalizeSession(key, startMs) {
  const endMs = streamLiveness.sessionEnd(key, Date.now(), scanIntervalMs(config));
  const ms = sessionLengthMs({ startMs, endMs, creditedMinutes: sessionMinutes.get(key) });
  sessionMinutes.delete(key);
  if (!config.watchTime || ms < 1000) return;
  if (!config.watchTime.streamerLongestMs) config.watchTime.streamerLongestMs = {};
  config.watchTime.longestSessionMs = Math.max(config.watchTime.longestSessionMs || 0, ms);
  config.watchTime.streamerLongestMs[key] = Math.max(config.watchTime.streamerLongestMs[key] || 0, ms);
  watchTimeDirty = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('watch-time-update', config.watchTime);
  }
}

// Ends every open session at its real length. Iterates sessionStarts, not
// activeWindows: the dashboard's 'closed' handler empties activeWindows before
// before-quit runs. Clearing makes a second call a no-op.
function finalizeAllSessions() {
  for (const [key, start] of sessionStarts) {
    try {
      finalizeSession(key, start);
    } catch (err) {
      reportFatal('finalizeSession', err);
    }
  }
  sessionStarts.clear();
  sessionMinutes.clear();
}

// Every way the app ends: quit, update install (electron-updater calls
// app.quit, so before-quit), and Windows shutdown/sign-out (session-end,
// where before-quit never fires). Synchronous, save first: the process may be
// killed right after. Idempotent: the sessions are cleared and the dirty flag
// reset, so a second call only flushes cookies again.
function persistOnExit() {
  app.isQuitting = true;
  finalizeAllSessions();
  if (watchTimeDirty) {
    saveConfig();
    watchTimeDirty = false;
  }
  flushCookies();
}

// Build the watch URL for a stream (fallback for pop-out windows when the
// renderer can't supply the webview's current URL).
function streamWatchUrl(platform, username) {
  const u = username.toLowerCase();
  switch (platform.toLowerCase()) {
    case 'twitch': return `https://www.twitch.tv/${u}`;
    case 'kick': return `https://kick.com/${u}`;
    case 'youtube': return `https://www.youtube.com/${u.startsWith('@') ? u : '@' + u}/live`;
    case 'rumble': return `https://rumble.com/c/${u}`;
    default: return '';
  }
}

// Fetch Twitch OAuth Token (Client Credentials). Resolves to { token, cached }:
// checkTwitchHelix retries a 401 only on a token that came from the cache.
async function getTwitchToken() {
  if (!config.twitchClientId || !config.twitchClientSecret) {
    throw new Error('Twitch credentials not fully configured.');
  }

  // Return the cached token while valid and minted from these credentials, so
  // a Client ID/secret saved or imported since takes effect on the next scan.
  const credentialKey = twitchCredentialKey(config.twitchClientId, config.twitchClientSecret);
  const cached = twitchTokens.get(credentialKey);
  if (cached) return { token: cached, cached: true };

  addLog(twitchTokens.heldForOther(credentialKey)
    ? '[Twitch] Credentials changed. Requesting a new OAuth token...'
    : '[Twitch] Requesting new OAuth token (cached token expired or missing)...');
  // URLSearchParams, so a secret containing & or + reaches Twitch intact.
  const params = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    grant_type: 'client_credentials',
  });
  const response = await fetchTextWithDeadline(net.fetch, `https://id.twitch.tv/oauth2/token?${params}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Auth failed with status ${response.status}`);
  }
  const data = parseJsonBody(response.text, 'Twitch auth');
  if (!data || !data.access_token) throw new Error('Twitch auth returned no access token');

  twitchTokens.set(credentialKey, data.access_token, data.expires_in);
  addLog(`[Twitch] OAuth token cached. Expires in ~${Math.round((data.expires_in || 3600) / 3600)} hours.`);

  return { token: data.access_token, cached: false };
}

// Check Twitch Streamers (Helix, in chunks of 100 logins; see twitch-scan.js)
async function checkTwitchStreamers(streamersToCheck) {
  return checkTwitchHelix(streamersToCheck, {
    request: (url, init) => fetchTextWithDeadline(net.fetch, url, init),
    log: addLog,
    clientId: config.twitchClientId,
    getToken: getTwitchToken,
    invalidateToken: () => twitchTokens.clear(),
  });
}

// Check Twitch Streamers using public GraphQL API (Keyless Fallback), in
// batches under Twitch's operation limit; see twitch-scan.js.
async function checkTwitchStreamersGQL(streamersToCheck) {
  return checkTwitchGql(streamersToCheck, {
    request: (url, init) => fetchTextWithDeadline(net.fetch, url, init),
    log: addLog,
    clientId: TWITCH_PUBLIC_CLIENT_ID,
    userAgent: normalizedUserAgent,
  });
}

// Check a single Kick streamer
async function checkKickStreamer(username) {
  try {
    const url = `https://kick.com/api/v1/channels/${String(username).toLowerCase()}`;
    const response = await fetchTextWithDeadline(net.fetch, url, {
      headers: {
        'User-Agent': normalizedUserAgent,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      // 403 or 404
      if (response.status === 403) {
        addLog(`Kick check for ${username} blocked by Cloudflare (403).`);
      } else {
        addLog(`Kick API for ${username} returned status: ${response.status}`);
      }
      return {
        platform: 'kick', username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: `Status ${response.status}`
      };
    }

    const data = parseJsonBody(response.text, 'Kick');
    if (!data || typeof data !== 'object') throw new Error('Kick returned an unexpected response');

    if (data.livestream) {
      const ls = data.livestream;
      return {
        platform: 'kick',
        username: username,
        isLive: true,
        title: ls.session_title || 'Live Stream',
        viewerCount: ls.viewer_count || 0,
        category: ls.categories && ls.categories[0] ? ls.categories[0].name : 'Gaming',
        // Never the scan time: go-live dedupe is keyed on this.
        liveSince: ls.created_at || ''
      };
    } else {
      return {
        platform: 'kick',
        username: username,
        isLive: false,
        title: '',
        viewerCount: 0,
        category: '',
        liveSince: ''
      };
    }
  } catch (err) {
    addLog(`Kick check failed for ${username}: ${err.message}`);
    return {
      platform: 'kick', username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: err.message
    };
  }
}

// Check a single YouTube streamer (Keyless Canonical Redirect Fallback)
async function checkYoutubeStreamer(username) {
  try {
    const name = String(username);
    const cleanUsername = name.startsWith('@') ? name : `@${name}`;
    const url = `https://www.youtube.com/${cleanUsername}/live`;
    // Twice the usual deadline: the page is over 1 MB, fetched three at a time
    // while the open cells are streaming video over the same link.
    const response = await fetchTextWithDeadline(net.fetch, url, {
      headers: {
        'User-Agent': normalizedUserAgent,
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, 2 * SCAN_REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      return {
        platform: 'youtube', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: `Status ${response.status}`
      };
    }

    // Live detection, title, viewers, and a session id (the video id) that
    // stays the same for the whole broadcast: see youtube-live.js.
    const page = parseYoutubeLivePage(response.text);
    if (page.isLive) {
      return {
        platform: 'youtube',
        username: username,
        isLive: true,
        title: page.title,
        viewerCount: page.viewerCount,
        category: 'YouTube Live',
        liveSince: page.liveSince,
        sessionId: page.sessionId
      };
    }

    return {
      platform: 'youtube', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: ''
    };
  } catch (err) {
    addLog(`YouTube check failed for ${username}: ${err.message}`);
    return {
      platform: 'youtube', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: err.message
    };
  }
}

// Check a single Rumble streamer (Keyless videostream__status--live Check)
async function checkRumbleStreamer(username) {
  let url = `https://rumble.com/c/${username}`;
  let response;
  try {
    response = await fetchTextWithDeadline(net.fetch, url, {
      headers: {
        'User-Agent': normalizedUserAgent
      }
    });

    if (response.status === 404) {
      addLog(`[Rumble] /c/${username} returned 404. Falling back to /user/${username}...`);
      url = `https://rumble.com/user/${username}`;
      response = await fetchTextWithDeadline(net.fetch, url, {
        headers: {
          'User-Agent': normalizedUserAgent
        }
      });
    }

    if (!response.ok) {
      return {
        platform: 'rumble', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: `Status ${response.status}`
      };
    }

    const html = response.text;
    // Clean HTML by removing style and script blocks to avoid CSS rule false positives
    const htmlClean = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      
    const isLive = htmlClean.includes('videostream__status--live') || htmlClean.includes('class="main-menu-item-channel-live-dot"');
    
    if (isLive) {
      let title = 'Rumble Live Stream';
      const titleMatch = html.match(/<h3 class="thumbnail__title" title="([^"]+)">/);
      if (titleMatch) {
        title = titleMatch[1];
      }

      let viewerCount = 0;
      const viewsMatch = html.match(/data-views="([^"]+)"/);
      if (viewsMatch) {
        viewerCount = parseInt(viewsMatch[1], 10) || 0;
      }

      return {
        platform: 'rumble',
        username: username,
        isLive: true,
        title: title,
        viewerCount: viewerCount,
        category: 'Rumble Live',
        // The page has no start time. '' keys the session by day; the scan
        // time would make every scan a new go-live.
        liveSince: '',
        resolvedUrl: url
      };
    }

    return {
      platform: 'rumble', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', resolvedUrl: url
    };
  } catch (err) {
    addLog(`Rumble check failed for ${username}: ${err.message}`);
    return {
      platform: 'rumble', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: err.message
    };
  }
}


// Generic parallel batch checker for single-streamer APIs (Kick, YouTube, Rumble)
async function checkStreamersParallel(usernames, checkerFn, concurrency = 3, delayMs = 300) {
  const results = [];
  for (let i = 0; i < usernames.length; i += concurrency) {
    const batch = usernames.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(u => checkerFn(u)));
    results.push(...batchResults);
    if (i + concurrency < usernames.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

/// Usernames monitored on one platform. Reads entries defensively: one the
// config normalizer has not seen must not make every scan throw.
function monitoredUsernames(platform) {
  return config.streamers.filter(s => streamerPlatform(s) === platform).map(streamerName).filter(Boolean);
}

// Main Polling Scan Logic. Runs through scanRunner only, one scan at a time.
async function doScan() {
  addLog('Starting stream status scan...');

  const twitchStreamers = monitoredUsernames('twitch');
  const kickStreamers = monitoredUsernames('kick');
  const youtubeStreamers = monitoredUsernames('youtube');
  const rumbleStreamers = monitoredUsernames('rumble');

  let results = [];

  // 1. Scan Twitch
  if (twitchStreamers.length > 0) {
    if (config.twitchEnabled !== false) {
      if (!config.twitchClientId || !config.twitchClientSecret) {
        addLog('[Twitch] No API credentials found. Using public key-free scan...');
        const twitchResults = await checkTwitchStreamersGQL(twitchStreamers);
        results = results.concat(twitchResults);
      } else {
        let twitchResults = await checkTwitchStreamers(twitchStreamers);
        // Only the logins Helix could not answer go to GQL, so one failed
        // chunk does not resend (or blind) the whole list.
        const failedLogins = twitchResults.filter(r => r.error).map(r => r.username);
        if (failedLogins.length) {
           addLog(`[Twitch] Helix API failed for ${failedLogins.length} of ${twitchStreamers.length} channels. Falling back to key-free GQL scan for those...`);
           twitchResults = mergeFallbackResults(twitchResults, await checkTwitchStreamersGQL(failedLogins));
        }
        results = results.concat(twitchResults);
      }
    } else {
      addLog('[Twitch] Platform disabled in settings. Skipping scan.');
      results = results.concat(twitchStreamers.map(u => ({
        platform: 'twitch', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: ''
      })));
    }
  }

  // 2. Scan Kick (parallel batches of 3)
  if (kickStreamers.length > 0) {
    if (config.kickEnabled !== false) {
      const kickResults = await checkStreamersParallel(kickStreamers, checkKickStreamer, 3, 300);
      results = results.concat(kickResults);
    } else {
      addLog('[Kick] Platform disabled in settings. Skipping scan.');
      results = results.concat(kickStreamers.map(u => ({
        platform: 'kick', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: ''
      })));
    }
  }

  // 3. Scan YouTube (parallel batches of 3)
  if (youtubeStreamers.length > 0) {
    if (config.youtubeEnabled !== false) {
      const ytResults = await checkStreamersParallel(youtubeStreamers, checkYoutubeStreamer, 3, 300);
      results = results.concat(ytResults);
    } else {
      addLog('[YouTube] Platform disabled in settings. Skipping scan.');
      results = results.concat(youtubeStreamers.map(u => ({
        platform: 'youtube', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: ''
      })));
    }
  }

  // 4. Scan Rumble (parallel batches of 3)
  if (rumbleStreamers.length > 0) {
    if (config.rumbleEnabled !== false) {
      const rumbleResults = await checkStreamersParallel(rumbleStreamers, checkRumbleStreamer, 3, 300);
      results = results.concat(rumbleResults);
    } else {
      addLog('[Rumble] Platform disabled in settings. Skipping scan.');
      results = results.concat(rumbleStreamers.map(u => ({
        platform: 'rumble', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: ''
      })));
    }
  }

  addLog(`Scan complete. Found ${results.filter(r => r.isLive).length} live streamers.`);

  // Kept for get-statuses: a dashboard that reloads between scans would
  // otherwise show every card as 'Checking...' until the next one.
  lastScanResults = results;

  // Send status update to UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', results);
  }

  // Auto-close, go-live alerts, auto-open and tab-limit preemption: see
  // scan-planner.js for the rules. While the dashboard is dead nothing can
  // open, and a stream the planner recorded as opened would then stay closed
  // for the rest of its broadcast once the dashboard is back, so auto-open
  // sits this scan out.
  applyScanResults(results, {
    now: Date.now(),
    config: dashboardHealth.canOpenStreams ? config : { ...config, autoOpen: false },
    activeWindows,
    openedSessions,
    notifiedSessions,
    liveness: streamLiveness,
    modeOf: getStreamerMode,
    notify: notifyGoLive,
    spawn: spawnStreamContainer,
    closeTab: (platform, username) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('close-stream-tab', { platform, username });
      }
      // Auto-close and preemption: a pop-out left open would keep playing an
      // offline page, or break the tab limit the preemption just enforced.
      closePopout(platform, username);
      sendStreamStatusToUI();
    },
    log: addLog,
  });
}

// Scans never overlap: an older scan finishing after a newer one used to
// close a cell the newer one had just opened. A throw is logged instead of
// surfacing as an unhandled rejection on every interval.
const scanRunner = createSingleFlight(doScan, (err) => addLog(`[Scan] Scan failed: ${err && err.message}`));

// Scheduled scans (interval, startup): join a scan already in progress.
function performScan() {
  return scanRunner.run();
}

// Scans the user asked for: always a scan that starts after the request.
function requestScan() {
  return scanRunner.runFresh();
}

// Reset Poller schedule
function resetPoller() {
  if (pollIntervalId) clearInterval(pollIntervalId);

  const msInterval = scanIntervalMs(config);
  addLog(`Resetting scan interval to run every ${msInterval / 60000} minutes.`);

  // The tick stamps the countdown itself, so the countdown follows this timer's
  // real phase. Scans started by hand run off-schedule and leave it alone.
  pollIntervalId = setInterval(() => {
    updateNextScanTime();
    if (scanRunner.running) {
      addLog('[Scan] The previous scan is still running. Skipping this interval.');
      return;
    }
    performScan();
  }, msInterval);
  updateNextScanTime();
}

// Timer countdown helper
function updateNextScanTime() {
  nextScanTime = Date.now() + scanIntervalMs(config);
  sendCountdownToUI();
}

function sendCountdownToUI() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const secondsRemaining = Math.max(0, Math.round((nextScanTime - Date.now()) / 1000));
    mainWindow.webContents.send('countdown-update', secondsRemaining);
  }
}

// App lifecycle
app.on('second-instance', (_event, argv) => {
  // Autostart passes --hidden; a login-time relaunch must not pop the window.
  if (argv.includes('--hidden')) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Without an application menu of our own, every window (including any a page
  // manages to open) gets Electron's default one: reload, zoom and DevTools on
  // accelerators. macOS keeps the app and Edit menus so Cmd+Q and copy/paste
  // still work there. First, so even a window the startup-failure path below
  // creates never has them.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    : null);

  addLog('Initializing Stream Lurker standalone desktop application...');
  for (const r of cookieMigrationResults) {
    const where = path.relative(app.getPath('userData'), r.file);
    if (r.status === 'migrated') {
      addLog(`[Upgrade] Carried cookie store ${where} from schema v${r.from} to v${r.to}: ${r.rowsAfter}/${r.rowsBefore} cookies kept. Backup: ${path.basename(r.backup)}`);
    } else if (r.status === 'failed' || (r.status === 'skipped' && r.error)) {
      addLog(`[Upgrade] Cookie store ${where} was not migrated (${r.status}: ${r.error}). If logins are missing, reconnect them in Platform Logins.`);
    }
  }
  loadConfig();
  applyStartupSettings();

  const rawUA = session.defaultSession.getUserAgent();
  // Strip Electron + the app token, and never report a Chrome older than the
  // floor (see ua-spoof.js). navigator.userAgent in pages derives
  // navigator.userAgentData from this, so the spoofed version flows through.
  normalizedUserAgent = normalizeUserAgent(rawUA, SPOOF_CHROME.full);
  addLog(`[System] Electron User-Agent: ${rawUA}`);
  addLog(`[System] Spoofed User-Agent for embedded browser: ${normalizedUserAgent}`);
  session.defaultSession.setUserAgent(normalizedUserAgent);
  session.fromPartition('persist:default').setUserAgent(normalizedUserAgent);

  // Before any page exists: no window, webview, probe or extension may load on
  // a session that still auto-grants permissions. session-created usually got
  // here first; lockDownSession ignores a second call.
  lockDownSession(session.defaultSession);
  lockDownSession(session.fromPartition('persist:default'));
  protocol.handle(DASHBOARD_SCHEME, createDashboardHandler(__dirname));

  // Spoof Sec-CH-UA client hints to match the spoofed User-Agent fingerprint.
  const clientHints = { major: SPOOF_CHROME.major, full: SPOOF_CHROME.full, platform: process.platform };

  // No onBeforeRequest listener: every request of every stream went through
  // one on the main-process thread only to be answered {} (it served the
  // removed hidden Drops window). While any session.webRequest listener
  // exists on this partition, Chromium never routes requests through an
  // extension's chrome.webRequest, which is why the catalog's uBlock Origin
  // cannot block anything here (see EXTENSION_CATALOG).

  // Spoof Sec-CH-UA client hints on ALL requests (not just Twitch) so Kick,
  // YouTube/Google and Rumble don't see the real Electron brand or a different
  // Chrome version. These must match navigator.userAgentData from the stealth
  // preload.
  session.fromPartition('persist:default').webRequest.onBeforeSendHeaders(
    { urls: ['*://*/*'] },
    (details, callback) => {
      callback({ requestHeaders: applyClientHints(details.requestHeaders || {}, clientHints) });
    }
  );


  session.fromPartition('persist:default').webRequest.onHeadersReceived(
    { urls: ['*://gql.twitch.tv/*'] },
    (details, callback) => {
      const responseHeaders = details.responseHeaders || {};
      const setHeader = (name, val) => {
        const lowerName = name.toLowerCase();
        for (const key of Object.keys(responseHeaders)) {
          if (key.toLowerCase() === lowerName) {
            delete responseHeaders[key];
          }
        }
        responseHeaders[name] = [val];
      };

      // Rewrite Set-Cookie headers to broaden domain to .twitch.tv
      let rawCookies = responseHeaders['Set-Cookie'] || responseHeaders['set-cookie'];
      if (rawCookies) {
        const updatedCookies = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).map(cookie => {
          let val = cookie.replace(/domain=\.?gql\.twitch\.tv/gi, 'Domain=.twitch.tv');
          if (!/domain=/i.test(val)) {
            val += '; Domain=.twitch.tv';
          }
          return val;
        });
        delete responseHeaders['Set-Cookie'];
        delete responseHeaders['set-cookie'];
        responseHeaders['set-cookie'] = updatedCookies;
      }

      setHeader('Access-Control-Allow-Origin', 'https://www.twitch.tv');
      setHeader('Access-Control-Allow-Credentials', 'true');
      callback({ responseHeaders });
    }
  );

  // 7TV is no longer bundled/auto-installed — users opt in via the
  // Recommended Extensions catalog in the Adblock & Extensions tab. A failure
  // here must never keep the window and tray from existing.
  try {
    await loadExtensions();
  } catch (err) {
    reportFatal('loadExtensions', err);
  }
  startRuntime();
}).catch((err) => {
  // Whatever broke startup, never leave an invisible process with no window
  // or tray holding the profile. Not a blocking dialog: it would freeze the
  // app it is reporting on.
  reportFatal('startup', err);
  startRuntime();
  dialog.showMessageBox({
    type: 'warning',
    title: 'Stream Lurker',
    message: 'Stream Lurker hit an error while starting.',
    detail: `${err && err.message ? err.message : err}\n\nIt is running, but something may not work until it is restarted. Details are in the activity log.`,
  }).catch(() => {});
});

// Everything the running app needs, each step isolated so one failure cannot
// leave a process with no window or tray. Runs once; the startup-failure path
// above calls it too.
let runtimeStarted = false;
function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  const step = (label, fn) => {
    try { fn(); } catch (err) { reportFatal(`startup: ${label}`, err); }
  };

  step('dashboard window', () => { createMainWindow(); });

  step('tray', () => { createTray(); });

  // config.json exists but could not be read: ask, without blocking.
  step('config prompt', () => { if (configWriteLocked) promptConfigUnreadable(); });

  // Start the localhost receiver for the 1-click login browser extension.
  step('cookie receiver', () => { startCookieReceiver(); });

  // Start background poller
  step('poller', () => { resetPoller(); });

  // Start watch time tracker
  step('watch time', () => { startWatchTimeTracking(); });

  // Run immediate first scan after a short delay to let frontend mount
  setTimeout(performScan, 3000);

  // Setup countdown update clock
  if (countdownTimerId) clearInterval(countdownTimerId);
  countdownTimerId = setInterval(sendCountdownToUI, 1000);

  // Validate saved sessions after UI is ready
  setTimeout(runSafely('validateSavedSessions', validateSavedSessions), 6000);

  // Confirm with YouTube itself that the session still works — cookie presence
  // alone can't tell. Once after startup settles, then periodically.
  setTimeout(runSafely('checkYouTubeSessionHealth', checkYouTubeSessionHealth), 45000);
  setInterval(runSafely('checkYouTubeSessionHealth', checkYouTubeSessionHealth), 45 * 60 * 1000);
  setTimeout(runSafely('refreshPlaceholderAccountNames', refreshPlaceholderAccountNames), 20000);

  // Extension folders on a drive that was not mounted yet at sign-in.
  setTimeout(runSafely('retryUnavailableExtensions', retryUnavailableExtensions), 2 * 60 * 1000);

  // Save pending watch time every minute. Only a clean quit or a Windows
  // shutdown (session-end) saves on the way out; a crash, a Task Manager kill
  // or power loss costs at most this interval. The write is small and atomic.
  setInterval(() => {
    if (watchTimeDirty) {
      saveConfig();
      watchTimeDirty = false;
    }
  }, 60000);

  // Periodically flush the cookie store to disk. Google rotates its session
  // cookies (__Secure-*PSIDTS) every few minutes; if the app is killed or
  // crashes before Chromium's own lazy flush, those writes are lost and the
  // next launch starts from stale tokens — which shows up as YouTube randomly
  // being logged out.
  setInterval(flushCookies, 300000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

// Final save of open sessions and pending watch time (see persistOnExit).
app.on('before-quit', () => persistOnExit());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// System Tray
function createTray() {
  try {
    // icon.ico ships with the app (see build.files) and carries a real 16x16
    // frame, which is what the Windows tray wants. This used to be
    // createEmpty(), which is why the tray slot rendered blank while still
    // showing the tooltip. Fall back to the PNG, then to an empty image, so a
    // missing asset can never stop the tray (and its Quit item) from existing.
    let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    if (icon.isEmpty()) {
      addLog('[Tray] Could not load icon.ico/icon.png — tray icon will be blank.');
      icon = nativeImage.createEmpty();
    } else {
      // Windows picks the nearest frame, but an explicit 16x16 avoids a blurry
      // downscale from the 256x256 frame on some DPI settings.
      const small = icon.resize({ width: 16, height: 16 });
      if (!small.isEmpty()) icon = small;
    }
    tray = new Tray(icon);

    tray.setToolTip('Stream Lurker');
    // Built when opened, so the Active Streams count is current. A menu set
    // once with setContextMenu is a snapshot (it read 0 forever), and on
    // Windows a stored menu would be shown instead of this one. Linux
    // AppIndicator emits no 'right-click' and needs the stored menu, which
    // refreshTrayMenu keeps current there.
    if (process.platform === 'linux') {
      tray.setContextMenu(buildTrayMenu());
    } else {
      tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
    }

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
    
    addLog('[System] System tray icon created. App will minimize to tray on close.');
  } catch (err) {
    addLog(`[System] System tray creation failed: ${err.message}. App will exit on close.`);
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Force Scan Now',
      click: () => {
        requestScan();
      }
    },
    { type: 'separator' },
    {
      label: `Active Streams: ${activeWindows.size}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit Stream Lurker',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
}

// Linux only (see createTray): elsewhere the menu is built when opened.
// Called wherever the open-stream count changes; never on a timer, which
// makes an open menu flicker.
function refreshTrayMenu() {
  if (process.platform !== 'linux' || !tray || tray.isDestroyed()) return;
  try { tray.setContextMenu(buildTrayMenu()); } catch (e) { /* tray going away */ }
}

// Helper to fetch Twitch Username from GQL using OAuth token. Through the
// shared, time-bounded resolver: validateSavedSessions awaits this before it
// checks Kick and YouTube, so a stalled request here used to stall those too.
async function fetchTwitchUsername(token) {
  const result = await resolveTwitchUser(token);
  if (!result.login) addLog(`[Auth] Could not look up the Twitch username: ${describeTwitchUserResult(result)}.`);
  return result.login || null;
}

// Session Validation on Startup
// ── YouTube session liveness ───────────────────────────────────────────────
// Whether Google still accepts the session can only be answered from inside a
// real page. A plain net.fetch with the cookie jar reports signed-out for
// sessions that work fine in a browser, so it must never drive this decision.
// Returns 'live' | 'signed-out' | 'unknown'; anything short of two corroborating
// signals on a fully-loaded page is 'unknown', and 'unknown' changes nothing.
// Load a page in a hidden window on the shared session and evaluate a script in
// it. Anything that depends on being a real browser — login state, account
// names, Cloudflare-protected APIs — has to be answered from in here rather
// than from a bare request.
// Resolves within HIDDEN_PAGE_DEADLINE_MS whatever the page does (a stalled
// load, a crash, a reload mid-script) and always destroys the window; before,
// any of those leaked a hidden renderer for the life of the process and hung
// the caller (see hidden-page.js).
async function runInHiddenPage(url, script, settleMs = 5000) {
  let win = null;
  try {
    win = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        partition: 'persist:default',
        // No preload here, so the sandbox costs nothing, and this window loads
        // YouTube and Kick unattended for as long as the app runs.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    setContentsRole(win.webContents, 'hidden');
    win.webContents.setUserAgent(normalizedUserAgent);
    win.webContents.setAudioMuted(true);
    return await runPageScript(win, { url, script, settleMs, loadOptions: { userAgent: normalizedUserAgent } });
  } catch (e) {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (err) { /* ignore */ }
    return null;
  }
}

// Reads sign-in state and the account name in one page load.
const YOUTUBE_PROBE_SCRIPT = `
  (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clean = (s) => {
      if (!s) return null;
      const n = s.replace(/avatar\\s+image\\s+of/i, '')
                 .replace(/(profile\\s+)?(photo|picture)\\s+of/i, '')
                 .trim();
      if (!n) return null;
      return /avatar|profile|photo|default/i.test(n) ? null : n;
    };
    try {
      const cfgReady = !!(window.ytcfg && window.ytcfg.get);
      const loggedIn = cfgReady ? window.ytcfg.get('LOGGED_IN') : null;
      const hasAvatar = !!document.querySelector('button#avatar-btn, #avatar-btn, [aria-label*="Account"]');
      const hasSignIn = !!document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google.com/ServiceLogin"]');

      let name = null;
      if (loggedIn === true || hasAvatar) {
        if (cfgReady) name = window.ytcfg.get('CHANNEL_HANDLE') || window.ytcfg.get('USER_NAME') || null;
        if (!name && window.ytcfg && window.ytcfg.data_) {
          name = window.ytcfg.data_.CHANNEL_HANDLE || window.ytcfg.data_.USER_NAME || null;
        }
        if (!name) {
          const el = document.querySelector('ytd-active-account-header-renderer #channel-handle, #channel-handle')
                  || document.querySelector('ytd-active-account-header-renderer #account-name, #account-name');
          if (el && el.textContent.trim()) name = el.textContent.trim();
        }
        if (!name) {
          // Opening the account menu is what actually renders the handle.
          const btn = document.querySelector('button#avatar-btn, #avatar-btn');
          if (btn) {
            btn.click();
            await sleep(900);
            const el = document.querySelector('ytd-active-account-header-renderer #channel-handle, #channel-handle')
                    || document.querySelector('ytd-active-account-header-renderer #account-name, #account-name');
            if (el && el.textContent.trim()) name = el.textContent.trim();
            if (!name) {
              const img = btn.querySelector('img');
              name = clean(img && img.alt) || clean(btn.getAttribute('aria-label'));
            }
          }
        }
      }
      return { cfgReady, loggedIn, hasAvatar, hasSignIn, name: name || null };
    } catch (e) { return null; }
  })()
`;

// Returns { state: 'live' | 'signed-out' | 'unknown', name }. Background
// callers go through youtubeProbe.run() (joins a probe in flight), importers
// through youtubeProbe.fresh() (a page loaded after their cookies were written).
async function probeYouTubeLogin() {
  const probe = await runInHiddenPage('https://www.youtube.com/', YOUTUBE_PROBE_SCRIPT, 6000);
  if (!probe || !probe.cfgReady) return { state: 'unknown', name: null }; // page never really loaded
  const name = probe.name || null;
  if (probe.loggedIn === true || probe.hasAvatar) return { state: 'live', name };
  // Only call it dead when the player config says so AND the page is actually
  // offering a sign-in link.
  if (probe.loggedIn === false && probe.hasSignIn) return { state: 'signed-out', name: null };
  return { state: 'unknown', name };
}

const youtubeProbe = createProbeGate(probeYouTubeLogin);

// Kick's own API, called from inside a kick.com page so it carries the session
// cookies and isn't turned away by Cloudflare (see kick-user.js). Background
// callers go through kickNameProbe.run(), importers through .fresh().
async function resolveKickUser() {
  const res = await runInHiddenPage('https://kick.com/', KICK_USER_SCRIPT, 6000);

  if (!res) {
    addLog('[Auth] Kick name lookup failed: the page did not load.');
    return null;
  }
  const name = kickNameFrom(res);
  if (!name) {
    addLog(`[Auth] Kick name lookup found nothing (${(res.tried || []).join(' | ') || 'no attempts'}${res.title ? '; page=' + res.title : ''}).`);
    return null;
  }
  return name;
}

const kickNameProbe = createProbeGate(resolveKickUser);

// Per-platform account write counters (see account-state.js): a background
// check drops its result when a sign-in or sign-out happened while it ran.
const accountEpochs = createAccountEpochs();

async function readKickSessionCookies(ses = session.fromPartition('persist:default')) {
  return ses.cookies.get({ url: 'https://kick.com', name: 'session_token' });
}

// The cookies a Google session lives on, from both hosts it spans.
async function readYouTubeAuthCookies(ses = session.fromPartition('persist:default')) {
  return [
    ...await ses.cookies.get({ url: 'https://www.youtube.com' }),
    ...await ses.cookies.get({ url: 'https://accounts.google.com' }),
  ];
}

// Anyone connected before name resolution existed still has "Kick User" stored.
// Resolve it once on startup so the Platform Logins card shows who they are.
// (YouTube's name is picked up by checkYouTubeSessionHealth, which loads the
// page anyway — no reason to load it twice.)
async function refreshPlaceholderAccountNames() {
  if (!config.accounts) return;
  if (config.accounts.kick && isPlaceholderName(config.accounts.kick) && config.kickEnabled !== false) {
    // No session_token means no account to name, only a hidden kick.com load
    // on every launch (validateSavedSessions clears such a placeholder).
    let signedIn = false;
    try { signedIn = hasKickSessionToken(await readKickSessionCookies()); } catch (e) { /* treat as unknown */ }
    if (!signedIn) return;
    const snap = accountEpochs.snapshot('kick', config.accounts);
    const name = await kickNameProbe.run();
    // Signed out, or connected again by an import, while the page loaded.
    if (!accountEpochs.isCurrent(snap, config.accounts)) return;
    if (name) {
      config.accounts.kick = name;
      saveConfig();
      addLog(`[Auth] Resolved Kick account name: ${name}`);
      notifyLoginSuccess('kick', name);
    }
  }
}

// Consecutive confirmed signed-out probes. One is a warning; two in a row is
// what it takes to actually mark the account disconnected.
let youtubeSignedOutStreak = 0;

// One check at a time: two overlapping checks would share one probe and count
// a single signed-out answer twice.
function checkYouTubeSessionHealth() {
  return youtubeHealthCheck.run();
}

async function runYouTubeSessionHealthCheck() {
  if (!config.accounts || !config.accounts.youtube) return; // nothing to lose
  if (config.youtubeEnabled === false) return;

  const snap = accountEpochs.snapshot('youtube', config.accounts);
  const { state, name } = await youtubeProbe.run();
  // Signed out, reconnected or renamed while the page loaded: this probe
  // describes a session that is no longer the saved one, in either direction
  // (a stale 'live' would re-add a signed-out account, a stale 'signed-out'
  // would count against fresh cookies).
  if (!accountEpochs.isCurrent(snap, config.accounts)) {
    addLog('[Auth] The YouTube account changed while it was being checked; ignoring that check.');
    return;
  }

  if (state === 'live') {
    if (youtubeSignedOutStreak > 0) addLog('[Auth] YouTube session is healthy again.');
    youtubeSignedOutStreak = 0;
    // The page is the only place the real account name is available, so take it
    // while we're here if all we have is the "YouTube User" placeholder, or if
    // it names another account: a background re-sync from the extension can
    // swap the session, and never loads a page itself.
    if (name && (isPlaceholderName(snap.name) || !sameAccountName(name, snap.name))) {
      config.accounts.youtube = name;
      saveConfig();
      addLog(isPlaceholderName(snap.name)
        ? `[Auth] Resolved YouTube account name: ${name}`
        : `[Auth] YouTube reports the signed-in account as ${name} (was ${snap.name}).`);
      notifyLoginSuccess('youtube', name);
    }
    return;
  }
  if (state === 'unknown') return; // never act on an inconclusive probe

  youtubeSignedOutStreak++;
  if (youtubeSignedOutStreak < 2) {
    addLog('[Auth] YouTube looks signed out. Re-checking before flagging it — if this persists, reconnect from Platform Logins.');
    return;
  }

  // The cookies stay (the probe is a page heuristic, and deleting a live
  // session on a false negative cannot be undone). Their fingerprint is kept
  // instead, so the next launch does not rebuild the account from these same
  // dead cookies and announce the expiry all over again (validateSavedSessions).
  let expiredFingerprint = null;
  try { expiredFingerprint = youtubeAuthFingerprint(await readYouTubeAuthCookies()); } catch (e) { /* no marker */ }
  if (!accountEpochs.isCurrent(snap, config.accounts)) return;
  addLog('[Auth] YouTube session has expired. Reconnect from Platform Logins (1-click extension, or paste cookies).');
  delete config.accounts.youtube;
  accountEpochs.bump('youtube');
  if (expiredFingerprint) config.youtubeExpiredFingerprint = expiredFingerprint;
  saveConfig();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-expired', { platform: 'youtube' });
  }
  if (config.notificationsEnabled !== false && Notification.isSupported()) {
    try {
      new Notification({
        title: 'YouTube session expired',
        body: 'Stream Lurker is signed out of YouTube. Reconnect from Platform Logins.',
        silent: true,
      }).show();
    } catch (e) { /* non-fatal */ }
  }
}

const youtubeHealthCheck = createSingleFlight(runYouTubeSessionHealthCheck, (err) => reportFatal('checkYouTubeSessionHealth', err));

// The expiry marker records a verdict from a page heuristic. Ask the page once
// per launch, silently: cookies that are in fact alive reconnect on their own
// (as they did before the marker existed), dead ones stay quiet instead of
// being re-added and announced as expired again.
async function recheckExpiredYouTube() {
  if (config.youtubeEnabled === false || !config.youtubeExpiredFingerprint) return;
  if (!config.accounts || config.accounts.youtube) return;
  const snap = accountEpochs.snapshot('youtube', config.accounts);
  const { state, name } = await youtubeProbe.run();
  if (state !== 'live' || !accountEpochs.isCurrent(snap, config.accounts)) return;
  delete config.youtubeExpiredFingerprint;
  config.accounts.youtube = name || placeholderName('youtube');
  accountEpochs.bump('youtube');
  youtubeSignedOutStreak = 0;
  saveConfig();
  addLog(`[Auth] YouTube reports the saved session signed in again; reconnected as ${config.accounts.youtube}.`);
  notifyLoginSuccess('youtube', config.accounts.youtube);
}

async function validateSavedSessions() {
  const platformsToCheck = ['twitch', 'kick', 'youtube', 'rumble'];
  addLog('[Auth] Validating saved platform sessions...');
  const ses = session.fromPartition('persist:default');

  for (const platform of platformsToCheck) {
    let isValid = false;
    // If the cookie lookup itself throws we can't conclude anything — leave the
    // saved account alone rather than reporting a bogus logout.
    let checkErrored = false;
    // YouTube already confirmed these exact cookies signed out.
    let knownExpired = false;

    try {
      if (platform === 'twitch') {
        const cookies = await ses.cookies.get({ name: 'auth-token' });
        isValid = cookies.some(c => c.domain && c.domain.includes('twitch.tv'));
        if (isValid) {
          if (!config.accounts[platform] || config.accounts[platform] === 'Twitch User') {
            const tokenCookie = cookies.find(c => c.domain && c.domain.includes('twitch.tv'));
            if (tokenCookie) {
              const username = await fetchTwitchUsername(tokenCookie.value);
              // The dashboard's copy of the config is from page load, and
              // save-config no longer overwrites accounts with it: tell it.
              if (username) {
                config.accounts[platform] = username;
                saveConfig();
                addLog(`[Auth] Recovered Twitch username: ${username}`);
                notifyLoginSuccess(platform, username);
              } else if (config.accounts[platform] !== 'Twitch User') {
                config.accounts[platform] = 'Twitch User';
                saveConfig();
                notifyLoginSuccess(platform, 'Twitch User');
              }
            }
          }
        }
      } else if (platform === 'kick') {
        // session_token only. kick_session is a visitor cookie every Kick
        // stream cell gets (see hasKickSessionToken).
        isValid = hasKickSessionToken(await readKickSessionCookies(ses));
      } else if (platform === 'youtube') {
        // Google no longer guarantees the legacy SID/SSID pair is present — modern
        // sessions can live entirely on the __Secure-*PSID family, and those
        // cookies rotate. Checking only SID/SSID meant a rotation could look like
        // a logout and wipe the saved account. Accept any known auth cookie, and
        // look at google.com too since the session spans both hosts.
        const cookies = await readYouTubeAuthCookies(ses);
        isValid = cookies.some(c => YOUTUBE_AUTH_COOKIE.test(c.name));
        if (isValid && !config.accounts.youtube && config.youtubeExpiredFingerprint) {
          if (youtubeAuthFingerprint(cookies) === config.youtubeExpiredFingerprint) {
            knownExpired = true;
          } else {
            // Different cookies arrived since (a re-sync, a paste, a sign-in
            // in a stream cell): judge them afresh.
            delete config.youtubeExpiredFingerprint;
            saveConfig();
          }
        }
      } else if (platform === 'rumble') {
        const cookies = await ses.cookies.get({ url: 'https://rumble.com' });
        isValid = cookies.some(c => c.name.includes('session') || c.name === 'u_s');
      }
    } catch (e) {
      checkErrored = true;
      addLog(`[Auth] Error validating ${platform.toUpperCase()} session: ${e.message} (keeping saved account).`);
    }

    if (checkErrored) continue;
    if (knownExpired) {
      addLog('[Auth] YouTube: the saved cookies are the ones YouTube already reported signed out, so the account stays disconnected. Reconnect from Platform Logins.');
      setTimeout(runSafely('recheckExpiredYouTube', recheckExpiredYouTube), 40000);
      continue;
    }

    if (!isValid) {
      if (config.accounts && config.accounts[platform]) {
        if (platform === 'kick' && isPlaceholderName(config.accounts.kick)) {
          // Older builds took Kick's visitor cookie for a login, so this was
          // never a real account; say that rather than "expired".
          addLog('[Auth] Kick was listed as connected, but the app holds no Kick sign-in (only the visitor cookie every Kick page sets). Clearing it; connect Kick from Platform Logins to use an account.');
        } else {
          addLog(`[Auth] Session expired for ${platform.toUpperCase()}. Marking as disconnected.`);
        }
        delete config.accounts[platform];
        accountEpochs.bump(platform);
        saveConfig();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-expired', { platform });
        }
      }
    } else {
      if (!config.accounts[platform]) {
        config.accounts[platform] = placeholderName(platform);
        saveConfig();
        notifyLoginSuccess(platform, config.accounts[platform]);
      }
      addLog(`[Auth] Session valid for ${platform.toUpperCase()} (${config.accounts[platform]}).`);
    }
  }
}

// IPC Handler Registrations
ipcMain.handle('get-config', () => {
  return config;
});

ipcMain.handle('open-login-modal', async (event, { platform }) => {
  return new Promise((resolve, reject) => {
    const p = platform.toLowerCase();
    let loginUrl = '';
    let title = '';

    if (p === 'twitch') {
      loginUrl = 'https://www.twitch.tv/login';
      title = 'Connect Twitch Account';
    } else if (p === 'kick') {
      loginUrl = 'https://kick.com/login';
      title = 'Connect Kick Account';
    } else if (p === 'youtube') {
      loginUrl = 'https://accounts.google.com/ServiceLogin?service=youtube';
      title = 'Connect YouTube Account';
    } else if (p === 'rumble') {
      loginUrl = 'https://rumble.com/login';
      title = 'Connect Rumble Account';
    } else {
      return resolve({ success: false, error: 'Unknown platform' });
    }

    addLog(`[Auth] Opening login modal for ${platform.toUpperCase()}...`);

    // Create the login modal window. Sandboxed: the sandbox changes no web API a
    // CAPTCHA can see, and twitch-preload.js only needs require('electron')
    // (it already runs sandboxed in the Twitch GQL window).
    const loginWin = new BrowserWindow({
      width: 650,
      height: 800,
      parent: mainWindow,
      modal: true,
      title: title,
      backgroundColor: '#09090b',
      show: false,
      webPreferences: {
        partition: 'persist:default',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'src', 'twitch-preload.js')
      }
    });
    setContentsRole(loginWin.webContents, 'login');

    loginWin.setMenuBarVisibility(false);
    // Use the spoofed clean Chrome UA for every platform. It stays consistent with
    // the globally-spoofed Sec-CH-UA headers and the preload's navigator.userAgentData,
    // so no Electron brand or stale version leaks to trip "browser not supported".
    const uaToUse = normalizedUserAgent;
    loginWin.webContents.setUserAgent(uaToUse);
    // Rejects on a redirect that replaces the load, or a closed window; the
    // polling below carries on either way.
    loginWin.loadURL(loginUrl, { userAgent: uaToUse }).catch(() => {});

    loginWin.once('ready-to-show', () => {
      loginWin.show();
    });

    const ses = session.fromPartition('persist:default');
    const label = platform.toUpperCase();
    // Every script in this window is bounded: executeJavaScript waits, with no
    // timeout, for the page to stop loading and for a reply that a closed,
    // crashed or navigating page never sends (see hidden-page.js).
    const run = (script, ms = 5000) => runScriptWithin(loginWin.webContents, script, ms);
    let lastKickNote = '';
    // A stale token left in the jar fails the API proof on every poll; asking
    // Kick twice every 1.5 s for five minutes invites a rate-limit challenge
    // in the very window the user is signing in with. A new sign-in changes
    // the token and is checked at once.
    let lastKickProof = { token: null, at: 0 };

    // One poll: truthy (with the name when the proof carries one) once signed in.
    async function detectLogin() {
      if (loginWin.isDestroyed()) return null;
      const url = loginWin.webContents.getURL();
      if (!url || url === 'about:blank') return null;

      if (p === 'kick') {
        // Kick needs proof, not a missing "Log in" button: a Cloudflare or
        // Kasada challenge, an error page and a page still hydrating have none
        // either. The session cookie first (cheap), then Kick's own API must
        // name the account with that session as the bearer; a stale cookie
        // gets an empty answer.
        const cookies = await ses.cookies.get({ url: 'https://kick.com', name: 'session_token' });
        if (!hasKickSessionToken(cookies)) return null;
        const token = cookies.find(c => c.name === 'session_token' && c.value).value;
        if (token === lastKickProof.token && Date.now() - lastKickProof.at < 6000) return null;
        lastKickProof = { token, at: Date.now() };
        const res = await run(KICK_USER_SCRIPT, 15000);
        const name = kickNameFrom(res, { requireApi: true });
        if (name) return { name };
        const note = ((res && res.tried) || []).join(' | ') || 'no answer';
        if (note !== lastKickNote) {
          lastKickNote = note;
          addLog(`[Auth - Kick] Sign-in cookie present, but Kick has not confirmed the account yet (${note}).`);
        }
        return null;
      }

      // Cookie-based detection first (more reliable than DOM selectors).
      try {
        if (p === 'twitch') {
          const cookies = await ses.cookies.get({ name: 'auth-token' });
          if (cookies.some(c => c.domain && c.domain.includes('twitch.tv'))) return {};
        } else if (p === 'youtube') {
          const googleCookies = await ses.cookies.get({ url: 'https://youtube.com' });
          if (googleCookies.some(c => c.name === 'SID' || c.name === 'SSID')) return {};
        } else if (p === 'rumble') {
          const cookies = await ses.cookies.get({ url: 'https://rumble.com' });
          if (cookies.some(c => c.name.includes('session') || c.name === 'u_s')) return {};
        }
      } catch (e) {
        // Cookie check failed, fall through to DOM detection
      }

      // DOM-based detection (fallback)
      let script = '';
      if (p === 'twitch') {
        script = `
          (() => {
            try {
              const twUser = localStorage.getItem('twilight-user');
              if (twUser) {
                const parsed = JSON.parse(twUser);
                if (parsed && parsed.login) return true;
              }
              const userBtn = document.querySelector('[data-a-target="user-menu-toggle"]');
              if (userBtn) return true;
            } catch(e) {}
            return false;
          })()
        `;
      } else if (p === 'youtube') {
        if (url.includes('youtube.com')) {
          script = `
            (() => {
              try {
                if (window.ytcfg && window.ytcfg.get && window.ytcfg.get('LOGGED_IN')) return true;
                return !!document.querySelector('button#avatar-btn, [aria-label*="Account"], #avatar-btn');
              } catch(e) {}
              return false;
            })()
          `;
        }
      } else if (p === 'rumble') {
        script = `
          (() => {
            try {
              return !!document.querySelector('.header-user-name, .user-name, [class*="user-menu"]');
            } catch(e) {}
            return false;
          })()
        `;
      }
      if (!script) return null;
      return (await run(script)) === true ? {} : null;
    }

    async function extractName(hit) {
      if (hit && hit.name) return hit.name;
      if (p === 'twitch') {
        return run(`
          (() => {
            try {
              let username = null;
              const session = localStorage.getItem('twilight-user');
              if (session) {
                const parsed = JSON.parse(session);
                if (parsed && parsed.login) username = parsed.login;
              }
              if (!username) {
                const userBtn = document.querySelector('[data-a-target="user-menu-toggle"]');
                if (userBtn) {
                  const avatar = userBtn.querySelector('img');
                  if (avatar && avatar.alt && avatar.alt !== 'User Avatar') {
                    username = avatar.alt;
                  }
                }
              }
              return username;
            } catch(e) {
              return null;
            }
          })()
        `);
      }
      if (p === 'youtube') {
        const currentUrl = loginWin.webContents.getURL();
        if (!currentUrl.includes('youtube.com')) {
          let timer = null;
          try {
            const load = loginWin.loadURL('https://www.youtube.com');
            load.catch(() => { /* reported below if it lost the race */ });
            await Promise.race([load, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('timed out after 15s')), 15000);
            })]);
          } catch (err) {
            addLog(`[Auth] Navigation to YouTube failed: ${err.message}`);
          } finally {
            clearTimeout(timer);
          }
          await new Promise(r => setTimeout(r, 3000));
        }
        // The script retries for up to about 18 s while the account menu renders.
        return run(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            const cleanName = (name) => {
              if (!name) return null;
              let n = name.replace(/avatar\\s+image\\s+of/i, '')
                          .replace(/photo\\s+of/i, '')
                          .replace(/profile\\s+photo\\s+of/i, '')
                          .replace(/profile\\s+picture\\s+of/i, '')
                          .trim();
              if (n && !n.toLowerCase().includes('avatar') && !n.toLowerCase().includes('profile') && !n.toLowerCase().includes('photo') && !n.toLowerCase().includes('default')) {
                return n;
              }
              return null;
            };

            for (let attempt = 0; attempt < 20; attempt++) {
              try {
                // Strategy 1: Check ytcfg configuration properties
                if (window.ytcfg && window.ytcfg.get) {
                  const handle = window.ytcfg.get('CHANNEL_HANDLE');
                  const name = window.ytcfg.get('USER_NAME');
                  if (handle) return handle;
                  if (name) return name;
                }
                if (window.ytcfg && window.ytcfg.data_) {
                  const d = window.ytcfg.data_;
                  if (d.CHANNEL_HANDLE) return d.CHANNEL_HANDLE;
                  if (d.USER_NAME) return d.USER_NAME;
                }

                // Strategy 2: Check for active menu dropdown headers if already open
                const activeHandle = document.querySelector('ytd-active-account-header-renderer #channel-handle, #channel-handle');
                if (activeHandle && activeHandle.textContent.trim()) {
                  return activeHandle.textContent.trim();
                }
                const activeName = document.querySelector('ytd-active-account-header-renderer #account-name, #account-name');
                if (activeName && activeName.textContent.trim()) {
                  return activeName.textContent.trim();
                }

                // Strategy 3: Try to find avatar button to trigger the dropdown menu
                const avatarBtn = document.querySelector('button#avatar-btn, #avatar-btn, yt-img-shadow#avatar, ytd-topbar-menu-button-renderer');
                if (avatarBtn) {
                  avatarBtn.click();
                  await sleep(400); // Wait for the dropdown to render

                  const handleEl = document.querySelector('ytd-active-account-header-renderer #channel-handle, #channel-handle');
                  if (handleEl && handleEl.textContent.trim()) {
                    return handleEl.textContent.trim();
                  }
                  const nameEl = document.querySelector('ytd-active-account-header-renderer #account-name, #account-name');
                  if (nameEl && nameEl.textContent.trim()) {
                    return nameEl.textContent.trim();
                  }

                  // Strategy 4: Fallback to alt tag or aria-label attributes directly on button/image
                  const img = avatarBtn.querySelector('img');
                  if (img && img.alt) {
                    const name = cleanName(img.alt);
                    if (name) return name;
                  }
                  const label = avatarBtn.getAttribute('aria-label');
                  if (label) {
                    const name = cleanName(label);
                    if (name) return name;
                  }
                }
              } catch (e) {}
              await sleep(500);
            }
            return null;
          })()
        `, 25000);
      }
      if (p === 'rumble') {
        return run(`
          (() => {
            try {
              const nameEl = document.querySelector('.header-user-name, .user-name');
              return nameEl ? nameEl.textContent.trim() : null;
            } catch(e) {
              return null;
            }
          })()
        `);
      }
      return null;
    }

    // Detection already proved the session, so this also runs when the name
    // never arrives (see login-flow.js). An existing real name beats the
    // placeholder.
    const fallbackName = () => {
      const existing = config.accounts && config.accounts[p];
      return existing && !isPlaceholderName(existing) ? existing : placeholderName(p);
    };

    function commitLogin(username) {
      addLog(`[Auth] Account connected: ${username} on ${label}`);
      if (!config.accounts) config.accounts = {};
      config.accounts[p] = username;
      accountEpochs.bump(p);
      if (p === 'youtube') delete config.youtubeExpiredFingerprint;
      saveConfig();
      setSignedOut(p, false);
      notifyLoginSuccess(p, username);
    }

    // One poll at a time, one claim, one save, and the IPC call always
    // resolves: on success, on close, on timeout, or when the name lookup
    // fails after a sign-in was detected (see login-flow.js).
    const flow = createLoginFlow({
      detect: detectLogin,
      extractName: async (hit) => {
        addLog(`[Auth] Successful login detected on ${label}! Extracting username...`);
        const value = await extractName(hit);
        return typeof value === 'string' && value.trim() ? value.trim() : null;
      },
      commit: commitLogin,
      fallbackName,
      closeWindow: () => { if (!loginWin.isDestroyed()) loginWin.close(); },
      onSettled: resolve,
      log: (text) => addLog(`[Auth] Login modal for ${label}: ${text}`),
      deadlineMs: LOGIN_TIMEOUT_MS,
    });
    loginWin.on('closed', () => flow.windowClosed());
    flow.start();
  });
});

ipcMain.handle('logout-platform', async (event, { platform }) => {
  const p = platform.toLowerCase();
  addLog(`[Auth] Signing out of ${platform.toUpperCase()} and purging session cookies...`);

  // Remove from accounts config. The epoch bump makes a health check or name
  // lookup already in flight drop its result instead of re-adding the account.
  accountEpochs.bump(p);
  if (config.accounts && config.accounts[p]) {
    delete config.accounts[p];
    saveConfig();
  }
  if (p === 'youtube' && config.youtubeExpiredFingerprint) {
    delete config.youtubeExpiredFingerprint; // the cookies it describes are purged below
    saveConfig();
  }
  // Or the extension's next background re-sync would sign it straight back in.
  setSignedOut(p, true);

  try {
    const ses = session.fromPartition('persist:default');
    
    // Find all cookies for the platform's domain and delete them programmatically
    let domainFilter = '';
    if (p === 'twitch') domainFilter = 'twitch.tv';
    else if (p === 'kick') domainFilter = 'kick.com';
    else if (p === 'youtube') domainFilter = 'google.com';
    else if (p === 'rumble') domainFilter = 'rumble.com';

    if (domainFilter) {
      const cookies = await ses.cookies.get({ domain: domainFilter });
      addLog(`[Auth] Found ${cookies.length} session cookies for ${domainFilter}. Deleting...`);
      for (const cookie of cookies) {
        const scheme = cookie.secure ? 'https' : 'http';
        const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
        const url = `${scheme}://${domain}${cookie.path}`;
        try {
          await ses.cookies.remove(url, cookie.name);
        } catch (cookieErr) {
          // Ignore
        }
      }

      if (p === 'youtube') {
        // Clear cookies from all Google-related domains for thorough logout
        const googleDomains = ['youtube.com', 'accounts.google.com', 'myaccount.google.com'];
        for (const gDomain of googleDomains) {
          const gCookies = await ses.cookies.get({ domain: gDomain });
          addLog(`[Auth] Found ${gCookies.length} session cookies for ${gDomain}. Deleting...`);
          for (const cookie of gCookies) {
            const scheme = cookie.secure ? 'https' : 'http';
            const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
            const url = `${scheme}://${domain}${cookie.path}`;
            try {
              await ses.cookies.remove(url, cookie.name);
            } catch (cookieErr) {
              // Ignore
            }
          }
        }
      }
    }

    addLog(`[Auth] Successfully signed out of ${platform.toUpperCase()} and purged cookie jar.`);
    return { success: true };
  } catch (err) {
    addLog(`[Auth] Error purging cookies for ${platform.toUpperCase()}: ${err.message}`);
    return { success: false, error: err.message };
  }
});


ipcMain.handle('get-twitch-follows', async () => {
  addLog('[Twitch Sync] Retrieving auth token from cookie jar...');
  try {
    const allCookies = await session.fromPartition('persist:default').cookies.get({
      name: 'auth-token'
    });
    
    const twitchCookie = allCookies.find(c => c.domain && c.domain.includes('twitch.tv'));
    
    if (!twitchCookie) {
      addLog('[Twitch Sync] No Twitch auth-token cookie found. User might not be logged in.');
      return { success: false, error: 'Not logged in to Twitch' };
    }
    
    const token = twitchCookie.value;
    addLog('[Twitch Sync] Securely fetched auth-token cookie. Fetching live follows via GQL...');
    
    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
        'Authorization': `OAuth ${token}`,
        'Cookie': `auth-token=${token}`,
        'Content-Type': 'application/json',
        'User-Agent': normalizedUserAgent
      },
      body: JSON.stringify([{
        operationName: 'FollowedLiveUsers',
        query: `query FollowedLiveUsers {
          currentUser {
            login
            followedLiveUsers(first: 100) {
              edges {
                node {
                  login
                }
              }
            }
          }
        }`
      }])
    });

    if (!response.ok) {
      throw new Error(`GQL request failed: status ${response.status}`);
    }

    const data = await response.json();
    const currentUser = data[0]?.data?.currentUser;
    if (!currentUser) {
      addLog('[Twitch Sync] GQL returned empty currentUser. Token might be invalid or expired.');
      return { success: false, error: 'Failed to fetch Twitch user details' };
    }

    const username = currentUser.login || 'Twitch User';
    const follows = currentUser.followedLiveUsers?.edges?.map(e => e.node.login).filter(Boolean) || [];
    
    addLog(`[Twitch Sync] Successfully synced GQL for ${username}. Found ${follows.length} live follows.`);
    
    if (config.accounts && config.accounts.twitch !== username) {
      config.accounts.twitch = username;
      saveConfig();
    }
    
    return { success: true, username, follows };
  } catch (err) {
    addLog(`[Twitch Sync] Secure GQL sync failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// Extension syncs started by settings saves, one after another: two quick
// saves reconciling at once would both plan the same load.
let extensionSyncQueue = Promise.resolve();

// The dashboard sends its whole copy of the config, taken at page load. Only
// the settings it owns are taken from it, validated, and merged over main's
// live config (see config-boundary.js): accounts, watch time, the pairing
// code and main's markers always stay main's, so a stale copy can no longer
// revert them, and a compromised page can no longer set them.
ipcMain.handle('save-config', (event, newConfig) => {
  const oldInterval = config.checkInterval;
  // Taken before the merge: comparing after compared the new list with
  // itself, so a same-length change never reloaded.
  const oldExtensions = JSON.stringify(Array.isArray(config.extensions) ? config.extensions : []);

  const { patch, refused, approvedUsed } = rendererConfigPatch(newConfig, config, { approvedExtensions: approvedExtensionPaths });
  for (const r of refused) addLog(`[Config] Ignored ${r.key} from the dashboard: ${r.reason}.`);
  // One use each: a folder the user picked is added once.
  for (const p of approvedUsed) approvedExtensionPaths.delete(p);
  const next = { ...config, ...patch };
  // Before it replaces config or reaches disk (see sanitizeIncomingConfig).
  sanitizeIncomingConfig(next, 'settings');
  saveConfig(next);
  addLog('Settings saved.');
  applyStartupSettings();

  // If interval changed, reset the poller
  if (config.checkInterval !== oldInterval) {
    resetPoller();
  }

  // If extensions changed, bring the loaded set in line. A removed extension
  // is unloaded now, but what it injected stays in open pages until they
  // reload, as a newly added one only injects on a load.
  if (JSON.stringify(Array.isArray(config.extensions) ? config.extensions : []) !== oldExtensions) {
    extensionSyncQueue = extensionSyncQueue.then(() => loadExtensions().then((changed) => {
      addLog('Extensions reloaded successfully.');
      if ((changed.loaded || changed.unloaded) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('reload-stream-containers');
      }
    }).catch((err) => reportFatal('loadExtensions', err)));
  }

  return true;
});

ipcMain.handle('add-streamer', (event, { platform, username }) => {
  const cleanUsername = String(username ?? '').trim();
  if (!cleanUsername) return { success: false, error: 'Username cannot be empty' };
  platform = String(platform ?? '');

  const exists = config.streamers.some(
    s => streamerPlatform(s) === platform.toLowerCase() && streamerName(s).toLowerCase() === cleanUsername.toLowerCase()
  );

  if (exists) {
    return { success: false, error: 'Streamer already added' };
  }

  config.streamers.push({ platform: platform.toLowerCase(), username: cleanUsername, mode: 'auto' });
  saveConfig();
  addLog(`Added streamer: ${cleanUsername} on ${platform.toUpperCase()}`);
  
  // Trigger scan for the new streamer. Several adds in a row share one
  // follow-up scan rather than starting one each.
  setTimeout(requestScan, 500);

  return { success: true, streamers: config.streamers };
});

ipcMain.handle('delete-streamer', (event, { platform, username }) => {
  const p = String(platform ?? '').toLowerCase();
  const u = String(username ?? '').toLowerCase();
  config.streamers = config.streamers.filter(
    s => !(streamerPlatform(s) === p && streamerName(s).toLowerCase() === u)
  );
  saveConfig();
  addLog(`Removed streamer: ${username} from ${p.toUpperCase()}`);
  return { success: true, streamers: config.streamers };
});

// Which config.extensions entries were not reachable at the last load, so the
// Extensions tab can show them as unavailable instead of "Active". Runtime
// state only; config.extensions stays a plain list of path strings.
ipcMain.handle('get-extension-status', () => ({
  unavailable: [...unavailableExtensions],
}));

ipcMain.handle('select-extension-folder', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Unpacked Chrome Extension Folder',
    // Without one, Electron 43+ always starts in Downloads (see dialog-dirs.js).
    defaultPath: extensionPickerDir({
      remembered: lastExtensionPickDir,
      extensions: config.extensions,
      managedRoot: path.join(app.getPath('userData'), 'managed-extensions'),
      fallback: app.getPath('documents'),
    }),
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  lastExtensionPickDir = path.dirname(selectedPath);

  // Verify manifest.json exists in this folder
  const manifestPath = path.join(selectedPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    addLog(`Error: Selected folder does not contain a manifest.json. Is this a valid unpacked extension?`);
    return { error: 'Missing manifest.json in selected directory' };
  }

  // Check if extension is already added
  if (Array.isArray(config.extensions) && config.extensions.includes(selectedPath)) {
    return { error: 'Extension already added' };
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    addLog(`Extension directory selected: ${manifest.name || 'Unknown'} at ${selectedPath}`);
    // The dashboard's next save may now add exactly this folder.
    approvedExtensionPaths.add(selectedPath);
    return { path: selectedPath, name: manifest.name || 'Chrome Extension', version: manifest.version || '1.0' };
  } catch (err) {
    return { error: `Failed to read manifest.json: ${err.message}` };
  }
});

// ── Extension Catalog ──────────────────────────────────────────────────────
// Curated list of one-click installable extensions. Each entry points at a
// GitHub repo whose Releases publish a Chromium unpacked .zip. The install flow:
//   1. Hit GitHub API for the latest release JSON
//   2. Find the asset matching `assetPattern` and download it
//   3. Extract to userData/managed-extensions/<id>/
//   4. Locate the directory containing manifest.json and register that path in config.extensions
const EXTENSION_CATALOG = [
  {
    id: 'ublock-origin',
    name: 'uBlock Origin',
    // Honest about what it can do here: the app's own webRequest listeners on
    // the stream session (client-hint spoofing) take precedence over any
    // extension's chrome.webRequest, so uBO's network filters never run, and
    // Twitch/Kick ads are stitched into the video stream server-side anyway.
    description: 'Content blocker, with limits inside Stream Lurker: the embedded browser does not let extensions block network requests, so ads and trackers still load and at most its element-hiding filters apply. Twitch and Kick stream ads are part of the video and are not removed.',
    repo: 'gorhill/uBlock',
    assetPattern: /^uBlock0_.+\.chromium\.zip$/i
  },
  {
    id: '7tv',
    name: '7TV',
    description: 'Adds 7TV global and channel emotes to Twitch and Kick chat inside stream containers.',
    repo: 'SevenTV/Extension',
    // Use the NIGHTLY build's mv3 asset. This is exactly what the old bundled
    // installer pulled, and it works in the embedded webview — the STABLE
    // (`latest`) release's build strips the Twitch chat input and doesn't mount
    // its replacement. The nightly build behaves correctly here.
    releaseTag: 'nightly-release',
    assetPattern: /^7tv-webextension-mv3\.zip$/i
  }
];

// 7TV ships configured for Twitch only. Patch its manifest so it also injects
// on kick.com (host permission + content-script match), restoring the Kick
// emote support the old bundled installer used to add.
function patchSevenTVManifestForKick(manifestRoot) {
  try {
    const manifestPath = path.join(manifestRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (!manifest.host_permissions) manifest.host_permissions = [];
    if (!manifest.host_permissions.includes('*://*.kick.com/*')) {
      manifest.host_permissions.push('*://*.kick.com/*');
    }

    if (Array.isArray(manifest.content_scripts)) {
      manifest.content_scripts.forEach(script => {
        if (script.matches && Array.isArray(script.matches)) {
          const hasTwitch = script.matches.some(m => m.includes('twitch.tv'));
          const hasKick = script.matches.some(m => m.includes('kick.com'));
          if (hasTwitch && !hasKick) script.matches.push('*://*.kick.com/*');
        }
      });
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    addLog('[Catalog] Patched 7TV manifest with Kick.com permissions and content scripts.');
  } catch (e) {
    addLog(`[Catalog] Warning: failed to patch 7TV manifest for Kick: ${e.message}`);
  }
}

function getManagedExtensionsRoot() {
  const dir = path.join(app.getPath('userData'), 'managed-extensions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCatalogEntryInstallPath(id) {
  return path.join(getManagedExtensionsRoot(), id);
}

// Walk the extracted directory to find the dir that contains manifest.json.
// Some zips put files at root; uBlock puts them under uBlock0.chromium/.
function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const e of entries) {
    const sub = path.join(dir, e.name);
    if (fs.existsSync(path.join(sub, 'manifest.json'))) return sub;
  }
  // One more level for safety
  for (const e of entries) {
    const found = findManifestRoot(path.join(dir, e.name));
    if (found) return found;
  }
  return null;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

// GET with a hard deadline and a size cap. The previous helpers had neither, so a
// stalled GitHub response left an install hanging forever with the UI waiting.
function netGet(url, accept, { timeoutMs = 30000, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url,
      headers: { 'User-Agent': 'stream-lurker', 'Accept': accept },
      redirect: 'follow'
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (err) => {
      try { req.abort(); } catch (e) { /* already closed */ }
      finish(reject, err);
    };
    const timer = setTimeout(() => fail(new Error(`Timed out after ${timeoutMs / 1000}s fetching ${url}`)), timeoutMs);
    const chunks = [];
    let size = 0;
    req.on('response', (res) => {
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { fail(new Error(`Response from ${url} is larger than ${maxBytes} bytes`)); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) finish(resolve, body);
        else finish(reject, new Error(`HTTP ${res.statusCode} from ${url}: ${body.toString('utf8', 0, 200)}`));
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

async function fetchJson(url) {
  const body = await netGet(url, 'application/vnd.github+json');
  return JSON.parse(body.toString('utf8'));
}

// Catalog assets are a few MB; holding one in memory avoids a temp file that
// leaked on every failed install.
function downloadBuffer(url) {
  return netGet(url, 'application/octet-stream', { timeoutMs: 120000, maxBytes: 100 * 1024 * 1024 });
}

// Replace `live` with `staging` so that no failure leaves neither. Renaming the
// live dir first is what fails on Windows while its files are locked, and that
// failure happens before anything was changed.
function swapDirectory(staging, live) {
  const old = `${live}.old`;
  rmrf(old);
  const hadLive = fs.existsSync(live);
  if (hadLive) fs.renameSync(live, old);
  try {
    fs.renameSync(staging, live);
  } catch (e) {
    if (hadLive) fs.renameSync(old, live);
    throw e;
  }
  try { rmrf(old); } catch (e) { /* cleared by the next install */ }
}

const catalogInstallsInFlight = new Set();

function getInstalledManifestForCatalogEntry(entry) {
  const root = getCatalogEntryInstallPath(entry.id);
  if (!fs.existsSync(root)) return null;
  const manifestRoot = findManifestRoot(root);
  if (!manifestRoot) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(manifestRoot, 'manifest.json'), 'utf8'));
    return { path: manifestRoot, version: m.version, name: m.name };
  } catch {
    return null;
  }
}

ipcMain.handle('list-catalog-extensions', async () => {
  return EXTENSION_CATALOG.map(entry => {
    const installed = getInstalledManifestForCatalogEntry(entry);
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      repo: entry.repo,
      repoUrl: `https://github.com/${entry.repo}`,
      installed: installed ? { version: installed.version, path: installed.path } : null
    };
  });
});

ipcMain.handle('install-catalog-extension', async (event, { id }) => {
  const entry = EXTENSION_CATALOG.find(e => e.id === id);
  if (!entry) return { ok: false, error: `Unknown catalog id: ${id}` };
  if (catalogInstallsInFlight.has(entry.id)) return { ok: false, error: `${entry.name} is already being installed.` };
  catalogInstallsInFlight.add(entry.id);

  addLog(`[Catalog] Installing ${entry.name}…`);
  try {
    // Some extensions (7TV) ship the build we need on a specific tag (nightly-release)
    // rather than the stable `latest` release.
    const releaseUrl = entry.releaseTag
      ? `https://api.github.com/repos/${entry.repo}/releases/tags/${entry.releaseTag}`
      : `https://api.github.com/repos/${entry.repo}/releases/latest`;
    const release = await fetchJson(releaseUrl);
    const assets = release.assets || [];
    const asset = assets.find(a => entry.assetPattern.test(a.name) && /\.zip$/i.test(a.name));
    if (!asset) {
      const available = assets.map(a => a.name).join(', ');
      return { ok: false, error: `No matching .zip asset in ${entry.releaseTag || 'latest'} release of ${entry.repo}. Available: ${available || 'none'}` };
    }

    addLog(`[Catalog] Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);
    const zip = await downloadBuffer(asset.browser_download_url);
    // Checked against what the release API says about the asset before any of
    // it is unpacked: a truncated or altered download is refused, and the
    // installed version stays as it is.
    const integrity = checkReleaseAsset(zip, asset);
    if (!integrity.ok) throw new Error(`the download of ${asset.name} failed its integrity check (${integrity.reason}). The installed version was kept`);
    addLog(integrity.verified
      ? `[Catalog] Verified ${asset.name} against the release's sha256 digest.`
      : `[Catalog] ${asset.name} matches the release's size; not hash-verified (${integrity.reason}).`);

    // Build the new copy beside the live one and swap only when it is complete,
    // so a failed download, a bad archive or a locked file leaves the working
    // version installed and config.extensions still pointing at it.
    const installRoot = getCatalogEntryInstallPath(entry.id);
    const staging = `${installRoot}.staging`;
    rmrf(staging);
    let unloaded = [];
    try {
      addLog(`[Catalog] Extracting ${asset.name}…`);
      const { refused } = extractZipBuffer(zip, staging);
      if (refused.length) addLog(`[Catalog] Skipped ${refused.length} unsafe path(s) in ${asset.name}.`);
      const stagedManifest = findManifestRoot(staging);
      if (!stagedManifest) throw new Error('Extracted archive did not contain a manifest.json');
      // Per-extension post-install patches.
      if (entry.id === '7tv') patchSevenTVManifestForKick(stagedManifest);
      // The running copy goes first: a loaded copy kept the old version
      // running after an update, and on Windows its service worker holds the
      // folder's files, which makes the rename fail.
      unloaded = unloadExtensionsUnder(installRoot);
      swapDirectory(staging, installRoot);
    } catch (e) {
      rmrf(staging);
      // The previous version is still on disk: put it back in the session.
      for (const p of unloaded) {
        await loadSingleExtension(p).catch((err) => addLog(`[Catalog] Could not reload the previous ${entry.name}: ${err.message}`));
      }
      throw e;
    }

    const manifestRoot = findManifestRoot(installRoot);

    // Replace any prior registration of any subpath of installRoot, then add the new manifestRoot
    config.extensions = (Array.isArray(config.extensions) ? config.extensions : []).filter(p => !isInsideDir(p, installRoot));
    config.extensions.push(manifestRoot);
    saveConfig();

    const manifest = JSON.parse(fs.readFileSync(path.join(manifestRoot, 'manifest.json'), 'utf8'));

    // Load it into the live session immediately so it works without an app restart.
    try {
      await loadSingleExtension(manifestRoot);
      addLog(`[Catalog] Loaded ${entry.name} v${manifest.version} into the live session.`);
      // Reload any open stream containers so the content scripts inject.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('reload-stream-containers');
      }
    } catch (loadErr) {
      addLog(`[Catalog] Installed ${entry.name} but live-load failed (${loadErr.message}). It will load on next app start.`);
    }

    addLog(`[Catalog] Installed ${entry.name} v${manifest.version}.`);
    return { ok: true, path: manifestRoot, version: manifest.version, name: manifest.name };
  } catch (err) {
    addLog(`[Catalog] Install failed for ${entry.name}: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    catalogInstallsInFlight.delete(entry.id);
  }
});

ipcMain.handle('uninstall-catalog-extension', async (event, { id }) => {
  const entry = EXTENSION_CATALOG.find(e => e.id === id);
  if (!entry) return { ok: false, error: `Unknown catalog id: ${id}` };
  // An uninstall must not delete the folder an install is writing.
  if (catalogInstallsInFlight.has(entry.id)) return { ok: false, error: `${entry.name} is being installed; try again when it finishes.` };
  const installRoot = getCatalogEntryInstallPath(entry.id);
  config.extensions = (Array.isArray(config.extensions) ? config.extensions : []).filter(p => !isInsideDir(p, installRoot));
  saveConfig();
  // Unloaded before its files go: it used to keep injecting into every
  // stream until restart, served from a folder that no longer existed.
  const unloaded = unloadExtensionsUnder(installRoot);
  // Content scripts it already injected stay until their page reloads.
  if (unloaded.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reload-stream-containers');
  }
  try {
    rmrf(installRoot);
  } catch (err) {
    // Removed from the list and unloaded either way; only files are left.
    addLog(`[Catalog] Removed ${entry.name}, but some of its files could not be deleted (${err.message}): ${installRoot}`);
    return { ok: true, warning: `Removed, but some files could not be deleted: ${err.message}` };
  }
  addLog(`[Catalog] Uninstalled ${entry.name}.`);
  return { ok: true };
});

// Resolves once a scan that started after the request has finished, so the
// Scan Now button's cooldown covers the real scan.
ipcMain.handle('force-scan', async () => {
  addLog('User requested immediate scan.');
  await requestScan();
  return true;
});

ipcMain.handle('open-stream-container', (event, { platform, username }) => {
  spawnStreamContainer(platform, username);
  return true;
});

// Pop a single stream out into its own always-on-top window (PiP-style). Reuses
// the shared persist:default session so the user's login carries over. `url` is
// the webview's current URL when available, so YouTube live-video state etc. is
// preserved; otherwise we fall back to the channel page.
ipcMain.handle('popout-stream', (event, { platform, username, url }) => {
  const key = `${platform.toLowerCase()}:${username.toLowerCase()}`;

  const existing = popoutWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return true;
  }

  const ses = session.fromPartition('persist:default');
  const win = new BrowserWindow({
    width: 640,
    height: 360,
    title: `${username} · ${platform.toUpperCase()}`,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:default',
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  setContentsRole(win.webContents, 'stream');
  win.setMenuBarVisibility(false);
  // Keep the "name · PLATFORM" label: this window has no address bar, so the
  // title is the only thing telling the user what they are looking at.
  win.on('page-title-updated', (e) => e.preventDefault());
  // Same per-host zoom map as the cells (see web-contents-created).
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.setZoomLevel(0); } catch (e) { /* closing */ }
  });
  win.webContents.setUserAgent(ses.getUserAgent());
  // `url` comes from the renderer (the cell's current page). Only a platform
  // page may be loaded into an always-on-top window on the logged-in session.
  win.loadURL(isPlatformUrl(url) ? url : streamWatchUrl(platform, username));
  popoutWindows.set(key, win);
  addLog(`[Pop-out] Opened floating window for ${username} on ${platform.toUpperCase()}.`);

  win.on('closed', () => {
    popoutWindows.delete(key);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream-popout-closed', { platform, username });
    }
  });
  return true;
});

ipcMain.handle('close-stream-container', (event, { platform, username }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('close-stream-tab', { platform, username });
  }
  // The user closed the stream, not just its cell.
  closePopout(platform, username);
  return true;
});

ipcMain.handle('update-active-tabs', (event, tabsList) => {
  // The renderer's grid is the source of truth for what's open. Diff the
  // incoming list against tracked session starts: any key that disappeared had
  // its container closed, so finalize that session's duration.
  const incoming = new Set(tabsList);
  for (const [key, start] of sessionStarts) {
    if (!incoming.has(key)) {
      finalizeSession(key, start);
      sessionStarts.delete(key);
      streamLiveness.forget(key);
    }
  }
  // Track start times for any open key we aren't already timing (e.g. restored).
  for (const t of tabsList) {
    if (!sessionStarts.has(t)) {
      sessionStarts.set(t, Date.now());
      sessionMinutes.set(t, 0);
    }
    // A cell main did not open (restored, opened in the dashboard) starts out
    // confirmed, like a spawned one.
    if (!activeWindows.has(t)) streamLiveness.start(t, Date.now());
  }

  activeWindows.clear();
  tabsList.forEach(t => activeWindows.set(t, true));
  sendStreamStatusToUI();
  return true;
});

// ── Config backup / transfer ───────────────────────────────────────────────
// Lets the user move a setup between machines and keep a copy of their watch
// history somewhere other than the app's own data directory.
ipcMain.handle('export-config', async () => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Stream Lurker Settings',
      defaultPath: path.join(app.getPath('documents'), `stream-lurker-backup-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    // So Import starts where the last backup was written.
    lastConfigDir = path.dirname(filePath);

    // Without the pairing code (the one secret a local process needs to write
    // cookies into the app) and this machine's cookie-jar markers. Import
    // never takes them from a file either.
    fs.writeFileSync(filePath, JSON.stringify(exportableConfig(config), null, 2), 'utf8');
    addLog(`[Config] Exported settings to ${filePath}`);
    return { success: true, filePath };
  } catch (err) {
    addLog(`[Config] Export failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('import-config', async () => {
  // Nothing would be saved, and the import would look like it worked.
  if (configWriteLocked) {
    return { success: false, error: 'Your current settings file could not be read at startup, so Stream Lurker is not saving anything. Restart Stream Lurker (or choose Retry) before importing.' };
  }
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Stream Lurker Settings',
      // Without one, Electron 43+ always starts in Downloads. Documents is
      // where Export writes by default.
      defaultPath: existingDir(lastConfigDir) || app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { success: false, canceled: true };
    lastConfigDir = path.dirname(filePaths[0]);

    const incoming = readConfigFile(filePaths[0]);
    if (!incoming) return { success: false, error: 'That file is not valid JSON.' };
    // Only the portable user data and settings, validated (see
    // config-boundary.js). A backup, possibly someone else's, never brings
    // extension folders (loaded with file access into the session holding
    // every login), a pairing code or account names with it.
    const imported = importedConfig(incoming, config);
    // Sanity-check it actually looks like a Stream Lurker backup before letting
    // it replace a working setup.
    if (!imported) {
      return { success: false, error: 'That does not look like a Stream Lurker backup (missing streamers / watchTime).' };
    }

    // Snapshot what's there now so a regretted import is recoverable, with
    // the minutes the one-minute flush has not written yet.
    if (watchTimeDirty) {
      saveConfig();
      watchTimeDirty = false;
    }
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.copyFileSync(configPath, `${configPath}.preimport-${stamp}.json`); } catch (e) { /* best effort */ }
    }

    const source = path.basename(filePaths[0]);
    config = imported.config;
    config.rumbleEnabled = false; // still not supported, whatever the backup says
    // Before saveConfig, so a bad value never reaches config.json or .bak.
    // Entries the import refused are set aside with the ones the normalizer drops.
    sanitizeIncomingConfig(config, source, imported.dropped);
    capLongestSessions(config.watchTime);
    saveConfig();

    for (const r of imported.refused) addLog(`[Config] Kept this computer's ${r.key}: the value in ${source} is ${r.reason}.`);
    if (imported.ignored.length) {
      addLog(`[Config] Not imported (this computer's own, or unknown): ${imported.ignored.slice(0, 12).join(', ')}${imported.ignored.length > 12 ? ', …' : ''}.`);
    }
    const count = config.streamers.length;
    addLog(`[Config] Imported settings from ${filePaths[0]} (${count} streamer${count === 1 ? '' : 's'}).`);
    applyStartupSettings();
    resetPoller();
    return { success: true, config, streamers: count, skipped: imported.dropped.length };
  } catch (err) {
    addLog(`[Config] Import failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-recent-logs', () => {
  return logs;
});

ipcMain.handle('get-active-containers', () => {
  return Array.from(activeWindows.keys());
});

// The last scan's statuses, pulled by the dashboard at init. A push on load
// would race the renderer registering its status-update listener.
ipcMain.handle('get-statuses', () => {
  return lastScanResults;
});

// ── Auto-Updater ───────────────────────────────────────────────────────────
// User-triggered: the renderer's "Check for Updates" button calls these handlers.
// We do NOT auto-download — we only download after the user confirms via UI.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => {
  addLog('[Updater] Checking for updates…');
  sendUpdateEvent('update-status', { state: 'checking' });
});
autoUpdater.on('update-available', (info) => {
  addLog(`[Updater] Update available: v${info.version}`);
  sendUpdateEvent('update-status', { state: 'available', version: info.version, releaseNotes: info.releaseNotes, releaseName: info.releaseName });
});
autoUpdater.on('update-not-available', (info) => {
  addLog(`[Updater] No update available (current v${app.getVersion()}).`);
  sendUpdateEvent('update-status', { state: 'not-available', version: info && info.version });
});
autoUpdater.on('error', (err) => {
  addLog(`[Updater] Error: ${err && err.message ? err.message : err}`);
  sendUpdateEvent('update-status', { state: 'error', message: err && err.message ? err.message : String(err) });
});
autoUpdater.on('download-progress', (progress) => {
  sendUpdateEvent('update-status', {
    state: 'downloading',
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total
  });
});
autoUpdater.on('update-downloaded', (info) => {
  addLog(`[Updater] Update downloaded: v${info.version}. Ready to install.`);
  sendUpdateEvent('update-status', { state: 'downloaded', version: info.version });
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    const msg = 'Auto-update only works in packaged builds. Running from source.';
    addLog(`[Updater] ${msg}`);
    sendUpdateEvent('update-status', { state: 'dev', message: msg, currentVersion: app.getVersion() });
    return { ok: false, dev: true, currentVersion: app.getVersion() };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, currentVersion: app.getVersion(), updateInfo: result && result.updateInfo };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('install-update', () => {
  // Quit and install. isSilent=false shows the installer UI; isForceRunAfter=true relaunches the app.
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Watch time tracking and timer
let watchTimeTimerId = null;
function startWatchTimeTracking() {
  if (watchTimeTimerId) clearInterval(watchTimeTimerId);
  watchTimeTimerId = setInterval(() => {
    // The cells live inside the dashboard: while it is crashed or reloading
    // nothing plays, whatever activeWindows still lists.
    if (!dashboardHealth.creditsWatchTime || activeWindows.size === 0) return;

    if (!config.watchTime) {
      config.watchTime = { streamers: {}, platforms: { twitch: 0, kick: 0, youtube: 0, rumble: 0 }, sessions: 0 };
    }
    if (!config.watchTime.streamers) config.watchTime.streamers = {};
    if (!config.watchTime.platforms) config.watchTime.platforms = { twitch: 0, kick: 0, youtube: 0, rumble: 0 };
    if (config.watchTime.sessions == null) config.watchTime.sessions = 0;
    if (!config.watchTime.streamerSessions) config.watchTime.streamerSessions = {};
    if (!config.watchTime.daily) config.watchTime.daily = {};

    let updated = false;
    const now = Date.now();
    const intervalMs = scanIntervalMs(config);
    for (const key of activeWindows.keys()) {
      const [platform, username] = key.split(':');
      if (!platform || !username) continue;

      // Only while scans still confirm the stream live: an outage or a run of
      // 403s keeps the cell open (errors never auto-close), and crediting it
      // meanwhile wrote phantom hours into the history. See stream-liveness.js.
      const verdict = streamLiveness.credit(key, now, intervalMs);
      if (verdict.transition === 'paused') {
        const since = verdict.lastLiveAt ? new Date(verdict.lastLiveAt).toLocaleTimeString() : 'unknown';
        addLog(`[Watch time] Paused for ${key}: no scan has confirmed it live since ${since}.`);
      } else if (verdict.transition === 'resumed') {
        addLog(`[Watch time] Resumed for ${key}: a scan confirmed it live again.`);
      }
      if (!verdict.credit) continue;

      const streamerKey = `${platform}:${username}`;
      config.watchTime.streamers[streamerKey] = (config.watchTime.streamers[streamerKey] || 0) + 1;
      config.watchTime.platforms[platform] = (config.watchTime.platforms[platform] || 0) + 1;
      // The session's length is these same minutes, so it matches the totals
      // by construction and cannot count sleep (see session-stats.js).
      if (sessionMinutes.has(key)) sessionMinutes.set(key, sessionMinutes.get(key) + 1);
      updated = true;
    }

    // One calendar minute of lurking for today (regardless of how many streams
    // are open) — drives the daily activity heatmap and streak counters.
    if (updated) {
      const dk = todayKey();
      config.watchTime.daily[dk] = (config.watchTime.daily[dk] || 0) + 1;
    }

    if (updated) {
      watchTimeDirty = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watch-time-update', config.watchTime);
      }
    }
  }, 60000); // Increment every minute; saved by the one-minute dirty flush
}

// Platform calendars (see schedule-sync.js): every request under the
// scanner's deadline, three at a time, and one log line for all of Kick.
const scheduleSync = createScheduleSync({
  fetch: (url, init) => net.fetch(url, init),
  userAgent: () => normalizedUserAgent,
  clientId: TWITCH_PUBLIC_CLIENT_ID,
  runParallel: checkStreamersParallel,
  log: addLog,
});

// twitch-preload.js still asks for a Twitch device id at document start, and
// sendSync blocks the page until it is answered. Nothing records one any
// more: only the removed hidden Drops window ever set it, so the answer was
// always null. Answered until the preload stops asking.
ipcMain.on('get-twitch-unique-id-sync', (event) => {
  event.returnValue = null;
});


// Open a URL in the user's default browser. The renderer can't use Electron's
// shell directly under context isolation, so it routes through here.
ipcMain.handle('open-external', async (event, url) => {
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false, error: 'Invalid URL' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Browser-assisted Twitch login: Twitch's protected_login gate (Kasada) rejects
// embedded browsers (error_code 5025). Instead, the user signs in with their real
// browser and pastes their cookies. A token-ONLY import gets logged out on load
// because the session is bound to the browser's device cookies (unique_id, etc.),
// so we accept the FULL `document.cookie` string and replicate the whole session.
ipcMain.handle('set-twitch-token', async (event, rawInput) => {
  try {
    const raw = String(rawInput || '').trim();

    // Parse the input. Two accepted forms:
    //  (a) a full `document.cookie` string: "auth-token=ab..; unique_id=..; login=.."
    //  (b) just the auth-token value (or "auth-token=VALUE").
    const pairs = [];
    let token = '';
    if (/;/.test(raw) || /\b\w+=/.test(raw)) {
      for (const part of raw.split(/;\s*/)) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!name || !value) continue;
        pairs.push({ name, value });
        if (name.toLowerCase() === 'auth-token') token = value;
      }
    }
    if (!token) {
      const m = raw.match(/auth-?token\s*[=:]\s*([a-z0-9]+)/i);
      token = (m ? m[1] : raw).replace(/^["']|["']$/g, '').trim();
      if (token && !pairs.some(p => p.name.toLowerCase() === 'auth-token')) {
        pairs.push({ name: 'auth-token', value: token });
      }
    }
    if (!/^[a-z0-9]{20,60}$/i.test(token)) {
      return { success: false, error: 'Could not find an auth-token. On twitch.tv open the console (F12) and run copy(document.cookie), then paste that here.' };
    }

    // 1) Verify the token resolves a user BEFORE touching cookies (non-destructive).
    // A network failure is not a rejection: nothing is changed and the user is
    // told to retry, not to sign in again.
    const check = await resolveTwitchUser(token);
    addLog(`[Auth] Token validation ${describeTwitchUserResult(check)}.`);
    const username = check.login;
    if (!username) {
      return { success: false, error: twitchUserFailureMessage(check, 'token') };
    }

    // Ensure a `login` cookie is present so the web client knows the username.
    if (!pairs.some(p => p.name.toLowerCase() === 'login')) {
      pairs.push({ name: 'login', value: username });
    }

    // 2) Clear old auth cookies, then write the imported session cookies. Importing
    // the whole set (auth-token + unique_id + persistent + ...) keeps the session
    // device-consistent so Twitch's client doesn't log it out. (Chromium won't let a
    // JS-readable cookie overwrite an httpOnly one, so clear first.)
    const ses = session.fromPartition('persist:default');
    const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    for (const p of pairs) {
      try {
        const existing = await ses.cookies.get({ name: p.name });
        for (const c of existing) {
          if (!/twitch\.tv$/i.test(c.domain.replace(/^\./, ''))) continue;
          const scheme = c.secure ? 'https' : 'http';
          const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
          await ses.cookies.remove(`${scheme}://${host}${c.path || '/'}`, p.name);
        }
      } catch (e) {}
    }
    let setCount = 0;
    for (const p of pairs) {
      try {
        await ses.cookies.set({ url: 'https://www.twitch.tv', name: p.name, value: p.value, domain: '.twitch.tv', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction', expirationDate });
        setCount++;
      } catch (e) {
        addLog(`[Auth] Could not set cookie ${p.name}: ${e.message}`);
      }
    }
    const verify = await ses.cookies.get({ name: 'auth-token' });
    addLog(`[Auth] Imported Twitch session for ${username}: set ${setCount}/${pairs.length} cookies (auth-token present: ${verify.length > 0}).`);

    config.accounts = config.accounts || {};
    config.accounts.twitch = username;
    accountEpochs.bump('twitch');
    saveConfig();
    setSignedOut('twitch', false);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-success', { platform: 'twitch', username });
    }
    return { success: true, username, cookiesSet: setCount };
  } catch (err) {
    addLog(`[Auth] Twitch token import failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// Browser-assisted YouTube/Google login. Google blocks embedded sign-in
// ("this browser may not be secure"), so the user exports their google.com +
// youtube.com cookies from a real browser and we replicate the full session
// (preserving httpOnly/secure attributes — Google's session cookies are httpOnly).
// Parsed by cookie-import.js, then the same path as the extension's import:
// same filter, same writer, and the answer comes from a real YouTube page
// instead of a bare fetch (which reports signed-out for live sessions).
ipcMain.handle('set-google-cookies', async (event, blob) => {
  try {
    const parsed = assignPastedYouTubeDomains(parseCookieBlob(blob));
    const result = await importGoogleSession(parsed, { paste: true });
    // Connected again by hand: the extension may re-sync YouTube again.
    if (result && result.success) setSignedOut('youtube', false);
    return result;
  } catch (err) {
    addLog(`[Auth] Google cookie import failed: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 1-click login: companion browser extension posts the user's platform cookies
// to a localhost-only receiver, which replicates the session (same mechanism as
// the manual paste flows above, just automated). Shared import helpers below.
// ───────────────────────────────────────────────────────────────────────────

// Write a list of normalized cookie objects to the session. cookie-import.js
// decides each cookie's exact shape (host-only and __Host- cookies carry no
// Domain, or Chromium rejects them or widens them to every subdomain) and
// which existing same-named cookies go first (Chromium blocks a JS-readable
// cookie from overwriting an httpOnly one). All clearing happens before the
// first write, so one import never deletes a cookie it just wrote.
async function writeCookieList(cookieList, defaultDomain) {
  const ses = session.fromPartition('persist:default');
  const plan = planCookieWrites(cookieList, { defaultDomain });
  for (const name of plan.clear.keys()) {
    try {
      const existing = await ses.cookies.get({ name });
      for (const ex of existing) {
        if (shouldClearExisting(ex, plan)) await ses.cookies.remove(removalUrl(ex), name);
      }
    } catch (e) {}
  }
  let count = 0;
  for (const details of plan.writes) {
    try {
      await ses.cookies.set(details);
      count++;
    } catch (e) {
      addLog(`[Ext] Could not set cookie ${details.name}: ${e.message}`);
    }
  }
  return count;
}

function notifyLoginSuccess(platform, username) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('login-success', { platform, username });
  }
}

// { login, reason: 'ok' | 'rejected' | 'network' | 'unexpected', status }.
// Bounded at 15 s (see twitch-user.js).
function resolveTwitchUser(token) {
  return resolveTwitchUserVia(token, { fetch: net.fetch, clientId: TWITCH_PUBLIC_CLIENT_ID, userAgent: normalizedUserAgent });
}

// Import functions used by the extension receiver. Each takes an array of cookie
// objects (as returned by chrome.cookies.getAll) for that platform.
async function importTwitchSession(cookieList, opts = {}) {
  const list = (cookieList || [])
    .filter(c => c && c.name && /(^|\.)twitch\.tv$/.test((c.domain || '').replace(/^\./, '')))
    .map(c => ({ ...c, httpOnly: c.name.toLowerCase() === 'auth-token' ? false : !!c.httpOnly }));
  const token = list.find(c => c.name.toLowerCase() === 'auth-token')?.value || '';
  if (!/^[a-z0-9]{20,60}$/i.test(token)) return { success: false, error: 'No Twitch auth-token found in the cookies. Are you logged in on twitch.tv?' };
  // Validated before any cookie is touched; a network failure leaves the
  // current session and account exactly as they were.
  const check = await resolveTwitchUser(token);
  const username = check.login;
  if (!username) {
    addLog(`[Ext] Twitch ${opts.auto ? 're-sync' : 'import'} not applied: ${describeTwitchUserResult(check)}.`);
    return { success: false, error: twitchUserFailureMessage(check, 'session') };
  }
  accountEpochs.bump('twitch');
  if (!list.some(c => c.name.toLowerCase() === 'login')) {
    list.push({ name: 'login', value: username, domain: '.twitch.tv', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction' });
  }
  const setCount = await writeCookieList(list, '.twitch.tv');
  config.accounts = config.accounts || {};
  const previous = config.accounts.twitch;
  config.accounts.twitch = username;
  saveConfig();
  // A background re-sync stays quiet unless it put a different account in
  // place: the card must never keep showing the old name for a new session.
  if (!opts.auto || !sameAccountName(previous, username)) notifyLoginSuccess('twitch', username);
  if (opts.auto && previous && !sameAccountName(previous, username)) {
    addLog(`[Ext] The Twitch account changed from ${previous} to ${username} with a background re-sync from the browser extension.`);
  }
  addLog(`[Ext] ${opts.auto ? 'Re-synced' : 'Imported'} Twitch session for ${username} (${setCount} cookies).`);
  return { success: true, username, cookiesSet: setCount };
}

// opts.auto: the extension's background re-sync. opts.paste: the Import &
// Verify modal, which must not report success for cookies YouTube rejects.
async function importGoogleSession(cookieList, opts = {}) {
  // C1: youtube.com (any subdomain), and exactly google.com / accounts.google.com.
  const relevant = (cookieList || []).filter(c => c && c.name && isYouTubeCookieDomain(c.domain));
  if (!relevant.length) {
    return { success: false, error: opts.paste
      ? 'No Google/YouTube cookies found in that paste. Export cookies for youtube.com (and google.com) and paste the whole thing.'
      : 'No Google/YouTube cookies found. Open youtube.com (logged in) first.' };
  }
  if (!hasGoogleSessionCookies(relevant)) {
    // What document.cookie, or a cookies.txt without its #HttpOnly_ lines,
    // yields: SID/APISID/SAPISID but none of the httpOnly session cookies.
    return { success: false, error: opts.paste
      ? 'Those cookies are missing Google\'s httpOnly sign-in cookies (__Secure-1PSID, or SID with HSID and SSID). A copy of document.cookie cannot include them: use a cookie-export extension (Cookie-Editor, or Get cookies.txt LOCALLY) while signed in to youtube.com, and paste its whole export.'
      : 'Missing the Google sign-in session cookies (e.g. __Secure-1PSID/SID).' };
  }
  accountEpochs.bump('youtube');
  const setCount = await writeCookieList(relevant, '.youtube.com');
  if (!setCount) {
    return { success: false, error: 'None of those cookies could be saved (see the activity log). Export them again and paste the whole export.' };
  }

  // No net.fetch check here on purpose: fetching youtube.com with the cookie jar
  // reports signed-out for sessions that work perfectly in a browser, so it
  // can't verify anything. The probe below asks a real page instead.
  config.accounts = config.accounts || {};
  youtubeSignedOutStreak = 0; // fresh cookies — give it a clean slate
  delete config.youtubeExpiredFingerprint; // new cookies; the old verdict no longer applies

  // The account name only exists inside a loaded YouTube page. Skip the page
  // load on routine re-syncs where we already have a real name. fresh(): a
  // probe that loaded before these cookies were written would describe the
  // old session.
  let probe = null;
  if (opts.paste || !opts.auto || isPlaceholderName(config.accounts.youtube)) {
    probe = await youtubeProbe.fresh();
  }
  // A real page says these cookies are signed out. A paste must not report
  // success, and a background re-sync must not bring back an account the
  // health check already expired (it would expire, and notify, all over again).
  if (probe && probe.state === 'signed-out' && (opts.paste || (opts.auto && !config.accounts.youtube))) {
    // Remembered like a health-check expiry, so the next launch does not
    // rebuild the account from them either (validateSavedSessions).
    try {
      const fingerprint = youtubeAuthFingerprint(await readYouTubeAuthCookies());
      if (fingerprint) config.youtubeExpiredFingerprint = fingerprint;
    } catch (e) { /* no marker */ }
    saveConfig();
    addLog(`[${opts.paste ? 'Auth' : 'Ext'}] Wrote ${setCount} Google/YouTube cookies, but YouTube shows them signed out; not connecting the account.`);
    return { success: false, error: opts.paste
      ? 'YouTube still shows you as signed out with those cookies. Sign in on youtube.com in your browser, export the cookies again, and paste the whole export.'
      : 'YouTube shows this session as signed out in Stream Lurker, so YouTube stays disconnected. Sign in again on youtube.com, then click Connect YouTube.' };
  }
  const previous = config.accounts.youtube;
  if (probe) config.accounts.youtube = probe.name || config.accounts.youtube || placeholderName('youtube');
  if (!config.accounts.youtube) config.accounts.youtube = placeholderName('youtube');

  saveConfig();
  // A routine re-sync loads no page and so cannot tell who the cookies belong
  // to; the periodic health check compares the name (runYouTubeSessionHealthCheck).
  if (!opts.auto || !sameAccountName(previous, config.accounts.youtube)) notifyLoginSuccess('youtube', config.accounts.youtube);
  const how = opts.paste ? 'Imported pasted' : (opts.auto ? 'Re-synced' : 'Imported');
  addLog(`[${opts.paste ? 'Auth' : 'Ext'}] ${how} Google/YouTube session as ${config.accounts.youtube} (${setCount}/${relevant.length} cookies${probe ? `, YouTube reports ${probe.state}` : ''}).`);
  const result = { success: true, username: config.accounts.youtube, cookiesSet: setCount };
  if (probe) result.verified = probe.state === 'live';
  return result;
}

// How often a background Kick re-sync (every 30 minutes) may spend a hidden
// page load confirming whose session it just wrote. Once per launch, then
// twice a day.
const KICK_NAME_RECHECK_MS = 12 * 60 * 60 * 1000;
let kickNameCheckedAt = 0;

async function importKickSession(cookieList, opts = {}) {
  const relevant = (cookieList || []).filter(c => /(^|\.)kick\.com$/.test((c.domain || '').replace(/^\./, '').toLowerCase()));
  if (!relevant.length) return { success: false, error: 'No kick.com cookies found. Open kick.com (logged in) first.' };
  // Checked before anything is written. Without session_token the browser is
  // signed out of Kick (kick_session is a visitor cookie), and writing its
  // anonymous cookies would replace a session the app may still hold. A
  // background re-sync then changes nothing, including the saved account.
  if (!hasKickSessionToken(relevant)) {
    if (opts.auto) addLog('[Ext] Kick re-sync skipped: the browser is not signed in to kick.com; kept the app\'s current Kick session.');
    return { success: false, error: opts.auto
      ? 'Not signed in to kick.com in this browser; Stream Lurker kept its current Kick session.'
      : 'You are not signed in to kick.com in this browser. Sign in there, then click Connect Kick again.' };
  }
  accountEpochs.bump('kick');
  const setCount = await writeCookieList(relevant, '.kick.com');
  config.accounts = config.accounts || {};
  const previous = config.accounts.kick;

  // Ask Kick who we are rather than showing "Kick User". Worth a page load on
  // a real connect, when we still don't have a proper name, and now and then
  // on a re-sync, which can swap in another account's session unnoticed.
  // (Comparing cookie values cannot tell: Kick rotates them on every request.)
  const recheck = opts.auto && Date.now() - kickNameCheckedAt >= KICK_NAME_RECHECK_MS;
  if (!opts.auto || isPlaceholderName(config.accounts.kick) || recheck) {
    const resolved = await kickNameProbe.fresh();
    kickNameCheckedAt = Date.now();
    if (resolved) config.accounts.kick = resolved;
    else if (!config.accounts.kick) config.accounts.kick = placeholderName('kick');
  }
  if (!config.accounts.kick) config.accounts.kick = placeholderName('kick');

  saveConfig();
  if (!opts.auto || !sameAccountName(previous, config.accounts.kick)) notifyLoginSuccess('kick', config.accounts.kick);
  if (opts.auto && previous && !isPlaceholderName(previous) && !sameAccountName(previous, config.accounts.kick)) {
    addLog(`[Ext] The Kick account changed from ${previous} to ${config.accounts.kick} with a background re-sync from the browser extension.`);
  }
  addLog(`[Ext] ${opts.auto ? 'Re-synced' : 'Imported'} Kick session as ${config.accounts.kick} (${setCount} cookies).`);
  return { success: true, username: config.accounts.kick, cookiesSet: setCount };
}

// Stable pairing code (persisted) the extension must present to import cookies,
// and the key /ping proves the app holds. Never logged. A stored value that is
// not a code (a number, a short string from a hand edit) could never match
// anything, so it is replaced (see config-boundary.js).
function getPairingCode() {
  const stored = normalizePairingCode(config.extensionPairingCode);
  if (!stored) {
    config.extensionPairingCode = newPairingCode(crypto.randomBytes);
    saveConfig();
  } else if (stored !== config.extensionPairingCode) {
    config.extensionPairingCode = stored;
    saveConfig();
  }
  return config.extensionPairingCode;
}

// C1: a platform the user signed out of in the app. The extension's automatic
// re-sync is refused for it (409 SIGNED_OUT) until the user connects it again
// by hand, whichever way they do that. Persisted: a restart must not undo a
// sign-out.
const SIGN_OUT_PLATFORMS = ['twitch', 'kick', 'youtube', 'rumble'];
function setSignedOut(platform, signedOut) {
  const p = String(platform || '').toLowerCase();
  if (!SIGN_OUT_PLATFORMS.includes(p) || isSignedOutIn(config.signedOutPlatforms, p) === signedOut) return;
  config.signedOutPlatforms = withSignedOut(config.signedOutPlatforms, p, signedOut);
  saveConfig();
}

const RECEIVER_PORTS = [47100, 47101, 47102, 47103, 47104];
// Reservations (Hyper-V, WSL, Docker) change across reboots and service
// restarts, and the app runs for weeks: try again rather than once.
const RECEIVER_RETRY_MS = 10 * 60 * 1000;
let cookieReceiver = null;
let cookieReceiverPort = 0;
let cookieReceiverStarting = false;
let cookieReceiverError = '';
const pairingGuard = createPairingGuard();

// Every check on a request (Host, Origin, content type, pairing code, lockout,
// SIGNED_OUT) is in cookie-receiver.js.
const handleReceiverRequest = createReceiverHandler({
  getPort: () => cookieReceiverPort,
  getPairingCode,
  guard: pairingGuard,
  importers: { twitch: importTwitchSession, youtube: importGoogleSession, kick: importKickSession },
  isSignedOut: (platform) => isSignedOutIn(config.signedOutPlatforms, platform),
  onManualImport: (platform) => setSignedOut(platform, false),
  log: addLog,
});

function startCookieReceiver() {
  if (cookieReceiver || cookieReceiverStarting) return;
  cookieReceiverStarting = true;
  listenOnFirstPort({
    ports: RECEIVER_PORTS,
    host: '127.0.0.1',
    createServer: () => createReceiverServer(handleReceiverRequest),
    onRuntimeError: (err) => addLog(`[Ext] Cookie receiver error: ${err && err.message}`),
  }).then(({ server, port, errors }) => {
    cookieReceiverStarting = false;
    if (server) {
      cookieReceiver = server;
      cookieReceiverPort = port;
      cookieReceiverError = '';
      addLog(`[Ext] 1-click login receiver on 127.0.0.1:${port}.`);
      return;
    }
    const detail = errors.map(e => `${e.port} ${e.code}`).join(', ');
    cookieReceiverError = `No port could be opened (${detail}).`;
    addLog(`[Ext] Could not open the 1-click login receiver on any of ports ${RECEIVER_PORTS[0]}-${RECEIVER_PORTS[RECEIVER_PORTS.length - 1]} (${detail}). The browser extension cannot connect; trying again in ${RECEIVER_RETRY_MS / 60000} minutes.`);
    setTimeout(startCookieReceiver, RECEIVER_RETRY_MS);
  }).catch((err) => {
    cookieReceiverStarting = false;
    reportFatal('startCookieReceiver', err);
  });
}

// Resolve the on-disk path of the bundled extension (works packaged or in dev).
function getExtensionPath() {
  const packaged = path.join(process.resourcesPath || '', 'extension');
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, 'extension');
}

ipcMain.handle('get-extension-info', () => ({
  pairingCode: getPairingCode(),
  port: cookieReceiverPort,
  ports: RECEIVER_PORTS,
  // Set when no port could be bound, so Platform Logins can say why the
  // extension finds nothing.
  receiverError: cookieReceiverError,
  extensionPath: getExtensionPath()
}));

// A fresh 128-bit code, for a code that was shared or leaked. The paired
// extension stops syncing until the new code is pasted into it (its popup
// then says the code does not match), so this is the user's call only.
ipcMain.handle('rotate-pairing-code', () => {
  config.extensionPairingCode = newPairingCode(crypto.randomBytes);
  saveConfig();
  pairingGuard.reset();
  addLog('[Ext] Generated a new pairing code. Paste it into the browser extension to reconnect it.');
  return { pairingCode: config.extensionPairingCode };
});

// shell.openPath never rejects for a folder it cannot open: it resolves with
// an error message, and '' means it opened.
ipcMain.handle('open-extension-folder', async () => {
  const p = getExtensionPath();
  try {
    if (!fs.existsSync(p)) {
      addLog(`[Ext] The extension folder is missing: ${p}. Reinstalling Stream Lurker restores it.`);
      return { success: false, error: 'The extension folder is missing. Reinstall Stream Lurker to restore it.', path: p };
    }
    const err = await shell.openPath(p);
    if (err) {
      addLog(`[Ext] Could not open the extension folder ${p}: ${err}`);
      return { success: false, error: err, path: p };
    }
    return { success: true, path: p };
  } catch (e) {
    return { success: false, error: e.message, path: p };
  }
});

ipcMain.handle('download-clip', async (event, url, filename) => {
  try {
    // https on Twitch's clip hosts only, as the dashboard builds them (see
    // clip-download.js): not http:, not a LAN address.
    const clipUrl = clipDownloadUrl(url);
    if (mainWindow && clipUrl) {
      // A bare, legal file name, offered in Downloads. Never a path.
      const name = clipFileName(filename);
      addLog(`[Clips] Starting download for: ${name}`);
      // Registered before the download starts, so will-download (see
      // handleWillDownload) recognises it as ours and lets it through.
      clipDownloads.expect(clipUrl, path.join(app.getPath('downloads'), name));
      mainWindow.webContents.downloadURL(clipUrl);
      return { success: true };
    }
    return { success: false, error: 'Invalid URL or no main window' };
  } catch (err) {
    addLog(`[Clips] Download error: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-clip-window', async (event, url) => {
  try {
    // A twitch.tv page over https, like every clip link the dashboard makes.
    const pageUrl = clipPageUrl(url);
    if (pageUrl) {
      const clipWin = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'Clip Player',
        backgroundColor: '#000000',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });
      setContentsRole(clipWin.webContents, 'clip');
      clipWin.loadURL(pageUrl);
      return { success: true };
    }
    return { success: false, error: 'Invalid URL' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


// Always settles: every request has a deadline (see schedule-sync.js).
ipcMain.handle('sync-platform-schedules', async () => scheduleSync.syncSchedules({
  twitch: monitoredUsernames('twitch'),
  youtube: monitoredUsernames('youtube'),
  kick: monitoredUsernames('kick'),
}));

