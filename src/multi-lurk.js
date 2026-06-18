// Multi-Lurk grid: in-app stream tabs and grid cells.
// Each lurked stream has (1) a sidebar tab button and (2) a webview cell in
// the grid. createStreamTab builds both; removeStreamTab tears them down.

import { state, getPlatformSVG, streamUrl, appendLogMessage } from './state.js';
import { switchTab } from './tabs.js';
import {
  qualityAndTheaterScript,
  ghostSuspendScript,
  ghostResumeScript,
} from './inject.js';

// Render the webview at a fixed 1280x720 so platform sites keep their desktop
// layout, then uniformly scale + center it in the cell to preserve 16:9.
const webviewResizeObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    const container = entry.target;
    const webview = container.querySelector('webview');
    if (!webview) continue;
    const { width: w, height: h } = entry.contentRect;
    if (w <= 0 || h <= 0) continue;

    const scale = Math.min(w / 1280, h / 720);
    const scaledW = 1280 * scale;
    const scaledH = 720 * scale;

    webview.style.width = '1280px';
    webview.style.height = '720px';
    webview.style.transform = `scale(${scale})`;
    webview.style.transformOrigin = 'top left';
    webview.style.position = 'absolute';
    webview.style.left = `${(w - scaledW) / 2}px`;
    webview.style.top = `${(h - scaledH) / 2}px`;
  }
});

export function updateGridLayout() {
  const gridContainer = document.getElementById('multi-lurk-grid');
  if (!gridContainer) return;

  const cells = gridContainer.querySelectorAll('.stream-grid-cell');
  const visibleCells = Array.from(cells).filter(c => !c.classList.contains('excluded-from-grid'));
  const visibleCount = visibleCells.length;
  const totalCount = cells.length;

  gridContainer.dataset.streams = visibleCount;

  let placeholder = gridContainer.querySelector('.grid-empty-placeholder');
  if (visibleCount === 0 && totalCount > 0) {
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'grid-empty-placeholder';
      placeholder.innerHTML = `
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="7" height="9"/>
          <rect x="14" y="3" width="7" height="5"/>
          <rect x="14" y="12" width="7" height="9"/>
          <rect x="3" y="16" width="7" height="5"/>
        </svg>
        <h3>No streams in the grid viewspace</h3>
        <p>Toggle the grid icon next to each active stream in the sidebar to add them to your split-screen grid view space.</p>
      `;
      gridContainer.appendChild(placeholder);
    }
  } else if (placeholder) {
    placeholder.remove();
  }

  const tabBtn = document.getElementById('multi-lurk-tab-btn');
  const badge = tabBtn?.querySelector('.active-streams-badge');
  if (badge) badge.textContent = `[${visibleCount}/${totalCount}]`;
}

export function updateGlobalGhostButtonState() {
  const globalGhostBtn = document.getElementById('global-ghost-btn');
  if (!globalGhostBtn) return;

  const cells = document.querySelectorAll('#multi-lurk-grid .stream-grid-cell');
  if (cells.length === 0) {
    globalGhostBtn.classList.remove('active');
    globalGhostBtn.title = 'Toggle Ghost Mode (Decoder Suspension) for All Streams';
    return;
  }

  const allGhost = Array.from(cells).every(c => c.dataset.ghostMode === 'true');
  globalGhostBtn.classList.toggle('active', allGhost);
  globalGhostBtn.title = allGhost
    ? 'Disable Ghost Mode for All Streams'
    : 'Enable Ghost Mode for All Streams';
}

export function setupGlobalGhostButton() {
  const globalGhostBtn = document.getElementById('global-ghost-btn');
  if (!globalGhostBtn) return;
  globalGhostBtn.addEventListener('click', () => {
    const cells = document.querySelectorAll('#multi-lurk-grid .stream-grid-cell');
    if (cells.length === 0) return;

    const hasNormalStream = Array.from(cells).some(c => c.dataset.ghostMode !== 'true');
    const targetGhostState = hasNormalStream;

    cells.forEach(cell => {
      const isGhostActive = cell.dataset.ghostMode === 'true';
      if (isGhostActive !== targetGhostState) {
        cell.querySelector('.ghost-mode-btn')?.click();
      }
    });

    updateGlobalGhostButtonState();
  });
}

export function syncActiveTabs() {
  const cells = document.querySelectorAll('#multi-lurk-grid .stream-grid-cell');
  const tabsList = Array.from(cells).map(c => `${c.dataset.platform.toLowerCase()}:${c.dataset.username.toLowerCase()}`);
  window.api.updateActiveTabs(tabsList);
}

function ensureMultiLurkButton() {
  let btn = document.getElementById('multi-lurk-tab-btn');
  if (btn) return btn;

  btn = document.createElement('button');
  btn.id = 'multi-lurk-tab-btn';
  btn.className = 'nav-btn stream-tab-btn';
  btn.dataset.tab = 'multi-lurk';
  btn.title = 'Watch Active Streams in Split-Screen Grid';
  btn.innerHTML = `
    <div class="platform-badge" style="background-color: var(--cyan-color); display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%;">
      <svg class="badge-logo" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="color: #fff;">
        <rect x="3" y="3" width="7" height="9"/>
        <rect x="14" y="3" width="7" height="5"/>
        <rect x="14" y="12" width="7" height="9"/>
        <rect x="3" y="16" width="7" height="5"/>
      </svg>
    </div>
    <span style="font-weight: 700;">Multi-Lurk Grid</span>
    <span class="active-streams-badge" style="margin-left: auto; background-color: var(--cyan-glow); color: var(--cyan-color); font-size: 0.75rem; padding: 2px 6px; border-radius: 10px; font-weight: 700; border: 1px solid var(--cyan-color);">[0/0]</span>
  `;
  btn.addEventListener('click', () => switchTab('multi-lurk'));

  const sidebarTabsContainer = document.getElementById('active-lurk-tabs');
  sidebarTabsContainer.insertBefore(btn, sidebarTabsContainer.firstChild);
  return btn;
}

function buildCellHTML(platform, username, isQualityDisabled) {
  const p = platform.toLowerCase();
  return `
    <div class="stream-cell-header">
      <div class="stream-cell-identity">
        <div class="platform-badge ${p}">${getPlatformSVG(p)}</div>
        <span class="stream-cell-name">${username}</span>
      </div>
      <div class="stream-cell-actions">
        <button class="cell-action-btn chat-popout-btn" title="Open chat in your browser (sign in there to chat)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
        <button class="cell-action-btn popout-btn" title="Pop out into a floating Picture-in-Picture window">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="14" rx="2"/>
            <rect x="12" y="10" width="7" height="6" rx="1"/>
          </svg>
        </button>
        <button class="cell-action-btn quality-toggle-btn ${isQualityDisabled ? '' : 'active'}" title="${isQualityDisabled ? 'Enable Auto Quality (Currently: Native Quality)' : 'Disable Auto Quality (Currently: Auto Quality Active)'}">
          <svg class="quality-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.5 1z"/>
          </svg>
        </button>
        <button class="cell-action-btn ghost-mode-btn" title="Enable Ghost Mode (Suspend Video Decoding to Save CPU)">
          <svg class="ghost-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: block;">
            <path d="M9 18v-6a3 3 0 0 1 6 0v6"/>
            <path d="M12 2a9 9 0 0 0-9 9v9c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-9a9 9 0 0 0-9-9z"/>
            <circle cx="9" cy="11" r="1"/>
            <circle cx="15" cy="11" r="1"/>
            <path d="M12 15a1 1 0 0 0 1-1h-2a1 1 0 0 0 1 1z"/>
          </svg>
        </button>
        <button class="cell-action-btn reload-btn" title="Reload Stream">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
        </button>
        <button class="cell-action-btn move-left-btn" title="Move Stream Left/Up">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <button class="cell-action-btn move-right-btn" title="Move Stream Right/Down">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
        <button class="cell-action-btn mute-btn muted" title="Unmute Audio">
          <svg class="speaker-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path class="volume-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        </button>
        <button class="cell-action-btn close-btn" title="Close Lurk Stream">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="stream-cell-webview-container">
      <webview src="${streamUrl(platform, username, state.currentStatuses.find(s => s.platform.toLowerCase() === p && s.username.toLowerCase() === username.toLowerCase()))}" partition="persist:default" allowpopups muted></webview>
    </div>
  `;
}

// Build the URL we open in the user's DEFAULT browser so they can chat while
// signed in (embedded login is blocked by Google/Twitch anti-bot). For Twitch we
// use the dedicated chat-only popout; for YouTube we extract the live video id
// from the embedded webview's current URL to open the chat-only popout, falling
// back to the live watch page. Kick/Rumble open the channel page where chat is
// inline and the user can type once logged in.
function chatPopoutUrl(platform, username, webview) {
  const p = platform.toLowerCase();
  const u = username.toLowerCase();
  switch (p) {
    case 'twitch':
      return `https://www.twitch.tv/popout/${u}/chat`;
    case 'youtube': {
      try {
        const current = webview.getURL() || '';
        const m = current.match(/[?&]v=([\w-]{11})/)
          || current.match(/\/live\/([\w-]{11})/)
          || current.match(/youtu\.be\/([\w-]{11})/);
        if (m) return `https://www.youtube.com/live_chat?v=${m[1]}&is_popout=1`;
      } catch (e) { /* fall through */ }
      return `https://www.youtube.com/${u.startsWith('@') ? u : '@' + u}/live`;
    }
    case 'kick':
      return `https://kick.com/${u}`;
    case 'rumble':
      try { return webview.getURL() || `https://rumble.com/c/${u}`; }
      catch (e) { return `https://rumble.com/c/${u}`; }
    default:
      return '';
  }
}

function bindCellActions(cell, platform, username) {
  const p = platform.toLowerCase();
  const u = username.toLowerCase();
  const key = `${p}:${u}`;
  // Look up the grid container lazily — `cell` isn't attached yet at bind time.
  const grid = () => document.getElementById('multi-lurk-grid');

  const webview = cell.querySelector('webview');
  const muteBtn = cell.querySelector('.mute-btn');
  const qualityToggleBtn = cell.querySelector('.quality-toggle-btn');
  const ghostBtn = cell.querySelector('.ghost-mode-btn');
  const reloadBtn = cell.querySelector('.reload-btn');
  const moveLeftBtn = cell.querySelector('.move-left-btn');
  const moveRightBtn = cell.querySelector('.move-right-btn');
  const closeBtn = cell.querySelector('.close-btn');
  const chatPopoutBtn = cell.querySelector('.chat-popout-btn');
  const popoutBtn = cell.querySelector('.popout-btn');

  const container = cell.querySelector('.stream-cell-webview-container');
  if (container) webviewResizeObserver.observe(container);

  webview.addEventListener('console-message', (e) => {
    if (e.message.includes('[Kick Quality]')) {
      appendLogMessage(`[Quality - ${username}] ${e.message.replace('[Kick Quality] ', '')}`);
    }
    if (e.message.includes('[Twitch Theater] Need Alt+T')) {
      try {
        webview.focus();
        webview.sendInputEvent({ type: 'keyDown', keyCode: 't', modifiers: ['alt'] });
        webview.sendInputEvent({ type: 'keyUp', keyCode: 't', modifiers: ['alt'] });

        const now = Date.now();
        if (!webview.__lastAltTLog || now - webview.__lastAltTLog > 15000) {
          webview.__lastAltTLog = now;
          appendLogMessage(`[Lurk] Sent native Alt+T keyboard shortcut to maximize Twitch player for ${username}.`);
        }
      } catch (err) {
        console.error('Failed to send native Alt+T keypress:', err);
      }
    }
  });

  webview.addEventListener('dom-ready', () => {
    webview.setAudioMuted(true);

    const url = webview.getURL();
    if (!url || (!url.includes('twitch.tv') && !url.includes('kick.com') && !url.includes('youtube.com'))) return;

    const disabled = cell.dataset.autoQualityDisabled === 'true';
    webview.executeJavaScript(`window.__autoQualityDisabled = ${disabled};`).catch(err => console.error(err));

    const quality = state.currentConfig?.defaultQuality || '160p';
    webview.executeJavaScript(qualityAndTheaterScript(quality))
      .catch(err => console.error('Failed to inject quality script:', err));
  });

  qualityToggleBtn.addEventListener('click', () => {
    const newActive = !qualityToggleBtn.classList.contains('active');
    qualityToggleBtn.classList.toggle('active', newActive);
    qualityToggleBtn.title = newActive
      ? 'Disable Auto Quality (Currently: Auto Quality Active)'
      : 'Enable Auto Quality (Currently: Native Quality)';
    cell.dataset.autoQualityDisabled = newActive ? 'false' : 'true';

    webview.executeJavaScript(`window.__autoQualityDisabled = ${!newActive};`).catch(err => console.error(err));

    if (!state.currentConfig.disabledAutoQuality) state.currentConfig.disabledAutoQuality = {};
    if (newActive) {
      delete state.currentConfig.disabledAutoQuality[key];
    } else {
      state.currentConfig.disabledAutoQuality[key] = true;
    }
    window.api.saveConfig(state.currentConfig);
    appendLogMessage(`[Quality] ${newActive ? 'Re-enabled' : 'Disabled'} auto-quality adjustment for ${username}.`);
  });

  muteBtn.addEventListener('click', () => {
    const newMuted = !webview.isAudioMuted();
    webview.setAudioMuted(newMuted);
    muteBtn.classList.toggle('muted', newMuted);
    muteBtn.title = newMuted ? 'Unmute Audio' : 'Mute Audio';
  });

  reloadBtn.addEventListener('click', () => {
    appendLogMessage(`[Lurk] Reloading active container: ${username} on ${platform.toUpperCase()}`);
    webview.reload();
  });

  chatPopoutBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = chatPopoutUrl(platform, username, webview);
    if (!url) return;
    window.api.openExternal(url);
    appendLogMessage(`[Chat] Opened ${platform.toUpperCase()} chat for ${username} in your browser. Sign in there to send messages.`);
  });

  popoutBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    let url = '';
    try { url = webview.getURL() || ''; } catch (err) { /* webview not ready */ }
    window.api.popoutStream(platform, username, url);
    popoutBtn.classList.add('active');
    popoutBtn.title = 'Pop-out window open (click to re-focus it)';
    cell.dataset.poppedOut = 'true';

    // Suspend the in-grid copy so we aren't decoding the same stream twice.
    // Mark it as auto-ghosted so we only resume it (not a manually-ghosted cell)
    // when the pop-out window closes.
    let note = '';
    if (cell.dataset.ghostMode !== 'true') {
      cell.dataset.autoGhostedByPopout = 'true';
      ghostBtn?.click();
      note = ' (grid copy suspended to save CPU)';
    }
    appendLogMessage(`[Pop-out] Opened ${username} (${platform.toUpperCase()}) in a floating window${note}.`);
  });

  moveLeftBtn.addEventListener('click', () => {
    const prev = cell.previousElementSibling;
    const g = grid();
    if (prev?.classList.contains('stream-grid-cell') && g) {
      g.insertBefore(cell, prev);
      updateGridLayout();
    }
  });

  moveRightBtn.addEventListener('click', () => {
    const next = cell.nextElementSibling;
    const g = grid();
    if (next?.classList.contains('stream-grid-cell') && g) {
      g.insertBefore(cell, next.nextSibling);
      updateGridLayout();
    }
  });

  closeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.closeStreamContainer(platform, username);
  });

  ghostBtn.addEventListener('click', () => {
    const newGhostState = cell.dataset.ghostMode !== 'true';
    cell.dataset.ghostMode = newGhostState ? 'true' : 'false';
    ghostBtn.classList.toggle('active', newGhostState);
    ghostBtn.title = newGhostState
      ? 'Disable Ghost Mode (Resume Video Decoding)'
      : 'Enable Ghost Mode (Suspend Video Decoding to Save CPU)';
    if (newGhostState) cell.setAttribute('data-ghost-mode', 'true');
    else cell.removeAttribute('data-ghost-mode');

    webview.executeJavaScript(newGhostState ? ghostSuspendScript : ghostResumeScript).catch(err => console.error(err));
    appendLogMessage(`[Ghost Mode] ${newGhostState ? 'Activated background decoder suspension' : 'Deactivated suspension'} for ${username}.`);

    updateGlobalGhostButtonState();
  });
}

function buildSidebarTabButton(platform, username, tabId, cellId) {
  const p = platform.toLowerCase();

  const tabBtn = document.createElement('div');
  tabBtn.className = `nav-btn stream-tab-btn ${p}-tab`;
  tabBtn.dataset.tab = tabId;
  tabBtn.title = `Watch ${username} on ${platform.toUpperCase()}`;
  tabBtn.style.cursor = 'pointer';

  tabBtn.innerHTML = `
    <button class="grid-toggle-btn included" title="Toggle Grid Visibility">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="7" height="9"/>
        <rect x="14" y="3" width="7" height="5"/>
        <rect x="14" y="12" width="7" height="9"/>
        <rect x="3" y="16" width="7" height="5"/>
      </svg>
    </button>
    <div class="platform-badge ${p}">${getPlatformSVG(p)}</div>
    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px; font-weight: 500;">${username}</span>
    <button class="stream-tab-close" title="Close Lurk Stream">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  const gridToggle = tabBtn.querySelector('.grid-toggle-btn');
  gridToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const cellElement = document.getElementById(cellId);
    if (!cellElement) return;
    const isIncluded = gridToggle.classList.contains('included');
    gridToggle.classList.toggle('included', !isIncluded);
    cellElement.classList.toggle('excluded-from-grid', isIncluded);
    appendLogMessage(`[Lurk] ${isIncluded ? 'Excluded' : 'Added'} ${username} ${isIncluded ? 'from' : 'to'} Multi-Lurk Grid.`);
    updateGridLayout();
  });

  tabBtn.addEventListener('click', (e) => {
    if (e.target.closest('.stream-tab-close') || e.target.closest('.grid-toggle-btn')) return;
    switchTab(tabId);
  });

  tabBtn.querySelector('.stream-tab-close').addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.closeStreamContainer(platform, username);
  });

  return tabBtn;
}

export function createStreamTab(platform, username) {
  const p = platform.toLowerCase();
  const u = username.toLowerCase();
  const tabId = `stream-${p}-${u}`;
  const cellId = `grid-cell-${p}-${u}`;
  const key = `${p}:${u}`;

  appendLogMessage(`[Lurk] Initializing active container: ${username} on ${platform.toUpperCase()}`);

  const sidebarTabsContainer = document.getElementById('active-lurk-tabs');
  sidebarTabsContainer.querySelector('.no-active-lurks')?.remove();

  ensureMultiLurkButton();

  const gridContainer = document.getElementById('multi-lurk-grid');
  let cell = document.getElementById(cellId);
  if (!cell) {
    if (!state.currentConfig.disabledAutoQuality) state.currentConfig.disabledAutoQuality = {};
    const isQualityDisabled = state.currentConfig.disabledAutoQuality[key] === true;

    cell = document.createElement('div');
    cell.id = cellId;
    cell.className = `stream-grid-cell ${p}-cell`;
    cell.dataset.platform = p;
    cell.dataset.username = username;
    cell.dataset.autoQualityDisabled = isQualityDisabled ? 'true' : 'false';
    cell.innerHTML = buildCellHTML(platform, username, isQualityDisabled);

    bindCellActions(cell, platform, username);
    gridContainer.appendChild(cell);
  }

  if (!document.querySelector(`[data-tab="${tabId}"]`)) {
    sidebarTabsContainer.appendChild(buildSidebarTabButton(platform, username, tabId, cellId));
  }

  updateGridLayout();
  updateGlobalGhostButtonState();

  // Opening a stream never changes the active view. Auto-jumping to the
  // Multi-Lurk grid (or any tab) is disruptive when the user is watching a
  // stream full-screen or batch-opening streams from the monitor panel — the
  // new tab/cell is created in the background and the user navigates to it when
  // they choose.

  syncActiveTabs();
}

// Reflect pop-out window state on the cell's pop-out button. Called when the
// floating window is closed (from main) so the button returns to its idle look.
export function setCellPoppedOut(platform, username, on) {
  const cellId = `grid-cell-${platform.toLowerCase()}-${username.toLowerCase()}`;
  const cell = document.getElementById(cellId);
  if (!cell) return;

  const btn = cell.querySelector('.popout-btn');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.title = on
      ? 'Pop-out window open (click to re-focus it)'
      : 'Pop out into a floating Picture-in-Picture window';
  }

  if (on) {
    cell.dataset.poppedOut = 'true';
  } else {
    delete cell.dataset.poppedOut;
    // Resume decoding if we auto-suspended this cell when it was popped out
    // (leave it alone if the user had ghosted it manually).
    if (cell.dataset.autoGhostedByPopout === 'true') {
      delete cell.dataset.autoGhostedByPopout;
      if (cell.dataset.ghostMode === 'true') cell.querySelector('.ghost-mode-btn')?.click();
    }
  }
}

export function removeStreamTab(platform, username) {
  const p = platform.toLowerCase();
  const u = username.toLowerCase();
  const tabId = `stream-${p}-${u}`;
  const cellId = `grid-cell-${p}-${u}`;

  appendLogMessage(`[Lurk] Terminating active container: ${username} on ${platform.toUpperCase()}`);

  document.querySelector(`[data-tab="${tabId}"]`)?.remove();

  const cell = document.getElementById(cellId);
  if (cell) {
    const container = cell.querySelector('.stream-cell-webview-container');
    if (container) webviewResizeObserver.unobserve(container);
    cell.remove();
  }

  updateGridLayout();
  updateGlobalGhostButtonState();

  const gridContainer = document.getElementById('multi-lurk-grid');
  const cellsCount = gridContainer ? gridContainer.querySelectorAll('.stream-grid-cell').length : 0;

  if (cellsCount === 0) {
    const sidebarTabsContainer = document.getElementById('active-lurk-tabs');
    if (sidebarTabsContainer) {
      document.getElementById('multi-lurk-tab-btn')?.remove();
      sidebarTabsContainer.innerHTML = `<div class="no-active-lurks">No active streams open</div>`;
    }

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab?.id === 'tab-multi-lurk') switchTab('dashboard');
  } else if (!document.querySelector('.stream-tab-btn.active')) {
    switchTab('multi-lurk');
  }

  syncActiveTabs();
}

// Reload every open stream webview — used after a newly installed extension is
// loaded into the session so its content scripts inject into live streams.
export function reloadAllStreamContainers() {
  const webviews = document.querySelectorAll('#multi-lurk-grid .stream-grid-cell webview');
  webviews.forEach(wv => {
    try { wv.reload(); } catch (e) { /* ignore */ }
  });
  if (webviews.length) {
    appendLogMessage(`[Extensions] Reloaded ${webviews.length} open stream container(s) to apply the new extension.`);
  }
}

export function closeAllStreamTabs() {
  document.querySelectorAll('#multi-lurk-grid .stream-grid-cell').forEach(cell => {
    removeStreamTab(cell.dataset.platform, cell.dataset.username);
  });
}
