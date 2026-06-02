// Twitch Drops & Inventory module. Two responsibilities:
// (1) Background poller that scans active Twitch lurks for in-progress drops &
//     auto-claims channel points.
// (2) "Available Campaigns" panel: fetches all active drop campaigns from
//     Twitch GQL (split into watch-time vs sub-required), and lets the user
//     "Quest" by opening a drops-enabled stream in the chosen game category.

import { state, appendLogMessage } from './state.js';
import { autoClaimPointsScript, dropsQueryScript } from './inject.js';

const POLL_INTERVAL_MS = 30_000;
const CAMPAIGN_REFRESH_INTERVAL_MS = 5 * 60_000;
const QUEST_MONITOR_INTERVAL_MS = 45_000;
// Twitch only credits watch-time drops on up to 2 concurrent streams.
const MAX_TWITCH_STREAMS = 2;

let claimedDropsCount = 0;
let availableWatchCampaigns = [];
let availableSubCampaigns = [];
let availableFollowedCampaigns = [];

// Active "Quest for Drop" session, if any. While set, the monitor keeps this
// streamer open, fails over to the next category stream if they go offline, and
// closes the stream once the campaign reaches 100%.
let activeQuest = null; // { username, gameName, gameSlug, progress, openedAt }
let questMonitorId = null;

function updateDropsUI(campaigns) {
  const container = document.getElementById('drops-campaigns-list');
  const claimedDisplay = document.getElementById('claimed-drops-count');
  if (!container) return;

  const uniqueCampaigns = [];
  const seenIds = new Set();
  for (const c of campaigns) {
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    uniqueCampaigns.push(c);
  }

  if (claimedDisplay) claimedDisplay.textContent = claimedDropsCount;

  if (uniqueCampaigns.length === 0) {
    container.innerHTML = `
      <div class="no-drops-message">
        <p>No active drops progress yet. Lurk in a drops-enabled stream or click <strong>Quest</strong> on a campaign to begin.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  uniqueCampaigns.forEach(camp => {
    const isCompleted = camp.percentComplete >= 100;
    const progressFillWidth = Math.min(100, Math.max(0, camp.percentComplete));
    const gameName = camp.game?.name || 'Twitch Stream';

    const item = document.createElement('div');
    item.className = 'drop-campaign-item';
    item.innerHTML = `
      <div class="drop-info">
        <span class="drop-game-name">${gameName} (Lurking: ${camp.streamer})</span>
        <span class="drop-campaign-name">${camp.name}</span>
      </div>
      <div class="drop-progress-container">
        ${isCompleted ? `
          <span class="drop-completed-badge">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Earned
          </span>
        ` : `
          <div class="drop-progress-bar-wrapper">
            <div class="drop-progress-fill" style="width: ${progressFillWidth}%"></div>
          </div>
          <span class="drop-percentage">${progressFillWidth}%</span>
        `}
      </div>
    `;
    container.appendChild(item);

    if (isCompleted && !camp.__alreadyClaimedLogged) {
      camp.__alreadyClaimedLogged = true;
      claimedDropsCount++;
      if (claimedDisplay) claimedDisplay.textContent = claimedDropsCount;
      appendLogMessage(`[Drops] Auto-claimed Twitch Drop Campaign: ${camp.name}!`);
    }
  });
}

async function pollOnce() {
  const cfg = state.currentConfig;
  if (!cfg) return;

  const wantPoints = cfg.autoClaimPoints !== false;
  const wantDrops = cfg.autoClaimDrops !== false;
  if (!wantPoints && !wantDrops) {
    updateDropsUI([]);
    return;
  }

  const twitchCells = Array.from(document.querySelectorAll('.stream-grid-cell[data-platform="twitch"]'));
  if (twitchCells.length === 0) {
    updateDropsUI([]);
    return;
  }

  const totalCampaigns = [];

  for (const cell of twitchCells) {
    const webview = cell.querySelector('webview');
    const username = cell.dataset.username;
    if (!webview) continue;

    try {
      const isReady = await webview.executeJavaScript('!!document.cookie');
      if (!isReady) continue;

      if (wantPoints) {
        await webview.executeJavaScript(autoClaimPointsScript(username)).catch(err => console.error(err));
      }

      if (wantDrops) {
        const dropsData = await webview.executeJavaScript(dropsQueryScript);
        if (Array.isArray(dropsData) && dropsData.length > 0) {
          for (const camp of dropsData) {
            camp.streamer = username;
            totalCampaigns.push(camp);
          }
        }
      }
    } catch {
      // Webview might be in a transition state; skip silently.
    }
  }

  updateDropsUI(totalCampaigns);

  // Drop progress is account-wide (accumulated watch minutes), so track the max
  // we've ever seen for the quest streamer — it survives stream switches and the
  // occasional empty poll, and only moves up toward 100%.
  if (activeQuest) {
    const mine = totalCampaigns.filter(
      c => (c.streamer || '').toLowerCase() === activeQuest.username.toLowerCase()
    );
    if (mine.length) {
      const best = Math.max(...mine.map(c => c.percentComplete || 0));
      activeQuest.progress = Math.max(activeQuest.progress || 0, best);
    }
  }
}

// ─── Available Campaigns Panel ──────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatMinutes(mins) {
  if (!mins) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function buildCampaignCard(camp, category) {
  const game = camp.game || {};
  const isSub = (camp.category || category) === 'sub';
  const gameName = game.displayName || game.name || (isSub ? 'Twitch Reward' : 'Twitch Stream');
  const boxArt = game.boxArtURL || camp.imageURL || '';
  const endDate = camp.endAt ? new Date(camp.endAt) : null;
  const endLabel = endDate ? endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const hasGame = !!(game.name || game.displayName);

  const dropsHtml = (camp.drops || []).slice(0, 4).map(d => {
    const benefit = d.benefitEdges?.[0]?.benefit;
    const img = benefit?.imageAssetURL || '';
    const reqLabel = isSub
      ? `${d.requiredSubs || 1} sub${(d.requiredSubs || 1) > 1 ? 's' : ''}`
      : formatMinutes(d.requiredMinutesWatched);
    return `
      <div class="drop-reward-row">
        ${img ? `<img class="drop-reward-img" src="${escapeHtml(img)}" alt="" loading="lazy">` : '<div class="drop-reward-img placeholder"></div>'}
        <div class="drop-reward-meta">
          <span class="drop-reward-name">${escapeHtml(benefit?.name || d.name)}</span>
          <span class="drop-reward-req">${escapeHtml(reqLabel)}</span>
        </div>
      </div>
    `;
  }).join('');

  const pct = Math.round(camp.percentComplete || 0);
  const progressHtml = pct > 0 ? `
    <div class="drop-campaign-mini-progress">
      <div class="drop-progress-bar-wrapper" style="flex: 1; width: auto;">
        <div class="drop-progress-fill" style="width: ${Math.min(100, pct)}%"></div>
      </div>
      <span class="drop-percentage">${pct}%</span>
    </div>
  ` : '';

  // Watch campaigns get a Quest button (opens a drops stream). Sub/reward
  // campaigns are earned by subscribing, so show a details link instead —
  // unless the reward also has a watch goal in a known game.
  const showQuest = !isSub ? hasGame : (hasGame && camp.minuteWatchedGoal > 0);
  const questBtn = showQuest ? `
    <button class="btn btn-sm btn-violet btn-glow drop-quest-btn" title="Open a drops-enabled stream in this category">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Quest for Drop
    </button>
  ` : '';
  const detailsBtn = (isSub && camp.detailsURL) ? `
    <button class="btn btn-sm drop-link-account-btn" data-link-url="${escapeHtml(camp.detailsURL)}" title="View reward details on Twitch">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      View Details
    </button>
  ` : '';
  const linkBtn = (camp.accountLinkRequired && camp.accountLinkURL) ? `
    <button class="btn btn-sm drop-link-account-btn" data-link-url="${escapeHtml(camp.accountLinkURL)}" title="Link your game account to claim drops">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      Link Account
    </button>
  ` : '';

  return `
    <div class="drop-available-card glass-panel" data-game-name="${escapeHtml(game.name || '')}" data-game-slug="${escapeHtml(game.slug || '')}" data-campaign-id="${escapeHtml(camp.id)}">
      <div class="drop-available-header">
        ${boxArt ? `<img class="drop-game-box" src="${escapeHtml(boxArt)}" alt="" loading="lazy">` : '<div class="drop-game-box placeholder"></div>'}
        <div class="drop-available-titles">
          <span class="drop-game-name">${escapeHtml(gameName)}</span>
          <span class="drop-campaign-name">${escapeHtml(camp.name)}</span>
          ${endLabel ? `<span class="drop-campaign-ends">Ends ${endLabel}</span>` : ''}
        </div>
      </div>
      <div class="drop-rewards-grid">${dropsHtml}</div>
      ${progressHtml}
      <div class="drop-available-actions">
        ${linkBtn}
        ${detailsBtn}
        ${questBtn}
      </div>
    </div>
  `;
}

function renderFollowedCampaigns() {
  const section = document.getElementById('drops-followed-section');
  const list = document.getElementById('drops-followed-list');
  const count = document.getElementById('followed-campaigns-count');
  if (!section || !list) return;

  if (count) count.textContent = availableFollowedCampaigns.length;

  if (availableFollowedCampaigns.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  section.style.display = 'block';

  list.innerHTML = availableFollowedCampaigns.map(f => {
    const game = f.game || {};
    const gameName = game.displayName || game.name || 'Unknown game';
    const viewers = (f.viewersCount || 0).toLocaleString();
    return `
      <div class="drop-followed-card glass-panel" data-login="${escapeHtml(f.login)}" data-game-name="${escapeHtml(game.name || '')}" data-game-slug="${escapeHtml(game.slug || '')}">
        <div class="drop-followed-meta">
          <span class="drop-followed-name">${escapeHtml(f.displayName || f.login)}</span>
          <span class="drop-followed-game">${escapeHtml(gameName)} · ${viewers} viewers</span>
          <span class="drop-followed-campaign">${escapeHtml(f.campaignName || '')}</span>
        </div>
        <button class="btn btn-sm btn-violet btn-glow drop-prioritize-btn" title="Watch this streamer at top priority to earn the rewards">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          Prioritize
        </button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.drop-prioritize-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const card = e.target.closest('.drop-followed-card');
      const login = card?.dataset.login;
      if (!login) return;
      btn.disabled = true;
      btn.innerHTML = `<span class="pulse-dot"></span> Watching...`;
      try {
        // Same quest behaviour as "Quest for Drop": cap Twitch streams at 2,
        // monitor progress, fail over to the category if they go offline, and
        // release the slot once rewards are earned. Also pins them to the top of
        // the watch-priority queue.
        await beginQuest({
          username: login,
          gameName: card.dataset.gameName || '',
          gameSlug: card.dataset.gameSlug || '',
          prioritize: true
        });
        appendLogMessage(`[Drops] Prioritized ${login} — watching to earn rewards.`);
      } catch (err) {
        appendLogMessage(`[Drops] Prioritize failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          Prioritize
        `;
      }
    });
  });
}

function renderAvailableCampaigns() {
  const watchEl = document.getElementById('drops-available-watch');
  const subEl = document.getElementById('drops-available-sub');
  const watchCount = document.getElementById('watch-cat-count');
  const subCount = document.getElementById('sub-cat-count');
  const activeCount = document.getElementById('active-campaigns-count');
  if (!watchEl || !subEl) return;

  if (watchCount) watchCount.textContent = availableWatchCampaigns.length;
  if (subCount) subCount.textContent = availableSubCampaigns.length;
  if (activeCount) activeCount.textContent = availableWatchCampaigns.length + availableSubCampaigns.length;

  const renderList = (campaigns, container, cat) => {
    if (campaigns.length === 0) {
      container.innerHTML = `
        <div class="no-drops-message">
          <p>No active ${cat} campaigns right now. Click <strong>Refresh</strong> or check back later.</p>
        </div>
      `;
      return;
    }
    container.innerHTML = campaigns.map(c => buildCampaignCard(c, cat)).join('');
  };

  renderList(availableWatchCampaigns, watchEl, 'watch');
  renderList(availableSubCampaigns, subEl, 'sub');

  // Wire actions
  document.querySelectorAll('.drop-quest-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.drop-available-card');
      if (!card) return;
      questForDrop(card.dataset.gameName, card.dataset.gameSlug, btn);
    });
  });

  document.querySelectorAll('.drop-link-account-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.dataset.linkUrl;
      if (url) window.api.openExternal(url);
    });
  });
}

function getTwitchCells() {
  return Array.from(document.querySelectorAll('.stream-grid-cell[data-platform="twitch"]'));
}

// Keep open Twitch streams within MAX_TWITCH_STREAMS so drops keep crediting,
// never closing the quest stream itself. When trimming, keep the highest watch-
// priority channels (their order in config.streamers) and close the rest.
function enforceTwitchCap(keepUsername) {
  const keep = (keepUsername || '').toLowerCase();
  const others = getTwitchCells().filter(c => (c.dataset.username || '').toLowerCase() !== keep);
  const allowedOthers = Math.max(0, MAX_TWITCH_STREAMS - 1);
  if (others.length <= allowedOthers) return;

  const order = (state.currentConfig?.streamers || [])
    .filter(s => s.platform.toLowerCase() === 'twitch')
    .map(s => s.username.toLowerCase());
  const rank = u => {
    const i = order.indexOf((u || '').toLowerCase());
    return i === -1 ? Infinity : i;
  };
  others.sort((a, b) => rank(a.dataset.username) - rank(b.dataset.username));

  others.slice(allowedOthers).forEach(c => {
    appendLogMessage(`[Drops] Closing ${c.dataset.username} to stay within ${MAX_TWITCH_STREAMS} drop-earning streams.`);
    window.api.closeStreamContainer('twitch', c.dataset.username);
  });
}

function startQuest(quest) {
  activeQuest = { ...quest, progress: 0, openedAt: Date.now() };
  if (questMonitorId) clearInterval(questMonitorId);
  questMonitorId = setInterval(() => {
    monitorQuest().catch(err => console.error('Quest monitor error:', err?.message || err));
  }, QUEST_MONITOR_INTERVAL_MS);
}

// Nudge the Live Progress panel to refresh soon after a quest stream opens,
// instead of waiting for the next 30s poll. Staggered so it lands after the
// webview has loaded enough to answer the drops query.
function scheduleQuestPolls() {
  [6_000, 15_000, 25_000].forEach(delay => {
    setTimeout(() => {
      pollOnce().catch(err => console.error('Quest poll error:', err?.message || err));
    }, delay);
  });
}

// Shared entry point for both "Quest for Drop" and a followed-streamer
// "Prioritize": registers the quest, enforces the 2-stream cap, opens the
// stream (optionally pinning it to top watch priority), and refreshes progress.
async function beginQuest({ username, gameName, gameSlug, prioritize = false }) {
  startQuest({ username, gameName, gameSlug });
  enforceTwitchCap(username);
  if (prioritize) {
    await window.api.prioritizeStreamer('twitch', username);
  } else {
    await window.api.openStreamContainer('twitch', username);
  }
  scheduleQuestPolls();
}

function stopQuest({ closeStream = false } = {}) {
  if (questMonitorId) {
    clearInterval(questMonitorId);
    questMonitorId = null;
  }
  if (closeStream && activeQuest?.username) {
    window.api.closeStreamContainer('twitch', activeQuest.username);
  }
  activeQuest = null;
}

async function monitorQuest() {
  if (!activeQuest) return;

  // 1) Rewards earned — close the quest stream and hand the slot back to the
  //    normal watch-priority queue.
  if ((activeQuest.progress || 0) >= 100) {
    appendLogMessage(`[Drops] Rewards earned on ${activeQuest.username}. Closing quest stream and returning to the watch queue.`);
    stopQuest({ closeStream: true });
    return;
  }

  // 2) If the user manually closed the quest stream, end the quest quietly
  //    (allow a grace period for the cell to first appear after opening).
  const cellOpen = getTwitchCells().some(
    c => (c.dataset.username || '').toLowerCase() === activeQuest.username.toLowerCase()
  );
  if (!cellOpen && Date.now() - (activeQuest.openedAt || 0) > 20_000) {
    appendLogMessage(`[Drops] Quest stream ${activeQuest.username} was closed. Ending quest.`);
    stopQuest();
    return;
  }

  // Keep within the 2-stream drop cap.
  enforceTwitchCap(activeQuest.username);

  // 3) If the quest streamer went offline, fail over to the next top stream in
  //    the same category.
  const liveRes = await window.api.checkTwitchLive(activeQuest.username);
  if (liveRes && liveRes.success && !liveRes.live) {
    const offline = activeQuest.username;
    appendLogMessage(`[Drops] ${offline} went offline. Finding the next drops stream in ${activeQuest.gameName}...`);
    window.api.closeStreamContainer('twitch', offline);

    const next = await window.api.findDropsStream(activeQuest.gameName, activeQuest.gameSlug, [offline]);
    if (next?.success && next.username) {
      activeQuest.username = next.username;
      activeQuest.openedAt = Date.now();
      enforceTwitchCap(next.username);
      await window.api.openStreamContainer('twitch', next.username);
      appendLogMessage(`[Drops] Switched quest from ${offline} to ${next.username} to keep earning.`);
    } else {
      appendLogMessage(`[Drops] No other live drops stream found in ${activeQuest.gameName}. Ending quest.`);
      stopQuest();
    }
  }
}

async function questForDrop(gameName, gameSlug, btn) {
  if (!gameName) return;
  appendLogMessage(`[Drops] Questing for drop in category: ${gameName}...`);

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="pulse-dot"></span> Searching...`;
  }

  try {
    const res = await window.api.findDropsStream(gameName, gameSlug, []);
    if (!res?.success) {
      appendLogMessage(`[Drops] Quest failed: ${res?.error || 'No drops-enabled stream found.'}`);
      return;
    }

    if (res.username) {
      appendLogMessage(`[Drops] Questing on ${res.username} (${gameName}). It'll switch streams if they go offline and stop once rewards are earned.`);
      await beginQuest({ username: res.username, gameName, gameSlug, prioritize: false });
    } else if (res.directoryUrl) {
      appendLogMessage(`[Drops] No live drops-enabled stream found for ${gameName}. Opening directory in browser.`);
      window.api.openExternal(res.directoryUrl);
    }
  } catch (err) {
    appendLogMessage(`[Drops] Quest error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Quest for Drop
      `;
    }
  }
}

async function refreshAvailableCampaigns({ silent = false } = {}) {
  if (!silent) appendLogMessage('[Drops] Fetching available Twitch drop campaigns...');

  const res = await window.api.fetchDropCampaigns();
  if (!res?.success) {
    if (!silent) appendLogMessage(`[Drops] ${res?.error || 'Failed to fetch campaigns.'}`);
    const msg = `<div class="no-drops-message"><p>${escapeHtml(res?.error || 'Failed to fetch campaigns.')}</p></div>`;
    ['drops-available-watch', 'drops-available-sub'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = msg;
    });
    return;
  }

  availableWatchCampaigns = res.watchCampaigns || [];
  availableSubCampaigns = res.subCampaigns || [];
  availableFollowedCampaigns = res.followedCampaigns || [];
  renderFollowedCampaigns();
  renderAvailableCampaigns();
  if (!silent) {
    appendLogMessage(`[Drops] Loaded ${availableWatchCampaigns.length} watch + ${availableSubCampaigns.length} sub campaigns.`);
  }
}

function setupCategoryTabs() {
  const tabs = document.querySelectorAll('.drops-cat-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const cat = tab.dataset.cat;
      ['watch', 'sub'].forEach(c => {
        document.getElementById(`drops-available-${c}`)?.classList.toggle('active', c === cat);
      });
    });
  });
}

function setupRefreshButton() {
  document.getElementById('refresh-drops-campaigns-btn')?.addEventListener('click', () => {
    refreshAvailableCampaigns();
  });
}

export function startDropsPoller() {
  setupCategoryTabs();
  setupRefreshButton();

  // Initial fetch (delayed so login state has time to load)
  setTimeout(() => refreshAvailableCampaigns({ silent: true }), 2000);

  setInterval(() => {
    pollOnce().catch(err => console.error('Error in Drops poller:', err?.message || err));
  }, POLL_INTERVAL_MS);

  setInterval(() => {
    refreshAvailableCampaigns({ silent: true }).catch(err => console.error('Drops campaign refresh failed:', err));
  }, CAMPAIGN_REFRESH_INTERVAL_MS);
}
