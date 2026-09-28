// Multi-Lurk grid: in-app stream tabs and grid cells.
// Each lurked stream has (1) a sidebar tab button and (2) a webview cell in
// the grid. createStreamTab builds both; removeStreamTab tears them down.

import {
  state, getPlatformSVG, appendLogMessage, fmtDuration, formatViewerCount, escapeHtml,
  safeHttpsUrl, STREAM_HOSTS, streamTabId, gridCellId,
} from './state.js';
import { switchTab } from './tabs.js';
import { createStreamWebview } from './stream-webview.js';
import { describeCellFailure, planCellRecovery, MAX_RELOADS, RELOAD_WINDOW_MS } from './cell-recovery.js';
import { theaterKeyDecision } from './theater-key.js';
import { guestLogLine, createLineDeduper } from './guest-console.js';
import {
  qualityAndTheaterScript,
  ghostSuspendScript,
  ghostResumeScript,
} from './inject.js';

// Pages the quality/theatre script is injected into. Matched on the exact host
// or a subdomain: a substring test let twitch.tv.example.net through.
const INJECT_HOSTS = ['twitch.tv', 'kick.com', 'youtube.com'];

// At dom-ready the platform has usually not inserted its <video> yet, and the
// ghost script does nothing without one, so a reloaded ghosted cell re-applies
// it a few times while the player comes up.
const GHOST_REAPPLY_DELAYS_MS = [0, 3000, 10000, 25000];

// How long a cell keeps the keyboard focus it took for a native Alt+T. The key
// travels renderer -> main -> guest, so it needs a moment to land first.
const ALT_T_FOCUS_RETURN_MS = 500;

// Timers and listeners a cell owns outside its DOM. removeStreamTab disposes
// them, so nothing fires against a removed webview (reload() on one throws).
const cellLife = new WeakMap();

function lifeOf(cell) {
  let life = cellLife.get(cell);
  if (!life) {
    life = {
      reloadTimes: [],     // when recovery reloads ran (see cell-recovery.js)
      reloadTimer: null,
      onlineListener: null,
      loadFailed: false,   // the current main-frame load failed
      givingUp: false,
      ghostTimers: [],
      altTSent: 0,         // native Alt+T presses sent to the current page
      guestLog: createLineDeduper(), // forwarded page lines (guest-console.js)
    };
    cellLife.set(cell, life);
  }
  return life;
}

function disposeCell(cell) {
  const life = cellLife.get(cell);
  if (!life) return;
  clearTimeout(life.reloadTimer);
  life.ghostTimers.forEach(clearTimeout);
  if (life.onlineListener) window.removeEventListener('online', life.onlineListener);
  cellLife.delete(cell);
}

// Whether the user can currently see this cell's page.
function isCellOnScreen(cell) {
  if (!document.getElementById('tab-multi-lurk')?.classList.contains('active')) return false;
  if (cell.classList.contains('excluded-from-grid') || cell.dataset.ghostMode === 'true') return false;
  const g = cell.parentNode;
  return !(g?.classList?.contains('single-view') && !cell.classList.contains('maximized'));
}

// Where keyboard focus sits relative to `webview` (see theater-key.js).
function focusOwnerFor(webview) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return 'none';
  if (el === webview) return 'self';
  const tag = el.tagName;
  if (tag === 'WEBVIEW' || tag === 'IFRAME') return 'webview';
  if (el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'editable';
  return 'other';
}

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

// Re-render the meta line on every open cell. Called on each watch-time tick
// (totals climb) and each scan (viewers/uptime move), so the header stays
// current without rebuilding the cell — a rebuild would reload the webview.
export function refreshGridCellMeta() {
  const cells = document.querySelectorAll('#multi-lurk-grid .stream-grid-cell');
  cells.forEach(cell => {
    const meta = cell.querySelector('.stream-cell-meta');
    if (!meta) return;
    meta.innerHTML = cellMetaHTML(cell.dataset.platform, cell.dataset.username);
  });
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

// Look up the live status the scanner last reported for a stream.
function statusFor(platform, username) {
  const p = platform.toLowerCase();
  const u = username.toLowerCase();
  return state.currentStatuses.find(
    s => s.platform.toLowerCase() === p && s.username.toLowerCase() === u
  );
}

// The meta line under a cell's name: all-time watch time for this streamer,
// their current viewer count, and how long they've been live. Returns '' when
// there's nothing worth showing so the header stays compact.
function cellMetaHTML(platform, username) {
  const key = `${platform.toLowerCase()}:${username.toLowerCase()}`;
  const minutes = state.currentConfig?.watchTime?.streamers?.[key] || 0;
  const status = statusFor(platform, username);

  // Watch time is the headline figure and is pinned so it never truncates.
  const watched = minutes > 0
    ? `<span class="cell-meta-watched" title="Your all-time watch time for ${escapeHtml(username)}">${fmtDuration(minutes)} watched</span>`
    : '';

  // Viewers and uptime are secondary — labels stay terse (a dot for viewers,
  // "up" for uptime) so all three fit beside the eight action buttons.
  const rest = [];
  if (status?.isLive && status.viewerCount) {
    rest.push(`<span title="Current viewers"><span class="cell-meta-dot"></span>${formatViewerCount(status.viewerCount)}</span>`);
  }
  if (status?.isLive && status.liveSince) {
    const started = new Date(status.liveSince).getTime();
    if (!Number.isNaN(started)) {
      const upMins = Math.max(0, Math.floor((Date.now() - started) / 60000));
      if (upMins > 0) rest.push(`<span title="Live for ${fmtDuration(upMins)}">up ${fmtDuration(upMins)}</span>`);
    }
  }

  if (!watched && !rest.length) return '';
  const sep = '<span class="cell-meta-sep">·</span>';
  const restHTML = rest.length
    ? `<span class="cell-meta-rest">${watched ? sep : ''}${rest.join(sep)}</span>`
    : '';
  return watched + restHTML;
}

function buildCellHTML(platform, username, isQualityDisabled) {
  const p = platform.toLowerCase();
  return `
    <div class="stream-cell-header">
      <div class="stream-cell-identity">
        <div class="platform-badge ${escapeHtml(p)}">${getPlatformSVG(p)}</div>
        <span class="stream-cell-name">${escapeHtml(username)}</span>
        <span class="stream-cell-meta">${cellMetaHTML(platform, username)}</span>
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
    <div class="stream-cell-webview-container"></div>
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

  const life = lifeOf(cell);
  const currentUrl = () => {
    try { return webview.getURL() || ''; } catch (err) { return ''; }
  };

  // The webContents mute follows the mute button, and a ghosted cell is always
  // silent. Re-applied on every dom-ready: a reload (the button, a recovery,
  // an extension install) brings back a page whose <video> is not muted.
  const applyAudio = () => {
    try {
      webview.setAudioMuted(muteBtn.classList.contains('muted') || cell.dataset.ghostMode === 'true');
    } catch (err) { /* not attached yet; dom-ready applies it */ }
  };

  const reapplyGhost = () => {
    life.ghostTimers.forEach(clearTimeout);
    life.ghostTimers = GHOST_REAPPLY_DELAYS_MS.map(ms => setTimeout(() => {
      if (!cell.isConnected || cell.dataset.ghostMode !== 'true') return;
      webview.executeJavaScript(ghostSuspendScript).catch(() => { /* page navigating */ });
    }, ms));
  };

  webview.addEventListener('console-message', (e) => {
    const message = typeof e.message === 'string' ? e.message : '';
    const line = guestLogLine(message, username);
    if (line) {
      // Only the quality script prints these, and it only runs on the
      // platform hosts; the same line within a minute is dropped.
      if (safeHttpsUrl(currentUrl(), INJECT_HOSTS) && life.guestLog(line, Date.now())) appendLogMessage(line);
      return;
    }
    if (message.includes('[Twitch Theater] Need Alt+T')) {
      const decision = theaterKeyDecision(life.altTSent, {
        url: currentUrl(),
        windowFocused: document.hasFocus(),
        cellVisible: isCellOnScreen(cell),
        focusOwner: focusOwnerFor(webview),
      });
      if (!decision.send) return;
      life.altTSent++;
      const previous = document.activeElement;
      try {
        if (decision.focus) webview.focus();
        webview.sendInputEvent({ type: 'keyDown', keyCode: 't', modifiers: ['alt'] });
        webview.sendInputEvent({ type: 'keyUp', keyCode: 't', modifiers: ['alt'] });
        appendLogMessage(`[Lurk] Sent native Alt+T keyboard shortcut to maximize Twitch player for ${username}.`);
      } catch (err) {
        console.error('Failed to send native Alt+T keypress:', err);
      }
      // Hand focus back once the key has reached the page. Left on this
      // cell, it would read as "the user is in another cell" to every other
      // cell's request, and only the first cell would ever get theatre mode.
      if (decision.focus) {
        setTimeout(() => {
          if (document.activeElement !== webview) return; // moved on already
          if (previous?.isConnected && previous !== document.body && typeof previous.focus === 'function') previous.focus();
          else webview.blur();
        }, ALT_T_FOCUS_RETURN_MS);
      }
    }
  });

  // A new document gets its own Alt+T allowance; in-page (SPA) navigations
  // keep the same page and fire did-navigate-in-page instead.
  webview.addEventListener('did-navigate', () => { life.altTSent = 0; });

  // ── Dead page recovery (contract C6, policy in cell-recovery.js) ──
  const PLAT = platform.toUpperCase();
  const scheduleRecovery = (what) => {
    // One outage often fires several events; the first one drives recovery.
    if (life.reloadTimer || life.onlineListener || life.givingUp) return;

    // Offline, a reload can only fail again and burn an attempt. Wait for the
    // network instead (sleep/resume and Wi-Fi drops land here).
    if (navigator.onLine === false) {
      appendLogMessage(`[Lurk] ${username} (${PLAT}): ${what}. Offline; will reload when the network is back.`);
      life.onlineListener = () => {
        window.removeEventListener('online', life.onlineListener);
        life.onlineListener = null;
        if (cell.isConnected) scheduleRecovery(what);
      };
      window.addEventListener('online', life.onlineListener);
      return;
    }

    const plan = planCellRecovery(life.reloadTimes, Date.now());
    life.reloadTimes = plan.recent;
    if (plan.action === 'give-up') {
      life.givingUp = true;
      appendLogMessage(`[Lurk] ${username} (${PLAT}): ${what}. ${MAX_RELOADS} reloads in ${RELOAD_WINDOW_MS / 60000} minutes did not fix it; closing the stream.`);
      // The close button's path: main finalizes the session and stops
      // crediting watch time, and won't reopen it for this broadcast.
      Promise.resolve(window.api.closeStreamContainer(platform, username))
        .catch(err => console.error('Failed to close dead stream cell:', err));
      return;
    }
    appendLogMessage(`[Lurk] ${username} (${PLAT}): ${what}. Reloading in ${Math.round(plan.delayMs / 1000)}s (attempt ${plan.attempt}/${MAX_RELOADS}).`);
    life.reloadTimer = setTimeout(() => {
      life.reloadTimer = null;
      if (!cell.isConnected) return;
      life.reloadTimes.push(Date.now());
      try { webview.reload(); } catch (err) { console.error('Stream cell reload failed:', err); }
    }, plan.delayMs);
  };

  const onPageFailure = (type) => (e) => {
    // Closing a cell tears its guest down, which can report as a failure.
    if (!cell.isConnected) return;
    const what = describeCellFailure(type, e);
    if (!what) return;
    if (type === 'did-fail-load') life.loadFailed = true;
    cell.dataset.crashed = 'true';
    scheduleRecovery(what);
  };
  webview.addEventListener('render-process-gone', onPageFailure('render-process-gone'));
  webview.addEventListener('did-fail-load', onPageFailure('did-fail-load'));
  webview.addEventListener('did-start-loading', () => { life.loadFailed = false; });

  // Healthy again once any page comes up from a load that did not fail.
  // Chromium's error page also fires dom-ready and did-finish-load, but
  // did-fail-load reaches us first and sets loadFailed until the next load
  // starts. Either event clears it, so a page that never fires `load` can't
  // leave the overlay over a working stream. Off the platform counts too: a
  // YouTube cell's reload can land on Google's consent or sign-in page, which
  // fires no further failure, so the overlay would sit over it for good and
  // block the very click that gets back to the stream.
  const markHealthy = () => {
    if (life.loadFailed || cell.dataset.crashed !== 'true') return;
    delete cell.dataset.crashed;
    if (safeHttpsUrl(currentUrl(), STREAM_HOSTS)) appendLogMessage(`[Lurk] ${username} (${PLAT}) recovered.`);
  };
  webview.addEventListener('did-finish-load', markHealthy);

  webview.addEventListener('dom-ready', () => {
    markHealthy();
    applyAudio();
    if (cell.dataset.ghostMode === 'true') reapplyGhost();

    const url = currentUrl();
    if (!safeHttpsUrl(url, INJECT_HOSTS)) return;

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

  // The button is the user's choice; the webContents state can also be muted
  // by ghost mode, so it is not read back to decide the toggle.
  muteBtn.addEventListener('click', () => {
    const newMuted = !muteBtn.classList.contains('muted');
    muteBtn.classList.toggle('muted', newMuted);
    muteBtn.title = newMuted ? 'Unmute Audio' : 'Mute Audio';
    applyAudio();
  });

  reloadBtn.addEventListener('click', () => {
    appendLogMessage(`[Lurk] Reloading active container: ${username} on ${platform.toUpperCase()}`);
    // The user is retrying now; an automatic reload still pending would only
    // interrupt the page they just asked for.
    clearTimeout(life.reloadTimer);
    life.reloadTimer = null;
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
    applyAudio();

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
    <div class="platform-badge ${escapeHtml(p)}">${getPlatformSVG(p)}</div>
    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px; font-weight: 500;">${escapeHtml(username)}</span>
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

// sync: false leaves telling main to the caller. A dashboard reload restores
// every open stream in one pass and syncs once after it: a sync per stream
// sent main [A], [A,B], [A,B,C], and main ended and restarted the sessions of
// B and C each time one was missing from the list.
export function createStreamTab(platform, username, { sync = true } = {}) {
  const p = platform.toLowerCase();
  const u = username.toLowerCase();
  const tabId = streamTabId(p, u);
  const cellId = gridCellId(p, u);
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
    // The webview is created separately (src/stream-webview.js) so the
    // username never reaches its attributes as markup.
    cell.querySelector('.stream-cell-webview-container')
      .appendChild(createStreamWebview(platform, username, statusFor(platform, username)));

    bindCellActions(cell, platform, username);
    gridContainer.appendChild(cell);
  }

  // CSS.escape: the id embeds the username, and a quote in it would otherwise
  // throw here and leave the stream without a sidebar tab.
  if (!document.querySelector(`[data-tab="${CSS.escape(tabId)}"]`)) {
    sidebarTabsContainer.appendChild(buildSidebarTabButton(platform, username, tabId, cellId));
  }

  updateGridLayout();
  updateGlobalGhostButtonState();

  // Opening a stream never changes the active view. Auto-jumping to the
  // Multi-Lurk grid (or any tab) is disruptive when the user is watching a
  // stream full-screen or batch-opening streams from the monitor panel — the
  // new tab/cell is created in the background and the user navigates to it when
  // they choose.

  if (sync) syncActiveTabs();
}

// Reflect pop-out window state on the cell's pop-out button. Called when the
// floating window is closed (from main) so the button returns to its idle look.
export function setCellPoppedOut(platform, username, on) {
  const cell = document.getElementById(gridCellId(platform, username));
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
  const tabId = streamTabId(platform, username);
  const cellId = gridCellId(platform, username);

  appendLogMessage(`[Lurk] Terminating active container: ${username} on ${platform.toUpperCase()}`);

  // Read before the button goes: only closing the stream the user is looking
  // at should move them. Main closes streams on its own (offline, preempted),
  // and that must not drag someone out of Settings or the Calendar.
  const tabBtn = document.querySelector(`[data-tab="${CSS.escape(tabId)}"]`);
  const wasActive = !!tabBtn?.classList.contains('active');
  tabBtn?.remove();

  const cell = document.getElementById(cellId);
  if (cell) {
    disposeCell(cell);
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
  } else if (wasActive) {
    switchTab('multi-lurk');
  }

  syncActiveTabs();
}

// Reload every open stream webview. Main asks for it whenever the loaded
// extensions change: a new one only injects its content scripts on a load, and
// what a removed one injected stays in a page until it reloads.
export function reloadAllStreamContainers() {
  const webviews = document.querySelectorAll('#multi-lurk-grid .stream-grid-cell webview');
  webviews.forEach(wv => {
    try { wv.reload(); } catch (e) { /* ignore */ }
  });
  if (webviews.length) {
    appendLogMessage(`[Extensions] Reloaded ${webviews.length} open stream container(s) to apply the extension change.`);
  }
}

export function closeAllStreamTabs() {
  document.querySelectorAll('#multi-lurk-grid .stream-grid-cell').forEach(cell => {
    removeStreamTab(cell.dataset.platform, cell.dataset.username);
  });
}
