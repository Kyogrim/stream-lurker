// Top watched-streamers list and platform hours breakdown.

import { PLATFORMS, state, getPlatformSVG, isPlatformEnabled, platformColorVar } from './state.js';

const TOP_N = 5;

const EMPTY_HOURS = { twitch: 0, kick: 0, youtube: 0, rumble: 0 };

export function renderLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;
  list.innerHTML = '';

  const watchTime = state.currentConfig.watchTime || { streamers: {}, platforms: { ...EMPTY_HOURS } };
  const streamers = watchTime.streamers || {};
  const platforms = { ...EMPTY_HOURS, ...(watchTime.platforms || {}) };

  const sortedStreamers = Object.entries(streamers)
    .map(([key, mins]) => {
      const [platform, username] = key.split(':');
      return { platform, username, minutes: mins, hours: (mins / 60).toFixed(1) };
    })
    .filter(s => isPlatformEnabled(s.platform))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, TOP_N);

  if (sortedStreamers.length === 0) {
    list.innerHTML = `
      <div class="no-stats-message" style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 10px 0; width: 100%;">
        No watch history tracked yet. Keep a stream tab open to track hours!
      </div>
    `;
  } else {
    const maxMinutes = sortedStreamers[0].minutes || 1;
    sortedStreamers.forEach((s, idx) => {
      const rankEmoji = idx === 0 ? '👑' : `#${idx + 1}`;
      const pct = Math.max(5, (s.minutes / maxMinutes) * 100);
      const platColor = platformColorVar(s.platform);

      const card = document.createElement('div');
      card.className = 'leaderboard-item';
      card.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 10px;
        background-color: hsla(240, 5.9%, 15%, 0.15);
        border: 1px solid var(--panel-border);
        border-radius: var(--radius-sm);
      `;
      card.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 0.8rem; font-weight: 700; color: var(--cyan-color);">${rankEmoji}</span>
            <span class="platform-badge ${s.platform}" style="width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background-color: ${platColor};">
              ${getPlatformSVG(s.platform)}
            </span>
            <span style="font-size: 0.85rem; font-weight: 600;">${s.username}</span>
          </div>
          <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-primary);">${s.hours} hrs</span>
        </div>
        <div style="width: 100%; height: 4px; background-color: var(--panel-border); border-radius: 2px; overflow: hidden;">
          <div style="width: ${pct}%; height: 100%; background-color: ${platColor}; border-radius: 2px;"></div>
        </div>
      `;
      list.appendChild(card);
    });
  }

  // Platform hours breakdown legend + bars.
  const mins = Object.fromEntries(
    PLATFORMS.map(p => [p, isPlatformEnabled(p) ? (platforms[p] || 0) : 0])
  );
  const total = PLATFORMS.reduce((sum, p) => sum + mins[p], 0) || 1;

  for (const p of PLATFORMS) {
    const legendEl = document.getElementById(`legend-${p}-h`);
    if (legendEl) legendEl.textContent = `${(mins[p] / 60).toFixed(1)}h`;
    const barEl = document.getElementById(`platform-bar-${p}`);
    if (barEl) barEl.style.width = `${(mins[p] / total) * 100}%`;
  }
}
