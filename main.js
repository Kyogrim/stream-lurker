const { app, BrowserWindow, ipcMain, session, dialog, net, Notification, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');
const extractZip = require('extract-zip');

// Enable extension support in Electron partitioned sessions & webviews by bypassing sandbox restrictions
app.commandLine.appendSwitch('disable-extension-sandbox');

// Disable backgrounding, occlusion, and timer throttling for hidden windows to ensure Kasada challenges run correctly
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'true');
app.commandLine.appendSwitch('disable-renderer-backgrounding', 'true');
app.commandLine.appendSwitch('disable-background-timer-throttling', 'true');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Constants
const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Global variables
let mainWindow = null;
let tray = null;
const activeWindows = new Map(); // Key: platform:username -> true
let activeQuestStreamer = null; // Track active quest streamer (lowercase) to prevent preemption/auto-close
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

// Map of already opened stream session identifiers to prevent opening duplicate tabs/windows
// We store "platform:username:liveSince" or "platform:username:dateString"
const openedSessions = new Map(); // key -> timestamp for time-based eviction

let pollIntervalId = null;
let countdownTimerId = null;
let nextScanTime = 0;
const logs = [];
let normalizedUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// The original, un-normalized Electron UA captured at startup. Login windows use
// THIS (not the normalized one) so navigator.userAgent stays consistent with
// navigator.userAgentData / Sec-CH-UA. Stripping Electron from the UA string while
// leaving the client hints intact creates a mismatch that trips Google's
// "this browser may not be secure" embedded-login block. The initial build never
// normalized the UA, which is why login worked there.
let defaultElectronUA = null;

// Twitch OAuth token cache
let twitchTokenCache = { token: null, expiresAt: 0 };

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

// Load configuration
function loadConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const loaded = JSON.parse(data);
      config = { ...config, ...loaded };
      
      // Initialize defaults for new settings
      if (!config.watchTime) {
        config.watchTime = { streamers: {}, platforms: { twitch: 0, kick: 0, youtube: 0, rumble: 0 } };
      }
      if (!config.watchTime.streamers) config.watchTime.streamers = {};
      if (!config.watchTime.platforms) config.watchTime.platforms = { twitch: 0, kick: 0, youtube: 0, rumble: 0 };
      if (!config.calendarEvents) config.calendarEvents = [];
      if (!config.syncedCalendarEvents) config.syncedCalendarEvents = [];
      if (!config.seventvLastUpdated) config.seventvLastUpdated = null;
      if (!config.defaultQuality) config.defaultQuality = '160p';
      if (!config.disabledAutoQuality) config.disabledAutoQuality = {};
      if (!config.accounts) config.accounts = {};

      // Rumble is a "coming soon" feature — force it off regardless of any
      // stale saved value so the scanner never polls it.
      config.rumbleEnabled = false;

      addLog('Configuration loaded successfully.');
    } else {
      addLog('No existing configuration found. Creating defaults...');
      config.watchTime = { streamers: {}, platforms: { twitch: 0, kick: 0, youtube: 0, rumble: 0 } };
      config.calendarEvents = [];
      config.syncedCalendarEvents = [];
      config.seventvLastUpdated = null;
      config.defaultQuality = '160p';
      config.disabledAutoQuality = {};
      config.accounts = {};
      saveConfig(config);
    }
  } catch (err) {
    addLog(`Error loading config: ${err.message}. Using defaults.`);
  }
}

// Save configuration
function saveConfig(newConfig) {
  if (newConfig) config = newConfig;
  const configPath = getConfigPath();
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    addLog(`Error saving config: ${err.message}`);
  }
}

// Load a SINGLE extension into the live persist:default session so a freshly
// installed addon takes effect without an app restart. Returns the loaded
// extension info or throws. Open stream containers must be reloaded to pick it up.
async function loadSingleExtension(extPath) {
  const ses = session.fromPartition('persist:default');
  if (!fs.existsSync(extPath)) throw new Error(`Extension path does not exist: ${extPath}`);
  // If an extension is already loaded from this exact path, skip re-loading
  // (re-loading the same id throws "Extension already loaded").
  let loaded = [];
  if (ses.extensions) loaded = ses.extensions.getAllExtensions();
  else if (typeof ses.getAllExtensions === 'function') loaded = ses.getAllExtensions();
  const already = loaded.find(e => e.path && path.resolve(e.path) === path.resolve(extPath));
  if (already) return already;

  if (ses.extensions) {
    return await ses.extensions.loadExtension(extPath, { allowFileAccess: true });
  }
  return await ses.loadExtension(extPath, { allowFileAccess: true });
}

// Load Chrome extensions into the persistent stream session.
// Stream cell webviews use partition="persist:default", so that's the only
// session that needs them. Loading into defaultSession as well races the
// same extension ID against itself and the service worker registration fails
// with "File currently in use" — which kills 7TV's background functionality.
async function loadExtensions() {
  const targets = [
    session.fromPartition('persist:default')
  ];

  for (const ses of targets) {
    const sesName = ses === session.defaultSession ? 'default' : 'persist:default';
    
    // Clear pre-existing loaded extensions in this launch if any
    let loadedExts = [];
    if (ses.extensions) {
      loadedExts = ses.extensions.getAllExtensions();
    } else if (typeof ses.getAllExtensions === 'function') {
      loadedExts = ses.getAllExtensions();
    }
    
    addLog(`Currently loaded extensions in session (${sesName}): ${loadedExts.length}`);

    for (const extPath of config.extensions) {
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
          addLog(`Successfully loaded extension in ${sesName}: ${name} (${version})`);
        } else {
          addLog(`Extension path does not exist: ${extPath}. Removing from list.`);
          config.extensions = config.extensions.filter(p => p !== extPath);
          saveConfig();
        }
      } catch (err) {
        addLog(`Failed to load extension at ${extPath} in ${sesName}: ${err.message}`);
      }
    }
  }
}



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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    addLog(`[Console - MainWindow] [Level ${level}] ${message} at ${sourceId}:${line}`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    addLog(`[System - MainWindow] Renderer process gone! Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    addLog(`[System - MainWindow] Load failed! Error Code: ${errorCode}, Description: ${errorDescription}, URL: ${validatedURL}`);
  });

  try {
    mainWindow.webContents.debugger.attach('1.3');
    mainWindow.webContents.debugger.on('message', (event, method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        const desc = params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text;
        addLog(`[Debugger Exception] ${desc}`);
      }
    });
    mainWindow.webContents.debugger.sendCommand('Runtime.enable');
  } catch (err) {
    addLog(`[Debugger Error] Failed to attach: ${err.message}`);
  }

  // Remove default menu bar
  mainWindow.setMenuBarVisibility(false);

  // Load dashboard
  mainWindow.loadFile('index.html');

  // Capture screen diagnostic after load
  setTimeout(async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        addLog('Capturing page screenshot...');
        const image = await mainWindow.webContents.capturePage();
        const png = image.toPNG();
        const targetPath = 'C:\\Users\\tmdav\\.gemini\\antigravity-ide\\brain\\f27a3c68-36a2-4597-9c18-2840f5c9cbae\\dashboard_capture.png';
        fs.writeFileSync(targetPath, png);
        addLog(`Dashboard screenshot saved to: ${targetPath}`);
      }
    } catch (err) {
      addLog(`Failed to save screenshot: ${err.message}`);
    }
  }, 10000);

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

// Close all active stream containers
function closeAllStreamContainers() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('close-all-stream-tabs');
  }
  activeWindows.clear();
}

// Spawns a dedicated browser container window for a live streamer
function spawnStreamContainer(platform, username) {
  const key = `${platform.toLowerCase()}:${username.toLowerCase()}`;
  
  if (activeWindows.has(key)) {
    addLog(`Tab for ${platform}:${username} is already active.`);
    return;
  }

  addLog(`Spawning stream tab for ${platform}:${username}...`);
  activeWindows.set(key, true);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-stream-tab', { platform, username });
  }
}

// Send current open streams list to dashboard
function sendStreamStatusToUI() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const openStreams = Array.from(activeWindows.keys());
    mainWindow.webContents.send('active-containers-update', openStreams);
  }
}

// Fetch Twitch OAuth Token (Client Credentials)
async function getTwitchToken() {
  if (!config.twitchClientId || !config.twitchClientSecret) {
    throw new Error('Twitch credentials not fully configured.');
  }

  // Return cached token if still valid
  if (twitchTokenCache.token && Date.now() < twitchTokenCache.expiresAt) {
    return twitchTokenCache.token;
  }

  addLog('[Twitch] Requesting new OAuth token (cached token expired or missing)...');
  const tokenUrl = `https://id.twitch.tv/oauth2/token?client_id=${config.twitchClientId}&client_secret=${config.twitchClientSecret}&grant_type=client_credentials`;
  
  const response = await net.fetch(tokenUrl, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Auth failed with status ${response.status}`);
  }
  const data = await response.json();
  
  // Cache the token with a 1-minute safety margin before actual expiry
  twitchTokenCache.token = data.access_token;
  twitchTokenCache.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000) - 60000;
  addLog(`[Twitch] OAuth token cached. Expires in ~${Math.round((data.expires_in || 3600) / 3600)} hours.`);
  
  return twitchTokenCache.token;
}

// Check Twitch Streamers
async function checkTwitchStreamers(streamersToCheck) {
  if (streamersToCheck.length === 0) return [];
  
  try {
    const token = await getTwitchToken();
    const usernamesQuery = streamersToCheck.map(u => `user_login=${u.toLowerCase()}`).join('&');
    const streamsUrl = `https://api.twitch.tv/helix/streams?${usernamesQuery}`;

    const response = await net.fetch(streamsUrl, {
      headers: {
        'Client-ID': config.twitchClientId,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Helix request failed: ${response.status}`);
    }

    const data = await response.json();
    const liveStreams = data.data || [];
    
    return streamersToCheck.map(username => {
      const liveInfo = liveStreams.find(s => s.user_login.toLowerCase() === username.toLowerCase());
      if (liveInfo) {
        return {
          platform: 'twitch',
          username: username,
          isLive: true,
          title: liveInfo.title || 'Live Stream',
          viewerCount: liveInfo.viewer_count || 0,
          category: liveInfo.game_name || 'Just Chatting',
          liveSince: liveInfo.started_at || new Date().toISOString()
        };
      } else {
        return {
          platform: 'twitch',
          username: username,
          isLive: false,
          title: '',
          viewerCount: 0,
          category: '',
          liveSince: ''
        };
      }
    });
  } catch (err) {
    addLog(`Twitch check failed: ${err.message}`);
    // Return offline status for these so we don't break the loop
    return streamersToCheck.map(u => ({
      platform: 'twitch', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: err.message
    }));
  }
}

// Check Twitch Streamers using public GraphQL API (Keyless Fallback)
async function checkTwitchStreamersGQL(streamersToCheck) {
  if (streamersToCheck.length === 0) return [];

  try {
    const batchBody = streamersToCheck.map(username => ({
      operationName: 'StreamRefetchManager',
      variables: { channelLogin: username.toLowerCase() },
      query: `query StreamRefetchManager($channelLogin: String!) {
        user(login: $channelLogin) {
          stream {
            id
            title
            viewersCount
            game {
              name
            }
            createdAt
          }
        }
      }`
    }));

    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json',
        'User-Agent': normalizedUserAgent
      },
      body: JSON.stringify(batchBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GQL request failed: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    
    return streamersToCheck.map((username, index) => {
      try {
        const resObj = data[index];
        if (resObj && resObj.errors && resObj.errors.length) {
          const msg = resObj.errors.map(e => e.message).join('; ');
          return {
            platform: 'twitch',
            username: username,
            isLive: false,
            title: '',
            viewerCount: 0,
            category: '',
            liveSince: '',
            error: msg
          };
        }

        const userObj = resObj && resObj.data && resObj.data.user;
        const liveInfo = userObj && userObj.stream;
        
        if (liveInfo) {
          return {
            platform: 'twitch',
            username: username,
            isLive: true,
            title: liveInfo.title || 'Live Stream',
            viewerCount: liveInfo.viewersCount || 0,
            category: liveInfo.game ? liveInfo.game.name : 'Just Chatting',
            liveSince: liveInfo.createdAt || new Date().toISOString()
          };
        }
      } catch (innerErr) {
        return {
          platform: 'twitch',
          username: username,
          isLive: false,
          title: '',
          viewerCount: 0,
          category: '',
          liveSince: '',
          error: innerErr.message
        };
      }
      
      return {
        platform: 'twitch',
        username: username,
        isLive: false,
        title: '',
        viewerCount: 0,
        category: '',
        liveSince: ''
      };
    });
  } catch (err) {
    addLog(`Twitch key-free GQL check failed: ${err.message}`);
    return streamersToCheck.map(u => ({
      platform: 'twitch', username: u, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: err.message
    }));
  }
}

// Check a single Kick streamer
async function checkKickStreamer(username) {
  const url = `https://kick.com/api/v1/channels/${username.toLowerCase()}`;
  try {
    const response = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

    const data = await response.json();
    
    if (data.livestream) {
      const ls = data.livestream;
      return {
        platform: 'kick',
        username: username,
        isLive: true,
        title: ls.session_title || 'Live Stream',
        viewerCount: ls.viewer_count || 0,
        category: ls.categories && ls.categories[0] ? ls.categories[0].name : 'Gaming',
        liveSince: ls.created_at || new Date().toISOString()
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
  const cleanUsername = username.startsWith('@') ? username : `@${username}`;
  const url = `https://www.youtube.com/${cleanUsername}/live`;
  try {
    const response = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      return {
        platform: 'youtube', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: `Status ${response.status}`
      };
    }

    const html = await response.text();
    const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
    
    if (canonicalMatch) {
      const canonicalUrl = canonicalMatch[1];
      const isLive = canonicalUrl.includes('/watch?v=') && 
                     !html.includes('upcomingEventData') && 
                     !html.includes('"upcomingEventData"') &&
                     !html.includes('scheduledStartTime') &&
                     !html.includes('liveStreamOfflineSlateRenderer') &&
                     !html.includes('offlineSlate') &&
                     !html.includes('LIVE_STREAM_OFFLINE') &&
                     !html.includes('isUpcoming');
      if (isLive) {
        // Parse Title from videoDetails
        let title = 'YouTube Live Stream';
        const titleMatch = html.match(/"videoDetails":\s*({.+?})/);
        if (titleMatch) {
          const titleSub = titleMatch[1].match(/"title":"([^"]+)"/);
          if (titleSub) title = titleSub[1];
        }
        
        // Parse Viewer Count
        let viewerCount = 0;
        const viewCountMatch = html.match(/"viewCount":"([^"]+)"/);
        if (viewCountMatch) {
          viewerCount = parseInt(viewCountMatch[1], 10) || 0;
        }

        return {
          platform: 'youtube',
          username: username,
          isLive: true,
          title: title,
          viewerCount: viewerCount,
          category: 'YouTube Live',
          liveSince: new Date().toISOString()
        };
      }
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
    response = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 404) {
      addLog(`[Rumble] /c/${username} returned 404. Falling back to /user/${username}...`);
      url = `https://rumble.com/user/${username}`;
      response = await net.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
    }

    if (!response.ok) {
      return {
        platform: 'rumble', username: username, isLive: false, title: '', viewerCount: 0, category: '', liveSince: '', error: `Status ${response.status}`
      };
    }

    const html = await response.text();
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
        liveSince: new Date().toISOString(),
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

// Get currently active tab count for a platform
function getActiveTabsCount(platform) {
  let count = 0;
  for (const key of activeWindows.keys()) {
    if (key.startsWith(`${platform.toLowerCase()}:`)) {
      count++;
    }
  }
  return count;
}

// Main Polling Scan Logic
async function performScan() {
  addLog('Starting stream status scan...');
  
  const twitchStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'twitch').map(s => s.username);
  const kickStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'kick').map(s => s.username);
  const youtubeStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'youtube').map(s => s.username);
  const rumbleStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'rumble').map(s => s.username);

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
        if (twitchResults.some(r => r.error)) {
           addLog('[Twitch] Helix API failed (Auth/Credentials). Falling back to key-free GQL scan...');
           twitchResults = await checkTwitchStreamersGQL(twitchStreamers);
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

  // Send status update to UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', results);
  }

  // Sort results exactly in the order of original config.streamers priority!
  // Pre-build priority map for O(n) sort instead of O(n²) findIndex calls
  const priorityMap = new Map();
  config.streamers.forEach((s, i) => priorityMap.set(`${s.platform.toLowerCase()}:${s.username.toLowerCase()}`, i));
  results.sort((a, b) => {
    const idxA = priorityMap.get(`${a.platform.toLowerCase()}:${a.username.toLowerCase()}`) ?? Infinity;
    const idxB = priorityMap.get(`${b.platform.toLowerCase()}:${b.username.toLowerCase()}`) ?? Infinity;
    return idxA - idxB;
  });

  // Handle Auto-Close for offline channels
  for (const stream of results) {
    if (!stream.isLive && !stream.error) {
      const platform = stream.platform.toLowerCase();
      const username = stream.username.toLowerCase();
      const key = `${platform}:${username}`;
      
      if (activeWindows.has(key)) {
        if (activeQuestStreamer && username === activeQuestStreamer.toLowerCase()) {
          continue; // Protect quest streamer; monitorQuest manages its lifecycle
        }
        addLog(`[Lurk] Streamer ${stream.username} on ${stream.platform.toUpperCase()} went offline. Auto-closing container.`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('close-stream-tab', { platform: stream.platform, username: stream.username });
        }
        activeWindows.delete(key);
        sendStreamStatusToUI();
      }
    }
  }

  // Handle Auto-Open Lurk triggers
  if (config.autoOpen) {
    for (const stream of results) {
      if (stream.isLive) {
        const platform = stream.platform.toLowerCase();
        const username = stream.username.toLowerCase();
        
        // Create a unique session key based on start time or day, so we don't open multiple windows in the same stream session
        const sessionDate = stream.liveSince ? stream.liveSince.substring(0, 19) : new Date().toDateString();
        const sessionKey = `${platform}:${username}:${sessionDate}`;

        if (!openedSessions.has(sessionKey)) {
          // Evict sessions older than 24 hours to prevent unbounded growth
          const now = Date.now();
          const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
          for (const [key, timestamp] of openedSessions) {
            if (now - timestamp > TWENTY_FOUR_HOURS) openedSessions.delete(key);
          }
          // Enforce platform tab limits
          let maxTabs = 2;
          if (platform === 'twitch') maxTabs = config.maxTwitchTabs !== undefined ? config.maxTwitchTabs : 2;
          else if (platform === 'kick') maxTabs = config.maxKickTabs !== undefined ? config.maxKickTabs : 2;
          else if (platform === 'youtube') maxTabs = config.maxYoutubeTabs !== undefined ? config.maxYoutubeTabs : 2;
          else if (platform === 'rumble') maxTabs = config.maxRumbleTabs !== undefined ? config.maxRumbleTabs : 2;

          let currentCount = getActiveTabsCount(platform);

          if (currentCount >= maxTabs) {
            // Priority-based preemption: Check if we can close a lower-priority active stream on this platform
            const activeKeysForPlatform = Array.from(activeWindows.keys())
              .filter(k => k.startsWith(`${platform}:`))
              .filter(k => {
                const [_, activeUser] = k.split(':');
                return !activeQuestStreamer || activeUser.toLowerCase() !== activeQuestStreamer.toLowerCase();
              });

            const activeStreamPriorities = activeKeysForPlatform.map(key => {
              const [_, activeUser] = key.split(':');
              const indexInConfig = config.streamers.findIndex(
                s => s.platform.toLowerCase() === platform && s.username.toLowerCase() === activeUser
              );
              return {
                key,
                username: activeUser,
                index: indexInConfig === -1 ? Infinity : indexInConfig
              };
            });

            // Sort descending by index (largest index = lowest priority is first)
            activeStreamPriorities.sort((a, b) => b.index - a.index);

            const incomingIndex = config.streamers.findIndex(
              s => s.platform.toLowerCase() === platform && s.username.toLowerCase() === username
            );
            const incomingPriority = incomingIndex === -1 ? Infinity : incomingIndex;

            const lowestPriorityActiveStream = activeStreamPriorities[0];

            if (lowestPriorityActiveStream && lowestPriorityActiveStream.index > incomingPriority) {
              const closeUsername = lowestPriorityActiveStream.username;
              addLog(`[Lurk] Preempting: Closing lower-priority active stream ${closeUsername} on ${platform.toUpperCase()} (priority index ${lowestPriorityActiveStream.index}) to open higher-priority stream ${stream.username} (priority index ${incomingPriority}).`);
              
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('close-stream-tab', { platform: stream.platform, username: closeUsername });
              }
              activeWindows.delete(`${platform}:${closeUsername}`);
              // Clear any openedSessions entries for the preempted stream so it can be
              // reopened later when capacity frees up (otherwise a 24/7 stream whose
              // liveSince never changes would be permanently skipped on subsequent scans).
              const preemptedPrefix = `${platform}:${closeUsername}:`;
              for (const k of openedSessions.keys()) {
                if (k.startsWith(preemptedPrefix)) openedSessions.delete(k);
              }
              currentCount = getActiveTabsCount(platform);
            } else {
              addLog(`[Lurk] Limit reached: Skip auto-opening ${stream.platform.toUpperCase()} stream for ${stream.username} (Active: ${currentCount}/${maxTabs})`);
              continue;
            }
          }

          addLog(`[Lurk] Detected live stream: ${stream.username} on ${stream.platform.toUpperCase()}!`);
          
          // Desktop notification
          if (Notification.isSupported()) {
            const notif = new Notification({
              title: `${stream.username} is LIVE!`,
              body: `${stream.title} on ${stream.platform.toUpperCase()}`,
              silent: false
            });
            notif.show();
          }
          
          spawnStreamContainer(stream.platform, stream.username);
          openedSessions.set(sessionKey, Date.now());
        }
      }
    }
  }

  // Update next scan time
  updateNextScanTime();
}

// Reset Poller schedule
function resetPoller() {
  if (pollIntervalId) clearInterval(pollIntervalId);
  
  const msInterval = config.checkInterval * 60 * 1000;
  addLog(`Resetting scan interval to run every ${config.checkInterval} minutes.`);
  
  pollIntervalId = setInterval(performScan, msInterval);
  updateNextScanTime();
}

// Timer countdown helper
function updateNextScanTime() {
  nextScanTime = Date.now() + (config.checkInterval * 60 * 1000);
  sendCountdownToUI();
}

function sendCountdownToUI() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const secondsRemaining = Math.max(0, Math.round((nextScanTime - Date.now()) / 1000));
    mainWindow.webContents.send('countdown-update', secondsRemaining);
  }
}

// App lifecycle
app.whenReady().then(async () => {
  addLog('Initializing Stream Lurker standalone desktop application...');
  loadConfig();
  
  const rawUA = session.defaultSession.getUserAgent();
  defaultElectronUA = rawUA; // preserve the consistent original for login windows
  const userAgent = rawUA
    .replace(/stream-lurker\/\S+/i, '')
    .replace(/Electron\/\S+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  addLog(`[System] Normalized User-Agent for standard Chrome features: ${userAgent}`);
  session.defaultSession.setUserAgent(userAgent);
  session.fromPartition('persist:default').setUserAgent(userAgent);

  // Spoof Sec-Ch-Ua client hints on Twitch requests to match normalized User-Agent fingerprint
  const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)/);
  const chromeMajorVersion = chromeVersionMatch ? chromeVersionMatch[1] : '124';
  const osPlatform = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : 'Windows';
  const platformString = `"${osPlatform}"`;

  session.fromPartition('persist:default').webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    (details, callback) => {
      if (twitchPageWin && !twitchPageWin.isDestroyed() && details.webContentsId === twitchPageWin.webContents.id) {
        const urlStr = details.url.toLowerCase();
        if (
          urlStr.includes('usher.ttvnw.net') ||
          urlStr.includes('.m3u8') ||
          urlStr.includes('.ts') ||
          urlStr.includes('video-weaver')
        ) {
          return callback({ cancel: true });
        }
      }
      callback({});
    }
  );

  session.fromPartition('persist:default').webRequest.onBeforeSendHeaders(
    { urls: ['*://*.twitch.tv/*', '*://*.twitchcdn.net/*'] },
    (details, callback) => {
      const headers = details.requestHeaders;
      const setHeader = (name, val) => {
        const lowerName = name.toLowerCase();
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === lowerName) {
            delete headers[key];
          }
        }
        headers[name] = val;
      };
      setHeader('sec-ch-ua', `"Chromium";v="${chromeMajorVersion}", "Google Chrome";v="${chromeMajorVersion}", "Not-A.Brand";v="99"`);
      setHeader('sec-ch-ua-mobile', '?0');
      setHeader('sec-ch-ua-platform', platformString);
      callback({ requestHeaders: headers });
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
  // Recommended Extensions catalog in the Adblock & Extensions tab.
  await loadExtensions();
  createMainWindow();
  
  session.defaultSession.on('will-download', (event, item, webContents) => {
    if (currentDownloadFileName) {
      item.setSaveDialogOptions({ defaultPath: currentDownloadFileName });
      currentDownloadFileName = null;
    }
  });

  createTray();

  // Start background poller
  resetPoller();

  // Start watch time tracker
  startWatchTimeTracking();

  // Run immediate first scan after a short delay to let frontend mount
  setTimeout(performScan, 3000);

  // Diagnostic drops fetch
  setTimeout(async () => {
    addLog('[Drops Test] Running diagnostic drops fetch...');
    try {
      const res = await handleFetchDropCampaigns();
      addLog(`[Drops Test] Result: success=${res.success}, error=${res.error || 'none'}, watchCampaigns=${res.watchCampaigns ? res.watchCampaigns.length : 0}`);
    } catch (e) {
      addLog(`[Drops Test] Diagnostic threw error: ${e.message}`);
    }
  }, 10000);

  // Setup countdown update clock
  if (countdownTimerId) clearInterval(countdownTimerId);
  countdownTimerId = setInterval(sendCountdownToUI, 1000);

  // Validate saved sessions after UI is ready
  setTimeout(validateSavedSessions, 6000);

  // Periodic debounced watch time save (every 5 min instead of every 60s)
  setInterval(() => {
    if (watchTimeDirty) {
      saveConfig();
      watchTimeDirty = false;
    }
  }, 300000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Final save of any pending watch time data
  if (watchTimeDirty) {
    saveConfig();
    watchTimeDirty = false;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// System Tray
function createTray() {
  try {
    // Create a simple 16x16 tray icon (1-pixel nativeImage as fallback)
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    
    const contextMenu = Menu.buildFromTemplate([
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
          performScan();
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
    
    tray.setToolTip('Stream Lurker');
    tray.setContextMenu(contextMenu);
    
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

// Helper to fetch Twitch Username from GQL using OAuth token
async function fetchTwitchUsername(token) {
  try {
    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
        'Authorization': `OAuth ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': normalizedUserAgent
      },
      body: JSON.stringify([{
        operationName: 'GetUserInfo',
        query: 'query GetUserInfo { currentUser { login } }'
      }])
    });
    if (response.ok) {
      const data = await response.json();
      return data[0]?.data?.currentUser?.login || null;
    }
  } catch (e) {
    addLog(`[Auth] Failed to fetch Twitch username via GQL: ${e.message}`);
  }
  return null;
}

// Session Validation on Startup
async function validateSavedSessions() {
  const platformsToCheck = ['twitch', 'kick', 'youtube', 'rumble'];
  addLog('[Auth] Validating saved platform sessions...');
  const ses = session.fromPartition('persist:default');
  
  for (const platform of platformsToCheck) {
    let isValid = false;
    
    try {
      if (platform === 'twitch') {
        const cookies = await ses.cookies.get({ name: 'auth-token' });
        isValid = cookies.some(c => c.domain && c.domain.includes('twitch.tv'));
        if (isValid) {
          if (!config.accounts[platform] || config.accounts[platform] === 'Twitch User') {
            const tokenCookie = cookies.find(c => c.domain && c.domain.includes('twitch.tv'));
            if (tokenCookie) {
              const username = await fetchTwitchUsername(tokenCookie.value);
              if (username) {
                config.accounts[platform] = username;
                saveConfig();
                addLog(`[Auth] Recovered Twitch username: ${username}`);
              } else {
                config.accounts[platform] = 'Twitch User';
                saveConfig();
              }
            }
          }
        }
      } else if (platform === 'kick') {
        const cookies = await ses.cookies.get({ url: 'https://kick.com' });
        isValid = cookies.some(c => c.name === 'kick_session' || c.name.includes('session'));
      } else if (platform === 'youtube') {
        const cookies = await ses.cookies.get({ url: 'https://youtube.com' });
        isValid = cookies.some(c => c.name === 'SID' || c.name === 'SSID');
      } else if (platform === 'rumble') {
        const cookies = await ses.cookies.get({ url: 'https://rumble.com' });
        isValid = cookies.some(c => c.name.includes('session') || c.name === 'u_s');
      }
    } catch (e) {
      addLog(`[Auth] Error validating ${platform.toUpperCase()} session: ${e.message}`);
    }
    
    if (!isValid) {
      if (config.accounts && config.accounts[platform]) {
        addLog(`[Auth] Session expired for ${platform.toUpperCase()}. Marking as disconnected.`);
        delete config.accounts[platform];
        saveConfig();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-expired', { platform });
        }
      }
    } else {
      if (!config.accounts[platform]) {
        config.accounts[platform] = `${platform.charAt(0).toUpperCase() + platform.slice(1)} User`;
        saveConfig();
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

    // Create the login modal window (sandbox: false to prevent CAPTCHA/JS issues)
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
        sandbox: false
      }
    });

    loginWin.setMenuBarVisibility(false);
    // Use the original (un-normalized) Electron UA for the login window so the
    // UA string stays consistent with the client hints. A stripped UA here is what
    // trips Google's "browser may not be secure" block. Matches the initial build
    // where login worked. Applies only to this window, not stream containers.
    if (defaultElectronUA) {
      loginWin.webContents.setUserAgent(defaultElectronUA);
    }
    loginWin.loadURL(loginUrl, defaultElectronUA ? { userAgent: defaultElectronUA } : undefined);

    loginWin.once('ready-to-show', () => {
      loginWin.show();
    });

    let checkInterval = null;
    let resolved = false;
    let timeoutId = null;
    let kickNoLoginStreak = 0; // consecutive polls with no Log in button (Kick)

    // Login timeout — prevent indefinite polling if user never completes login
    timeoutId = setTimeout(() => {
      if (!resolved && !loginWin.isDestroyed()) {
        clearInterval(checkInterval);
        resolved = true;
        addLog(`[Auth] Login timed out for ${platform.toUpperCase()} after 5 minutes.`);
        loginWin.close();
        resolve({ success: false, error: 'Login timed out' });
      }
    }, LOGIN_TIMEOUT_MS);

    // Cookie-based login detection helper (primary strategy — more reliable than DOM selectors)
    async function checkCookieLogin() {
      try {
        const ses = session.fromPartition('persist:default');
        if (p === 'twitch') {
          const cookies = await ses.cookies.get({ name: 'auth-token' });
          return cookies.some(c => c.domain && c.domain.includes('twitch.tv'));
        } else if (p === 'kick') {
          // Bypassed cookie check to allow DOM/localStorage detection to handle it
          return false;
        } else if (p === 'youtube') {
          const googleCookies = await ses.cookies.get({ url: 'https://youtube.com' });
          return googleCookies.some(c => c.name === 'SID' || c.name === 'SSID');
        } else if (p === 'rumble') {
          const cookies = await ses.cookies.get({ url: 'https://rumble.com' });
          return cookies.some(c => c.name.includes('session') || c.name === 'u_s');
        }
      } catch (e) {
        // Cookie check failed, fall through to DOM detection
      }
      return false;
    }

    // Check interval to detect when user is successfully logged in
    checkInterval = setInterval(async () => {
      if (loginWin.isDestroyed() || resolved) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const url = loginWin.webContents.getURL();
        if (!url || url === 'about:blank') return;

        let isLoggedIn = false;

        // Strategy 1: Cookie-based detection (primary, most reliable)
        isLoggedIn = await checkCookieLogin();

        // Strategy 2: DOM-based detection (fallback)
        if (!isLoggedIn) {
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
          } else if (p === 'kick') {
            script = `
              (async () => {
                try {
                  const href = window.location.href;
                  const onLoginPage = /\\/(login|auth|sign-in|signin|register)/i.test(href);

                  // Visible "Log in" / "Sign up" controls = definitively logged OUT.
                  const loginButtons = Array.from(document.querySelectorAll('a, button')).filter(el => {
                    const t = (el.textContent || '').trim().toLowerCase();
                    return t === 'sign in' || t === 'log in' || t === 'login' || t === 'register' || t === 'sign up';
                  }).length;

                  // Positive auth signals (only present when logged in):
                  // a real user avatar, or links to account-only pages.
                  let userName = null;
                  const avatarImg = document.querySelector('img[src*="/user/" i], img[src*="/profile_image/" i], img[src*="/avatars/" i]');
                  const hasAvatar = !!avatarImg;
                  if (avatarImg && avatarImg.alt) {
                    const a = avatarImg.alt.toLowerCase();
                    if (!a.includes('avatar') && !a.includes('profile') && !a.includes('logo')) userName = avatarImg.alt;
                  }
                  const hasAccountLink = !!document.querySelector(
                    'a[href*="/dashboard" i], a[href*="/settings" i], a[href*="/account" i], a[href*="logout" i]'
                  );

                  // Authenticated API confirmation (best signal when it works).
                  let apiUserName = null;
                  try {
                    const controller = new AbortController();
                    const tid = setTimeout(() => controller.abort(), 2500);
                    const r = await fetch('/api/v2/user', { credentials: 'include', signal: controller.signal });
                    clearTimeout(tid);
                    if (r.ok) {
                      const b = await r.json().catch(() => ({}));
                      apiUserName = b.username || (b.data && b.data.username) || b.slug || null;
                    }
                  } catch (e) {}

                  return {
                    href,
                    onLoginPage,
                    loginButtons,
                    hasAvatar,
                    hasAccountLink,
                    apiUserName,
                    userName: apiUserName || userName,
                  };
                } catch(e) {
                  return { error: e.message };
                }
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

          if (script) {
            const res = await loginWin.webContents.executeJavaScript(script);
            if (p === 'kick') {
              if (res && !res.error) {
                // Track consecutive polls with NO "Log in" button. Kick keeps the
                // user on the /login URL even after authenticating (SPA, no redirect),
                // so URL is useless. The login button disappearing is the reliable
                // "you're authenticated" signal; `hasAvatar` is a false positive
                // (the login page itself shows avatar images).
                if (res.loginButtons === 0) kickNoLoginStreak++;
                else kickNoLoginStreak = 0;

                addLog(`[Auth - Kick] poll: loginButtons=${res.loginButtons} noLoginStreak=${kickNoLoginStreak} accountLink=${res.hasAccountLink} apiUser=${res.apiUserName} href=${res.href}`);

                // Logged in when the Log in button is gone AND either a positive auth
                // signal is present, or the button has been gone for several polls
                // (fallback for when account links/API don't surface).
                const positiveSignal = res.hasAccountLink || !!res.apiUserName;
                if (res.loginButtons === 0 && (positiveSignal || kickNoLoginStreak >= 3)) {
                  isLoggedIn = true;
                }
              }
            } else {
              isLoggedIn = res;
            }
          }
        }

        if (isLoggedIn) {
          resolved = true;
          clearInterval(checkInterval);
          clearTimeout(timeoutId);
          addLog(`[Auth] Successful login detected on ${platform.toUpperCase()}! Extracting username...`);

          let username = '';
          if (p === 'twitch') {
            const data = await loginWin.webContents.executeJavaScript(`
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
            username = data || 'Twitch User';
          } else if (p === 'kick') {
            const data = await loginWin.webContents.executeJavaScript(`
              (async () => {
                try {
                  let actualUsername = null;
                  for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    const val = localStorage.getItem(key);
                    if (val && (val.includes('username') || val.includes('slug'))) {
                      try {
                        const parsed = JSON.parse(val);
                        const findUsername = (obj) => {
                          if (!obj || typeof obj !== 'object') return null;
                          if (obj.username && typeof obj.username === 'string') return obj.username;
                          if (obj.slug && typeof obj.slug === 'string') return obj.slug;
                          for (const k in obj) {
                            const res = findUsername(obj[k]);
                            if (res) return res;
                          }
                          return null;
                        };
                        actualUsername = findUsername(parsed);
                        if (actualUsername) break;
                      } catch(e) {}
                    }
                  }
                  if (!actualUsername) {
                    try {
                      const avatarImg = document.querySelector('img[src*="/user/" i], img[src*="/profile_image/" i], img[src*="/avatars/" i]');
                      if (avatarImg && avatarImg.alt && !avatarImg.alt.toLowerCase().includes('avatar') && !avatarImg.alt.toLowerCase().includes('profile') && !avatarImg.alt.toLowerCase().includes('logo')) {
                        actualUsername = avatarImg.alt;
                      }
                    } catch(e) {}
                  }
                  if (!actualUsername) {
                    try {
                      const controller = new AbortController();
                      const id = setTimeout(() => controller.abort(), 2000);
                      const userRes = await fetch('/api/v2/user', { signal: controller.signal }).then(r => r.json().catch(() => ({})));
                      clearTimeout(id);
                      actualUsername = userRes.username || userRes.data?.username || userRes.slug;
                    } catch(e) {}
                  }
                  return actualUsername;
                } catch(e) {
                  return null;
                }
              })()
            `);
            username = data || 'Kick User';
          } else if (p === 'youtube') {
            const currentUrl = loginWin.webContents.getURL();
            if (!currentUrl.includes('youtube.com')) {
              try {
                await loginWin.loadURL('https://www.youtube.com');
              } catch (err) {
                addLog(`[Auth] Navigation to YouTube failed: ${err.message}`);
              }
              await new Promise(r => setTimeout(r, 3000));
            }
            const data = await loginWin.webContents.executeJavaScript(`
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
            `);
            username = data || 'YouTube User';
          } else if (p === 'rumble') {
            const data = await loginWin.webContents.executeJavaScript(`
              (() => {
                try {
                  const nameEl = document.querySelector('.header-user-name, .user-name');
                  return nameEl ? nameEl.textContent.trim() : null;
                } catch(e) {
                  return null;
                }
              })()
            `);
            username = data || 'Rumble User';
          }

          addLog(`[Auth] Account connected: ${username} on ${platform.toUpperCase()}`);

          // Save to config
          if (!config.accounts) config.accounts = {};
          config.accounts[p] = username;
          saveConfig();

          if (p === 'twitch') {
            resetTwitchPageWindow();
          }

          // Notify UI
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('login-success', { platform: p, username });
          }

          // Close modal
          loginWin.close();
          resolve({ success: true, username });
        }
      } catch (err) {
        // Safe to ignore executeJavaScript frame errors during transitions
      }
    }, 1500);

    loginWin.on('closed', () => {
      clearInterval(checkInterval);
      clearTimeout(timeoutId);
      if (!resolved) {
        addLog(`[Auth] Login modal for ${platform.toUpperCase()} was closed without completion.`);
        resolve({ success: false, error: 'Modal closed' });
      }
    });
  });
});

ipcMain.handle('logout-platform', async (event, { platform }) => {
  const p = platform.toLowerCase();
  addLog(`[Auth] Signing out of ${platform.toUpperCase()} and purging session cookies...`);

  // Remove from accounts config
  if (config.accounts && config.accounts[p]) {
    delete config.accounts[p];
    saveConfig();
  }

  if (p === 'twitch') {
    resetTwitchPageWindow();
  }

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

ipcMain.handle('save-config', (event, newConfig) => {
  const oldInterval = config.checkInterval;
  const oldExtensionsCount = config.extensions.length;
  
  saveConfig(newConfig);
  addLog('Settings saved.');

  // If interval changed, reset the poller
  if (config.checkInterval !== oldInterval) {
    resetPoller();
  }

  // If extensions changed, reload extensions
  if (config.extensions.length !== oldExtensionsCount || JSON.stringify(config.extensions) !== JSON.stringify(newConfig.extensions)) {
    loadExtensions().then(() => {
      addLog('Extensions reloaded successfully.');
    });
  }

  return true;
});

ipcMain.handle('add-streamer', (event, { platform, username }) => {
  const cleanUsername = username.trim();
  if (!cleanUsername) return { success: false, error: 'Username cannot be empty' };

  const exists = config.streamers.some(
    s => s.platform.toLowerCase() === platform.toLowerCase() && s.username.toLowerCase() === cleanUsername.toLowerCase()
  );

  if (exists) {
    return { success: false, error: 'Streamer already added' };
  }

  config.streamers.push({ platform: platform.toLowerCase(), username: cleanUsername });
  saveConfig();
  addLog(`Added streamer: ${cleanUsername} on ${platform.toUpperCase()}`);
  
  // Trigger scan for the new streamer
  setTimeout(performScan, 500);

  return { success: true, streamers: config.streamers };
});

ipcMain.handle('delete-streamer', (event, { platform, username }) => {
  config.streamers = config.streamers.filter(
    s => !(s.platform.toLowerCase() === platform.toLowerCase() && s.username.toLowerCase() === username.toLowerCase())
  );
  saveConfig();
  addLog(`Removed streamer: ${username} from ${platform.toUpperCase()}`);
  return { success: true, streamers: config.streamers };
});

ipcMain.handle('select-extension-folder', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Unpacked Chrome Extension Folder',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  
  // Verify manifest.json exists in this folder
  const manifestPath = path.join(selectedPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    addLog(`Error: Selected folder does not contain a manifest.json. Is this a valid unpacked extension?`);
    return { error: 'Missing manifest.json in selected directory' };
  }

  // Check if extension is already added
  if (config.extensions.includes(selectedPath)) {
    return { error: 'Extension already added' };
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    addLog(`Extension directory selected: ${manifest.name || 'Unknown'} at ${selectedPath}`);
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
    description: 'Efficient ad and content blocker. Recommended for hiding Twitch/Kick pre-roll and mid-roll ads inside stream containers.',
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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url,
      headers: { 'User-Agent': 'stream-lurker', 'Accept': 'application/vnd.github+json' },
      redirect: 'follow'
    });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url,
      headers: { 'User-Agent': 'stream-lurker', 'Accept': 'application/octet-stream' },
      redirect: 'follow'
    });
    const out = fs.createWriteStream(destPath);
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        out.close();
        reject(new Error(`Download failed ${res.statusCode}`));
        return;
      }
      res.on('data', (chunk) => out.write(chunk));
      res.on('end', () => out.end(() => resolve()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

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

    const installRoot = getCatalogEntryInstallPath(entry.id);
    // Wipe any prior install so updates don't leave stale files behind
    rmrf(installRoot);
    fs.mkdirSync(installRoot, { recursive: true });

    const tmpZip = path.join(app.getPath('temp'), `${entry.id}-${Date.now()}.zip`);
    addLog(`[Catalog] Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);
    await downloadFile(asset.browser_download_url, tmpZip);

    addLog(`[Catalog] Extracting ${asset.name}…`);
    await extractZip(tmpZip, { dir: installRoot });
    try { fs.unlinkSync(tmpZip); } catch {}

    const manifestRoot = findManifestRoot(installRoot);
    if (!manifestRoot) {
      rmrf(installRoot);
      return { ok: false, error: 'Extracted archive did not contain a manifest.json' };
    }

    // Per-extension post-install patches.
    if (entry.id === '7tv') patchSevenTVManifestForKick(manifestRoot);

    // Replace any prior registration of any subpath of installRoot, then add the new manifestRoot
    config.extensions = (config.extensions || []).filter(p => !p.startsWith(installRoot));
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
  }
});

ipcMain.handle('uninstall-catalog-extension', async (event, { id }) => {
  const entry = EXTENSION_CATALOG.find(e => e.id === id);
  if (!entry) return { ok: false, error: `Unknown catalog id: ${id}` };
  const installRoot = getCatalogEntryInstallPath(entry.id);
  config.extensions = (config.extensions || []).filter(p => !p.startsWith(installRoot));
  saveConfig();
  rmrf(installRoot);
  addLog(`[Catalog] Uninstalled ${entry.name}.`);
  return { ok: true };
});

ipcMain.handle('force-scan', () => {
  addLog('User requested immediate scan.');
  performScan();
  return true;
});

ipcMain.handle('open-stream-container', (event, { platform, username }) => {
  spawnStreamContainer(platform, username);
  return true;
});

// Move a streamer to the top of the watch-priority list (config.streamers order
// is the lurk priority) and open their stream container immediately. Adds them
// to the tracked list if they weren't already there.
ipcMain.handle('prioritize-streamer', (event, { platform, username }) => {
  const p = (platform || '').toLowerCase();
  const cleanUsername = (username || '').trim();
  if (!cleanUsername) return { success: false, error: 'Username cannot be empty' };

  config.streamers = config.streamers.filter(
    s => !(s.platform.toLowerCase() === p && s.username.toLowerCase() === cleanUsername.toLowerCase())
  );
  config.streamers.unshift({ platform: p, username: cleanUsername });
  saveConfig();
  addLog(`[Drops] Prioritized ${cleanUsername} (${p.toUpperCase()}) for watching to earn rewards.`);

  spawnStreamContainer(p, cleanUsername);
  return { success: true, streamers: config.streamers };
});

ipcMain.handle('close-stream-container', (event, { platform, username }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('close-stream-tab', { platform, username });
  }
  return true;
});

ipcMain.handle('update-active-tabs', (event, tabsList) => {
  activeWindows.clear();
  tabsList.forEach(t => activeWindows.set(t, true));
  sendStreamStatusToUI();
  return true;
});

ipcMain.handle('get-recent-logs', () => {
  return logs;
});

ipcMain.handle('get-active-containers', () => {
  return Array.from(activeWindows.keys());
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
    if (activeWindows.size === 0) return;
    
    if (!config.watchTime) {
      config.watchTime = { streamers: {}, platforms: { twitch: 0, kick: 0, youtube: 0, rumble: 0 } };
    }
    if (!config.watchTime.streamers) config.watchTime.streamers = {};
    if (!config.watchTime.platforms) config.watchTime.platforms = { twitch: 0, kick: 0, youtube: 0, rumble: 0 };
    
    let updated = false;
    for (const key of activeWindows.keys()) {
      const [platform, username] = key.split(':');
      if (!platform || !username) continue;
      
      const streamerKey = `${platform}:${username}`;
      config.watchTime.streamers[streamerKey] = (config.watchTime.streamers[streamerKey] || 0) + 1;
      config.watchTime.platforms[platform] = (config.watchTime.platforms[platform] || 0) + 1;
      updated = true;
    }
    
    if (updated) {
      watchTimeDirty = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watch-time-update', config.watchTime);
      }
    }
  }, 60000); // Increment every minute, saves debounced every 5 min
}

// Fetch Twitch stream schedule via client-free GQL query
async function fetchTwitchSchedule(username) {
  try {
    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json',
        'User-Agent': normalizedUserAgent
      },
      body: JSON.stringify([{
        operationName: 'ChannelStartup',
        variables: { channelLogin: username.toLowerCase() },
        query: `query ChannelStartup($channelLogin: String!) {
          user(login: $channelLogin) {
            channel {
              schedule {
                segments {
                  id
                  startAt
                  endAt
                  title
                  isCancelled
                }
              }
            }
          }
        }`
      }])
    });
    if (!response.ok) return [];
    const data = await response.json();
    const segments = data[0]?.data?.user?.channel?.schedule?.segments || [];
    return segments.filter(s => !s.isCancelled).map(s => {
      const start = new Date(s.startAt);
      return {
        id: s.id,
        streamer: username,
        platform: 'twitch',
        title: s.title || s.game?.name || 'Twitch Stream',
        startAt: s.startAt,
        endAt: s.endAt,
        day: start.getDay(), // 0 = Sunday, 1 = Monday...
        time: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), // "HH:MM"
        type: 'auto'
      };
    });
  } catch (e) {
    addLog(`Twitch schedule GQL fetch failed for ${username}: ${e.message}`);
    return [];
  }
}

// Scrape YouTube schedule (upcoming streams)
async function fetchYoutubeSchedule(username) {
  try {
    const cleanUsername = username.startsWith('@') ? username : `@${username}`;
    const url = `https://www.youtube.com/${cleanUsername}/live`;
    const response = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) return [];
    const html = await response.text();
    
    // Check for "upcomingEventData":{"startTime":"1716327000"} or "scheduledStartTime":"1716327000"
    let startTimeSec = null;
    const timeMatch = html.match(/"upcomingEventData":\s*{\s*"startTime":\s*"(\d+)"/);
    if (timeMatch) {
      startTimeSec = parseInt(timeMatch[1], 10);
    } else {
      const scheduledMatch = html.match(/"scheduledStartTime"\s*:\s*"(\d+)"/);
      if (scheduledMatch) {
        startTimeSec = parseInt(scheduledMatch[1], 10);
      }
    }

    if (startTimeSec) {
      const start = new Date(startTimeSec * 1000);
      
      let title = 'YouTube Scheduled Stream';
      const titleMatch = html.match(/"videoDetails":\s*({.+?})/);
      if (titleMatch) {
        const titleSub = titleMatch[1].match(/"title":"([^"]+)"/);
        if (titleSub) title = titleSub[1];
      }
      
      return [{
        id: `yt-${username}-${startTimeSec}`,
        streamer: username,
        platform: 'youtube',
        title: title,
        startAt: start.toISOString(),
        day: start.getDay(),
        time: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), // "HH:MM"
        type: 'auto'
      }];
    }
  } catch (e) {
    addLog(`YouTube schedule check failed for ${username}: ${e.message}`);
  }
  return [];
}

// Fetch Kick schedule (Kick does not natively support weekly calendar schedules, return graceful empty array)
async function fetchKickSchedule(username) {
  try {
    addLog(`[Calendar] Kick.com does not natively support weekly schedules for ${username}. Utilize manual calendar entries.`);
  } catch(e) {}
  return [];
}

// Twitch Drops: pull all active drop campaigns visible to the logged-in user
// via GQL using the auth-token cookie. Categorizes drops by reward type:
// sub-required vs watch-only.
async function getTwitchAuthToken() {
  const allCookies = await session.fromPartition('persist:default').cookies.get({ name: 'auth-token' });
  const twitchCookie = allCookies.find(c => c.domain && c.domain.includes('twitch.tv'));
  return twitchCookie ? twitchCookie.value : null;
}

async function getTwitchUniqueId() {
  const allCookies = await session.fromPartition('persist:default').cookies.get({});
  const names = allCookies.map(c => `${c.name}=${c.domain}`);
  addLog(`[Twitch Cookie Diagnostic] All cookies in jar: ${names.join(', ')}`);
  const twitchCookie = allCookies.find(c => c.name === 'unique_id' && c.domain && c.domain.includes('twitch.tv'));
  const val = twitchCookie ? twitchCookie.value : null;
  cachedTwitchUniqueId = val;
  return val;
}

// Hidden, logged-in Twitch page used to issue integrity-protected GQL requests.
// Operations like ViewerDropsDashboard/inventory require a Client-Integrity
// header that Twitch's Kasada SDK generates in the browser — a bare net.fetch
// can't produce it, so we run those requests from inside a real Twitch page
// where the SDK hooks fetch and supplies the headers. The window is reused.
let twitchPageWin = null;
let twitchPageReady = null;
let cachedTwitchUniqueId = null;

async function clearTwitchTelemetryCookies() {
  try {
    const ses = session.fromPartition('persist:default');
    const cookies = await ses.cookies.get({ domain: 'twitch.tv' });
    const keep = ['auth-token', 'twilight-user', 'persistent', 'unique_id', 'unique_id_durable', 'login'];
    let clearedCount = 0;
    for (const cookie of cookies) {
      if (!keep.includes(cookie.name)) {
        const url = `https://${cookie.domain.startsWith('.') ? 'www' : ''}${cookie.domain}${cookie.path}`;
        await ses.cookies.remove(url, cookie.name);
        clearedCount++;
      }
    }
    if (clearedCount > 0) {
      addLog(`[Drops] Cleared ${clearedCount} Twitch telemetry/Kasada cookies for clean session reset.`);
    }
  } catch (e) {
    addLog(`[Drops] Error clearing telemetry cookies: ${e.message}`);
  }
}

function resetTwitchPageWindow() {
  if (twitchPageWin && !twitchPageWin.isDestroyed()) {
    try {
      twitchPageWin.destroy();
    } catch (e) {}
  }
  twitchPageWin = null;
  twitchPageReady = null;
  addLog('[Drops] Destroyed and reset Twitch GQL page window context.');
  clearTwitchTelemetryCookies();
}

async function getTwitchPageWindow() {
  if (twitchPageWin && !twitchPageWin.isDestroyed()) {
    await twitchPageReady;
    if (twitchPageWin.webContents.getURL().includes('twitch.tv')) return twitchPageWin;
    // Lost the twitch.tv origin (redirect/crash) — rebuild below.
    try { twitchPageWin.destroy(); } catch (e) {}
    twitchPageWin = null;
  }
  
  // Proactively clear telemetry cookies for a clean initialization of the new window
  await clearTwitchTelemetryCookies();

  try {
    const allCookies = await session.fromPartition('persist:default').cookies.get({ name: 'unique_id' });
    const cookie = allCookies.find(c => c.domain && c.domain.includes('twitch.tv'));
    cachedTwitchUniqueId = cookie ? cookie.value : null;
    addLog(`[Drops] Cached Twitch unique_id before page creation: "${cachedTwitchUniqueId}"`);
  } catch (e) {
    addLog(`[Drops] Failed to cache unique_id on creation: ${e.message}`);
  }

  twitchPageWin = new BrowserWindow({
    width: 1280,
    height: 720,
    x: 0,
    y: 0,
    show: true,
    focusable: false,
    frame: false,
    transparent: false,
    hasShadow: false,
    skipTaskbar: true,
    opacity: 0.01,
    webPreferences: {
      partition: 'persist:default',
      backgroundThrottling: false,
      webSecurity: true,
      autoplayPolicy: 'user-gesture-required',
      preload: path.join(__dirname, 'src', 'twitch-preload.js'),
      allFrames: true,
      nodeIntegrationInSubFrames: true
    }
  });
  try { twitchPageWin.setFocusable(false); } catch (e) {}
  try { twitchPageWin.setIgnoreMouseEvents(true); } catch (e) {}
  twitchPageWin.webContents.on('console-message', (event, level, message, line, sourceId) => {
    addLog(`[Console - TwitchPageWin] [Level ${level}] ${message} at ${sourceId}:${line}`);
  });
  twitchPageWin.webContents.setUserAgent(session.fromPartition('persist:default').getUserAgent());
  twitchPageWin.webContents.setAudioMuted(true);
  twitchPageWin.on('closed', () => { twitchPageWin = null; twitchPageReady = null; });
  twitchPageReady = (async () => {
    try {
      // Determine target URL based on username to avoid loading featured streams on homepage
      const hasToken = await getTwitchAuthToken();
      let username = config.accounts && config.accounts.twitch;
      if (!username) {
        try {
          const cookies = await session.fromPartition('persist:default').cookies.get({ name: 'twilight-user' });
          const cookie = cookies.find(c => c.domain && c.domain.includes('twitch.tv'));
          if (cookie) {
            const parsed = JSON.parse(decodeURIComponent(cookie.value));
            if (parsed && parsed.login) {
              username = parsed.login;
            }
          }
        } catch (e) {}
      }
      let targetUrl;
      if (hasToken) {
        targetUrl = username ? `https://www.twitch.tv/${username.toLowerCase()}` : 'https://www.twitch.tv/directory/following';
      } else {
        targetUrl = 'https://www.twitch.tv/login';
      }
      addLog(`[Drops] Loading Twitch background page: ${targetUrl}`);

      // Await loadURL with a 15-second timeout to prevent hanging on slow resources
      await Promise.race([
        twitchPageWin.loadURL(targetUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 15000))
      ]);

      // Align localStorage device ID with unique_id cookie to prevent Kasada mismatch
      try {
        const allCookies = await session.fromPartition('persist:default').cookies.get({ name: 'unique_id' });
        const cookie = allCookies.find(c => c.domain && c.domain.includes('twitch.tv'));
        const cookieUniqueId = cookie ? cookie.value : null;

        if (cookieUniqueId) {
          const alignScript = `(() => {
            const rawLsDeviceId = localStorage.getItem('local_storage_device_id');
            const cleanLsDeviceId = rawLsDeviceId ? (rawLsDeviceId.startsWith('"') && rawLsDeviceId.endsWith('"') ? rawLsDeviceId.slice(1, -1) : rawLsDeviceId) : '';
            const expected = ${JSON.stringify(cookieUniqueId)};
            if (cleanLsDeviceId !== expected) {
              localStorage.setItem('local_storage_device_id', JSON.stringify(expected));
              return { needsReload: true, rawLsDeviceId, expected };
            }
            return { needsReload: false, rawLsDeviceId, expected };
          })()`;
          
          const alignResult = await twitchPageWin.webContents.executeJavaScript(alignScript);
          if (alignResult && alignResult.needsReload) {
            addLog(`[Drops] Mismatched Device IDs aligned in localStorage. LS: ${JSON.stringify(alignResult.rawLsDeviceId)}, Expected: ${JSON.stringify(alignResult.expected)}. Reloading Twitch page window...`);
            await Promise.race([
              twitchPageWin.loadURL(targetUrl),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 15000))
            ]);
            addLog('[Drops] Alignment reload triggered. Appending 5-second settling delay...');
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      } catch (alignErr) {
        addLog(`[Drops] Device ID alignment warning: ${alignErr.message}`);
      }

    } catch (e) {
      addLog(`[Drops] Twitch page load issue/timeout: ${e.message}`);
    }
    // Give Kasada's integrity SDK time to install its fetch hook.
    await new Promise(r => setTimeout(r, 5000));
  })();
  await twitchPageReady;
  return twitchPageWin;
}

// Run an authenticated Twitch GQL request from the hidden page context so the
// Kasada/integrity SDK can attach Client-Integrity + device headers.
async function twitchGqlAuthed(bodyArray) {
  const token = await getTwitchAuthToken();
  if (!token) throw new Error('Not logged in to Twitch');
  const uniqueId = await getTwitchUniqueId();
  addLog(`[Drops] twitchGqlAuthed: unique_id cookie is "${uniqueId}"`);
  let win = await getTwitchPageWindow();

  const script = `(async () => {
    let stage = 'init';
    try {
      const CLIENT_ID = ${JSON.stringify(TWITCH_PUBLIC_CLIENT_ID)};
      const TOKEN = ${JSON.stringify(token)};
      const BODY = ${JSON.stringify(JSON.stringify(bodyArray))};
      if (!location.origin.includes('twitch.tv')) {
        return { ok: false, error: 'page not on twitch.tv origin (got ' + location.origin + ')' };
      }
      const m = document.cookie.match(/unique_id=([^;]+)/);
      const cookieUniqueId = m ? decodeURIComponent(m[1]) : '';
      
      const cleanLocalVal = (key) => {
        const val = localStorage.getItem(key);
        if (!val) return '';
        try {
          return JSON.parse(val);
        } catch (e) {
          if (val.startsWith('"') && val.endsWith('"')) {
            return val.substring(1, val.length - 1);
          }
          return val;
        }
      };

      // Wait for Twitch/Kasada to initialize localStorage session ID
      let sessionVal = '';
      for (let i = 0; i < 150; i++) {
        const val1 = localStorage.getItem('twilight.sessionID');
        const val2 = localStorage.getItem('local_storage_app_session_id');
        if (val1 || val2) {
          sessionVal = val1 || val2;
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }

      const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
      const deviceId = cookieUniqueId || cleanLocalVal('local_storage_device_id') || cleanLocalVal('k-device-id') || hex(16);
      const sessionId = cleanLocalVal('twilight.sessionID') || cleanLocalVal('local_storage_app_session_id') || hex(8);
      const clientVersion = window.__twilightBuildID || window.__twilightCommitHash || '';
      const baseHeaders = {
        'Client-Id': CLIENT_ID,
        'Authorization': 'OAuth ' + TOKEN,
        'Client-Session-Id': sessionId,
        'X-Device-Id': deviceId
      };
      if (clientVersion) {
        baseHeaders['Client-Version'] = clientVersion;
      }
      stage = 'integrity';
      let integrityToken = '';
      let integrityResponse = null;
      try {
        const integrityHeaders = Object.assign({}, baseHeaders);
        delete integrityHeaders['Authorization'];
        const ir = await fetch('https://gql.twitch.tv/integrity', { method: 'POST', headers: integrityHeaders, credentials: 'include' });
        integrityResponse = await ir.json();
        integrityToken = integrityResponse.token || '';
      } catch (e) {
        integrityResponse = { error: String(e && e.message || e) };
      }
      stage = 'gql';
      const headers = Object.assign({ 'Content-Type': 'application/json' }, baseHeaders);
      if (integrityToken) headers['Client-Integrity'] = integrityToken;
      const resp = await fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: BODY, credentials: 'include' });
      const json = await resp.json();
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        ls[k] = localStorage.getItem(k);
      }
      return {
        ok: true,
        status: resp.status,
        data: json,
        hadIntegrity: !!integrityToken,
        integrityResponse,
        deviceId,
        sessionId,
        clientVersion,
        ls,
        cookies: document.cookie,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        hasFocus: document.hasFocus()
      };
    } catch (e) {
      return { ok: false, error: stage + ': ' + String((e && e.message) || e) };
    }
  })()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(script);
    if (result && result.ok) {
      addLog(`[Drops Diagnostic] document.cookie: "${result.cookies}"`);
      addLog(`[Drops Diagnostic] localStorage: ${JSON.stringify(result.ls)}`);
      addLog(`[Drops Diagnostic] visibilityState: "${result.visibilityState}", hidden: ${result.hidden}, hasFocus: ${result.hasFocus}`);
      addLog(`[Drops Diagnostic] integrityResponse: ${JSON.stringify(result.integrityResponse)}`);
    }
  } catch (err) {
    resetTwitchPageWindow();
    throw err;
  }

  if (!result || !result.ok) {
    // If it failed completely, let's retry once
    addLog('[Drops] GQL query execute failed. Resetting window and retrying...');
    resetTwitchPageWindow();
    win = await getTwitchPageWindow();
    try {
      result = await win.webContents.executeJavaScript(script);
    } catch (err) {
      resetTwitchPageWindow();
      throw err;
    }
  }

  if (!result || !result.ok) {
    resetTwitchPageWindow();
    throw new Error(result && result.error ? result.error : 'Page GQL request failed');
  }

  // Check if GQL returned an integrity check error
  let hasIntegrityError = false;
  if (result.data && Array.isArray(result.data)) {
    result.data.forEach(res => {
      if (res.errors && res.errors.some(e => e.message && e.message.toLowerCase().includes('failed integrity check'))) {
        hasIntegrityError = true;
      }
    });
  }

  if (hasIntegrityError) {
    addLog('[Drops] GQL failed integrity check. Resetting window and retrying once...');
    resetTwitchPageWindow();
    win = await getTwitchPageWindow();
    try {
      result = await win.webContents.executeJavaScript(script);
    } catch (err) {
      resetTwitchPageWindow();
      throw err;
    }
    if (!result || !result.ok) {
      resetTwitchPageWindow();
      throw new Error(result && result.error ? result.error : 'Page GQL request failed after integrity retry');
    }
  }

  addLog(`[Drops] GQL via page ok (status ${result.status}, integrity: ${result.hadIntegrity ? 'yes' : 'no'}, deviceId: ${result.deviceId}, sessionId: ${result.sessionId}, clientVersion: "${result.clientVersion}").`);
  return result.data;
}

// Fetch the user's currently-live followed channels along with the game each is
// streaming, so the Drops tab can surface follows that are playing a game with an
// active drop campaign.
async function getLiveFollowsWithGames() {
  const token = await getTwitchAuthToken();
  if (!token) return [];
  try {
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
        operationName: 'FollowedLiveUsersWithGame',
        query: `query FollowedLiveUsersWithGame {
          currentUser {
            followedLiveUsers(first: 100) {
              edges {
                node {
                  login
                  displayName
                  stream {
                    viewersCount
                    game { id name displayName slug }
                  }
                }
              }
            }
          }
        }`
      }])
    });
    if (!response.ok) return [];
    const data = await response.json();
    const edges = data[0]?.data?.currentUser?.followedLiveUsers?.edges || [];
    return edges.map(e => e.node).filter(n => n && n.stream).map(n => ({
      login: n.login,
      displayName: n.displayName || n.login,
      viewersCount: n.stream.viewersCount || 0,
      game: n.stream.game || null
    }));
  } catch (err) {
    addLog(`[Drops] Failed to fetch live follows: ${err.message}`);
    return [];
  }
}

ipcMain.handle('get-twitch-auth-token', getTwitchAuthToken);
ipcMain.on('get-twitch-unique-id-sync', (event) => {
  event.returnValue = cachedTwitchUniqueId;
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

let currentDownloadFileName = null;

ipcMain.handle('download-clip', async (event, url, filename) => {
  try {
    if (mainWindow && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      addLog(`[Clips] Starting download for: ${filename || 'clip.mp4'}`);
      currentDownloadFileName = filename || 'clip.mp4';
      mainWindow.webContents.downloadURL(url);
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
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
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
      clipWin.loadURL(url);
      return { success: true };
    }
    return { success: false, error: 'Invalid URL' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


ipcMain.handle('sync-platform-schedules', async () => {
  addLog('[Calendar] Syncing platform calendars for Twitch, YouTube, and Kick streams...');
  const twitchStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'twitch').map(s => s.username);
  const youtubeStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'youtube').map(s => s.username);
  const kickStreamers = config.streamers.filter(s => s.platform.toLowerCase() === 'kick').map(s => s.username);
  
  let allEvents = [];
  
  // Fetch Twitch in parallel
  const twitchPromises = twitchStreamers.map(u => fetchTwitchSchedule(u));
  const twitchResults = await Promise.all(twitchPromises);
  twitchResults.forEach(res => { allEvents = allEvents.concat(res); });
  
  // Fetch YouTube in parallel
  const youtubePromises = youtubeStreamers.map(u => fetchYoutubeSchedule(u));
  const youtubeResults = await Promise.all(youtubePromises);
  youtubeResults.forEach(res => { allEvents = allEvents.concat(res); });

  // Fetch Kick in parallel (graceful empty return)
  const kickPromises = kickStreamers.map(u => fetchKickSchedule(u));
  const kickResults = await Promise.all(kickPromises);
  kickResults.forEach(res => { allEvents = allEvents.concat(res); });
  
  addLog(`[Calendar] Sync complete. Detected ${allEvents.length} platform scheduled segments.`);
  return allEvents;
});

