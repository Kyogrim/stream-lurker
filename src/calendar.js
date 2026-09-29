// Weekly calendar view with manual events and platform-synced schedules.

import { state, appendLogMessage, platformColorVar, escapeHtml } from './state.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Events are replayed from config at every launch: synced ones carry schedule
// titles set by the streamer (or a channel editor), and importConfig merges
// arbitrary files. So an entry is reduced to plain strings plus a day that is
// an integer 0-6, and anything that can't be placed returns null instead of
// throwing and taking the whole calendar down.
export function normalizeCalendarEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Number(null), Number('') and Number([]) are all 0, so only numbers and
  // numeric strings count; anything else is not a day.
  const day = typeof ev.day === 'number' || (typeof ev.day === 'string' && ev.day.trim())
    ? Number(ev.day) : NaN;
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  return {
    day,
    time: String(ev.time ?? ''),
    streamer: String(ev.streamer ?? ''),
    title: String(ev.title ?? ''),
    platform: String(ev.platform ?? ''),
    isAuto: ev.type === 'auto',
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDayStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hasStartAt(ev) {
  return ev.startAt !== undefined && ev.startAt !== null && ev.startAt !== '';
}

// Where an event goes in the seven columns that start today (offset 0), with
// the view to render, or null when it doesn't belong on this week's board.
// Synced events carry startAt and are dated: one outside today..today+6 is
// dropped instead of landing under this week's same weekday, and its day and
// time are recomputed here in local time, because the stored ones were
// computed at sync time and go stale in a long session. Manual events have no
// startAt and recur weekly on their `day`, so they are never date-filtered.
export function placeCalendarEvent(ev, now = new Date()) {
  if (!ev || typeof ev !== 'object') return null;
  const today = localDayStart(now);
  if (!hasStartAt(ev)) {
    const view = normalizeCalendarEvent(ev);
    return view && { view, offset: (view.day - today.getDay() + 7) % 7 };
  }
  const start = new Date(ev.startAt);
  if (Number.isNaN(start.getTime())) return null;
  // Round, not floor: across a DST change two local midnights are 23 or 25
  // hours apart.
  const offset = Math.round((localDayStart(start) - today) / DAY_MS);
  if (offset < 0 || offset > 6) return null;
  const view = normalizeCalendarEvent({ ...ev, day: start.getDay(), time: hhmm(start) });
  return view && { view, offset };
}

// A synced event that is still worth showing: today or later, or undated.
function isUpcoming(ev, now) {
  if (!ev || typeof ev !== 'object' || !hasStartAt(ev)) return true;
  const start = new Date(ev.startAt);
  return Number.isNaN(start.getTime()) || start >= localDayStart(now);
}

function eventFormEls() {
  return {
    form: document.getElementById('add-event-form'),
    streamer: document.getElementById('event-streamer'),
    platform: document.getElementById('event-platform'),
    day: document.getElementById('event-day'),
    time: document.getElementById('event-time'),
    title: document.getElementById('event-title'),
  };
}

// Set by a 'change' on the day <select>: only a weekday the user chose is
// kept across the midnight rebuild. The untouched default is the first
// option, Today; kept, yesterday's value would sit six days out, and an event
// added without looking would land a week late.
let dayPickedByUser = false;

export function populateCalendarFormDays() {
  const daySelect = document.getElementById('event-day');
  if (!daySelect) return;
  // Rebuilt at midnight to move the Today/Tomorrow labels; keep the weekday
  // the user had picked in a half-filled form.
  const picked = dayPickedByUser ? daySelect.value : '';
  daySelect.innerHTML = '';
  const today = new Date().getDay();
  for (let i = 0; i < 7; i++) {
    const dayVal = (today + i) % 7;
    const option = document.createElement('option');
    option.value = String(dayVal);
    if (i === 0) option.textContent = `Today (${DAY_NAMES[dayVal]})`;
    else if (i === 1) option.textContent = `Tomorrow (${DAY_NAMES[dayVal]})`;
    else option.textContent = DAY_NAMES[dayVal];
    daySelect.appendChild(option);
  }
  if (picked) daySelect.value = picked;
}

function buildDayColumn(dayVal, offset, label, headerStyle, colStyle) {
  const colDiv = document.createElement('div');
  colDiv.className = 'day-column';
  colDiv.dataset.day = String(dayVal);
  colDiv.dataset.offset = String(offset);
  colDiv.style.cssText = colStyle;
  colDiv.innerHTML = `
    <div class="day-name" style="font-size: 0.85rem; font-weight: 700; text-align: center; border-bottom: 1px solid var(--panel-border); padding-bottom: 6px; ${escapeHtml(headerStyle)}">${escapeHtml(label)}</div>
    <div class="day-events-list" style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1; overflow-y: auto;"></div>
  `;
  return colDiv;
}

export function renderCalendar() {
  const daysColumnsContainer = document.querySelector('.days-columns');
  if (!daysColumnsContainer) return;
  daysColumnsContainer.innerHTML = '';

  const now = new Date();
  renderedDayKey = dayKey(now);
  const today = now.getDay();
  const baseColStyle = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    background-color: hsla(240, 5.9%, 15%, 0.15);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius-md);
    padding: 10px;
    min-height: 350px;
    transition: var(--transition);
  `;
  const todayColStyle = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    background-color: hsla(142, 70%, 10%, 0.2);
    border: 2px solid #00ff66;
    box-shadow: 0 0 15px rgba(0, 255, 102, 0.15);
    border-radius: var(--radius-md);
    padding: 10px;
    min-height: 350px;
    transition: var(--transition);
  `;
  const tomorrowColStyle = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    background-color: hsla(263, 70%, 10%, 0.2);
    border: 1.5px dashed #8b5cf6;
    border-radius: var(--radius-md);
    padding: 10px;
    min-height: 350px;
    transition: var(--transition);
  `;

  for (let i = 0; i < 7; i++) {
    const dayVal = (today + i) % 7;
    let label = DAY_NAMES[dayVal];
    let headerStyle = 'color: var(--cyan-color);';
    let colStyle = baseColStyle;
    if (i === 0) {
      label = 'Today';
      headerStyle = 'color: #00ff66; text-shadow: 0 0 8px rgba(0, 255, 102, 0.4);';
      colStyle = todayColStyle;
    } else if (i === 1) {
      label = 'Tomorrow';
      headerStyle = 'color: #8b5cf6; text-shadow: 0 0 8px rgba(139, 92, 246, 0.4);';
      colStyle = tomorrowColStyle;
    }
    daysColumnsContainer.appendChild(buildDayColumn(dayVal, i, label, headerStyle, colStyle));
  }

  const asList = v => (Array.isArray(v) ? v : []);
  const allEvents = [...asList(state.currentConfig.calendarEvents), ...asList(state.platformSchedules)]
    .map(ev => ({ ev, placed: placeCalendarEvent(ev, now) }))
    .filter(entry => entry.placed);
  if (allEvents.length === 0) return;

  // Within one column every event is on the same date, so "HH:MM" order is
  // time order.
  allEvents.sort((a, b) => a.placed.view.time.localeCompare(b.placed.view.time));

  allEvents.forEach(({ ev, placed: { view, offset } }) => {
    const dayCol = daysColumnsContainer.querySelector(`.day-column[data-offset="${offset}"]`);
    const list = dayCol?.querySelector('.day-events-list');
    if (!list) return;

    const isAuto = view.isAuto;
    const platColor = platformColorVar(view.platform);

    const eventCard = document.createElement('div');
    eventCard.className = `calendar-event-card ${isAuto ? 'auto' : 'manual'}`;
    eventCard.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      background-color: hsla(240, 5.9%, 15%, 0.35);
      border-left: 3px solid ${platColor};
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      position: relative;
      transition: var(--transition);
      cursor: pointer;
    `;
    // Fixed markup only; the event's own strings go in through textContent and
    // the title property below, never through the HTML parser.
    eventCard.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 700;">
        <span class="cal-ev-streamer" style="color: var(--text-primary); font-size: 0.72rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75px;"></span>
        <span class="cal-ev-time" style="font-family: var(--font-mono); color: var(--cyan-color); font-size: 0.65rem;"></span>
      </div>
      <div class="cal-ev-title" style="color: var(--text-secondary); font-size: 0.68rem; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 105px;"></div>
      ${!isAuto ? `
        <button class="delete-event-btn" style="position: absolute; top: 2px; right: 2px; background: none; border: none; color: var(--text-muted); font-size: 0.75rem; cursor: pointer; opacity: 0; transition: var(--transition); line-height: 1;">×</button>
      ` : ''}
    `;
    eventCard.querySelector('.cal-ev-streamer').textContent = view.streamer;
    eventCard.querySelector('.cal-ev-time').textContent = view.time;
    const titleEl = eventCard.querySelector('.cal-ev-title');
    titleEl.textContent = view.title;
    titleEl.title = view.title;

    if (!isAuto) {
      const delBtn = eventCard.querySelector('.delete-event-btn');
      eventCard.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
      eventCard.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        state.currentConfig.calendarEvents = state.currentConfig.calendarEvents.filter(event => event.id !== ev.id);
        await window.api.saveConfig(state.currentConfig);
        appendLogMessage(`[Calendar] Removed manual scheduled event for ${view.streamer}.`);
        renderCalendar();
      });
    }

    list.appendChild(eventCard);
  });
}

// ── Day rollover ─────────────────────────────────────────────────────────────
// The app runs unattended for weeks. The columns, the Today/Tomorrow labels and
// the date filter above are all relative to "now", so they are recomputed at
// each local midnight, and again whenever the window or the tab comes back in
// case a throttled or suspended timer fired late.

let renderedDayKey = '';
let midnightTimer = null;

export function msUntilNextLocalMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
}

export function refreshCalendarIfDayChanged() {
  if (!renderedDayKey || renderedDayKey === dayKey(new Date())) return false;
  populateCalendarFormDays();
  renderCalendar();
  return true;
}

function scheduleMidnightRefresh() {
  clearTimeout(midnightTimer);
  // A second of slack so the timer never lands a hair before midnight.
  midnightTimer = setTimeout(() => {
    // Re-armed even if a render throws, or the board freezes on that day.
    try { refreshCalendarIfDayChanged(); } finally { scheduleMidnightRefresh(); }
  }, msUntilNextLocalMidnight() + 1000);
}

// ── Platform schedule sync ───────────────────────────────────────────────────
// Runs from the Sync button, shortly after launch, and every few hours after
// that, one run at a time. A sync that fails must never cost the stored
// schedule: an offline launch used to save "no events" over every streamer's
// calendar, with nothing to resync it for the rest of a weeks-long session.

export const SCHEDULE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SCHEDULE_SYNC_RETRY_MS = 30 * 60 * 1000;

// The answer from sync-platform-schedules, in either shape main can give: the
// bare list (older main, which can't tell a failed fetch from an empty
// schedule, and doesn't save), or { events, failed, ok, saved } from a main
// that keeps failed streamers' previous events and saves the merged list.
// null when it is neither.
export function readScheduleSync(res) {
  if (Array.isArray(res)) return { events: res, failed: null, ok: null, persisted: false };
  if (!res || typeof res !== 'object' || !Array.isArray(res.events)) return null;
  return {
    events: res.events,
    failed: Array.isArray(res.failed) ? res.failed.map(String) : [],
    ok: Number.isFinite(res.ok) ? res.ok : null,
    persisted: res.saved === true,
  };
}

// What to do with a sync result, given the events shown now. { keep: true }
// leaves the stored schedule alone.
export function decideScheduleUpdate(previous, result, { manual = false, now = new Date() } = {}) {
  const prev = Array.isArray(previous) ? previous : [];
  if (!result) return { keep: true, reason: 'unreadable' };
  if (result.failed !== null) {
    // Main already merged: failed streamers keep their previous events.
    if (result.ok === 0 && result.failed.length > 0) return { keep: true, reason: 'all-failed', failed: result.failed };
    return { keep: false, events: result.events, failed: result.failed };
  }
  // An older main: an empty list is indistinguishable from every fetch
  // failing. An automatic sync doesn't bet the stored schedule on it while
  // any of that schedule is still ahead; a manual one does what was asked.
  if (!manual && result.events.length === 0 && prev.some(ev => isUpcoming(ev, now))) {
    return { keep: true, reason: 'empty' };
  }
  return { keep: false, events: result.events, failed: [] };
}

let syncInFlight = null;
let syncTimer = null;
let onlineRetryArmed = false;

function setSyncStatus(text) {
  const el = document.getElementById('calendar-sync-status');
  if (el) el.textContent = text;
}

// Resolves to { ok, learned }. ok: every streamer answered. learned: the
// stored schedule was updated, which includes a sync where some streamers
// failed, since main merged and saved the rest. learned is false only when
// the sync told us nothing (offline skip, every fetch failed, an empty
// answer from an older main, an unreadable one); only that is worth retrying
// early. A partial failure retried every 30 minutes just re-fetches the same
// broken streamer (a deleted handle 404s forever) and floods the log.
async function runScheduleSync(manual) {
  const previous = Array.isArray(state.platformSchedules) ? state.platformSchedules : [];
  if (!manual && navigator.onLine === false) {
    appendLogMessage('[Calendar] Offline; skipped the background schedule sync until the network is back.');
    return { ok: false, learned: false };
  }
  if (!manual) appendLogMessage('[Calendar] Running background scheduled calendar sync...');

  const result = readScheduleSync(await window.api.syncPlatformSchedules());
  const update = decideScheduleUpdate(previous, result, { manual });
  if (update.keep) {
    const why = update.reason === 'all-failed'
      ? `failed for all ${update.failed.length} streamers`
      : update.reason === 'empty' ? 'came back empty (network trouble?)' : 'gave an unreadable answer';
    appendLogMessage(`[Calendar] Schedule sync ${why}; kept the previous schedule.`);
    if (manual) setSyncStatus('Sync failed; kept the previous schedule.');
    return { ok: false, learned: false };
  }

  state.platformSchedules = update.events;
  if (state.currentConfig) state.currentConfig.syncedCalendarEvents = update.events;
  // A main that saves the merged list itself is the only writer. For an older
  // one, only a sync the user asked for saves: a timer sending this renderer's
  // config snapshot back would overwrite whatever main changed since launch.
  if (manual && !result.persisted) await window.api.saveConfig(state.currentConfig);
  renderCalendar();

  const failedNote = update.failed.length
    ? `; ${update.failed.length} streamer(s) failed and kept their previous schedule`
    : '';
  appendLogMessage(`[Calendar] ${manual ? 'Synced' : 'Background sync complete:'} ${update.events.length} platform scheduled streams${failedNote}.`);
  if (manual) {
    setSyncStatus(update.failed.length ? `${update.failed.length} streamer(s) could not be synced.` : '');
  }
  return { ok: update.failed.length === 0, learned: true };
}

// One sync at a time: a click while the timer's sync runs joins that run.
export function syncPlatformSchedules({ manual = false } = {}) {
  if (!syncInFlight) {
    syncInFlight = runScheduleSync(manual).finally(() => { syncInFlight = null; });
  }
  return syncInFlight;
}

// The wait before the next background sync, given how many in a row learned
// nothing. A sync that learned something waits the full interval; one that
// did not retries sooner, doubling from SCHEDULE_SYNC_RETRY_MS with each
// consecutive miss up to the full interval, so a lasting failure (a network
// that blocks the platforms) settles at the normal cadence.
export function nextScheduleSyncDelay(consecutiveFailures) {
  const n = Math.floor(Number(consecutiveFailures)) || 0;
  if (n <= 0) return SCHEDULE_SYNC_INTERVAL_MS;
  return Math.min(SCHEDULE_SYNC_RETRY_MS * 2 ** (n - 1), SCHEDULE_SYNC_INTERVAL_MS);
}

let syncFailures = 0;
let backgroundRun = null;

async function backgroundSyncOnce() {
  let learned = false;
  try {
    learned = (await syncPlatformSchedules()).learned === true;
  } catch (err) {
    console.error('Background calendar sync failed:', err);
  }
  syncFailures = learned ? 0 : syncFailures + 1;
  if (!learned) armOnlineRetry();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runBackgroundSync, nextScheduleSyncDelay(syncFailures));
}

// One loop iteration at a time, whether the timer or a reconnect started it.
function runBackgroundSync() {
  if (!backgroundRun) backgroundRun = backgroundSyncOnce().finally(() => { backgroundRun = null; });
  return backgroundRun;
}

function armOnlineRetry() {
  if (onlineRetryArmed) return;
  onlineRetryArmed = true;
  window.addEventListener('online', () => {
    onlineRetryArmed = false;
    // A reconnect is news: sync now, in place of the pending retry, and
    // restart the backoff.
    syncFailures = 0;
    runBackgroundSync();
  }, { once: true });
}

// Started once the dashboard is up: the first sync after `firstSyncDelayMs`,
// then every SCHEDULE_SYNC_INTERVAL_MS, or sooner after a sync that learned
// nothing (see nextScheduleSyncDelay). Also arms the midnight rollover.
export function startCalendarAutoRefresh({ firstSyncDelayMs = 5000 } = {}) {
  scheduleMidnightRefresh();
  syncFailures = 0;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runBackgroundSync, firstSyncDelayMs);
}

export function setupCalendarHandlers() {
  // Opening the tab, or coming back to the window, corrects a stale day.
  document.querySelector('.nav-btn[data-tab="calendar"]')?.addEventListener('click', refreshCalendarIfDayChanged);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshCalendarIfDayChanged();
  });
  window.addEventListener('focus', refreshCalendarIfDayChanged);
  // Only a real pick fires 'change'; the rebuild setting .value does not.
  document.getElementById('event-day')?.addEventListener('change', () => { dayPickedByUser = true; });

  const syncBtn = document.getElementById('sync-calendar-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.innerHTML = `<span class="pulse-dot"></span> Syncing...`;
      setSyncStatus('');
      try {
        await syncPlatformSchedules({ manual: true });
      } catch (err) {
        appendLogMessage(`[Calendar] Sync failed: ${err.message}`);
        setSyncStatus('Sync failed; kept the previous schedule.');
      } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = `
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Sync Platform Schedules
        `;
      }
    });
  }

  const { form, streamer, platform, day, time, title } = eventFormEls();
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const streamerVal = streamer.value.trim();
    const timeVal = time.value;
    if (!streamerVal || !timeVal) return;

    const newEvent = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      streamer: streamerVal,
      platform: platform.value,
      day: parseInt(day.value, 10),
      time: timeVal,
      title: title.value.trim() || 'Custom Lurk Session',
      type: 'manual',
    };

    if (!state.currentConfig.calendarEvents) state.currentConfig.calendarEvents = [];
    state.currentConfig.calendarEvents.push(newEvent);
    await window.api.saveConfig(state.currentConfig);

    streamer.value = '';
    title.value = '';
    time.value = '';

    appendLogMessage(`[Calendar] Added manual event for ${streamerVal} on ${newEvent.platform.toUpperCase()}.`);
    renderCalendar();
  });
}
