console.log('=== PRELOAD.JS RUNNING ===');
const { contextBridge, ipcRenderer } = require('electron');

// Helper to safely register an IPC listener without stacking duplicates
function safeOn(channel, handler) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // Config management
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getTwitchFollows: () => ipcRenderer.invoke('get-twitch-follows'),
  
  // Account logins via Modal Windows
  openLoginModal: (platform) => ipcRenderer.invoke('open-login-modal', { platform }),
  logoutPlatform: (platform) => ipcRenderer.invoke('logout-platform', { platform }),
  onLoginSuccess: (callback) => safeOn('login-success', (event, data) => callback(data)),
  onSessionExpired: (callback) => safeOn('session-expired', (event, data) => callback(data)),
  
  // Streamer management
  addStreamer: (platform, username) => ipcRenderer.invoke('add-streamer', { platform, username }),
  deleteStreamer: (platform, username) => ipcRenderer.invoke('delete-streamer', { platform, username }),
  
  // Extension management
  selectExtensionFolder: () => ipcRenderer.invoke('select-extension-folder'),
  
  // Actions
  forceScan: () => ipcRenderer.invoke('force-scan'),
  openStreamContainer: (platform, username) => ipcRenderer.invoke('open-stream-container', { platform, username }),
  prioritizeStreamer: (platform, username) => ipcRenderer.invoke('prioritize-streamer', { platform, username }),
  closeStreamContainer: (platform, username) => ipcRenderer.invoke('close-stream-container', { platform, username }),
  updateActiveTabs: (tabsList) => ipcRenderer.invoke('update-active-tabs', tabsList),
  syncPlatformSchedules: () => ipcRenderer.invoke('sync-platform-schedules'),

  getTwitchAuthToken: () => ipcRenderer.invoke('get-twitch-auth-token'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  downloadClip: (url, filename) => ipcRenderer.invoke('download-clip', url, filename),
  openClipWindow: (url) => ipcRenderer.invoke('open-clip-window', url),

  // Queries
  getRecentLogs: () => ipcRenderer.invoke('get-recent-logs'),
  getActiveContainers: () => ipcRenderer.invoke('get-active-containers'),
  
  // Event listeners (Main -> Renderer) — using safeOn to prevent listener stacking
  onLogMessage: (callback) => {
    safeOn('log-message', (event, message) => callback(message));
  },
  onWatchTimeUpdate: (callback) => {
    safeOn('watch-time-update', (event, data) => callback(data));
  },
  onStatusUpdate: (callback) => {
    safeOn('status-update', (event, results) => callback(results));
  },
  onCountdownUpdate: (callback) => {
    safeOn('countdown-update', (event, seconds) => callback(seconds));
  },
  onActiveContainersUpdate: (callback) => {
    safeOn('active-containers-update', (event, openContainers) => callback(openContainers));
  },
  onOpenStreamTab: (callback) => {
    safeOn('open-stream-tab', (event, data) => callback(data));
  },
  onCloseStreamTab: (callback) => {
    safeOn('close-stream-tab', (event, data) => callback(data));
  },
  onCloseAllStreamTabs: (callback) => {
    safeOn('close-all-stream-tabs', (event) => callback());
  }
});
