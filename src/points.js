// Channel Points auto-claimer module.
// Background poller that scans active Twitch lurks and auto-claims channel points.

import { state, appendLogMessage } from './state.js';
import { autoClaimPointsScript } from './inject.js';

const POLL_INTERVAL_MS = 30_000;
// executeJavaScript has no timeout of its own, and against a crashed or hung
// guest it never settles. Past this a cell stops holding up the cells after it
// and the next poll.
const CLAIM_TIMEOUT_MS = 5_000;

let polling = false;
// Webviews whose last claim call has not settled. A timeout frees the poll but
// not the call: it stays pending, with a reply listener in main, until the
// guest answers. So a stuck guest gets no second call until the first one
// returns: at most one pending call per cell, never one more every 30 s.
const inFlight = new WeakSet();
// A call sent into a renderer that then dies, or a document that is then
// replaced, is never answered. multi-lurk.js recovers a crashed cell by
// reloading the same <webview>, so holding it until that call settles would
// skip the recovered cell for good. The bound is one pending call per page.
// Each event maps to whether this occurrence ends the page the call went into.
// Not did-start-loading: it fires when any frame starts loading, so in a hung
// guest every ad or embed load would release the hold and let one more
// never-answered call through. A navigation event carries its own frame and
// document flags, where a read of isLoadingMainFrame() in the handler would
// race the load it is asking about. A field that is missing reads as "release":
// a hold that is never released skips the cell for good, an early release
// costs one pending call.
const RELEASE_ON = {
  'render-process-gone': () => true,
  'destroyed': () => true,
  // Subframe and same-document (history API, as Twitch uses between channels)
  // navigations leave the page, and the call into it, where they were.
  'did-start-navigation': (e) => !e || (e.isMainFrame !== false && e.isInPlace !== true),
};

function holdWhilePending(webview, call) {
  let held = true;
  const listeners = [];
  const release = () => {
    // Once only: after a reload has released it, a late answer from the old
    // page must not clear the hold of a call made into the new one.
    if (!held) return;
    held = false;
    for (const [type, fn] of listeners) webview.removeEventListener(type, fn);
    inFlight.delete(webview);
  };
  inFlight.add(webview);
  for (const [type, endsPage] of Object.entries(RELEASE_ON)) {
    const fn = (e) => { if (endsPage(e)) release(); };
    listeners.push([type, fn]);
    webview.addEventListener(type, fn);
  }
  call.then(release, release);
}

// Worth calling into: attached, renderer alive, not mid-navigation. Main holds
// executeJavaScript until a loading page stops loading and never answers for a
// dead renderer, so calling into either only piles up pending calls.
function guestReady(cell, webview) {
  if (!cell.isConnected || !webview.isConnected) return false;
  // multi-lurk.js flags a crashed or failed page until a platform page loads
  // again (C6). A failed load leaves Chromium's error page up, alive and not
  // loading, so the checks below alone would still call into it.
  if (cell.dataset.crashed === 'true') return false;
  try {
    // Both throw until the webview is attached, which is also "not ready".
    return !webview.isCrashed() && !webview.isLoadingMainFrame();
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the page after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function claimOne(webview, username, timeoutMs, log) {
  try {
    // One round trip: the claim script is its own readiness probe, it does
    // nothing on a page without a chest.
    const call = webview.executeJavaScript(autoClaimPointsScript());
    holdWhilePending(webview, call);
    if (await withTimeout(call, timeoutMs) === true) {
      log(`[Rewards - ${username}] Claimed channel points chest!`);
    }
  } catch (err) {
    log(`[Points - ${username}] Polling process error: ${err.message || err}`);
  }
}

// One pass over the Twitch cells. Options exist for the tests; the app calls it
// with none.
export async function pollOnce({
  cells = Array.from(document.querySelectorAll('.stream-grid-cell[data-platform="twitch"]')),
  timeoutMs = CLAIM_TIMEOUT_MS,
  log = appendLogMessage,
} = {}) {
  const cfg = state.currentConfig;
  if (!cfg) return;

  const wantPoints = cfg.autoClaimPoints !== false;
  if (!wantPoints) return;

  const jobs = [];
  for (const cell of cells) {
    const webview = cell.querySelector('webview');
    if (!webview || inFlight.has(webview) || !guestReady(cell, webview)) continue;
    jobs.push(claimOne(webview, cell.dataset.username, timeoutMs, log));
  }
  // In parallel and settled, so one slow or broken cell never skips the rest.
  await Promise.allSettled(jobs);
}

// One poll at a time. Safe only because every call inside is bounded by
// CLAIM_TIMEOUT_MS: a busy flag over an unbounded await would stop claiming
// for good after the first hang.
export async function pollTick(options) {
  if (polling) return false;
  polling = true;
  try {
    await pollOnce(options);
  } finally {
    polling = false;
  }
  return true;
}

export function startPointsPoller() {
  setInterval(() => {
    pollTick().catch(err => console.error('Error in Points poller:', err?.message || err));
  }, POLL_INTERVAL_MS);
}
