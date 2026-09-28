// Platform calendar sync (sync-platform-schedules). Tested with stalling and
// failing fetch stubs in test/main-schedule-sync.test.js.
//
// It used to start one request per streamer, all at once, with no deadline,
// and log one line per Kick streamer on every sync. One stalled connection
// left the IPC call pending for the rest of the session, so the calendar
// never refreshed again; dozens of Kick lines pushed the diagnostics users
// need out of the 200-line activity log. Now every request goes through the
// scanner's deadline helper, a few at a time, and Kick costs one line.

const { SCAN_REQUEST_TIMEOUT_MS, fetchTextWithDeadline, parseJsonBody } = require('./scan-fetch');
const { extractYtVideoTitle } = require('./youtube-live');

const SCHEDULE_CONCURRENCY = 3;
const SCHEDULE_BATCH_DELAY_MS = 300;

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
  return segments.filter(s => s && !s.isCancelled && s.startAt).map(s => {
    const start = new Date(s.startAt);
    return {
      id: s.id,
      streamer: username,
      platform: 'twitch',
      title: s.title || 'Twitch Stream',
      startAt: s.startAt,
      endAt: s.endAt,
      ...slot(start),
      type: 'auto',
    };
  }).filter(ev => Number.isFinite(new Date(ev.startAt).getTime()));
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
  return [{
    id: `yt-${username}-${startTimeSec}`,
    streamer: username,
    platform: 'youtube',
    title: extractYtVideoTitle(page, 'YouTube Scheduled Stream'),
    startAt: start.toISOString(),
    ...slot(start),
    type: 'auto',
  }];
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
// The fetchers resolve { events, error } and never reject.
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
      if (!response.ok) return { events: [], error: `HTTP ${response.status}` };
      return { events: parseTwitchSchedule(parseJsonBody(response.text, 'Twitch schedule'), username) };
    } catch (e) {
      return { events: [], error: failureText(e) };
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
      if (!response.ok) return { events: [], error: `HTTP ${response.status}` };
      return { events: parseYoutubeSchedule(response.text, username) };
    } catch (e) {
      return { events: [], error: failureText(e) };
    }
  }

  async function runPlatform(label, usernames, fetchOne) {
    const results = await runParallel(usernames, fetchOne, SCHEDULE_CONCURRENCY, SCHEDULE_BATCH_DELAY_MS);
    const failures = [];
    const events = [];
    results.forEach((r, i) => {
      if (r && Array.isArray(r.events)) events.push(...r.events);
      if (r && r.error) failures.push({ username: usernames[i], error: r.error });
    });
    const summary = failureSummary(label, failures, usernames.length);
    if (summary) log(summary);
    return events;
  }

  // A flat list of events: renderer.js and src/calendar.js read it as one.
  async function syncSchedules({ twitch = [], youtube = [], kick = [] } = {}) {
    log('[Calendar] Syncing platform calendars for Twitch and YouTube streams...');
    const events = [
      ...await runPlatform('Twitch', twitch, fetchTwitchSchedule),
      ...await runPlatform('YouTube', youtube, fetchYoutubeSchedule),
    ];
    // Kick has no public schedule API. One line per sync, not one per
    // streamer; a sync the user clicks still says why they got nothing.
    if (kick.length) {
      log(`[Calendar] Kick has no public schedule API; ${kick.length} Kick streamer${kick.length === 1 ? '' : 's'} skipped. Add manual calendar entries for them.`);
    }
    log(`[Calendar] Sync complete. Detected ${events.length} platform scheduled segments.`);
    return events;
  }

  return { fetchTwitchSchedule, fetchYoutubeSchedule, syncSchedules };
}

module.exports = {
  SCHEDULE_CONCURRENCY,
  failureSummary,
  parseTwitchSchedule,
  parseYoutubeSchedule,
  createScheduleSync,
};
