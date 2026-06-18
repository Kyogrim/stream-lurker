// "Live right now" glance — a top-bar pill showing how many monitored streamers
// are currently live, with a popover to open any of them in one click.

import { state, getPlatformSVG, formatViewerCount, isPlatformEnabled, platformColorVar } from './state.js';

function liveStreamers() {
  return state.currentStatuses
    .filter(s => s.isLive && isPlatformEnabled(s.platform))
    .sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
}

function closePopover() {
  const pop = document.getElementById('live-now-popover');
  const btn = document.getElementById('live-now-btn');
  if (pop) pop.hidden = true;
  if (btn) btn.classList.remove('open');
}

function togglePopover() {
  const pop = document.getElementById('live-now-popover');
  const btn = document.getElementById('live-now-btn');
  if (!pop || !btn) return;
  const willOpen = pop.hidden;
  pop.hidden = !willOpen;
  btn.classList.toggle('open', willOpen);
  if (willOpen) renderLiveNow();
}

export function renderLiveNow() {
  const pill = document.getElementById('live-now-btn');
  const countEl = document.getElementById('live-now-count');
  const list = document.getElementById('live-now-list');
  const popCount = document.getElementById('live-now-pop-count');
  if (!pill || !countEl || !list) return;

  const live = liveStreamers();
  countEl.textContent = live.length;
  if (popCount) popCount.textContent = live.length;
  pill.classList.toggle('has-live', live.length > 0);

  if (live.length === 0) {
    list.innerHTML = `<div class="live-now-empty">No monitored streamers are live right now.</div>`;
    return;
  }

  list.innerHTML = '';
  for (const s of live) {
    const p = s.platform.toLowerCase();
    const key = `${p}:${s.username.toLowerCase()}`;
    const isOpen = state.activeContainers.includes(key);
    const platColor = platformColorVar(p);

    const row = document.createElement('div');
    row.className = 'live-now-item';
    row.innerHTML = `
      <span class="platform-badge ${p}" style="width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background-color: ${platColor}; flex: 0 0 auto;">
        ${getPlatformSVG(p)}
      </span>
      <div class="live-now-item-main">
        <span class="live-now-item-name">${s.username}</span>
        <span class="live-now-item-meta">
          <span class="live-now-viewers"><span class="live-now-vdot"></span>${formatViewerCount(s.viewerCount || 0)}</span>
          ${s.category ? `<span class="live-now-cat">${s.category}</span>` : ''}
        </span>
      </div>
      <button class="live-now-open ${isOpen ? 'is-open' : ''}" ${isOpen ? 'disabled' : ''}>${isOpen ? 'Open' : 'Watch'}</button>
    `;

    const openBtn = row.querySelector('.live-now-open');
    if (!isOpen) {
      openBtn.addEventListener('click', () => {
        window.api.openStreamContainer(s.platform, s.username);
        openBtn.textContent = 'Opening…';
        openBtn.disabled = true;
        openBtn.classList.add('is-open');
      });
    }
    list.appendChild(row);
  }
}

export function setupLiveNow() {
  const btn = document.getElementById('live-now-btn');
  if (!btn) return;

  btn.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(); });

  // Close on outside click / Escape.
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.live-now-wrap');
    if (wrap && !wrap.contains(e.target)) closePopover();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });

  renderLiveNow();
}
