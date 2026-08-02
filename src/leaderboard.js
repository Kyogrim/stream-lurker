// Lurk Stats tab: headline totals, activity heatmap, the full watch-time
// ranking, per-platform split, and a per-streamer drill-down.

import { PLATFORMS, state, getPlatformSVG, isPlatformEnabled, platformColorVar, fmtDuration } from './state.js';

const EMPTY_HOURS = { twitch: 0, kick: 0, youtube: 0, rumble: 0 };

const PLATFORM_LABELS = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', rumble: 'Rumble' };

function rankBadge(idx) {
  if (idx === 0) return '👑';
  if (idx === 1) return '🥈';
  if (idx === 2) return '🥉';
  return `#${idx + 1}`;
}

// Local-date helpers for the daily activity buckets (keys are "YYYY-MM-DD").
function keyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateFromKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Current and longest run of consecutive days with any lurking activity.
function computeStreaks(daily) {
  const active = new Set(Object.keys(daily || {}).filter(k => daily[k] > 0));
  if (active.size === 0) return { current: 0, longest: 0 };

  let current = 0;
  const probe = new Date();
  probe.setHours(0, 0, 0, 0);
  if (!active.has(keyFromDate(probe))) probe.setDate(probe.getDate() - 1);
  while (active.has(keyFromDate(probe))) { current++; probe.setDate(probe.getDate() - 1); }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of [...active].sort()) {
    const d = dateFromKey(k);
    run = prev && Math.round((d - prev) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

// "5m ago", "3h ago", "2d ago", or a date for older timestamps.
function fmtRelative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Build the GitHub-style activity heatmap (last ~26 weeks). Columns are weeks
// (Sun→Sat top to bottom), shaded by minutes lurked that day.
function buildHeatmap(daily) {
  const WEEKS = 26;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - today.getDay())); // Saturday of this week
  const start = new Date(end);
  start.setDate(start.getDate() - (WEEKS * 7 - 1)); // a Sunday

  let max = 0;
  for (const k in daily) if (daily[k] > max) max = daily[k];

  let cells = '';
  const cursor = new Date(start);
  for (let i = 0; i < WEEKS * 7; i++) {
    const k = keyFromDate(cursor);
    const mins = daily[k] || 0;
    const future = cursor > today;
    const level = future ? -1 : (mins === 0 ? 0 : Math.min(4, Math.ceil((mins / (max || 1)) * 4)));
    const label = future
      ? ''
      : `${cursor.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${mins ? fmtDuration(mins) : 'no activity'}`;
    cells += `<div class="lb-hm-cell" data-level="${level}"${label ? ` title="${label}"` : ''}></div>`;
    cursor.setDate(cursor.getDate() + 1);
  }

  // Wrapped so the legend right-aligns to the heatmap itself rather than to the
  // full width of the tab.
  return `
    <div class="lb-heatmap">
    <div class="lb-hm-grid">${cells}</div>
    <div class="lb-hm-legend">
      <span>Less</span>
      <span class="lb-hm-cell" data-level="0"></span>
      <span class="lb-hm-cell" data-level="1"></span>
      <span class="lb-hm-cell" data-level="2"></span>
      <span class="lb-hm-cell" data-level="3"></span>
      <span class="lb-hm-cell" data-level="4"></span>
      <span>More</span>
    </div>
    </div>
  `;
}

// Pull the raw watch-time figures out of config and shape them into the derived
// numbers both the panel and the modal need. Streamer entries are filtered to
// currently-enabled platforms so disabling a platform hides its history.
function getStats() {
  const watchTime = state.currentConfig?.watchTime || { streamers: {}, platforms: { ...EMPTY_HOURS }, sessions: 0 };
  const platforms = { ...EMPTY_HOURS, ...(watchTime.platforms || {}) };

  const streamers = Object.entries(watchTime.streamers || {})
    .map(([key, mins]) => {
      const [platform, username] = key.split(':');
      return { platform, username, minutes: mins };
    })
    .filter(s => s.platform && s.username && isPlatformEnabled(s.platform))
    .sort((a, b) => b.minutes - a.minutes);

  const totalMinutes = streamers.reduce((sum, s) => sum + s.minutes, 0);
  const sessions = watchTime.sessions || 0;
  const daily = watchTime.daily || {};
  const streaks = computeStreaks(daily);

  let topPlatform = null;
  let topPlatformMins = 0;
  for (const p of PLATFORMS) {
    if (!isPlatformEnabled(p)) continue;
    const m = platforms[p] || 0;
    if (m > topPlatformMins) { topPlatformMins = m; topPlatform = p; }
  }

  return {
    streamers,
    platforms,
    sessions,
    totalMinutes,
    daily,
    streaks,
    longestSessionMin: (watchTime.longestSessionMs || 0) / 60000,
    streamerCount: streamers.length,
    avgPerSession: sessions > 0 ? totalMinutes / sessions : 0,
    avgPerStreamer: streamers.length > 0 ? totalMinutes / streamers.length : 0,
    top: streamers[0] || null,
    topPlatform,
    topPlatformMins,
  };
}

// Resolve the per-streamer breakdown for a single "platform:username" key,
// including its rank and share of the totals. Returns null if the streamer has
// no tracked history (e.g. its platform was disabled).
function getStreamerDetail(key) {
  const stats = getStats();
  const idx = stats.streamers.findIndex(s => `${s.platform}:${s.username}` === key);
  if (idx === -1) return null;

  const s = stats.streamers[idx];
  const wt = state.currentConfig?.watchTime || {};
  const sessions = (wt.streamerSessions || {})[key] || 0;
  const longestMs = (wt.streamerLongestMs || {})[key] || 0;
  const lastSeen = (wt.streamerLastSeen || {})[key] || 0;
  const platformMins = stats.platforms[s.platform] || 0;

  return {
    ...s,
    rank: idx + 1,
    total: stats.streamerCount,
    sessions,
    longestMin: longestMs / 60000,
    lastSeen,
    avgPerSession: sessions > 0 ? s.minutes / sessions : 0,
    shareOfTotal: stats.totalMinutes > 0 ? (s.minutes / stats.totalMinutes) * 100 : 0,
    shareOfPlatform: platformMins > 0 ? (s.minutes / platformMins) * 100 : 0,
  };
}

// Which view the tab is showing: null = overview, otherwise a streamer key.
let currentDetailKey = null;

function panelEl() { return document.getElementById('leaderboard-panel'); }

function statCard(value, label, accent) {
  return `
    <div class="lb-stat-card">
      <span class="lb-stat-val" style="color: ${accent || 'var(--cyan-color)'};">${value}</span>
      <span class="lb-stat-lbl">${label}</span>
    </div>
  `;
}

// The whole-tab overview: headline figures, activity heatmap, the complete
// ranking, and the per-platform split.
function renderOverview() {
  const host = panelEl();
  if (!host) return;

  currentDetailKey = null;
  const stats = getStats();

  if (stats.streamerCount === 0 && stats.sessions === 0) {
    host.innerHTML = `
      <div class="lb-empty">
        No watch history tracked yet.<br>Open a stream and let it run to start building your lurk stats!
      </div>
    `;
    return;
  }

  const topPlatformLabel = stats.topPlatform
    ? `${PLATFORM_LABELS[stats.topPlatform]} · ${(stats.topPlatformMins / 60).toFixed(1)}h`
    : '—';
  const topPlatformColor = stats.topPlatform ? platformColorVar(stats.topPlatform) : 'var(--cyan-color)';
  const streakVal = stats.streaks.current > 0 ? `${stats.streaks.current}d 🔥` : '0d';

  const cards = [
    statCard(fmtDuration(stats.totalMinutes), 'Total Watch Time'),
    statCard(stats.sessions.toLocaleString(), 'Lurk Sessions'),
    statCard(stats.streamerCount.toLocaleString(), 'Streamers Lurked'),
    statCard(fmtDuration(stats.avgPerSession), 'Avg / Session'),
    statCard(fmtDuration(stats.avgPerStreamer), 'Avg / Streamer'),
    statCard(fmtDuration(stats.longestSessionMin), 'Longest Session'),
    statCard(streakVal, 'Current Streak'),
    statCard(`${stats.streaks.longest}d`, 'Longest Streak'),
    statCard(topPlatformLabel, 'Top Platform', topPlatformColor),
  ].join('');

  const maxMinutes = stats.top?.minutes || 1;
  const rows = stats.streamers.map((s, idx) => {
    const pct = Math.max(4, (s.minutes / maxMinutes) * 100);
    const platColor = platformColorVar(s.platform);
    return `
      <div class="lb-row lb-row-clickable" data-key="${s.platform}:${s.username}" role="button" tabindex="0" title="View ${s.username}'s stats">
        <span class="lb-row-rank">${rankBadge(idx)}</span>
        <span class="platform-badge ${s.platform}" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background-color: ${platColor}; flex: 0 0 auto;">
          ${getPlatformSVG(s.platform)}
        </span>
        <div class="lb-row-main">
          <div class="lb-row-top">
            <span class="lb-row-name">${s.username}</span>
            <span class="lb-row-time">${fmtDuration(s.minutes)}</span>
          </div>
          <div class="lb-row-bar"><div style="width: ${pct}%; background-color: ${platColor};"></div></div>
        </div>
        <svg class="lb-row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </div>
    `;
  }).join('');

  const platTotal = PLATFORMS.reduce((sum, p) => sum + (isPlatformEnabled(p) ? (stats.platforms[p] || 0) : 0), 0) || 1;
  const platRows = PLATFORMS.filter(p => isPlatformEnabled(p)).map(p => {
    const m = stats.platforms[p] || 0;
    const pct = (m / platTotal) * 100;
    const color = platformColorVar(p);
    return `
      <div class="lb-plat-row">
        <span class="lb-plat-name"><span class="lb-plat-dot" style="background-color: ${color};"></span>${PLATFORM_LABELS[p]}</span>
        <div class="lb-plat-bar"><div style="width: ${pct}%; background-color: ${color};"></div></div>
        <span class="lb-plat-val">${fmtDuration(m)} · ${pct.toFixed(0)}%</span>
      </div>
    `;
  }).join('');

  const movies = Math.floor(stats.totalMinutes / 120);
  const funFact = movies >= 1
    ? `🍿 That's about <strong>${movies.toLocaleString()}</strong> feature-length ${movies === 1 ? 'movie' : 'movies'} worth of lurking.`
    : 'Keep lurking to unlock more stats!';

  host.innerHTML = `
    <div class="lb-stat-grid">${cards}</div>

    <div class="lb-section">
      <h4>Daily Activity <span class="lb-section-note">last 6 months</span></h4>
      ${buildHeatmap(stats.daily)}
    </div>

    <p class="lb-funfact">${funFact}</p>

    <div class="lb-columns">
      <div class="lb-section">
        <h4>Full Leaderboard</h4>
        <div class="lb-full-list">${rows || '<div class="lb-empty-sm">No streamer history yet.</div>'}</div>
      </div>

      <div class="lb-section">
        <h4>Watch Time by Platform</h4>
        <div class="lb-plat-list">${platRows}</div>
      </div>
    </div>
  `;
}

// Per-streamer drill-down shown when a leaderboard row is clicked.
function renderStreamerDetail(key) {
  const host = panelEl();
  if (!host) return;

  const d = getStreamerDetail(key);
  if (!d) { renderOverview(); return; }

  currentDetailKey = key;
  const platColor = platformColorVar(d.platform);

  const cards = [
    statCard(fmtDuration(d.minutes), 'Watch Time'),
    statCard(d.sessions.toLocaleString(), 'Lurk Sessions'),
    statCard(fmtDuration(d.avgPerSession), 'Avg / Session'),
    statCard(fmtDuration(d.longestMin), 'Longest Session'),
    statCard(fmtRelative(d.lastSeen), 'Last Lurked'),
    statCard(rankBadge(d.rank - 1), `Rank of ${d.total}`),
    statCard(`${d.shareOfTotal.toFixed(1)}%`, 'Of All Watch Time'),
    statCard(`${d.shareOfPlatform.toFixed(1)}%`, `Of ${PLATFORM_LABELS[d.platform]}`, platColor),
  ].join('');

  host.innerHTML = `
    <button class="lb-back-btn">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      Back to all stats
    </button>

    <div class="lb-detail-head">
      <span class="platform-badge ${d.platform}" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background-color: ${platColor}; flex: 0 0 auto;">
        ${getPlatformSVG(d.platform)}
      </span>
      <div class="lb-detail-id">
        <span class="lb-detail-name">${d.username}</span>
        <span class="lb-detail-sub">${PLATFORM_LABELS[d.platform]} · ranked #${d.rank} of ${d.total} lurked</span>
      </div>
    </div>

    <div class="lb-stat-grid">${cards}</div>
  `;
}

// Public entry point. Re-renders whichever view is open, so the minute-by-minute
// watch-time updates don't bounce the user out of a streamer's detail page.
export function renderLeaderboard() {
  if (!panelEl()) return;
  if (currentDetailKey) renderStreamerDetail(currentDetailKey);
  else renderOverview();
}

export function setupLeaderboard() {
  const host = panelEl();
  if (!host) return;

  // Delegated: the panel is re-rendered on every view switch and stats tick.
  host.addEventListener('click', (e) => {
    if (e.target.closest('.lb-back-btn')) { renderOverview(); return; }
    const row = e.target.closest('.lb-row-clickable');
    if (row?.dataset.key) renderStreamerDetail(row.dataset.key);
  });
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.lb-row-clickable');
    if (row?.dataset.key) { e.preventDefault(); renderStreamerDetail(row.dataset.key); }
  });

  renderLeaderboard();
}
