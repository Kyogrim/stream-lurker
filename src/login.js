// Account login / re-auth / sign-out cards and the IPC handlers that flip
// connected/disconnected card states.

import { PLATFORMS, state, appendLogMessage } from './state.js';
import { renderFollowsList } from './follows.js';

function setConnectionUI(platform, connected, username) {
  const disconnectedCard = document.getElementById(`${platform}-disconnected-state`);
  const connectedCard = document.getElementById(`${platform}-connected-state`);
  const usernameSpan = document.getElementById(`${platform}-username-val`);
  if (!disconnectedCard || !connectedCard) return;

  disconnectedCard.style.display = connected ? 'none' : 'flex';
  connectedCard.style.display = connected ? 'flex' : 'none';
  if (connected && username && usernameSpan) usernameSpan.textContent = username;
}

export function setupLoginPortalListeners() {
  if (!state.currentConfig.accounts) state.currentConfig.accounts = {};

  PLATFORMS.forEach(platform => {
    const username = state.currentConfig.accounts[platform];
    setConnectionUI(platform, !!username, username);
  });

  setupTwitchImportModal();
  setupYoutubeImportModal();

  document.querySelectorAll('.connect-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      // Twitch/YouTube block embedded login, so use browser-assisted cookie import.
      if (platform === 'twitch') { openTwitchImportModal(); return; }
      if (platform === 'youtube') { openYoutubeImportModal(); return; }
      btn.disabled = true;
      btn.innerHTML = `<span class="pulse-dot"></span> Connecting...`;
      try {
        await window.api.openLoginModal(platform);
        appendLogMessage(`[System] Connection status request resolved for ${platform.toUpperCase()}.`);
      } catch (err) {
        appendLogMessage(`[ERROR] Connection failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          Connect Account
        `;
      }
    });
  });

  document.querySelectorAll('.login-card .reauth-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      if (platform === 'twitch') { openTwitchImportModal(); return; }
      if (platform === 'youtube') { openYoutubeImportModal(); return; }
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      btn.innerHTML = `<span class="pulse-dot"></span> Re-auth...`;
      appendLogMessage(`[System] Opening re-authentication modal for ${platform.toUpperCase()}...`);
      try {
        await window.api.openLoginModal(platform);
        appendLogMessage(`[System] Re-authentication request resolved for ${platform.toUpperCase()}.`);
      } catch (err) {
        appendLogMessage(`[ERROR] Re-authentication failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    });
  });

  document.querySelectorAll('.login-card .logout-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      btn.disabled = true;
      btn.innerHTML = `<span class="pulse-dot"></span> Purging...`;
      appendLogMessage(`[System] Signing out of ${platform.toUpperCase()}...`);
      try {
        await window.api.logoutPlatform(platform);

        delete state.currentConfig.accounts[platform];
        if (platform === 'twitch' || platform === 'kick') {
          state.followsCache[platform] = [];
          renderFollowsList();
        }
        setConnectionUI(platform, false);

        appendLogMessage(`[System] Successfully disconnected ${platform.toUpperCase()} account.`);
      } catch (err) {
        appendLogMessage(`[ERROR] Sign out failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg class="btn-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          Sign Out
        `;
      }
    });
  });

  window.api.onLoginSuccess(async ({ platform, username }) => {
    appendLogMessage(`[System] Received successful login signal for ${platform.toUpperCase()} (${username}). Updating cards...`);
    if (!state.currentConfig.accounts) state.currentConfig.accounts = {};
    state.currentConfig.accounts[platform] = username;
    setConnectionUI(platform, true, username);

    if (platform === 'twitch' && state.currentConfig.twitchEnabled !== false) {
      try {
        appendLogMessage('[Twitch Sync] Auto-syncing live follows after successful connection...');
        const res = await window.api.getTwitchFollows();
        if (res.success) {
          state.followsCache.twitch = res.follows;
          renderFollowsList();
          if (res.username && state.currentConfig.accounts.twitch !== res.username) {
            state.currentConfig.accounts.twitch = res.username;
            setConnectionUI('twitch', true, res.username);
          }
          appendLogMessage(`[System] Auto-synced ${res.follows.length} live followed Twitch channels.`);
        }
      } catch (e) {
        appendLogMessage(`[Twitch Sync] Auto-sync follows failed: ${e.message}`);
      }
    }
  });

  window.api.onSessionExpired(({ platform }) => {
    appendLogMessage(`[Auth] Session expired for ${platform.toUpperCase()}. Marking as disconnected.`);
    if (state.currentConfig.accounts) delete state.currentConfig.accounts[platform];
    if (platform === 'twitch' || platform === 'kick') {
      state.followsCache[platform] = [];
      renderFollowsList();
    }
    setConnectionUI(platform, false);
  });
}

// ── Browser-assisted Twitch login modal ──────────────────────────────────────
function openTwitchImportModal() {
  const overlay = document.getElementById('twitch-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('ti-token-input');
  const status = document.getElementById('ti-status');
  if (input) input.value = '';
  if (status) { status.textContent = ''; status.className = 'ti-status'; }
  overlay.style.display = 'flex';
  setTimeout(() => input?.focus(), 50);
}

function closeTwitchImportModal() {
  const overlay = document.getElementById('twitch-import-overlay');
  if (overlay) overlay.style.display = 'none';
}

function setupTwitchImportModal() {
  const overlay = document.getElementById('twitch-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('ti-token-input');
  const status = document.getElementById('ti-status');
  const importBtn = document.getElementById('ti-import');

  document.getElementById('ti-open-twitch')?.addEventListener('click', () => {
    window.api.openExternal('https://www.twitch.tv/login');
  });
  document.getElementById('ti-cancel')?.addEventListener('click', closeTwitchImportModal);
  document.getElementById('ti-close')?.addEventListener('click', closeTwitchImportModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTwitchImportModal(); });

  const doImport = async () => {
    const token = (input?.value || '').trim();
    if (!token) {
      if (status) { status.textContent = 'Paste your auth-token first.'; status.className = 'ti-status error'; }
      return;
    }
    if (status) { status.textContent = 'Verifying with Twitch…'; status.className = 'ti-status pending'; }
    if (importBtn) importBtn.disabled = true;
    try {
      const res = await window.api.setTwitchToken(token);
      if (res?.success) {
        if (status) { status.textContent = `Connected as ${res.username}!`; status.className = 'ti-status ok'; }
        appendLogMessage(`[System] Twitch connected as ${res.username} via browser import.`);
        // main also emits 'login-success', which updates the card and syncs follows.
        setTimeout(closeTwitchImportModal, 900);
      } else {
        if (status) { status.textContent = res?.error || 'Import failed.'; status.className = 'ti-status error'; }
      }
    } catch (err) {
      if (status) { status.textContent = err.message; status.className = 'ti-status error'; }
    } finally {
      if (importBtn) importBtn.disabled = false;
    }
  };

  importBtn?.addEventListener('click', doImport);
  // Ctrl/Cmd+Enter submits (plain Enter inserts a newline in the textarea).
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doImport(); });
}

// ── Browser-assisted YouTube login modal ─────────────────────────────────────
function openYoutubeImportModal() {
  const overlay = document.getElementById('youtube-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('yti-input');
  const status = document.getElementById('yti-status');
  if (input) input.value = '';
  if (status) { status.textContent = ''; status.className = 'ti-status'; }
  overlay.style.display = 'flex';
  setTimeout(() => input?.focus(), 50);
}

function closeYoutubeImportModal() {
  const overlay = document.getElementById('youtube-import-overlay');
  if (overlay) overlay.style.display = 'none';
}

function setupYoutubeImportModal() {
  const overlay = document.getElementById('youtube-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('yti-input');
  const status = document.getElementById('yti-status');
  const importBtn = document.getElementById('yti-import');

  document.getElementById('yti-open-yt')?.addEventListener('click', () => {
    window.api.openExternal('https://www.youtube.com/');
  });
  document.getElementById('yti-cancel')?.addEventListener('click', closeYoutubeImportModal);
  document.getElementById('yti-close')?.addEventListener('click', closeYoutubeImportModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeYoutubeImportModal(); });

  const doImport = async () => {
    const blob = (input?.value || '').trim();
    if (!blob) {
      if (status) { status.textContent = 'Paste your exported cookies first.'; status.className = 'ti-status error'; }
      return;
    }
    if (status) { status.textContent = 'Importing session…'; status.className = 'ti-status pending'; }
    if (importBtn) importBtn.disabled = true;
    try {
      const res = await window.api.setGoogleCookies(blob);
      if (res?.success) {
        const msg = res.verified
          ? `Connected! (${res.cookiesSet} cookies, verified)`
          : `Imported ${res.cookiesSet} cookies — open a YouTube stream to confirm.`;
        if (status) { status.textContent = msg; status.className = 'ti-status ok'; }
        appendLogMessage(`[System] YouTube session imported (${res.cookiesSet} cookies, verified: ${!!res.verified}).`);
        setTimeout(closeYoutubeImportModal, 1100);
      } else {
        if (status) { status.textContent = res?.error || 'Import failed.'; status.className = 'ti-status error'; }
      }
    } catch (err) {
      if (status) { status.textContent = err.message; status.className = 'ti-status error'; }
    } finally {
      if (importBtn) importBtn.disabled = false;
    }
  };

  importBtn?.addEventListener('click', doImport);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doImport(); });
}
