console.log('=== RENDERER.JS RUNNING ===');
// Renderer entry point. Modules under src/ own each feature; this file wires
// the dashboard once on DOMContentLoaded and bridges main-process events to UI
// updates.

import { state, appendLogMessage } from './src/state.js';
import { setupTabs } from './src/tabs.js';
import {
  createStreamTab,
  removeStreamTab,
  closeAllStreamTabs,
  reloadAllStreamContainers,
  setupGlobalGhostButton,
} from './src/multi-lurk.js';
import { renderStreamsGrid, updateStats } from './src/dashboard.js';
import { renderMonitoredList } from './src/streamers.js';
import { renderExtensionsList, renderExtensionCatalog } from './src/extensions.js';
import { renderFollowsList, setupFollowsHandlers } from './src/follows.js';
import { renderLeaderboard } from './src/leaderboard.js';
import { populateCalendarFormDays, renderCalendar, setupCalendarHandlers } from './src/calendar.js';
import { setupLoginPortalListeners } from './src/login.js';
import { hydrateSettingsUI, applyServiceToggles, setupSettingsHandlers } from './src/settings.js';
import { startPointsPoller } from './src/points.js';
import { initClipsManager } from './src/clips.js';

const BACKGROUND_CALENDAR_SYNC_DELAY_MS = 5000;
const SCAN_BTN_COOLDOWN_MS = 1500;

function setupUpdater() {
  const versionEl = document.getElementById('app-version-display');
  const statusText = document.getElementById('update-status-text');
  const checkBtn = document.getElementById('check-updates-btn');
  const downloadBtn = document.getElementById('download-update-btn');
  const installBtn = document.getElementById('install-update-btn');
  const progressWrapper = document.getElementById('update-progress-wrapper');
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-text');

  if (!checkBtn) return;

  window.api.getAppVersion().then(v => {
    if (versionEl) versionEl.textContent = `v${v}`;
  }).catch(() => {});

  const setStatus = (msg) => { if (statusText) statusText.textContent = msg; };
  const showProgress = (show) => progressWrapper?.classList.toggle('hidden', !show);
  const setProgress = (pct) => {
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressText) progressText.textContent = `${pct.toFixed(1)}%`;
  };

  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    downloadBtn?.classList.add('hidden');
    installBtn?.classList.add('hidden');
    showProgress(false);
    setStatus('Checking for updates…');
    const res = await window.api.checkForUpdates();
    checkBtn.disabled = false;
    if (res && res.dev) {
      setStatus('Auto-update is disabled when running from source. Build a release to test.');
    } else if (res && !res.ok && res.error) {
      setStatus(`Update check failed: ${res.error}`);
    }
  });

  downloadBtn?.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    setStatus('Downloading update…');
    showProgress(true);
    setProgress(0);
    const res = await window.api.downloadUpdate();
    if (res && !res.ok && res.error) {
      setStatus(`Download failed: ${res.error}`);
      downloadBtn.disabled = false;
    }
  });

  installBtn?.addEventListener('click', () => {
    setStatus('Restarting to install update…');
    window.api.installUpdate();
  });

  window.api.onUpdateStatus((payload) => {
    if (!payload) return;
    switch (payload.state) {
      case 'checking':
        setStatus('Checking for updates…');
        break;
      case 'available':
        setStatus(`Update available: v${payload.version}. Click "Download Update" to get it.`);
        downloadBtn?.classList.remove('hidden');
        if (downloadBtn) downloadBtn.disabled = false;
        break;
      case 'not-available':
        setStatus('You are running the latest version.');
        break;
      case 'downloading':
        showProgress(true);
        setProgress(payload.percent || 0);
        setStatus(`Downloading update… (${Math.round((payload.bytesPerSecond || 0) / 1024)} KB/s)`);
        break;
      case 'downloaded':
        showProgress(false);
        setStatus(`Update v${payload.version} downloaded. Restart to install.`);
        installBtn?.classList.remove('hidden');
        downloadBtn?.classList.add('hidden');
        break;
      case 'error':
        showProgress(false);
        setStatus(`Updater error: ${payload.message}`);
        if (downloadBtn) downloadBtn.disabled = false;
        break;
      case 'dev':
        setStatus(payload.message || 'Auto-update only available in packaged builds.');
        break;
    }
  });
}

function setupTopBarHandlers() {
  const scanNowBtn = document.getElementById('scan-now-btn');
  scanNowBtn?.addEventListener('click', async () => {
    scanNowBtn.disabled = true;
    scanNowBtn.classList.remove('btn-cyan');
    scanNowBtn.innerHTML = `<span class="pulse-dot"></span> Scanning...`;

    await window.api.forceScan();

    setTimeout(() => {
      scanNowBtn.disabled = false;
      scanNowBtn.classList.add('btn-cyan');
      scanNowBtn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
        Scan Now
      `;
    }, SCAN_BTN_COOLDOWN_MS);
  });
}

function setupAddStreamerForm() {
  const form = document.getElementById('add-streamer-form');
  const usernameInput = document.getElementById('streamer-username');
  const errorEl = document.getElementById('add-streamer-error');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl?.classList.add('hidden');

    const platform = document.querySelector('input[name="platform"]:checked')?.value;
    const username = usernameInput.value.trim();
    if (!platform || !username) return;

    const res = await window.api.addStreamer(platform, username);
    if (res.success) {
      state.currentConfig.streamers = res.streamers;
      usernameInput.value = '';
      renderMonitoredList();
      updateStats();
      appendLogMessage('[System] Monitored streamers list updated.');
    } else if (errorEl) {
      errorEl.textContent = res.error || 'Failed to add streamer';
      errorEl.classList.remove('hidden');
    }
  });
}

function setupAddExtensionButton() {
  const btn = document.getElementById('add-extension-btn');
  const errorEl = document.getElementById('extension-error');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    errorEl?.classList.add('hidden');
    const result = await window.api.selectExtensionFolder();
    if (!result) return;
    if (result.error) {
      if (errorEl) {
        errorEl.textContent = result.error;
        errorEl.classList.remove('hidden');
      }
      return;
    }

    state.currentConfig.extensions.push(result.path);
    await window.api.saveConfig(state.currentConfig);
    renderExtensionsList();
    appendLogMessage(`[Extensions] Extension loaded: ${result.name} (${result.version})`);
  });
}

const WEBVIEW_LABEL = {
  'twitch-login-webview': 'Twitch',
  'kick-login-webview': 'Kick',
  'youtube-login-webview': 'YouTube',
  'rumble-login-webview': 'Rumble',
};

function setupRefreshWebviewButtons() {
  document.querySelectorAll('.refresh-webview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const webviewId = btn.dataset.webview;
      const webview = document.getElementById(webviewId);
      if (!webview) return;
      webview.reload();
      appendLogMessage(`[System] Refreshing ${WEBVIEW_LABEL[webviewId] || 'Platform'} Portal view.`);
    });
  });
}

function setupBackendListeners() {
  window.api.onLogMessage((message) => appendLogMessage(message));

  window.api.onCountdownUpdate((seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const clock = document.getElementById('countdown-clock');
    if (clock) clock.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  });

  window.api.onStatusUpdate((statuses) => {
    state.currentStatuses = statuses;
    renderStreamsGrid();
    updateStats();
  });

  window.api.onActiveContainersUpdate((openContainers) => {
    state.activeContainers = openContainers;
    renderStreamsGrid();
    updateStats();
  });

  window.api.onOpenStreamTab(({ platform, username }) => createStreamTab(platform, username));
  window.api.onCloseStreamTab(({ platform, username }) => removeStreamTab(platform, username));
  window.api.onCloseAllStreamTabs(() => closeAllStreamTabs());
  window.api.onReloadStreamContainers(() => reloadAllStreamContainers());

  window.api.onWatchTimeUpdate((data) => {
    if (state.currentConfig) {
      state.currentConfig.watchTime = data;
      renderLeaderboard();
    }
  });
}

async function init() {
  console.log('=== INIT RUNNING ===');
  setupTabs();
  setupGlobalGhostButton();
  setupTopBarHandlers();
  setupAddStreamerForm();
  setupAddExtensionButton();
  setupRefreshWebviewButtons();
  setupSettingsHandlers();
  setupFollowsHandlers();
  setupCalendarHandlers();
  setupUpdater();

  try {
    console.log('Fetching config...');
    state.currentConfig = await window.api.getConfig();
    console.log('Config fetched successfully:', state.currentConfig);
    
    console.log('Fetching active containers...');
    state.activeContainers = await window.api.getActiveContainers();
    console.log('Active containers fetched successfully:', state.activeContainers);

    console.log('Hydrating settings UI...');
    hydrateSettingsUI();
    console.log('Applying service toggles...');
    applyServiceToggles();

    console.log('Rendering extensions list...');
    renderExtensionsList();
    renderExtensionCatalog();

    console.log('Fetching recent logs...');
    const initialLogs = await window.api.getRecentLogs();
    console.log('Recent logs fetched successfully, count:', initialLogs ? initialLogs.length : 0);
    initialLogs.forEach(log => appendLogMessage(log));

    console.log('Updating stats...');
    updateStats();
    console.log('Rendering leaderboard...');
    renderLeaderboard();
    console.log('Leaderboard rendered successfully.');

    console.log('Populating calendar form days...');
    populateCalendarFormDays();
    console.log('Calendar form days populated successfully.');

    state.platformSchedules = state.currentConfig.syncedCalendarEvents || [];
    console.log('Platform schedules set. Count:', state.platformSchedules ? state.platformSchedules.length : 0);

    console.log('Rendering calendar...');
    renderCalendar();
    console.log('Calendar rendered successfully.');

    console.log('Setting up login portal listeners...');
    setupLoginPortalListeners();
    console.log('Setting up backend listeners...');
    setupBackendListeners();
    console.log('Starting points poller...');
    startPointsPoller();
    console.log('Initializing clips manager...');
    initClipsManager();
    console.log('Dashboard initialization completed fully!');

    // Silent delayed sync to keep platform schedules fresh.
    setTimeout(async () => {
      try {
        appendLogMessage('[Calendar] Running background scheduled calendar sync...');
        const schedules = await window.api.syncPlatformSchedules();
        state.platformSchedules = schedules;
        state.currentConfig.syncedCalendarEvents = schedules;
        await window.api.saveConfig(state.currentConfig);
        renderCalendar();
        appendLogMessage(`[Calendar] Background sync complete. Stored ${schedules.length} events.`);
      } catch (e) {
        console.error('Background calendar sync failed:', e);
      }
    }, BACKGROUND_CALENDAR_SYNC_DELAY_MS);
  } catch (err) {
    console.error('Failed to initialize application dashboard:', err);
    appendLogMessage(`[ERROR] Initialization failed: ${err.message}`);
  }
}

console.log('Document readyState:', document.readyState);
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
