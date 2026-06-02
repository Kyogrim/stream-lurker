// Monitor Panel grid of streamer cards, plus stats counters.

import { state, getPlatformSVG, formatViewerCount, isPlatformEnabled } from './state.js';

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

function createStreamerCardPlaceholder(platform, username) {
  const card = document.createElement('div');
  card.className = 'stream-card offline glass-panel';
  card.innerHTML = `
    <div class="card-header-row">
      <div class="streamer-identity">
        <div class="platform-badge ${platform.toLowerCase()}">${getPlatformSVG(platform)}</div>
        <span class="streamer-username">${username}</span>
      </div>
      <span class="live-badge offline">Checking...</span>
    </div>
    <div class="card-body">
      <p class="stream-title">Initializing status check agent...</p>
      <div class="stream-details"><div class="detail-item">--</div></div>
    </div>
    <div class="card-actions">
      <button class="card-btn offline-btn" disabled>Open Container</button>
    </div>
  `;
  return card;
}

function createStreamerCard(stream) {
  const platformLower = stream.platform.toLowerCase();
  const usernameLower = stream.username.toLowerCase();
  const isLive = stream.isLive;
  const isContainerOpen = state.activeContainers.includes(`${platformLower}:${usernameLower}`);

  const card = document.createElement('div');
  card.className = `stream-card ${isLive ? `live-${platformLower}` : 'offline'} glass-panel`;

  const liveBadgeHTML = isLive ? `<span class="live-badge live">LIVE</span>` : `<span class="live-badge offline">OFFLINE</span>`;

  const detailsHTML = isLive
    ? `<div class="detail-item"><span class="viewers-dot"></span>${formatViewerCount(stream.viewerCount)} Lurkers</div>
       <div class="detail-item">|</div>
       <div class="detail-item">${stream.category}</div>`
    : `<div class="detail-item">${stream.error ? `Error: ${stream.error}` : 'Offline'}</div>`;

  const actionButtonText = isContainerOpen ? 'Close Container' : 'Open Container';
  const actionButtonClass = isContainerOpen
    ? 'card-btn container-active'
    : isLive ? 'card-btn' : 'card-btn offline-btn';
  const actionButtonDisabled = !isLive && !isContainerOpen;

  card.innerHTML = `
    <div class="card-header-row">
      <div class="streamer-identity">
        <div class="platform-badge ${platformLower}">${getPlatformSVG(platformLower)}</div>
        <span class="streamer-username">${stream.username}</span>
      </div>
      ${liveBadgeHTML}
    </div>
    <div class="card-body">
      <p class="stream-title">${isLive ? stream.title : 'Stream is currently offline.'}</p>
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

  card.querySelector('button').addEventListener('click', async () => {
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
  if (!cfg || cfg.streamers.length === 0) {
    grid.innerHTML = EMPTY_NO_STREAMERS;
    return;
  }

  const enabledStreamers = cfg.streamers.filter(s => isPlatformEnabled(s.platform));
  if (enabledStreamers.length === 0) {
    grid.innerHTML = EMPTY_NO_ENABLED;
    return;
  }

  if (state.currentStatuses.length === 0) {
    enabledStreamers.forEach(s => grid.appendChild(createStreamerCardPlaceholder(s.platform, s.username)));
    return;
  }

  // Sort: Live first, then by user-defined priority order.
  const priorityIndex = new Map();
  cfg.streamers.forEach((s, idx) => priorityIndex.set(`${s.platform.toLowerCase()}:${s.username.toLowerCase()}`, idx));

  const sortedStatuses = [...state.currentStatuses].sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
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

  const enabledStreamers = cfg.streamers.filter(s => isPlatformEnabled(s.platform));
  const enabledLiveCount = state.currentStatuses.filter(s => s.isLive && isPlatformEnabled(s.platform)).length;

  document.getElementById('total-streamers-stat').textContent = enabledStreamers.length;
  document.getElementById('live-streamers-stat').textContent = enabledLiveCount;
  document.getElementById('containers-stat').textContent = state.activeContainers.length;
}
