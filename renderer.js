// Renderer entry point. Modules under src/ own each feature; this file wires
// the dashboard once on DOMContentLoaded and bridges main-process events to UI
// updates.

import { state, appendLogMessage } from './src/state.js';
import { setupTabs } from './src/tabs.js';
import {
  createStreamTab,
  removeStreamTab,
  closeAllStreamTabs,
  setupGlobalGhostButton,
} from './src/multi-lurk.js';
import { renderStreamsGrid, updateStats } from './src/dashboard.js';
import { renderMonitoredList } from './src/streamers.js';
import { renderExtensionsList } from './src/extensions.js';
import { renderFollowsList, setupFollowsHandlers } from './src/follows.js';
import { renderLeaderboard } from './src/leaderboard.js';
import { populateCalendarFormDays, renderCalendar, setupCalendarHandlers } from './src/calendar.js';
import { setupLoginPortalListeners } from './src/login.js';
import { hydrateSettingsUI, applyServiceToggles, setupSettingsHandlers } from './src/settings.js';
import { startDropsPoller } from './src/drops.js';

const BACKGROUND_CALENDAR_SYNC_DELAY_MS = 5000;
const SCAN_BTN_COOLDOWN_MS = 1500;

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

  window.api.onWatchTimeUpdate((data) => {
    if (state.currentConfig) {
      state.currentConfig.watchTime = data;
      renderLeaderboard();
    }
  });
}

async function init() {
  setupTabs();
  setupGlobalGhostButton();
  setupTopBarHandlers();
  setupAddStreamerForm();
  setupAddExtensionButton();
  setupRefreshWebviewButtons();
  setupSettingsHandlers();
  setupFollowsHandlers();
  setupCalendarHandlers();

  try {
    state.currentConfig = await window.api.getConfig();
    state.activeContainers = await window.api.getActiveContainers();

    hydrateSettingsUI();
    applyServiceToggles();

    renderExtensionsList();

    const initialLogs = await window.api.getRecentLogs();
    initialLogs.forEach(log => appendLogMessage(log));

    updateStats();
    renderLeaderboard();

    populateCalendarFormDays();
    state.platformSchedules = state.currentConfig.syncedCalendarEvents || [];
    renderCalendar();

    setupLoginPortalListeners();
    setupBackendListeners();
    startDropsPoller();

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

window.addEventListener('DOMContentLoaded', init);
