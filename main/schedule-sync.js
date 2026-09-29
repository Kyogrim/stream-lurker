// Platform calendar sync (sync-platform-schedules). Tested with stalling and
// failing fetch stubs in test/main-schedule-sync.test.js.
//
// It used to start one request per streamer, all at once, with no deadline,
// and log one line per Kick streamer on every sync. One stalled connection
// left the IPC call pending for the rest of the session, so the calendar
// never refreshed again; dozens of Kick lines pushed the diagnostics users
// need out of the 200-line activity log. Now every request goes through the
// scanner's deadline helper, a few at a time, and Kick costs one line.
//
// A failed fetch is not an empty schedule. Both used to come back as [], and
// the dashboard saved the result, so an offline launch wiped every
// streamer's stored calendar with nothing to resync it for weeks (G4.5). Now
// a streamer whose fetch failed keeps its previous events, main stores the
// merged list itself, and a sync where every fetch failed stores nothing.

const { SCAN_REQUEST_TIMEOUT_MS, fetchTextWithDeadline, parseJsonBody } = require('./scan-fetch');
const { extractYtVideoTitle } = require('./youtube-live');

const SCHEDULE_CONCURRENCY = 3;
const SCHEDULE_BATCH_DELAY_MS = 300;
// Titles are the streamer's own text, saved to config.json and shown on the
// calendar. The renderer escapes them; this keeps what is stored bounded.
const MAX_TITLE = 200;
const MAX_FIELD = 200;
// The calendar shows today and the six days after it.
const CALENDAR_DAYS = 7;

// A stored text field: strings and numbers as text, anything else the fallback.
function textField(value, fallback, max = MAX_FIELD) {
  const s = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : '';
  return (s.trim() ? s : fallback).slice(0, max);
}

const TWITCH_SCHEDULE_QUERY = `query ChannelStartup($channelLogin: String!) {
          user(login: $channelLogin) {
            channel {
              schedule {
                segments {
                  id
                  startAt
                  endAt
                  title
                  isCancelled
                }
              }
            }
          }
        }`;

// "HH:MM" in local time, and the local weekday (0 = Sunday).
function slot(start) {
  return { day: start.getDay(), time: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) };
}

function parseTwitchSchedule(data, username) {
  const segments = (Array.isArray(data) ? data[0] : null)?.data?.user?.channel?.schedule?.segments;
  if (!Array.isArray(segments)) return [];
  return segments.filter(s => s && !s.isCancelled && typeof s.startAt === 'string' && s.startAt).map(s => {
    const start = new Date(s.startAt);
    return {
      id: textField(s.id, ''),
      streamer: String(username),
      platform: 'twitch',
      title: textField(s.title, 'Twitch Stream', MAX_TITLE),
      startAt: s.startAt,
      endAt: typeof s.endAt === 'string' ? s.endAt : null,
      ...slot(start),
      type: 'auto',
    };
  }).filter(ev => Number.isFinite(new Date(ev.startAt).getTime()));
}

// Why a Twitch schedule answer is not a schedule, or null when it is one. A
// query that ran and found no such user (renamed, deleted) or no segments is
// a real "no events"; treating it as a failure would keep a renamed
// channel's old events forever.
function twitchScheduleFailure(data) {
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry || typeof entry !== 'object') return 'unexpected response';
  if (Array.isArray(entry.errors) && entry.errors.length) {
    const first = entry.errors[0];
    const what = first && (first.message || (first.extensions && first.extensions.code));
    return `GQL error${typeof what === 'string' && what ? `: ${what.slice(0, 80)}` : ''}`;
  }
  if (!entry.data || typeof entry.data !== 'object') return 'unexpected response';
  return null;
}

// Checks for "upcomingEventData":{"startTime":"1716327000"} or
// "scheduledStartTime":"1716327000" on the channel's /live page.
function parseYoutubeSchedule(html, username) {
  const page = typeof html === 'string' ? html : '';
  let startTimeSec = null;
  const timeMatch = page.match(/"upcomingEventData":\s*{\s*"startTime":\s*"(\d+)"/);
  if (timeMatch) {
    startTimeSec = parseInt(timeMatch[1], 10);
  } else {
    const scheduledMatch = page.match(/"scheduledStartTime"\s*:\s*"(\d+)"/);
    if (scheduledMatch) startTimeSec = parseInt(scheduledMatch[1], 10);
  }
  if (!startTimeSec) return [];
  const start = new Date(startTimeSec * 1000);
  if (!Number.isFinite(start.getTime())) return [];
  return [{
    id: `yt-${username}-${startTimeSec}`,
    streamer: String(username),
    platform: 'youtube',
    title: textField(extractYtVideoTitle(page, 'YouTube Scheduled Stream'), 'YouTube Scheduled Stream', MAX_TITLE),
    startAt: start.toISOString(),
    ...slot(start),
    type: 'auto',
  }];
}

// Matches a stored event to a monitored streamer. Events keep the name as the
// config spells it, while the Twitch query lowercases it; a YouTube entry may
// be saved with or without its @.
function streamerKey(platform, username) {
  const p = String(platform || '').toLowerCase();
  let u = String(username == null ? '' : username).trim().toLowerCase();
  if (p === 'youtube') u = u.replace(/^@/, '');
  return `${p}:${u}`;
}

// Whether an event falls on one of the days the calendar shows (local time,
// today and the six after it). Older ones will never show again and only grew
// config.json; later ones come back with the next sync.
function inCalendarWindow(ev, now = new Date()) {
  const start = new Date(ev && ev.startAt);
  if (!Number.isFinite(start.getTime())) return false;
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const after = new Date(now.getFullYear(), now.getMonth(), now.getDate() + CALENDAR_DAYS);
  return start >= first && start < after;
}

// A previously stored event, carried over for a streamer whose fetch failed,
// with the fields the calendar reads made safe to read. null when unusable.
function carriedEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  if (typeof ev.startAt !== 'string' || !Number.isFinite(new Date(ev.startAt).getTime())) return null;
  const out = { ...ev, streamer: textField(ev.streamer, ''), title: textField(ev.title, 'Scheduled Stream', MAX_TITLE) };
  if ('id' in ev) out.id = textField(ev.id, '');
  if ('time' in ev) out.time = textField(ev.time, '');
  return out;
}

// The list to store: new events for every streamer that answered, previous
// events for every one that failed, within the calendar's week.
function mergeSchedules({ fresh = [], failed = [], previous = [], now = new Date() } = {}) {
  const failedKeys = new Set(failed.map(f => streamerKey(f.platform, f.username)));
  const kept = (Array.isArray(previous) ? previous : [])
    .map(carriedEvent)
    .filter(ev => ev && failedKeys.has(streamerKey(ev.platform, ev.streamer)));
  return [...fresh, ...kept].filter(ev => inCalendarWindow(ev, now));
}

// A sync where every fetch failed learned nothing: store nothing. One with no
// fetches at all (no Twitch or YouTube streamers left) does clear the list.
function shouldStoreSchedule(result) {
  return !!result && !(result.ok === 0 && Array.isArray(result.failed) && result.failed.length > 0);
}

function failureText(err) {
  return err && err.code === 'ETIMEDOUT' ? `timed out (${err.message})` : (err && err.message) || String(err);
}

// "Twitch schedules failed for 3 of 40 streamers: a (timed out (15s)), ..."
// One line per platform, however many failed: an outage must not flood the
// activity log either.
function failureSummary(platform, failures, total) {
  if (!failures.length) return null;
  const shown = failures.slice(0, 5).map(f => `${f.username} (${f.error})`).join(', ');
  const more = failures.length > 5 ? `, and ${failures.length - 5} more` : '';
  return `[Calendar] ${platform} schedules failed for ${failures.length} of ${total} streamer${total === 1 ? '' : 's'}: ${shown}${more}.`;
}

// deps:
//   fetch            net.fetch (or a stub)
//   userAgent        a string, or a function read on every request (main
//                    settles the spoofed UA only once the app is ready)
//   clientId
//   runParallel(list, fn, concurrency, delayMs)  main's checkStreamersParallel
//   log(text)
//   timeoutMs        per request, body included
// The fetchers resolve { events, error } and never reject. events is null
// when the fetch failed (the streamer keeps what is stored), [] when the
// platform answered and there is nothing scheduled.
function createScheduleSync({ fetch, userAgent, clientId, runParallel, log = () => {}, timeoutMs = SCAN_REQUEST_TIMEOUT_MS }) {
  const ua = () => (typeof userAgent === 'function' ? userAgent() : userAgent);

  async function fetchTwitchSchedule(username) {
    try {
      const response = await fetchTextWithDeadline(fetch, 'https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': clientId, 'Content-Type': 'application/json', 'User-Agent': ua() },
        body: JSON.stringify([{
          operationName: 'ChannelStartup',
          variables: { channelLogin: String(username).toLowerCase() },
          query: TWITCH_SCHEDULE_QUERY,
        }]),
      }, timeoutMs);
      if (!response.ok) return { events: null, error: `HTTP ${response.status}` };
      const data = parseJsonBody(response.text, 'Twitch schedule');
      // HTTP 200 is not success: a rejected query is a 200 with errors.
      const failure = twitchScheduleFailure(data);
      if (failure) return { events: null, error: failure };
      return { events: parseTwitchSchedule(data, username) };
    } catch (e) {
      return { events: null, error: failureText(e) };
    }
  }

  async function fetchYoutubeSchedule(username) {
    try {
      const name = String(username);
      const url = `https://www.youtube.com/${name.startsWith('@') ? name : `@${name}`}/live`;
      // The page is over 1 MB, so it gets the scanner's doubled deadline.
      const response = await fetchTextWithDeadline(fetch, url, {
        headers: { 'User-Agent': ua(), 'Accept-Language': 'en-US,en;q=0.9' },
      }, 2 * timeoutMs);
      if (!response.ok) return { events: null, error: `HTTP ${response.status}` };
      // Only a channel page can say "nothing scheduled". A consent
      // interstitial or an error page answers 200 too, and has no event
      // either.
      if (!/ytInitialData|ytInitialPlayerResponse/.test(response.text)) {
        return { events: null, error: 'not a YouTube channel page' };
      }
      return { events: parseYoutubeSchedule(response.text, username) };
    } catch (e) {
      return { events: null, error: failureText(e) };
    }
  }

  async function runPlatform(platform, label, usernames, fetchOne) {
    const results = await runParallel(usernames, fetchOne, SCHEDULE_CONCURRENCY, SCHEDULE_BATCH_DELAY_MS);
    const failures = [];
    const events = [];
    let ok = 0;
    results.forEach((r, i) => {
      if (r && Array.isArray(r.events)) {
        events.push(...r.events);
        ok++;
      } else {
        failures.push({ platform, username: usernames[i], error: (r && r.error) || 'no answer' });
      }
    });
    const summary = failureSummary(label, failures, usernames.length);
    if (summary) log(summary);
    return { events, failures, ok };
  }

  // Resolves { events, failed, ok }: events is the list to store (see
  // mergeSchedules), failed names each streamer whose fetch failed as
  // "platform:username", ok counts the fetches that answered. `previous` is
  // the stored list; nothing here writes it (see shouldStoreSchedule).
  async function syncSchedules({ twitch = [], youtube = [], kick = [], previous = [], now = () => new Date() } = {}) {
    log('[Calendar] Syncing platform calendars for Twitch and YouTube streams...');
    const results = [
      await runPlatform('twitch', 'Twitch', twitch, fetchTwitchSchedule),
      await runPlatform('youtube', 'YouTube', youtube, fetchYoutubeSchedule),
    ];
    // Kick has no public schedule API. One line per sync, not one per
    // streamer; a sync the user clicks still says why they got nothing.
    if (kick.length) {
      log(`[Calendar] Kick has no public schedule API; ${kick.length} Kick streamer${kick.length === 1 ? '' : 's'} skipped. Add manual calendar entries for them.`);
    }
    const fresh = results.flatMap(r => r.events);
    const failures = results.flatMap(r => r.failures);
    const ok = results.reduce((n, r) => n + r.ok, 0);
    const events = mergeSchedules({ fresh, failed: failures, previous, now: now() });
    const result = { events, failed: failures.map(f => `${f.platform}:${f.username}`), ok };
    if (!shouldStoreSchedule(result)) {
      log(`[Calendar] Sync failed for all ${failures.length} streamer${failures.length === 1 ? '' : 's'}, kept previous schedule.`);
    } else {
      if (failures.length) log(`[Calendar] Sync failed for ${failures.length} streamer${failures.length === 1 ? '' : 's'}, kept previous schedule for ${failures.length === 1 ? 'it' : 'them'}.`);
      log(`[Calendar] Sync complete. Detected ${fresh.length} platform scheduled segments.`);
    }
    return result;
  }

  return { fetchTwitchSchedule, fetchYoutubeSchedule, syncSchedules };
}

module.exports = {
  SCHEDULE_CONCURRENCY,
  failureSummary,
  MAX_TITLE,
  parseTwitchSchedule,
  twitchScheduleFailure,
  parseYoutubeSchedule,
  streamerKey,
  inCalendarWindow,
  mergeSchedules,
  shouldStoreSchedule,
  createScheduleSync,
};
