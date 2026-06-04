// Channel Points auto-claimer module.
// Background poller that scans active Twitch lurks and auto-claims channel points.

import { state, appendLogMessage } from './state.js';
import { autoClaimPointsScript } from './inject.js';

const POLL_INTERVAL_MS = 30_000;

async function pollOnce() {
  const cfg = state.currentConfig;
  if (!cfg) return;

  const wantPoints = cfg.autoClaimPoints !== false;
  if (!wantPoints) return;

  const twitchCells = Array.from(document.querySelectorAll('.stream-grid-cell[data-platform="twitch"]'));
  if (twitchCells.length === 0) return;

  for (const cell of twitchCells) {
    const webview = cell.querySelector('webview');
    const username = cell.dataset.username;
    if (!webview) continue;

    try {
      const isReady = await webview.executeJavaScript('!!document.cookie');
      if (!isReady) continue;

      await webview.executeJavaScript(autoClaimPointsScript(username)).catch(err => console.error(err));
    } catch (err) {
      appendLogMessage(`[Points - ${username}] Polling process error: ${err.message || err}`);
    }
  }
}

export function startPointsPoller() {
  setInterval(() => {
    pollOnce().catch(err => console.error('Error in Points poller:', err?.message || err));
  }, POLL_INTERVAL_MS);
}
