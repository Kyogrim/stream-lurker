console.log('=== RENDERER.JS RUNNING ===');
// Renderer entry point. Modules under src/ own each feature; this file wires
// the dashboard once on DOMContentLoaded and bridges main-process events to UI
// updates.

import { state, appendLogMessage, gridCellId, monitoredStreamers } from './src/state.js';
import { setupTabs } from './src/tabs.js';
import {
  createStreamTab,
  removeStreamTab,
  closeAllStreamTabs,
  reloadAllStreamContainers,
  setupGlobalGhostButton,
  setCellPoppedOut,
  refreshGridCellMeta,
  syncActiveTabs,
} from './src/multi-lurk.js';
import { setupLiveNow, renderLiveNow } from './src/live-now.js';
import { setupOnboarding, maybeShowOnboarding } from './src/onboarding.js';
import { renderStreamsGrid, updateStats } from './src/dashboard.js';
import { renderMonitoredList } from './src/streamers.js';
import { renderExtensionsList, renderExtensionCatalog } from './src/extensions.js';
import { renderFollowsList, setupFollowsHandlers } from './src/follows.js';
import { renderLeaderboard, setupLeaderboard } from './src/leaderboard.js';
import { populateCalendarFormDays, renderCalendar, setupCalendarHandlers, startCalendarAutoRefresh } from './src/calendar.js';
import { setupLoginPortalListeners } from './src/login.js';
import { hydrateSettingsUI, applyServiceToggles, setupSettingsHandlers } from './src/settings.js';
import { startPointsPoller } from './src/points.js';
import { initClipsManager } from './src/clips.js';
import { loadWebFontsAfterLoad } from './src/fonts.js';
import { setupExternalLinks } from './src/external-links.js';

// Never awaited, and only once the window has loaded: the fonts are cosmetic
// and must not hold up the dashboard or main's watch-time crediting (see
// src/fonts.js).
loadWebFontsAfterLoad();

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

    // Resolves when the scan has run, which can take a while; a rejection
    // must still give the button back.
    try {
      await window.api.forceScan();
    } catch (err) {
      appendLogMessage(`[ERROR] Scan Now failed: ${err?.message || err}`);
    }

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

// Re-create grid cells for containers the main process still considers open.
// Runs on every dashboard load, so after a manual refresh or an automatic
// crash-recovery reload the grid matches what main is tracking (and still
// counting watch time for) instead of silently drifting to an empty grid.
// Main hears the result once, as one full list (see createStreamTab), and
// even when nothing was restored: a key that failed to restore is then
// dropped by main rather than credited for a cell nobody can see.
function restoreOpenStreamTabs() {
  try {
    for (const key of state.activeContainers) {
      const [platform, username] = key.split(':');
      if (!platform || !username) continue;
      if (document.getElementById(gridCellId(platform, username))) continue;

      // One stream that can't be rebuilt must not cost the others their cells.
      try {
        // activeContainers keys are lowercased; recover the display casing.
        // monitoredStreamers() skips a malformed entry, which would otherwise
        // throw here for every key whose match comes after it.
        const tracked = monitoredStreamers().find(
          s => s.platform.toLowerCase() === platform && s.username.toLowerCase() === username
        );
        createStreamTab(platform, tracked ? tracked.username : username, { sync: false });
      } catch (err) {
        reportInitFailure(`Restoring ${key}`, err);
      }
    }
  } finally {
    syncActiveTabs();
  }
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
    renderLiveNow();
    refreshGridCellMeta(); // viewer counts / uptime moved
  });

  window.api.onActiveContainersUpdate((openContainers) => {
    state.activeContainers = openContainers;
    renderStreamsGrid();
    updateStats();
    renderLiveNow();
  });

  window.api.onOpenStreamTab(({ platform, username }) => createStreamTab(platform, username));
  window.api.onCloseStreamTab(({ platform, username }) => removeStreamTab(platform, username));
  window.api.onCloseAllStreamTabs(() => closeAllStreamTabs());
  // Sent whenever the loaded extensions changed, including a folder that was
  // unreachable at startup loading late: its "Unavailable" badge goes too.
  window.api.onReloadStreamContainers(() => {
    reloadAllStreamContainers();
    renderExtensionsList();
  });
  window.api.onStreamPopoutClosed(({ platform, username }) => setCellPoppedOut(platform, username, false));

  window.api.onWatchTimeUpdate((data) => {
    if (state.currentConfig) {
      state.currentConfig.watchTime = data;
      renderLeaderboard();
      refreshGridCellMeta(); // all-time watch totals ticked up
    }
  });
}

// Each startup step runs on its own. They used to share one try block, so a
// render that threw on an imported config (a null list, an event without a
// time) skipped setupBackendListeners: main kept scanning, opening streams and
// counting watch time for a dashboard that never heard about any of it.
function initStep(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(err => reportInitFailure(label, err));
  } catch (err) {
    reportInitFailure(label, err);
  }
}

function reportInitFailure(label, err) {
  console.error(`Dashboard startup step failed: ${label}`, err);
  appendLogMessage(`[ERROR] ${label} failed during startup: ${err?.message || err}`);
}

async function init() {
  console.log('=== INIT RUNNING ===');
  initStep('Tabs', setupTabs);
  initStep('External links', setupExternalLinks);
  initStep('Ghost button', setupGlobalGhostButton);
  initStep('Top bar', setupTopBarHandlers);
  initStep('Add streamer form', setupAddStreamerForm);
  initStep('Add extension button', setupAddExtensionButton);
  initStep('Settings', setupSettingsHandlers);
  initStep('Follows', setupFollowsHandlers);
  initStep('Calendar handlers', setupCalendarHandlers);
  initStep('Leaderboard handlers', setupLeaderboard);
  initStep('Live Now', setupLiveNow);
  initStep('Onboarding handlers', setupOnboarding);
  initStep('Updater', setupUpdater);

  // Everything below renders from these; without them there is nothing to show.
  try {
    state.currentConfig = await window.api.getConfig();
    state.activeContainers = await window.api.getActiveContainers();
  } catch (err) {
    console.error('Failed to initialize application dashboard:', err);
    appendLogMessage(`[ERROR] Initialization failed: ${err.message}`);
    return;
  }

  // The last scan's results, so a reloaded dashboard shows who is live now
  // instead of "Checking..." cards until the next scan. Before the service
  // toggles (they render the monitor grid) and before open streams are
  // restored (their cells show viewers and uptime). [] before the first scan.
  try {
    const statuses = await window.api.getStatuses();
    state.currentStatuses = Array.isArray(statuses) ? statuses : [];
  } catch (err) {
    reportInitFailure('Loading the last scan results', err);
  }

  initStep('Settings form', hydrateSettingsUI);
  initStep('Service toggles', applyServiceToggles);
  initStep('Extensions list', renderExtensionsList);
  initStep('Extension catalog', renderExtensionCatalog);

  try {
    const initialLogs = await window.api.getRecentLogs();
    (Array.isArray(initialLogs) ? initialLogs : []).forEach(log => appendLogMessage(log));
  } catch (err) {
    reportInitFailure('Loading recent logs', err);
  }

  initStep('Stats', updateStats);
  initStep('Leaderboard', renderLeaderboard);
  initStep('Calendar form', populateCalendarFormDays);
  const synced = state.currentConfig?.syncedCalendarEvents;
  state.platformSchedules = Array.isArray(synced) ? synced : [];
  initStep('Calendar', renderCalendar);

  // Registered after the getRecentLogs await, so a line that arrives in
  // between is not printed twice. restoreOpenStreamTabs skips cells that an
  // early open-stream-tab already created.
  initStep('Login portal listeners', setupLoginPortalListeners);
  initStep('Backend listeners', setupBackendListeners);
  initStep('Restoring open streams', restoreOpenStreamTabs);
  initStep('Live Now count', renderLiveNow);
  initStep('Points poller', startPointsPoller);
  initStep('Clips', initClipsManager);
  console.log('Dashboard initialization completed fully!');

  // Fresh installs only — main marks existing configs as already onboarded.
  initStep('Onboarding', maybeShowOnboarding);

  // Keeps platform schedules and the Today column current for the whole
  // session, not only the first minutes after launch.
  initStep('Calendar auto-refresh', () => startCalendarAutoRefresh({ firstSyncDelayMs: BACKGROUND_CALENDAR_SYNC_DELAY_MS }));
}

console.log('Document readyState:', document.readyState);
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
