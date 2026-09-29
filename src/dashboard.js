// Monitor Panel grid of streamer cards, plus stats counters.

import { state, getPlatformSVG, formatViewerCount, isPlatformEnabled, escapeHtml, monitoredStreamers } from './state.js';

function streamersGridEl() { return document.getElementById('streams-grid'); }

const EMPTY_NO_STREAMERS = `
  <div class="no-streamers-message">
    <p>No streamers added yet. Go to the <strong>Manage Streamers</strong> panel to add your favorites.</p>
  </div>
`;

const EMPTY_NO_ENABLED = `
  <div class="no-streamers-message">
    <p>No active/enabled streamers to display. Go to the <strong>System Settings</strong> panel to enable platform services, or add streamers for enabled platforms.</p>
  </div>
`;

// badge: 'live' | 'checking' | anything else for OFFLINE. A state, not markup,
// so only these three fixed badges can reach the parser.
function cardHeader(platform, username, badge) {
  return `
    <div class="card-header-row">
      <div class="streamer-identity">
        <div class="platform-badge ${escapeHtml(platform.toLowerCase())}">${getPlatformSVG(platform)}</div>
        <span class="streamer-username">${escapeHtml(username)}</span>
      </div>
      ${badge === 'live' ? '<span class="live-badge live">LIVE</span>'
        : badge === 'checking' ? '<span class="live-badge offline">Checking...</span>'
        : '<span class="live-badge offline">OFFLINE</span>'}
    </div>
  `;
}

function isContainerOpenFor(stream) {
  return state.activeContainers.includes(`${stream.platform.toLowerCase()}:${stream.username.toLowerCase()}`);
}

// An offline card with nothing to act on or report is just its name and
// badge: dozens of full-size "Stream is currently offline." cards, each with
// a dead button, pushed the live ones and most of the list off screen. One
// keeps its full card while its container is open (the button closes it) or
// its check failed (the error says why).
export function isCompactCard(stream, isContainerOpen = isContainerOpenFor(stream)) {
  return !stream.isLive && !isContainerOpen && !stream.error;
}

// Before the first scan, compact too, so the grid does not jump from tall
// placeholders to short cards when the answers arrive.
function createStreamerCardPlaceholder(platform, username) {
  const card = document.createElement('div');
  card.className = 'stream-card offline compact glass-panel';
  card.innerHTML = cardHeader(platform, username, 'checking');
  return card;
}

function createStreamerCard(stream) {
  const platformLower = stream.platform.toLowerCase();
  const isLive = stream.isLive;
  const isContainerOpen = isContainerOpenFor(stream);

  const badge = isLive ? 'live' : 'offline';

  const card = document.createElement('div');
  if (isCompactCard(stream, isContainerOpen)) {
    card.className = 'stream-card offline compact glass-panel';
    card.innerHTML = cardHeader(platformLower, stream.username, badge);
    return card;
  }
  card.className = `stream-card ${isLive ? `live-${platformLower}` : 'offline'} glass-panel`;

  // One line: the viewer count and separator keep their size and only the
  // category gives way (style.css .detail-category), so a long game name no
  // longer wraps and drops this card's button below its neighbours'.
  const detailsHTML = isLive
    ? `<div class="detail-item detail-viewers"><span class="viewers-dot"></span>${formatViewerCount(stream.viewerCount)} Lurkers</div>
       <div class="detail-item detail-sep">|</div>
       <div class="detail-item detail-category">${escapeHtml(stream.category)}</div>`
    : `<div class="detail-item detail-category">${stream.error ? `Error: ${escapeHtml(stream.error)}` : 'Offline'}</div>`;

  const actionButtonText = isContainerOpen ? 'Close Container' : 'Open Container';
  const actionButtonClass = isContainerOpen
    ? 'card-btn container-active'
    : isLive ? 'card-btn' : 'card-btn offline-btn';
  const actionButtonDisabled = !isLive && !isContainerOpen;

  card.innerHTML = `
    ${cardHeader(platformLower, stream.username, badge)}
    <div class="card-body">
      <p class="stream-title">${isLive ? escapeHtml(stream.title) : 'Stream is currently offline.'}</p>
      <div class="stream-details">${detailsHTML}</div>
    </div>
    <div class="card-actions">
      <button class="${actionButtonClass}" ${actionButtonDisabled ? 'disabled' : ''}>
        ${isContainerOpen
          ? `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>`
          : `<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>`}
        ${actionButtonText}
      </button>
    </div>
  `;

  card.querySelector('.card-actions button').addEventListener('click', async () => {
    if (isContainerOpen) {
      await window.api.closeStreamContainer(stream.platform, stream.username);
    } else {
      await window.api.openStreamContainer(stream.platform, stream.username);
    }
  });

  return card;
}

export function renderStreamsGrid() {
  const grid = streamersGridEl();
  if (!grid) return;
  grid.innerHTML = '';

  const cfg = state.currentConfig;
  const streamers = monitoredStreamers(cfg);
  if (!cfg || streamers.length === 0) {
    grid.innerHTML = EMPTY_NO_STREAMERS;
    return;
  }

  const enabledStreamers = streamers.filter(s => isPlatformEnabled(s.platform));
  if (enabledStreamers.length === 0) {
    grid.innerHTML = EMPTY_NO_ENABLED;
    return;
  }

  if (state.currentStatuses.length === 0) {
    enabledStreamers.forEach(s => grid.appendChild(createStreamerCardPlaceholder(s.platform, s.username)));
    return;
  }

  // Live first, then offline cards that still show something (an open
  // container, an error), then the compact rest, each in the user's priority
  // order. Compact cards start a row of their own (style.css), so they never
  // sit beside a tall card over empty space.
  const priorityIndex = new Map();
  streamers.forEach((s, idx) => priorityIndex.set(`${s.platform.toLowerCase()}:${s.username.toLowerCase()}`, idx));
  const tier = s => (s.isLive ? 0 : isCompactCard(s) ? 2 : 1);

  const sortedStatuses = [...state.currentStatuses].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    const idxA = priorityIndex.get(`${a.platform.toLowerCase()}:${a.username.toLowerCase()}`) ?? 0;
    const idxB = priorityIndex.get(`${b.platform.toLowerCase()}:${b.username.toLowerCase()}`) ?? 0;
    return idxA - idxB;
  });

  const enabledStatuses = sortedStatuses.filter(s => isPlatformEnabled(s.platform));
  if (enabledStatuses.length === 0) {
    grid.innerHTML = EMPTY_NO_ENABLED;
    return;
  }

  enabledStatuses.forEach(s => grid.appendChild(createStreamerCard(s)));
}

export function updateStats() {
  const cfg = state.currentConfig;
  if (!cfg) return;

  const enabledStreamers = monitoredStreamers(cfg).filter(s => isPlatformEnabled(s.platform));
  const enabledLiveCount = state.currentStatuses.filter(s => s.isLive && isPlatformEnabled(s.platform)).length;

  document.getElementById('total-streamers-stat').textContent = enabledStreamers.length;
  document.getElementById('live-streamers-stat').textContent = enabledLiveCount;
  document.getElementById('containers-stat').textContent = state.activeContainers.length;
}
