// Account login / re-auth / sign-out cards and the IPC handlers that flip
// connected/disconnected card states.

import { PLATFORMS, state, appendLogMessage } from './state.js';
import { renderFollowsList, getKickLiveFollows } from './follows.js';

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

  document.querySelectorAll('.connect-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
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
          appendLogMessage(`[System] Auto-synced ${res.follows.length} live followed Twitch channels.`);
        }
      } catch (e) {
        appendLogMessage(`[Twitch Sync] Auto-sync follows failed: ${e.message}`);
      }
    } else if (platform === 'kick' && state.currentConfig.kickEnabled !== false) {
      try {
        appendLogMessage('[Kick Sync] Auto-syncing live follows after successful connection...');
        const kickFollows = await getKickLiveFollows();
        state.followsCache.kick = kickFollows;
        renderFollowsList();
        appendLogMessage(`[System] Auto-synced ${kickFollows.length} live followed Kick channels.`);
      } catch (e) {
        appendLogMessage(`[Kick Sync] Auto-sync follows failed: ${e.message}`);
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
