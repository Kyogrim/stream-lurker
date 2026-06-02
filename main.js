const { app, BrowserWindow, ipcMain, session, dialog, net, Notification, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Enable extension support in Electron partitioned sessions & webviews by bypassing sandbox restrictions
app.commandLine.appendSwitch('disable-extension-sandbox');

// Constants
const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Global variables
let mainWindow = null;
let tray = null;
const activeWindows = new Map(); // Key: platform:username -> true
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
  rumbleEnabled: true,
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

// Download and unpack 7TV extension dynamically on startup
async function install7TVExtension() {
  const userDataPath = app.getPath('userData');
  const extensionsDir = path.join(userDataPath, 'extensions');
  const seventvDir = path.join(extensionsDir, 'seventv');
  const zipPath = path.join(extensionsDir, 'seventv.zip');

  // Ensure extensions directory exists
  if (!fs.existsSync(extensionsDir)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
  }

  const manifestPath = path.join(seventvDir, 'manifest.json');
  let localVersion = null;
  let hasMV3 = false;

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.manifest_version === 3) {
        hasMV3 = true;
        localVersion = manifest.version || null;
      }
    } catch (e) {
      addLog(`[7TV] Failed to read pre-installed manifest: ${e.message}`);
    }
  }

  let needsDownload = true;
  let latestRelease = null;
  let targetAsset = null;

  addLog('[7TV] Fetching latest release info from GitHub (nightly-release)...');
  try {
    const response = await net.fetch('https://api.github.com/repos/SevenTV/Extension/releases/tags/nightly-release', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (response.ok) {
      latestRelease = await response.json();
      const assets = latestRelease.assets || [];
      targetAsset = assets.find(asset => asset.name.endsWith('.zip') && asset.name.toLowerCase().includes('mv3'))
        || assets.find(asset => 
            asset.name.endsWith('.zip') && 
            (asset.name.toLowerCase().includes('chrome') || 
             asset.name.toLowerCase().includes('webextension') || 
             asset.name.toLowerCase().includes('chromium'))
          )
        || assets.find(asset => asset.name.endsWith('.zip'));
    } else {
      addLog(`[7TV] GitHub API returned status ${response.status}. Gracefully continuing...`);
    }
  } catch (err) {
    addLog(`[7TV] Network check failed: ${err.message}. Gracefully continuing...`);
  }

  if (latestRelease && targetAsset) {
    const remoteLastUpdated = targetAsset.updated_at;

    if (hasMV3 && config.seventvLastUpdated === remoteLastUpdated) {
      addLog(`[7TV] Extension is already up-to-date (Last Updated: ${config.seventvLastUpdated}).`);
      needsDownload = false;
    } else {
      if (hasMV3) {
        addLog(`[7TV] Update available: Local last-updated ${config.seventvLastUpdated || 'unknown'} vs Remote last-updated ${remoteLastUpdated}. Upgrading...`);
      } else {
        addLog('[7TV] Extension not fully installed. Installing nightly-release...');
      }
      needsDownload = true;
    }
  } else {
    // If GitHub API check fails (offline/rate-limited) but we have a valid local installation, use it!
    if (hasMV3) {
      addLog(`[7TV] GitHub check unavailable or asset not found. Keeping existing local installation (Version ${localVersion || 'unknown'}).`);
      needsDownload = false;
    } else {
      addLog('[7TV] GitHub check unavailable and no local installation found. Fresh installation is required.');
      needsDownload = true;
    }
  }

  if (needsDownload) {
    // If we are replacing an existing directory, remove it first to avoid extraction pollution
    if (fs.existsSync(seventvDir)) {
      try {
        fs.rmSync(seventvDir, { recursive: true, force: true });
      } catch (rmErr) {
        addLog(`[7TV] Warning: failed to clean seventv directory: ${rmErr.message}`);
      }
    }

    try {
      if (!latestRelease || !targetAsset) {
        addLog('[7TV] Recheck: Fetching latest nightly-release from GitHub to download...');
        const response = await net.fetch('https://api.github.com/repos/SevenTV/Extension/releases/tags/nightly-release', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        if (!response.ok) {
          throw new Error(`GitHub API returned status ${response.status}`);
        }
        latestRelease = await response.json();
        const assets = latestRelease.assets || [];
        targetAsset = assets.find(asset => asset.name.endsWith('.zip') && asset.name.toLowerCase().includes('mv3'))
          || assets.find(asset => 
              asset.name.endsWith('.zip') && 
              (asset.name.toLowerCase().includes('chrome') || 
               asset.name.toLowerCase().includes('webextension') || 
               asset.name.toLowerCase().includes('chromium'))
            )
          || assets.find(asset => asset.name.endsWith('.zip'));
      }

      if (!targetAsset) {
        throw new Error('No suitable ZIP asset found in the nightly-release 7TV release.');
      }

      const remoteLastUpdated = targetAsset.updated_at;
      const downloadUrl = targetAsset.browser_download_url;
      addLog(`[7TV] Downloading latest release: ${targetAsset.name} from GitHub...`);

      const fileResponse = await net.fetch(downloadUrl);
      if (!fileResponse.ok) {
        throw new Error(`Failed to download ZIP file: status ${fileResponse.status}`);
      }

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      fs.writeFileSync(zipPath, buffer);
      addLog('[7TV] ZIP file downloaded successfully. Extracting archive...');

      // Ensure output folder exists
      if (!fs.existsSync(seventvDir)) {
        fs.mkdirSync(seventvDir, { recursive: true });
      }

      // Extract natively using PowerShell Expand-Archive on Windows
      await new Promise((resolve, reject) => {
        const psCommand = `powershell -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${seventvDir.replace(/'/g, "''")}' -Force"`;
        exec(psCommand, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`Extraction failed: ${stderr || err.message}`));
          } else {
            resolve();
          }
        });
      });

      addLog('[7TV] Extraction complete.');

      // Clean up ZIP file
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }

      // Update cached last updated time
      config.seventvLastUpdated = remoteLastUpdated;
      saveConfig();
    } catch (err) {
      addLog(`[7TV] Installation failed: ${err.message}`);
      return;
    }
  }

  // Programmatically inject Kick.com permissions and matches into unpacked seventv/manifest.json
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      
      // 1. Add kick.com to host_permissions
      if (!manifest.host_permissions) manifest.host_permissions = [];
      if (!manifest.host_permissions.includes('*://*.kick.com/*')) {
        manifest.host_permissions.push('*://*.kick.com/*');
      }
      
      // 2. Add kick.com to content_scripts matches
      if (manifest.content_scripts && Array.isArray(manifest.content_scripts)) {
        manifest.content_scripts.forEach(script => {
          if (script.matches && Array.isArray(script.matches)) {
            const hasTwitch = script.matches.some(m => m.includes('twitch.tv'));
            const hasKick = script.matches.some(m => m.includes('kick.com'));
            if (hasTwitch && !hasKick) {
              script.matches.push('*://*.kick.com/*');
            }
          }
        });
      }
      
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      addLog('[7TV] Successfully patched manifest.json with Kick.com permissions and content scripts.');
    }
  } catch (patchErr) {
    addLog(`[7TV] Warning: Failed to patch manifest.json for Kick: ${patchErr.message}`);
  }

  // Add to config.extensions and save
  if (!config.extensions.includes(seventvDir)) {
    config.extensions.push(seventvDir);
    saveConfig();
  }
  addLog('[7TV] Extension registered and ready.');
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

  // Remove default menu bar
  mainWindow.setMenuBarVisibility(false);

  // Load dashboard
  mainWindow.loadFile('index.html');

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
        // Fall through to offline status
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
              .filter(k => k.startsWith(`${platform}:`));

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
  
  // Pre-install 7TV Extension
  await install7TVExtension();
  
  await loadExtensions();
  createMainWindow();
  createTray();

  // Start background poller
  resetPoller();

  // Start watch time tracker
  startWatchTimeTracking();

  // Run immediate first scan after a short delay to let frontend mount
  setTimeout(performScan, 3000);

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

// Session Validation on Startup
async function validateSavedSessions() {
  const platforms = Object.keys(config.accounts || {});
  if (platforms.length === 0) return;
  
  addLog('[Auth] Validating saved platform sessions...');
  const ses = session.fromPartition('persist:default');
  
  for (const platform of platforms) {
    let isValid = false;
    
    try {
      if (platform === 'twitch') {
        const cookies = await ses.cookies.get({ name: 'auth-token' });
        isValid = cookies.some(c => c.domain && c.domain.includes('twitch.tv'));
      } else if (platform === 'kick') {
        const cookies = await ses.cookies.get({ domain: 'kick.com' });
        isValid = cookies.some(c => c.name === 'kick_session' || c.name.includes('session'));
      } else if (platform === 'youtube') {
        const cookies = await ses.cookies.get({ domain: 'google.com' });
        isValid = cookies.some(c => c.name === 'SID' || c.name === 'SSID');
      } else if (platform === 'rumble') {
        const cookies = await ses.cookies.get({ domain: 'rumble.com' });
        isValid = cookies.some(c => c.name.includes('session') || c.name === 'u_s');
      }
    } catch (e) {
      addLog(`[Auth] Error validating ${platform.toUpperCase()} session: ${e.message}`);
    }
    
    if (!isValid) {
      addLog(`[Auth] Session expired for ${platform.toUpperCase()}. Marking as disconnected.`);
      delete config.accounts[platform];
      saveConfig();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-expired', { platform });
      }
    } else {
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
    loginWin.loadURL(loginUrl);

    loginWin.once('ready-to-show', () => {
      loginWin.show();
    });

    let checkInterval = null;
    let resolved = false;
    let timeoutId = null;

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
          const cookies = await ses.cookies.get({ domain: 'kick.com' });
          const hasSession = cookies.some(c => c.name === 'kick_session' || c.name.includes('session') || c.name.includes('XSRF'));
          const url = loginWin.isDestroyed() ? '' : loginWin.webContents.getURL();
          return hasSession && !url.includes('/login') && !url.includes('/auth/');
        } else if (p === 'youtube') {
          const googleCookies = await ses.cookies.get({ domain: 'google.com' });
          return googleCookies.some(c => c.name === 'SID' || c.name === 'SSID');
        } else if (p === 'rumble') {
          const cookies = await ses.cookies.get({ domain: 'rumble.com' });
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
              (() => {
                try {
                  const userVal = localStorage.getItem('user');
                  if (userVal) {
                    const parsed = JSON.parse(userVal);
                    if (parsed && (parsed.username || parsed.slug)) return true;
                  }
                  if (document.querySelector('.profile-dropdown, #profile-dropdown-trigger, [href*="/dashboard"], [href*="/settings"], [class*="profile-dropdown"]')) {
                    return true;
                  }
                } catch(e) {}
                return false;
              })()
            `;
          } else if (p === 'youtube') {
            // YouTube: check if we've been redirected back to youtube.com with user avatar
            if (url.includes('youtube.com')) {
              script = `
                (() => {
                  try {
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
            isLoggedIn = await loginWin.webContents.executeJavaScript(script);
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
                  try {
                    const userObj = JSON.parse(localStorage.getItem('user') || '{}');
                    actualUsername = userObj.username || userObj.slug || userObj.name;
                  } catch(e) {}
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
            // For YouTube, we may still be on google.com after cookie detection
            // Navigate to youtube.com to extract username if needed
            const currentUrl = loginWin.webContents.getURL();
            if (!currentUrl.includes('youtube.com')) {
              loginWin.loadURL('https://www.youtube.com');
              await new Promise(r => setTimeout(r, 3000));
            }
            const data = await loginWin.webContents.executeJavaScript(`
              (() => {
                try {
                  const avatar = document.querySelector('button#avatar-btn, #avatar-btn');
                  if (!avatar) return null;
                  let nameVal = avatar.getAttribute('aria-label') || 'YouTube User';
                  if (nameVal.includes('Photo of')) nameVal = nameVal.replace('Photo of', '').trim();
                  return nameVal;
                } catch(e) {
                  return null;
                }
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// Hidden, logged-in Twitch page used to issue integrity-protected GQL requests.
// Operations like ViewerDropsDashboard/inventory require a Client-Integrity
// header that Twitch's Kasada SDK generates in the browser — a bare net.fetch
// can't produce it, so we run those requests from inside a real Twitch page
// where the SDK hooks fetch and supplies the headers. The window is reused.
let twitchPageWin = null;
let twitchPageReady = null;

async function getTwitchPageWindow() {
  if (twitchPageWin && !twitchPageWin.isDestroyed()) {
    await twitchPageReady;
    if (twitchPageWin.webContents.getURL().includes('twitch.tv')) return twitchPageWin;
    // Lost the twitch.tv origin (redirect/crash) — rebuild below.
    try { twitchPageWin.destroy(); } catch (e) {}
    twitchPageWin = null;
  }
  twitchPageWin = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: 'persist:default',
      backgroundThrottling: false
    }
  });
  twitchPageWin.webContents.setAudioMuted(true);
  twitchPageWin.on('closed', () => { twitchPageWin = null; twitchPageReady = null; });
  twitchPageReady = (async () => {
    try {
      // loadURL resolves on did-finish-load, rejects on net failure.
      await twitchPageWin.loadURL('https://www.twitch.tv/');
    } catch (e) {
      addLog(`[Drops] Twitch page load issue: ${e.message}`);
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
  const win = await getTwitchPageWindow();
  const script = `(async () => {
    let stage = 'init';
    try {
      const CLIENT_ID = ${JSON.stringify(TWITCH_PUBLIC_CLIENT_ID)};
      const TOKEN = ${JSON.stringify(token)};
      const BODY = ${JSON.stringify(JSON.stringify(bodyArray))};
      if (!location.origin.includes('twitch.tv')) {
        return { ok: false, error: 'page not on twitch.tv origin (got ' + location.origin + ')' };
      }
      const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
      const m = document.cookie.match(/unique_id=([^;]+)/);
      const deviceId = m ? decodeURIComponent(m[1]) : hex(16);
      const sessionId = hex(8);
      const baseHeaders = {
        'Client-ID': CLIENT_ID,
        'Authorization': 'OAuth ' + TOKEN,
        'Client-Session-Id': sessionId,
        'X-Device-Id': deviceId
      };
      stage = 'integrity';
      let integrityToken = '';
      try {
        const ir = await fetch('https://gql.twitch.tv/integrity', { method: 'POST', headers: baseHeaders });
        const ij = await ir.json();
        integrityToken = ij.token || '';
      } catch (e) {}
      stage = 'gql';
      const headers = Object.assign({ 'Content-Type': 'application/json' }, baseHeaders);
      if (integrityToken) headers['Client-Integrity'] = integrityToken;
      const resp = await fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: BODY });
      const json = await resp.json();
      return { ok: true, status: resp.status, data: json, hadIntegrity: !!integrityToken };
    } catch (e) {
      return { ok: false, error: stage + ': ' + String((e && e.message) || e) };
    }
  })()`;
  const result = await win.webContents.executeJavaScript(script);
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Page GQL request failed');
  addLog(`[Drops] GQL via page ok (status ${result.status}, integrity: ${result.hadIntegrity ? 'yes' : 'no'}).`);
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

ipcMain.handle('fetch-drop-campaigns', async () => {
  try {
    const token = await getTwitchAuthToken();
    if (!token) {
      return { success: false, error: 'Not logged in to Twitch. Sign in under Platform Logins first.' };
    }

    const data = await twitchGqlAuthed([{
        operationName: 'ViewerDropsDashboard',
        variables: { fetchRewardCampaigns: true },
        query: `query ViewerDropsDashboard($fetchRewardCampaigns: Boolean!) {
          currentUser {
            id
            dropCampaigns {
              id
              name
              status
              startAt
              endAt
              imageURL
              detailsURL
              accountLinkURL
              game { id name displayName boxArtURL slug }
              timeBasedDrops {
                id
                name
                requiredMinutesWatched
                requiredSubs
                startAt
                endAt
                benefitEdges {
                  entitlementLimit
                  benefit {
                    id
                    name
                    imageAssetURL
                    ownerOrganization { name }
                  }
                }
              }
            }
            inventory {
              dropCampaignsInProgress {
                id
                name
                game { name }
                timeBasedDrops {
                  id
                  requiredMinutesWatched
                  self { currentMinutesWatched }
                }
              }
            }
          }
          rewardCampaignsAvailableToUser @include(if: $fetchRewardCampaigns) {
            id
            name
            brand
            startsAt
            endsAt
            status
            summary
            instructions
            externalURL
            aboutURL
            image { image1xURL }
            game { id name displayName boxArtURL slug }
            unlockRequirements {
              subsGoal
              minuteWatchedGoal
            }
            rewards {
              id
              name
              earnableUntil
              bannerImage { image1xURL }
              thumbnailImage { image1xURL }
            }
          }
        }`
    }]);

    // Surface GQL-level validation errors so they're visible in the activity log.
    if (data[0]?.errors?.length) {
      const msg = data[0].errors.map(e => e.message).join('; ');
      addLog(`[Drops] GQL returned errors: ${msg}`);
      return { success: false, error: `Twitch GQL error: ${msg}` };
    }

    const user = data[0]?.data?.currentUser;
    if (!user) return { success: false, error: 'Empty GQL response. Twitch session may have expired — try re-authenticating.' };
    const rewardCampaignsAvailable = data[0]?.data?.rewardCampaignsAvailableToUser || [];

    const nowMs = Date.now();
    // Derive percent complete per in-progress campaign from watched vs required minutes.
    const inProgress = user.inventory?.dropCampaignsInProgress || [];
    const progressById = new Map(inProgress.map(c => {
      const drops = c.timeBasedDrops || [];
      let pct = 0;
      if (drops.length) {
        const ratios = drops.map(d => {
          const req = d.requiredMinutesWatched || 0;
          const got = d.self?.currentMinutesWatched || 0;
          return req > 0 ? Math.min(100, Math.round((got / req) * 100)) : 0;
        });
        pct = Math.max(...ratios);
      }
      return [c.id, pct];
    }));

    // Each Drop campaign can carry a mix of watch-time drops (requiredMinutesWatched)
    // and subscription drops (requiredSubs). Split the drops per campaign so a campaign
    // surfaces in the Watch tab for its watch drops and in the Sub tab for its sub drops.
    const watchCampaigns = [];
    const subCampaigns = [];
    (user.dropCampaigns || [])
      .filter(c => c.status === 'ACTIVE' && (!c.endAt || new Date(c.endAt).getTime() > nowMs))
      .forEach(camp => {
        const allDrops = camp.timeBasedDrops || [];
        const subDrops = allDrops.filter(d => (d.requiredSubs || 0) > 0);
        // Anything not requiring subs counts as watch-time (covers requiredMinutesWatched > 0
        // and zero-requirement drops that are simply earned by watching).
        const watchDrops = allDrops.filter(d => (d.requiredSubs || 0) <= 0);

        const base = {
          id: camp.id,
          name: camp.name,
          game: camp.game,
          imageURL: camp.imageURL,
          detailsURL: camp.detailsURL,
          endAt: camp.endAt,
          accountLinkRequired: !!camp.accountLinkURL,
          accountLinkURL: camp.accountLinkURL
        };

        if (watchDrops.length) {
          watchCampaigns.push({
            ...base,
            category: 'watch',
            percentComplete: progressById.get(camp.id) || 0,
            drops: watchDrops
          });
        }
        if (subDrops.length) {
          subCampaigns.push({
            ...base,
            category: 'sub',
            percentComplete: 0,
            subsGoal: Math.max(...subDrops.map(d => d.requiredSubs || 1)),
            minuteWatchedGoal: 0,
            drops: subDrops
          });
        }
      });

    // rewardCampaignsAvailableToUser is an additional source of subscription-driven
    // reward campaigns (unlock by subbing/gifting). The field is already scoped to
    // campaigns available to the user, so don't whitelist by status — only drop ended ones.
    rewardCampaignsAvailable
      .filter(c => !c.endsAt || new Date(c.endsAt).getTime() > nowMs)
      .forEach(camp => {
        const subsGoal = camp.unlockRequirements?.subsGoal || 1;
        subCampaigns.push({
          id: camp.id,
          name: camp.name,
          category: 'sub',
          game: camp.game,
          imageURL: camp.image?.image1xURL || '',
          detailsURL: camp.externalURL || camp.aboutURL || '',
          endAt: camp.endsAt,
          percentComplete: 0,
          accountLinkRequired: false,
          accountLinkURL: '',
          subsGoal,
          minuteWatchedGoal: camp.unlockRequirements?.minuteWatchedGoal || 0,
          drops: (camp.rewards || []).map(r => ({
            id: r.id,
            name: r.name,
            requiredSubs: subsGoal,
            benefitEdges: [{
              benefit: {
                id: r.id,
                name: r.name,
                imageAssetURL: r.thumbnailImage?.image1xURL || r.bannerImage?.image1xURL || ''
              }
            }]
          }))
        });
      });

    // Match currently-live followed channels against campaign games so the user
    // can prioritise watching a streamer they already follow to earn the rewards.
    const campaignGameMap = new Map();
    [...watchCampaigns, ...subCampaigns].forEach(c => {
      const gname = c.game?.name;
      if (gname && !campaignGameMap.has(gname.toLowerCase())) {
        campaignGameMap.set(gname.toLowerCase(), { campaignId: c.id, campaignName: c.name, game: c.game });
      }
    });

    let followedCampaigns = [];
    if (campaignGameMap.size > 0) {
      const liveFollows = await getLiveFollowsWithGames();
      followedCampaigns = liveFollows
        .filter(f => f.game?.name && campaignGameMap.has(f.game.name.toLowerCase()))
        .map(f => {
          const match = campaignGameMap.get(f.game.name.toLowerCase());
          return {
            login: f.login,
            displayName: f.displayName,
            viewersCount: f.viewersCount,
            game: f.game,
            campaignId: match.campaignId,
            campaignName: match.campaignName
          };
        })
        .sort((a, b) => b.viewersCount - a.viewersCount);
    }

    addLog(`[Drops] Fetched ${watchCampaigns.length} watch + ${subCampaigns.length} sub campaigns; ${followedCampaigns.length} followed streamer(s) on campaign games.`);
    return { success: true, watchCampaigns, subCampaigns, followedCampaigns };
  } catch (err) {
    addLog(`[Drops] Failed to fetch drop campaigns: ${err.message}`);
    return { success: false, error: err.message };
  }
});

// Find a live drops-enabled Twitch streamer in a given game category so
// the user can "quest" for a drop. Falls back to the directory page URL
// if no live stream matches.
ipcMain.handle('find-drops-stream', async (event, { gameName, gameSlug, exclude }) => {
  try {
    const excludeSet = new Set((exclude || []).map(s => String(s).toLowerCase()));
    const token = await getTwitchAuthToken();
    const headers = {
      'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    if (token) headers['Authorization'] = `OAuth ${token}`;

    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'DirectoryPage_Game',
        variables: {
          name: gameName,
          options: {
            sort: 'VIEWER_COUNT',
            recommendationsContext: { platform: 'web' },
            tags: []
          },
          limit: 30
        },
        query: `query DirectoryPage_Game($name: String!, $options: GameStreamOptions, $limit: Int) {
          game(name: $name) {
            streams(first: $limit, options: $options) {
              edges {
                node {
                  id
                  viewersCount
                  broadcaster { login displayName }
                  freeformTags { name }
                }
              }
            }
          }
        }`
      }])
    });

    if (response.ok) {
      const data = await response.json();
      const edges = (data[0]?.data?.game?.streams?.edges || [])
        .filter(e => {
          const login = e?.node?.broadcaster?.login;
          return login && !excludeSet.has(login.toLowerCase());
        });
      const dropsEnabled = edges.find(e => {
        const tags = (e.node.freeformTags || []).map(t => (t.name || '').toLowerCase());
        return tags.includes('dropsenabled') || tags.includes('drops');
      }) || edges[0];

      if (dropsEnabled?.node?.broadcaster?.login) {
        return { success: true, username: dropsEnabled.node.broadcaster.login };
      }
    }

    // Fallback: open the directory page filtered by drops
    return {
      success: true,
      directoryUrl: `https://www.twitch.tv/directory/category/${gameSlug || encodeURIComponent(gameName.toLowerCase().replace(/\s+/g, '-'))}?filter=drops`
    };
  } catch (err) {
    addLog(`[Drops] find-drops-stream failed: ${err.message}`);
    return { success: false, error: err.message };
  }
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

// Lightweight live check for a single Twitch channel, used by the drops quest
// monitor to decide whether the streamer it's watching has gone offline.
ipcMain.handle('check-twitch-live', async (event, username) => {
  try {
    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify([{
        operationName: 'StreamLiveCheck',
        variables: { login: String(username || '').toLowerCase() },
        query: `query StreamLiveCheck($login: String!) {
          user(login: $login) { stream { id game { name } } }
        }`
      }])
    });
    if (!response.ok) return { success: false, live: false };
    const data = await response.json();
    const stream = data[0]?.data?.user?.stream;
    return { success: true, live: !!stream, game: stream?.game?.name || '' };
  } catch (err) {
    return { success: false, live: false, error: err.message };
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

