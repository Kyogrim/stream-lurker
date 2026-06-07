// Settings panel: hydrate inputs from config, save changes, and re-apply
// platform service toggles to the rest of the UI.

import { PLATFORMS, state, appendLogMessage } from './state.js';
import { renderMonitoredList } from './streamers.js';
import { renderStreamsGrid, updateStats } from './dashboard.js';
import { renderFollowsList, setActiveFollowsTab } from './follows.js';

const DEFAULT_MAX_TABS = 2;

// Platforms that are not yet available — locked off in the UI ("Coming Soon")
// and force-disabled regardless of saved config so a stale rumbleEnabled:true
// can't re-enable them.
const LOCKED_PLATFORMS = ['rumble'];

// Pairs settings sliders with their value displays for hydration + live update.
const SLIDER_PAIRS = [
  { id: 'interval-slider', display: 'interval-display-val', configKey: 'checkInterval' },
  { id: 'max-twitch-tabs-slider', display: 'max-twitch-tabs-display-val', configKey: 'maxTwitchTabs', defaultVal: DEFAULT_MAX_TABS },
  { id: 'max-kick-tabs-slider', display: 'max-kick-tabs-display-val', configKey: 'maxKickTabs', defaultVal: DEFAULT_MAX_TABS },
  { id: 'max-youtube-tabs-slider', display: 'max-youtube-tabs-display-val', configKey: 'maxYoutubeTabs', defaultVal: DEFAULT_MAX_TABS },
  { id: 'max-rumble-tabs-slider', display: 'max-rumble-tabs-display-val', configKey: 'maxRumbleTabs', defaultVal: DEFAULT_MAX_TABS },
];

export function hydrateSettingsUI() {
  const cfg = state.currentConfig;
  if (!cfg) return;

  for (const { id, display, configKey, defaultVal } of SLIDER_PAIRS) {
    const slider = document.getElementById(id);
    const displayEl = document.getElementById(display);
    if (!slider || !displayEl) continue;
    const val = cfg[configKey] ?? defaultVal ?? '';
    slider.value = val;
    displayEl.textContent = val;
  }

  const autoOpenToggle = document.getElementById('auto-open-toggle');
  if (autoOpenToggle) autoOpenToggle.checked = !!cfg.autoOpen;

  for (const p of PLATFORMS) {
    const toggle = document.getElementById(`${p}-enabled-toggle`);
    if (!toggle) continue;
    if (LOCKED_PLATFORMS.includes(p)) {
      // Force locked platforms off and keep the toggle disabled.
      cfg[`${p}Enabled`] = false;
      toggle.checked = false;
      toggle.disabled = true;
    } else {
      toggle.checked = cfg[`${p}Enabled`] !== false;
    }
  }

  const twitchClientId = document.getElementById('twitch-client-id');
  const twitchClientSecret = document.getElementById('twitch-client-secret');
  if (twitchClientId) twitchClientId.value = cfg.twitchClientId || '';
  if (twitchClientSecret) twitchClientSecret.value = cfg.twitchClientSecret || '';

  const qualitySelect = document.getElementById('quality-select');
  if (qualitySelect) qualitySelect.value = cfg.defaultQuality || '160p';

  const autoClaimPointsToggle = document.getElementById('auto-claim-points-toggle');
  if (autoClaimPointsToggle) autoClaimPointsToggle.checked = cfg.autoClaimPoints !== false;
}

export function applyServiceToggles() {
  const cfg = state.currentConfig;
  if (!cfg) return;
  const on = Object.fromEntries(PLATFORMS.map(p => [p, cfg[`${p}Enabled`] !== false]));

  // 1. Manage Streamers radio options.
  for (const p of PLATFORMS) {
    document.querySelector(`.platform-option.${p}-opt`)?.classList.toggle('hidden', !on[p]);
  }
  const checkedRadio = document.querySelector('input[name="platform"]:checked');
  if (checkedRadio && !on[checkedRadio.value]) {
    const firstEnabled = PLATFORMS.find(p => on[p]);
    if (firstEnabled) {
      const targetRadio = document.querySelector(`input[name="platform"][value="${firstEnabled}"]`);
      if (targetRadio) targetRadio.checked = true;
    }
  }

  // 2. Platform Logins cards.
  for (const p of PLATFORMS) {
    document.querySelector(`.login-card.${p}-login-card`)?.classList.toggle('hidden', !on[p]);
  }

  // 3. Leaderboard legend rows.
  for (const p of PLATFORMS) {
    document.querySelector(`.legend-${p}`)?.classList.toggle('hidden', !on[p]);
  }

  // 4. Follows panel tabs (only twitch & kick).
  const followsTwitchTabBtn = document.querySelector('.follows-tab-btn[data-platform="twitch"]');
  const followsKickTabBtn = document.querySelector('.follows-tab-btn[data-platform="kick"]');
  const followsPanel = document.querySelector('.follows-import-panel');

  followsTwitchTabBtn?.classList.toggle('hidden', !on.twitch);
  followsKickTabBtn?.classList.toggle('hidden', !on.kick);
  followsPanel?.classList.toggle('hidden', !on.twitch && !on.kick);

  // Fall back to the other tab if the active one was just disabled.
  if (!on.twitch && state.activeFollowsTab === 'twitch' && on.kick) {
    setActiveFollowsTab('kick');
  } else if (!on.kick && state.activeFollowsTab === 'kick' && on.twitch) {
    setActiveFollowsTab('twitch');
  }

  renderMonitoredList();
  renderStreamsGrid();
  updateStats();
}

export function setupSettingsHandlers() {
  const cfg = () => state.currentConfig;

  // Auto-open toggle.
  const autoOpenToggle = document.getElementById('auto-open-toggle');
  autoOpenToggle?.addEventListener('change', async () => {
    cfg().autoOpen = autoOpenToggle.checked;
    await window.api.saveConfig(cfg());
    appendLogMessage(`[System] Auto-open active streams is now ${cfg().autoOpen ? 'ENABLED' : 'DISABLED'}.`);
  });

  // Slider live displays.
  for (const { id, display } of SLIDER_PAIRS) {
    const slider = document.getElementById(id);
    const displayEl = document.getElementById(display);
    if (!slider || !displayEl) continue;
    slider.addEventListener('input', () => { displayEl.textContent = slider.value; });
  }

  // Save General settings.
  const saveGeneralSettingsBtn = document.getElementById('save-general-settings');
  const generalSettingsSuccess = document.getElementById('general-settings-success');
  saveGeneralSettingsBtn?.addEventListener('click', async () => {
    const c = cfg();
    for (const { id, configKey } of SLIDER_PAIRS) {
      const slider = document.getElementById(id);
      if (slider) c[configKey] = parseInt(slider.value, 10);
    }
    for (const p of PLATFORMS) {
      if (LOCKED_PLATFORMS.includes(p)) { c[`${p}Enabled`] = false; continue; }
      const toggle = document.getElementById(`${p}-enabled-toggle`);
      if (toggle) c[`${p}Enabled`] = toggle.checked;
    }
    const qualitySelect = document.getElementById('quality-select');
    if (qualitySelect) c.defaultQuality = qualitySelect.value;

    await window.api.saveConfig(c);
    applyServiceToggles();

    if (generalSettingsSuccess) {
      generalSettingsSuccess.classList.remove('hidden');
      setTimeout(() => generalSettingsSuccess.classList.add('hidden'), 3000);
    }
  });

  // Save Twitch credentials.
  const saveTwitchSettingsBtn = document.getElementById('save-twitch-settings');
  const twitchSettingsSuccess = document.getElementById('twitch-settings-success');
  saveTwitchSettingsBtn?.addEventListener('click', async () => {
    cfg().twitchClientId = document.getElementById('twitch-client-id').value.trim();
    cfg().twitchClientSecret = document.getElementById('twitch-client-secret').value.trim();
    await window.api.saveConfig(cfg());
    if (twitchSettingsSuccess) {
      twitchSettingsSuccess.classList.remove('hidden');
      setTimeout(() => twitchSettingsSuccess.classList.add('hidden'), 3000);
    }
  });

  // Channel Points toggle.
  const autoClaimPointsToggle = document.getElementById('auto-claim-points-toggle');
  autoClaimPointsToggle?.addEventListener('change', () => {
    cfg().autoClaimPoints = autoClaimPointsToggle.checked;
    window.api.saveConfig(cfg());
    appendLogMessage(`[Rewards] Auto-claim Channel Points set to: ${autoClaimPointsToggle.checked}`);
  });
}
