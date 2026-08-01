// Manage Streamers panel: monitored list per platform, with drag & arrow reorder.

import { PLATFORMS, state, appendLogMessage, getPlatformSVG, platformColorVar, isPlatformEnabled } from './state.js';
import { renderStreamsGrid, updateStats } from './dashboard.js';

function monitoredListEl() { return document.getElementById('monitored-channels-list'); }

// What should happen when this streamer goes live. Entries saved before this
// existed have no `mode`, so anything unrecognised reads as 'auto' — those keep
// behaving exactly as before.
const STREAM_MODES = ['auto', 'notify', 'ignore'];
const MODE_META = {
  auto: {
    title: 'Auto-open when live (click to change)',
    icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  },
  notify: {
    title: 'Notify only — never auto-opens (click to change)',
    icon: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  },
  ignore: {
    title: 'No alerts, never auto-opens — still monitored (click to change)',
    icon: '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
  },
};

function getStreamMode(streamer) {
  return STREAM_MODES.includes(streamer.mode) ? streamer.mode : 'auto';
}

function groupByPlatform() {
  const groups = Object.fromEntries(PLATFORMS.map(p => [p, []]));
  for (const s of state.currentConfig.streamers) {
    const p = s.platform.toLowerCase();
    if (groups[p]) groups[p].push(s);
  }
  return groups;
}

function persistGroups(groups) {
  state.currentConfig.streamers = PLATFORMS.flatMap(p => groups[p]);
  return window.api.saveConfig(state.currentConfig);
}

// Unified reorder: swap by `direction` or move by `toIndex`.
// Pass either { direction: 'up' | 'down' } or { toIndex: number }.
async function reorderStreamer(platform, fromIndex, { direction, toIndex } = {}) {
  if (!state.currentConfig) return;

  const plat = platform.toLowerCase();
  const groups = groupByPlatform();
  const list = groups[plat];
  if (!list) return;

  const targetIndex = direction
    ? (direction === 'up' ? fromIndex - 1 : fromIndex + 1)
    : toIndex;

  if (
    targetIndex === fromIndex ||
    fromIndex < 0 || fromIndex >= list.length ||
    targetIndex < 0 || targetIndex >= list.length
  ) return;

  const [moved] = list.splice(fromIndex, 1);
  list.splice(targetIndex, 0, moved);

  await persistGroups(groups);
  renderMonitoredList();
  appendLogMessage(`[System] Reordered ${platform.toUpperCase()} priority: ${moved.username} moved ${direction || 'via drag & drop'}.`);
}

function buildRow(streamer, index, listLength) {
  const isFirst = index === 0;
  const isLast = index === listLength - 1;

  const row = document.createElement('div');
  row.className = 'list-item';
  row.draggable = true;

  const mode = getStreamMode(streamer);

  row.innerHTML = `
    <div class="list-item-identity">
      <div class="platform-badge ${streamer.platform}">${getPlatformSVG(streamer.platform)}</div>
      <span class="list-item-name">${streamer.username}</span>
    </div>
    <button class="mode-btn mode-${mode}" title="${MODE_META[mode].title}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MODE_META[mode].icon}</svg>
    </button>
    <div class="priority-controls">
      <button class="priority-btn up-btn" title="Move Up" ${isFirst ? 'disabled' : ''}>▲</button>
      <button class="priority-btn down-btn" title="Move Down" ${isLast ? 'disabled' : ''}>▼</button>
    </div>
    <button class="delete-btn" title="Remove Channel">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
    </button>
  `;

  const platLower = streamer.platform.toLowerCase();

  row.addEventListener('dragstart', (e) => {
    state.draggedItem = { platform: platLower, index };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(state.draggedItem));
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    state.draggedItem = null;
    monitoredListEl().querySelectorAll('.list-item').forEach(it => it.classList.remove('drag-over'));
  });

  row.addEventListener('dragover', (e) => {
    if (state.draggedItem?.platform === platLower) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });

  row.addEventListener('dragenter', () => {
    if (state.draggedItem?.platform === platLower && state.draggedItem.index !== index) {
      row.classList.add('drag-over');
    }
  });

  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (state.draggedItem?.platform === platLower && state.draggedItem.index !== index) {
      reorderStreamer(streamer.platform, state.draggedItem.index, { toIndex: index });
    }
  });

  // Cycle auto → notify → ignore. `streamer` is the same object held in
  // state.currentConfig.streamers, so mutating it and saving persists the change.
  row.querySelector('.mode-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = STREAM_MODES[(STREAM_MODES.indexOf(getStreamMode(streamer)) + 1) % STREAM_MODES.length];
    streamer.mode = next;
    await window.api.saveConfig(state.currentConfig);
    renderMonitoredList();
    const wording = next === 'auto'
      ? 'will auto-open when live'
      : next === 'notify' ? 'will only notify when live' : 'will not alert or auto-open';
    appendLogMessage(`[Alerts] ${streamer.username} ${wording}.`);
  });

  if (!isFirst) row.querySelector('.up-btn').addEventListener('click', () => reorderStreamer(streamer.platform, index, { direction: 'up' }));
  if (!isLast) row.querySelector('.down-btn').addEventListener('click', () => reorderStreamer(streamer.platform, index, { direction: 'down' }));

  row.querySelector('.delete-btn').addEventListener('click', async () => {
    const res = await window.api.deleteStreamer(streamer.platform, streamer.username);
    if (res.success) {
      state.currentConfig.streamers = res.streamers;
      renderMonitoredList();
      updateStats();
      appendLogMessage('[System] Monitored list updated.');
    }
  });

  return row;
}

function renderPlatformGroup(platformKey, list) {
  if (list.length === 0) return;
  const host = monitoredListEl();
  const accentColor = platformColorVar(platformKey);
  const platformName = platformKey[0].toUpperCase() + platformKey.slice(1);

  const groupHeader = document.createElement('div');
  groupHeader.className = 'monitored-platform-header';
  groupHeader.style.cssText = `
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--panel-border);
    padding: 16px 8px 8px 8px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  `;
  groupHeader.innerHTML = `
    <span style="color: ${accentColor}; font-weight: 700;">${platformName.toUpperCase()} CHANNELS</span>
    <span style="font-size: 0.75rem; opacity: 0.6;">${list.length} Monitored</span>
  `;
  host.appendChild(groupHeader);

  list.forEach((s, idx) => host.appendChild(buildRow(s, idx, list.length)));
}

export function renderMonitoredList() {
  const host = monitoredListEl();
  if (!host) return;
  host.innerHTML = '';

  const cfg = state.currentConfig;
  if (!cfg || cfg.streamers.length === 0) {
    host.innerHTML = `
      <div class="no-extensions-message" style="height: 120px;">
        <p>No channels added to monitor list. Add channels using the form on the left.</p>
      </div>
    `;
    return;
  }

  const groups = groupByPlatform();
  for (const p of PLATFORMS) {
    if (isPlatformEnabled(p)) renderPlatformGroup(p, groups[p]);
  }

  renderStreamsGrid();
}
