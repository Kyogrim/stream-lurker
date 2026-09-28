// Calendar placement, day rollover and platform schedule sync, run against the
// real src/calendar.js on the fake DOM from renderer-fake-dom.js:
//   F91  synced events are placed by date, and ones outside this week dropped
//   F97  the board rolls over at midnight and schedules re-sync all session,
//        without a timer sending the renderer's config snapshot to main
//   G4.5 a failed sync never replaces the stored schedule
// Run: node --test test/renderer-calendar-sync.test.js

'use strict';
// A zone with DST, set before any Date is made. Node applies TZ per process,
// and node --test runs each file in its own process.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, FakeElement } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
// Each test gets its own copy of calendar.js (timers, in-flight sync), while
// state.js stays shared, as in the app.
let fresh = 0;
const loadCalendar = () => import(`${pathToFileURL(path.join(ROOT, 'src/calendar.js')).href}?t=${++fresh}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const WED_NOON = at(2026, 9, 30, 12); // Wednesday 30 Sep 2026
const HOUR = 60 * 60 * 1000;

let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine: online }) });

// A <select> that behaves like one: rebuilding its options drops the choice.
function fakeSelect(doc, id) {
  const sel = doc.add('select', id);
  let chosen = null;
  const proto = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML');
  Object.defineProperty(sel, 'innerHTML', {
    get() { return proto.get.call(this); },
    set(v) { chosen = null; proto.set.call(this, v); },
  });
  Object.defineProperty(sel, 'value', {
    get() { return chosen ?? sel.children[0]?.value ?? ''; },
    set(v) { chosen = sel.children.some(o => o.value === v) ? v : null; },
  });
  return sel;
}

function setup({ api = {} } = {}) {
  const doc = createDocument();
  const consoleEl = doc.add('div', 'console-logs');
  doc.add('div', null, 'days-columns');
  const daySelect = fakeSelect(doc, 'event-day');
  const status = doc.add('span', 'calendar-sync-status');
  const syncBtn = doc.add('button', 'sync-calendar-btn');
  const listeners = {};
  const calls = [];
  const fullApi = {
    saveConfig: async (cfg) => { calls.push(['saveConfig', cfg]); return true; },
    syncPlatformSchedules: async () => { calls.push(['sync']); return []; },
    ...api,
  };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = doc;
  globalThis.window = {
    api: fullApi,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
  };
  const fire = (type) => { const fns = listeners[type] || []; listeners[type] = []; fns.forEach(fn => fn()); };
  const restore = () => Object.assign(globalThis, saved);
  return { doc, consoleEl, daySelect, status, syncBtn, listeners, calls, fire, restore };
}

function columns(doc) {
  return doc.querySelectorAll('.day-column').map(c => ({
    day: c.dataset.day,
    offset: c.dataset.offset,
    label: c.querySelector('.day-name').textContent,
    events: c.querySelectorAll('.calendar-event-card').map(card => ({
      title: card.querySelector('.cal-ev-title').textContent,
      time: card.querySelector('.cal-ev-time').textContent,
    })),
  }));
}

// A synced event as main stores it, with day/time deliberately wrong where a
// test wants to prove they are recomputed.
const synced = (title, start, extra = {}) => ({
  id: title, type: 'auto', platform: 'twitch', streamer: 's', title,
  startAt: start.toISOString(), day: start.getDay(), time: '00:00', ...extra,
});

let state;
test.before(async () => { ({ state } = await load('src/state.js')); });

// ── F91: placement ──────────────────────────────────────────────────────────

test('F91: placeCalendarEvent keeps dated events inside today..today+6, by local date', async () => {
  const { placeCalendarEvent } = await loadCalendar();
  const place = ev => placeCalendarEvent(ev, WED_NOON);

  assert.equal(place(synced('15 days out', at(2026, 10, 15, 20))), null);
  assert.equal(place(synced('7 days out', at(2026, 10, 7, 9))), null);
  assert.equal(place(synced('yesterday', at(2026, 9, 29, 23, 59))), null);
  assert.deepEqual(
    [place(synced('today late', at(2026, 9, 30, 23, 30))).offset, place(synced('today late', at(2026, 9, 30, 23, 30))).view.time],
    [0, '23:30'],
  );
  // Earlier today still shows: it is today's.
  assert.equal(place(synced('this morning', at(2026, 9, 30, 6))).offset, 0);
  const sixth = place(synced('6 days out', at(2026, 10, 6, 0, 0)));
  assert.equal(sixth.offset, 6);
  assert.equal(sixth.view.day, 2, 'Tuesday, from startAt');
  // The stored day and time are not trusted.
  const lying = place(synced('stale fields', at(2026, 10, 2, 18, 45), { day: 0, time: '03:00' }));
  assert.deepEqual([lying.offset, lying.view.day, lying.view.time], [2, 5, '18:45']);
  // An unusable day is fine when startAt is good; an unusable startAt is not.
  assert.equal(place(synced('no day', at(2026, 10, 1, 8), { day: 'x' })).offset, 1);
  assert.equal(place({ ...synced('bad start', at(2026, 10, 1, 8)), startAt: 'not a date' }), null);
  assert.equal(place({ ...synced('epoch', at(2026, 10, 1, 8)), startAt: 0 }), null, 'a number is a date too');
  assert.equal(place(null), null);
});

test('F91: placement survives DST changes (round, not floor)', async () => {
  const { placeCalendarEvent } = await loadCalendar();
  // US DST starts Sun 8 Mar 2026: Sat 00:00 to Mon 00:00 is 47 hours.
  const sat = at(2026, 3, 7, 12);
  assert.equal(placeCalendarEvent(synced('mon', at(2026, 3, 9, 10)), sat).offset, 2);
  assert.equal(placeCalendarEvent(synced('sun early', at(2026, 3, 8, 1, 30)), sat).offset, 1);
  // And ends Sun 1 Nov 2026: Sat 00:00 to Sun 00:00 is 24h, to Mon 49h.
  const oct31 = at(2026, 10, 31, 22);
  assert.equal(placeCalendarEvent(synced('sun', at(2026, 11, 1, 23)), oct31).offset, 1);
  assert.equal(placeCalendarEvent(synced('fri', at(2026, 11, 6, 23, 59)), oct31).offset, 6);
  assert.equal(placeCalendarEvent(synced('sat', at(2026, 11, 7, 0, 0)), oct31), null);
});

test('F91: manual events recur on their weekday and are never date-filtered', async () => {
  const { placeCalendarEvent } = await loadCalendar();
  const manual = day => ({ id: 'm', type: 'manual', day, time: '19:00', streamer: 'me', title: 'lurk', platform: 'kick' });
  assert.equal(placeCalendarEvent(manual(3), WED_NOON).offset, 0);
  assert.equal(placeCalendarEvent(manual(4), WED_NOON).offset, 1);
  assert.equal(placeCalendarEvent(manual(2), WED_NOON).offset, 6);
  assert.equal(placeCalendarEvent(manual(0), WED_NOON).offset, 4);
  assert.equal(placeCalendarEvent(manual(0), WED_NOON).view.time, '19:00');
  assert.equal(placeCalendarEvent({ ...manual(0), startAt: null }, WED_NOON).offset, 4);
  assert.equal(placeCalendarEvent({ ...manual(0), startAt: '' }, WED_NOON).offset, 4);
  assert.equal(placeCalendarEvent(manual(9), WED_NOON), null);
});

test('F91: the board shows this week only, each event under its own date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WED_NOON });
  const env = setup();
  t.after(env.restore);
  const { renderCalendar } = await loadCalendar();
  state.currentConfig = { calendarEvents: [{ id: 'm1', type: 'manual', day: 5, time: '20:00', streamer: 'me', title: 'friday lurk', platform: 'kick' }] };
  state.platformSchedules = [
    synced('fri this week', at(2026, 10, 2, 18)),
    synced('fri next week', at(2026, 10, 9, 18)),     // same weekday, 9 days out
    synced('in 15 days', at(2026, 10, 15, 18)),
    synced('last tuesday', at(2026, 9, 29, 18)),
    synced('today', at(2026, 9, 30, 21, 5), { day: 6, time: '99:99' }),
  ];
  renderCalendar();
  const cols = columns(env.doc);
  assert.deepEqual(cols.map(c => c.day), ['3', '4', '5', '6', '0', '1', '2']);
  assert.deepEqual(cols.map(c => c.offset), ['0', '1', '2', '3', '4', '5', '6']);
  assert.equal(cols[0].label, 'Today');
  assert.deepEqual(cols[0].events, [{ title: 'today', time: '21:05' }]);
  assert.deepEqual(cols[2].events.map(e => e.title), ['fri this week', 'friday lurk']);
  const all = cols.flatMap(c => c.events.map(e => e.title));
  for (const gone of ['fri next week', 'in 15 days', 'last tuesday']) assert.ok(!all.includes(gone), gone);
});

// ── F97: rollover ───────────────────────────────────────────────────────────

test('F97: msUntilNextLocalMidnight follows the local calendar, DST included', async () => {
  const { msUntilNextLocalMidnight } = await loadCalendar();
  assert.equal(msUntilNextLocalMidnight(at(2026, 9, 30, 23, 59)), 60 * 1000);
  assert.equal(msUntilNextLocalMidnight(at(2026, 9, 30, 0, 0)), 24 * HOUR);
  // 7 Mar -> 8 Mar 2026 is a normal day; 8 Mar itself has 23 hours.
  assert.equal(msUntilNextLocalMidnight(at(2026, 3, 8, 0, 0)), 23 * HOUR);
  assert.equal(msUntilNextLocalMidnight(at(2026, 11, 1, 0, 0)), 25 * HOUR);
});

test('F97: at midnight the Today column, the form labels and the date filter roll over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at(2026, 9, 30, 23, 59) });
  const env = setup();
  t.after(env.restore);
  const cal = await loadCalendar();
  state.currentConfig = { calendarEvents: [] };
  state.platformSchedules = [synced('wed night', at(2026, 9, 30, 22)), synced('next wed', at(2026, 10, 7, 22))];

  cal.setupCalendarHandlers(); // listens for the user picking a day
  cal.populateCalendarFormDays();
  cal.renderCalendar();
  cal.startCalendarAutoRefresh({ firstSyncDelayMs: 24 * HOUR });
  assert.equal(columns(env.doc)[0].day, '3');
  assert.deepEqual(columns(env.doc)[0].events.map(e => e.title), ['wed night']);
  assert.equal(env.daySelect.children[0].textContent, 'Today (Wednesday)');
  assert.equal(env.daySelect.value, '3', 'the untouched form defaults to Today');

  t.mock.timers.tick(61 * 1000);
  const cols = columns(env.doc);
  assert.equal(cols[0].day, '4', 'Thursday is Today now');
  assert.equal(cols[0].label, 'Today');
  assert.equal(cols[6].day, '3');
  assert.deepEqual(cols[6].events.map(e => e.title), ['next wed'], "last night's event is gone, next week's appears");
  assert.equal(env.daySelect.children[0].textContent, 'Today (Thursday)');
  assert.equal(env.daySelect.children[1].textContent, 'Tomorrow (Friday)');
  // Nobody touched the form: it follows Today, rather than keeping
  // Wednesday, which is now the last option, six days out.
  assert.equal(env.daySelect.value, '4', 'an untouched form reads the new Today');

  // The user picks Tuesday in a half-filled form. Only the 'change' a real
  // pick fires marks it; the rebuild setting .value does not.
  env.daySelect.value = '2';
  await env.daySelect.dispatch('change');
  // And again the next night: the timer re-arms itself.
  t.mock.timers.tick(24 * HOUR);
  assert.equal(columns(env.doc)[0].day, '5');
  assert.equal(env.daySelect.children[0].textContent, 'Today (Friday)');
  assert.equal(env.daySelect.value, '2', 'the picked weekday survives the rebuild');

  // A night whose render throws still leaves the timer armed for the next.
  // Watched at setTimeout itself: Node's mock re-runs a timer whose callback
  // threw (a browser drops it), which would hide a missing re-arm.
  const cfg = state.currentConfig;
  state.currentConfig = null;
  const armed = [];
  const mockedSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { armed.push(ms); return mockedSetTimeout(fn, ms, ...rest); };
  try {
    assert.throws(() => t.mock.timers.tick(24 * HOUR));
  } finally {
    globalThis.setTimeout = mockedSetTimeout;
  }
  assert.ok(armed.some(ms => ms > 23 * HOUR), `the next midnight was not armed (${armed})`);
  state.currentConfig = cfg;
  t.mock.timers.tick(24 * HOUR);
  assert.equal(columns(env.doc)[0].day, '0', 'Sunday renders after the failed Saturday');
});

test('F97: a late timer is corrected when the calendar tab or the window comes back', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(2026, 9, 30, 20) });
  const env = setup();
  t.after(env.restore);
  const calTab = env.doc.add('button', null, 'nav-btn');
  calTab.setAttribute('data-tab', 'calendar');
  const cal = await loadCalendar();
  cal.setupCalendarHandlers();
  state.currentConfig = { calendarEvents: [] };
  state.platformSchedules = [];
  cal.renderCalendar();
  assert.equal(cal.refreshCalendarIfDayChanged(), false, 'same day: nothing to do');

  t.mock.timers.setTime(at(2026, 10, 1, 7).getTime());
  await calTab.dispatch('click');
  assert.equal(columns(env.doc)[0].day, '4');
  t.mock.timers.setTime(at(2026, 10, 2, 7).getTime());
  env.listeners.focus.forEach(fn => fn());
  assert.equal(columns(env.doc)[0].day, '5');
});

// ── G4.5 / F97: sync ────────────────────────────────────────────────────────

test('G4.5: readScheduleSync understands both answers main can give', async () => {
  const { readScheduleSync } = await loadCalendar();
  const list = [{ id: 1 }];
  assert.deepEqual(readScheduleSync(list), { events: list, failed: null, ok: null, persisted: false });
  assert.deepEqual(readScheduleSync({ events: list, failed: ['twitch:a'], ok: 3, saved: true }), { events: list, failed: ['twitch:a'], ok: 3, persisted: true });
  assert.deepEqual(readScheduleSync({ events: [] }), { events: [], failed: [], ok: null, persisted: false });
  for (const junk of [null, undefined, 'x', 5, {}, { events: 'no' }]) assert.equal(readScheduleSync(junk), null);
});

test('G4.5: decideScheduleUpdate never trades the stored schedule for a failure', async () => {
  const { decideScheduleUpdate } = await loadCalendar();
  const now = WED_NOON;
  const upcoming = [synced('fri', at(2026, 10, 2, 18))];
  const past = [synced('last week', at(2026, 9, 23, 18))];
  const fresh = [synced('new', at(2026, 10, 3, 18))];

  assert.deepEqual(decideScheduleUpdate(upcoming, null, { now }), { keep: true, reason: 'unreadable' });
  // A main that reports failures: all failed keeps; some failed takes main's merge.
  assert.deepEqual(
    decideScheduleUpdate(upcoming, { events: upcoming, failed: ['twitch:a', 'twitch:b'], ok: 0, persisted: false }, { now }),
    { keep: true, reason: 'all-failed', failed: ['twitch:a', 'twitch:b'] },
  );
  assert.deepEqual(
    decideScheduleUpdate(upcoming, { events: fresh, failed: ['twitch:a'], ok: 4, persisted: true }, { now }),
    { keep: false, events: fresh, failed: ['twitch:a'] },
  );
  // No streamers at all is a real empty answer.
  assert.equal(decideScheduleUpdate(upcoming, { events: [], failed: [], ok: 0, persisted: true }, { now }).keep, false);
  // An older main's bare list: empty on a timer keeps anything still ahead...
  const legacyEmpty = { events: [], failed: null, ok: null, persisted: false };
  assert.deepEqual(decideScheduleUpdate(upcoming, legacyEmpty, { now }), { keep: true, reason: 'empty' });
  // ...but not a schedule that has already passed, or when the user asked.
  assert.equal(decideScheduleUpdate(past, legacyEmpty, { now }).keep, false);
  assert.equal(decideScheduleUpdate(upcoming, legacyEmpty, { manual: true, now }).keep, false);
  assert.equal(decideScheduleUpdate([], legacyEmpty, { now }).keep, false);
  assert.deepEqual(decideScheduleUpdate(upcoming, { events: fresh, failed: null, ok: null, persisted: false }, { now }), { keep: false, events: fresh, failed: [] });
});

test('F97/G4.5: background syncs repeat all session and never send the config snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: WED_NOON });
  const lists = [[synced('a', at(2026, 10, 1, 18))], [synced('b', at(2026, 10, 2, 18))]];
  let n = 0;
  const env = setup({ api: { syncPlatformSchedules: async () => { env.calls.push(['sync']); return lists[Math.min(n++, 1)]; } } });
  t.after(env.restore);
  const cal = await loadCalendar();
  state.currentConfig = { calendarEvents: [], syncedCalendarEvents: [] };
  state.platformSchedules = [];

  cal.startCalendarAutoRefresh({ firstSyncDelayMs: 5000 });
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(state.platformSchedules.map(e => e.title), ['a']);
  assert.deepEqual(state.currentConfig.syncedCalendarEvents.map(e => e.title), ['a']);
  assert.equal(columns(env.doc)[1].events[0].title, 'a');

  t.mock.timers.tick(cal.SCHEDULE_SYNC_INTERVAL_MS - 1);
  await flush();
  assert.equal(env.calls.filter(c => c[0] === 'sync').length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(env.calls.filter(c => c[0] === 'sync').length, 2);
  assert.deepEqual(state.platformSchedules.map(e => e.title), ['b']);
  assert.equal(env.calls.filter(c => c[0] === 'saveConfig').length, 0, 'a timer never saves the renderer config');
});

test('G4.5: an offline or empty background sync keeps the schedule and retries soon', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: WED_NOON });
  let answer = [];
  const env = setup({ api: { syncPlatformSchedules: async () => { env.calls.push(['sync']); return answer; } } });
  t.after(env.restore);
  const cal = await loadCalendar();
  const stored = [synced('stored fri', at(2026, 10, 2, 18))];
  state.currentConfig = { calendarEvents: [], syncedCalendarEvents: stored };
  state.platformSchedules = stored;
  const syncs = () => env.calls.filter(c => c[0] === 'sync').length;

  // Launch before Wi-Fi is up: no request at all.
  online = false;
  t.after(() => { online = true; });
  cal.startCalendarAutoRefresh({ firstSyncDelayMs: 5000 });
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(syncs(), 0);
  assert.equal(state.platformSchedules, stored);

  // The network comes back: one sync, which here comes back empty (VPN still
  // down, every fetch failed): the stored schedule stays.
  online = true;
  env.fire('online');
  await flush();
  assert.equal(syncs(), 1);
  assert.equal(state.platformSchedules, stored);
  assert.equal(state.currentConfig.syncedCalendarEvents, stored);
  assert.equal(env.calls.filter(c => c[0] === 'saveConfig').length, 0);

  // The loop retries in 30 minutes, not 6 hours, and then succeeds.
  answer = [synced('new sat', at(2026, 10, 3, 18))];
  t.mock.timers.tick(cal.SCHEDULE_SYNC_RETRY_MS);
  await flush();
  assert.equal(syncs(), 2);
  assert.deepEqual(state.platformSchedules.map(e => e.title), ['new sat']);
});

test('F97: nextScheduleSyncDelay backs off from 30 minutes to the 6 hour interval', async () => {
  const { nextScheduleSyncDelay, SCHEDULE_SYNC_INTERVAL_MS: SIX_H, SCHEDULE_SYNC_RETRY_MS: HALF_H } = await loadCalendar();
  assert.equal(SIX_H, 6 * HOUR);
  assert.equal(HALF_H, HOUR / 2);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50, 5000].map(nextScheduleSyncDelay),
    [SIX_H, HALF_H, HOUR, 2 * HOUR, 4 * HOUR, SIX_H, SIX_H, SIX_H, SIX_H]);
  for (const junk of [undefined, null, NaN, -3, 'x']) assert.equal(nextScheduleSyncDelay(junk), SIX_H, String(junk));
});

test('F97: a sync where only some streamers failed waits the full 6 hours, with no online retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: WED_NOON });
  const merged = [synced('merged', at(2026, 10, 1, 18))];
  // One deleted YouTube handle 404s on every sync; main merged and saved the
  // other twenty.
  const env = setup({
    api: { syncPlatformSchedules: async () => { env.calls.push(['sync']); return { events: merged, failed: ['youtube:gone'], ok: 20, saved: true }; } },
  });
  t.after(env.restore);
  const cal = await loadCalendar();
  state.currentConfig = { calendarEvents: [], syncedCalendarEvents: [] };
  state.platformSchedules = [];
  const syncs = () => env.calls.filter(c => c[0] === 'sync').length;

  cal.startCalendarAutoRefresh({ firstSyncDelayMs: 5000 });
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(syncs(), 1);
  assert.equal(state.platformSchedules, merged, 'the merge was taken');
  assert.equal((env.listeners.online || []).length, 0, 'no online retry for a sync that learned something');

  t.mock.timers.tick(cal.SCHEDULE_SYNC_RETRY_MS);
  await flush();
  assert.equal(syncs(), 1, 'not re-run after 30 minutes');
  t.mock.timers.tick(cal.SCHEDULE_SYNC_INTERVAL_MS - cal.SCHEDULE_SYNC_RETRY_MS - 1);
  await flush();
  assert.equal(syncs(), 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(syncs(), 2, 'the next sync runs at 6 h');

  // A whole day of it: 4 syncs and 8 calendar lines, not 49 and 98. Lines
  // are counted as they are appended: appendLogMessage keeps the console
  // element of whichever test logged first.
  const appended = t.mock.method(FakeElement.prototype, 'appendChild');
  for (let h = 0; h < 24; h += 6) {
    t.mock.timers.tick(6 * HOUR);
    await flush();
  }
  assert.equal(syncs(), 6);
  const lines = appended.mock.calls.map(c => c.arguments[0].textContent).filter(s => s.startsWith('[Calendar]'));
  assert.equal(lines.length, 8, lines.join('\n'));
  assert.match(lines.at(-1), /Background sync complete: 1 platform scheduled streams; 1 streamer\(s\) failed/);
  assert.equal((env.listeners.online || []).length, 0);
  assert.equal(env.calls.filter(c => c[0] === 'saveConfig').length, 0);
});

test('F97: syncs that learn nothing back off instead of retrying every 30 minutes forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: WED_NOON });
  let answer = () => ({ events: [], failed: ['twitch:a', 'youtube:b'], ok: 0, saved: false });
  const syncTimes = [];
  const env = setup({ api: { syncPlatformSchedules: async () => { syncTimes.push(Date.now()); return answer(); } } });
  t.after(env.restore);
  const errors = t.mock.method(console, 'error', () => {});
  const cal = await loadCalendar();
  const stored = [synced('stored fri', at(2026, 10, 2, 18))];
  state.currentConfig = { calendarEvents: [], syncedCalendarEvents: stored };
  state.platformSchedules = stored;

  cal.startCalendarAutoRefresh({ firstSyncDelayMs: 5000 });
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(syncTimes.length, 1);
  // Each retry in turn, timed in 15-minute steps. Every answer tells the
  // renderer nothing: all streamers failed, the IPC threw, or an older
  // main's empty list while the stored schedule is still ahead.
  const gaps = [];
  for (let i = 0; i < 6; i++) {
    if (i === 2) answer = () => { throw new Error('ipc down'); };
    if (i === 3) answer = () => [];
    const before = syncTimes.length;
    let waited = 0;
    while (syncTimes.length === before) {
      assert.ok(waited < 7 * HOUR, `retry ${i + 1} never came`);
      t.mock.timers.tick(15 * 60 * 1000);
      waited += 15 * 60 * 1000;
      await flush();
    }
    gaps.push(waited / HOUR);
  }
  assert.deepEqual(gaps, [0.5, 1, 2, 4, 6, 6]);
  assert.equal(errors.mock.callCount(), 1, 'the IPC failure was reported once');
  assert.equal(state.platformSchedules, stored, 'nothing learned, nothing replaced');
  assert.equal(env.calls.filter(c => c[0] === 'saveConfig').length, 0);

  // A sync that works resets it: the next one is 6 h out, and a failure
  // after that starts again at 30 minutes.
  answer = () => ({ events: [synced('fresh', at(2026, 10, 5, 18))], failed: [], ok: 3, saved: true });
  t.mock.timers.tick(6 * HOUR);
  await flush();
  assert.equal(state.platformSchedules[0].title, 'fresh');
  answer = () => ({ events: [], failed: ['twitch:a'], ok: 0, saved: false });
  const n = syncTimes.length;
  t.mock.timers.tick(6 * HOUR);
  await flush();
  assert.equal(syncTimes.length, n + 1);
  t.mock.timers.tick(cal.SCHEDULE_SYNC_RETRY_MS);
  await flush();
  assert.equal(syncTimes.length, n + 2, 'the backoff restarted at 30 minutes');
});

test('G4.5: the Sync button reports failed streamers and saves only for an older main', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WED_NOON });
  let answer;
  const env = setup({ api: { syncPlatformSchedules: async () => { env.calls.push(['sync']); return answer; } } });
  t.after(env.restore);
  const cal = await loadCalendar();
  cal.setupCalendarHandlers();
  const stored = [synced('stored', at(2026, 10, 2, 18))];
  state.currentConfig = { calendarEvents: [], syncedCalendarEvents: stored };
  state.platformSchedules = stored;
  const saves = () => env.calls.filter(c => c[0] === 'saveConfig').length;

  // A main that merges and saves: nothing for the renderer to save.
  const merged = [synced('merged', at(2026, 10, 1, 9)), stored[0]];
  answer = { events: merged, failed: ['twitch:flaky'], ok: 5, saved: true };
  await env.syncBtn.dispatch('click');
  assert.equal(state.platformSchedules, merged);
  assert.equal(saves(), 0);
  assert.equal(env.status.textContent, '1 streamer(s) could not be synced.');
  assert.equal(env.syncBtn.disabled, false);

  // Every fetch failed: keep, and say so.
  answer = { events: merged, failed: ['twitch:a', 'youtube:b'], ok: 0, saved: false };
  await env.syncBtn.dispatch('click');
  assert.equal(state.platformSchedules, merged);
  assert.equal(env.status.textContent, 'Sync failed; kept the previous schedule.');

  // An older main's bare list: the user asked, so it is taken and saved.
  answer = [];
  await env.syncBtn.dispatch('click');
  assert.deepEqual(state.platformSchedules, []);
  assert.equal(saves(), 1);
  assert.equal(env.status.textContent, '');

  // The IPC itself failing leaves everything as it was.
  state.platformSchedules = stored;
  env.calls.length = 0;
  answer = Promise.reject(new Error('ipc down'));
  answer.catch(() => {});
  await env.syncBtn.dispatch('click');
  assert.equal(state.platformSchedules, stored);
  assert.equal(env.status.textContent, 'Sync failed; kept the previous schedule.');
  assert.equal(env.syncBtn.disabled, false);
});

test('F97: one sync at a time; a click during a background sync joins it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: WED_NOON });
  let release;
  const env = setup({
    api: {
      syncPlatformSchedules: () => {
        env.calls.push(['sync']);
        return new Promise(resolve => { release = () => resolve([synced('x', at(2026, 10, 1, 18))]); });
      },
    },
  });
  t.after(env.restore);
  const cal = await loadCalendar();
  cal.setupCalendarHandlers();
  state.currentConfig = { calendarEvents: [] };
  state.platformSchedules = [];

  cal.startCalendarAutoRefresh({ firstSyncDelayMs: 5000 });
  t.mock.timers.tick(5000);
  await flush();
  const click = env.syncBtn.dispatch('click');
  const direct = cal.syncPlatformSchedules({ manual: true });
  assert.equal(env.calls.filter(c => c[0] === 'sync').length, 1);
  release();
  await click;
  await direct;
  assert.deepEqual(state.platformSchedules.map(e => e.title), ['x']);
  // Once it has settled, the next request starts a new run.
  cal.syncPlatformSchedules({ manual: true });
  assert.equal(env.calls.filter(c => c[0] === 'sync').length, 2);
  release();
  await flush();
});
