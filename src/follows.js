// Sync live followed channels from Twitch (via main process) and Kick (via
// background webview scrape).

import { state, appendLogMessage } from './state.js';
import { kickLiveFollowsScript } from './inject.js';
import { renderMonitoredList } from './streamers.js';
import { updateStats } from './dashboard.js';

const KICK_SCRAPE_TIMEOUT_MS = 20000;

let kickFollowsInFlight = null;

// Single-flight Kick follows scrape with safety timeout so a stuck webview
// load never leaves a dangling did-stop-loading listener.
export function getKickLiveFollows() {
  if (kickFollowsInFlight) return kickFollowsInFlight;

  kickFollowsInFlight = new Promise((resolve) => {
    const webview = document.getElementById('kick-login-webview');
    if (!webview) {
      kickFollowsInFlight = null;
      return resolve([]);
    }

    appendLogMessage('[Kick Sync] Initiating Kick live follows extraction...');

    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
      webview.removeEventListener('did-stop-loading', onLoad);
      if (timeoutId) clearTimeout(timeoutId);
      kickFollowsInFlight = null;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { webview.loadURL('about:blank'); } catch {}
      resolve(result);
    };

    const onLoad = async () => {
      const url = webview.getURL();
      if (!url.includes('kick.com')) return;
      try {
        const data = await webview.executeJavaScript(kickLiveFollowsScript);
        appendLogMessage(`[Kick Sync] Extraction complete. Found ${data ? data.length : 0} live channels.`);
        finish(data || []);
      } catch (err) {
        appendLogMessage(`[Kick Sync] Webview execution failed: ${err.message}`);
        finish([]);
      }
    };

    timeoutId = setTimeout(() => {
      appendLogMessage('[Kick Sync] Extraction timed out.');
      finish([]);
    }, KICK_SCRAPE_TIMEOUT_MS);

    webview.addEventListener('did-stop-loading', onLoad);

    webview.style.display = 'block';
    webview.style.opacity = '0';
    webview.style.height = '0px';
    webview.style.width = '0px';
    webview.style.position = 'absolute';

    webview.loadURL('https://kick.com/');
  });

  return kickFollowsInFlight;
}

export function renderFollowsList() {
  const host = document.getElementById('follows-list-container');
  if (!host) return;
  host.innerHTML = '';

  const list = state.followsCache[state.activeFollowsTab] || [];
  if (list.length === 0) {
    host.innerHTML = `
      <div class="no-follows-message" style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 15px 0; width: 100%;">
        No live channels discovered for ${state.activeFollowsTab.toUpperCase()}. Click Scan Live or ensure you are logged in.
      </div>
    `;
    return;
  }

  list.forEach(username => {
    const isMonitored = state.currentConfig.streamers.some(
      s => s.platform.toLowerCase() === state.activeFollowsTab && s.username.toLowerCase() === username.toLowerCase()
    );

    const item = document.createElement('div');
    item.className = 'follows-sync-item';
    item.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      background-color: hsla(240, 5.9%, 15%, 0.15);
      border: 1px solid var(--panel-border);
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      transition: var(--transition);
    `;
    item.innerHTML = `
      <span style="font-size: 0.82rem; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
        <span class="live-pulse-dot" style="width: 8px; height: 8px; background-color: var(--danger-color); border-radius: 50%; display: inline-block; box-shadow: 0 0 5px var(--danger-color);"></span>
        ${username}
      </span>
      <button class="btn btn-sm ${isMonitored ? 'btn-monitored' : 'btn-cyan'}" style="font-size: 0.65rem; padding: 4px 8px; border-radius: var(--radius-sm);" ${isMonitored ? 'disabled' : ''}>
        ${isMonitored ? 'Monitored' : '[+] Add to Lurk'}
      </button>
    `;

    if (!isMonitored) {
      item.querySelector('button').addEventListener('click', async () => {
        const res = await window.api.addStreamer(state.activeFollowsTab, username);
        if (res.success) {
          state.currentConfig.streamers = res.streamers;
          renderMonitoredList();
          updateStats();
          renderFollowsList();
          appendLogMessage(`[System] Added streamer: ${username} from ${state.activeFollowsTab.toUpperCase()} follows.`);
        }
      });
    }

    host.appendChild(item);
  });
}

// Programmatic version of switching tabs that does not rely on .click() to
// avoid surprise re-entrancy when other modules call this from layout code.
export function setActiveFollowsTab(platform) {
  state.activeFollowsTab = platform;
  document.querySelectorAll('.follows-tab-btn').forEach(b => {
    const isActive = b.dataset.platform === platform;
    b.classList.toggle('active', isActive);
    b.style.color = isActive
      ? (platform === 'twitch' ? 'var(--twitch-color)' : 'var(--kick-color)')
      : 'var(--text-muted)';
    b.style.borderBottomColor = isActive
      ? (platform === 'twitch' ? 'var(--twitch-color)' : 'var(--kick-color)')
      : 'transparent';
  });
  renderFollowsList();
}

export function setupFollowsHandlers() {
  const syncBtn = document.getElementById('sync-follows-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.innerHTML = `<span class="pulse-dot"></span> Scanning...`;
      appendLogMessage('[System] Synchronizing followed live channels...');
      try {
        const promises = [];
        if (state.currentConfig.twitchEnabled !== false) {
          promises.push((async () => {
            appendLogMessage('[Twitch Sync] Fetching live followed channels...');
            const res = await window.api.getTwitchFollows();
            if (res.success) {
              state.followsCache.twitch = res.follows;
              if (res.username && state.currentConfig.accounts) {
                state.currentConfig.accounts.twitch = res.username;
                const usernameSpan = document.getElementById('twitch-username-val');
                if (usernameSpan) usernameSpan.textContent = res.username;
              }
              appendLogMessage(`[System] Synced ${res.follows.length} LIVE channels from Twitch follows list.`);
            } else {
              appendLogMessage(`[Twitch Sync] Secure GQL sync failed: ${res.error || 'Unknown error'}`);
            }
          })());
        }
        if (state.currentConfig.kickEnabled !== false) {
          promises.push((async () => {
            const kickFollows = await getKickLiveFollows();
            state.followsCache.kick = kickFollows;
            appendLogMessage(`[System] Synced ${kickFollows.length} LIVE channels from Kick follows list.`);
          })());
        }
        await Promise.all(promises);
        appendLogMessage('[System] Sync complete. Rendering results...');
        renderFollowsList();
      } catch (err) {
        appendLogMessage(`[ERROR] Follows sync failed: ${err.message}`);
      } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; margin-right: 6px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Scan Live Channels`;
      }
    });
  }

  document.querySelectorAll('.follows-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveFollowsTab(btn.dataset.platform));
  });
}
