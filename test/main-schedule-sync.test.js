// Gate tests for main/schedule-sync.js and the YouTube title decoding in
// main/youtube-live.js: the calendar sync always settles (F80), a few requests
// at a time (F80), one log line for all of Kick (F79), and titles decoded from
// their JSON strings (F81). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduleSync, parseTwitchSchedule, parseYoutubeSchedule, failureSummary, SCHEDULE_CONCURRENCY } = require('../main/schedule-sync');
const { extractYtVideoTitle, parseYoutubeLivePage } = require('../main/youtube-live');

// main.js's checkStreamersParallel, verbatim in behaviour: batches of
// `concurrency`, a pause between batches.
async function runParallel(items, fn, concurrency = 3, delayMs = 300) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(u => fn(u))));
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, Math.min(delayMs, 5)));
  }
  return results;
}

function twitchBody(login, segments) {
  return JSON.stringify([{ data: { user: { channel: { schedule: { segments } } } } }]);
}

function response(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

// Answers per channel: 'stall' never answers (until aborted), a number is an
// HTTP status, anything else is the body.
function fakeFetch(answers, stats) {
  return (url, init) => {
    stats.inFlight++;
    stats.max = Math.max(stats.max, stats.inFlight);
    const done = (v) => { stats.inFlight--; return v; };
    let key;
    if (url.includes('gql.twitch.tv')) key = `twitch:${JSON.parse(init.body)[0].variables.channelLogin}`;
    else key = `youtube:${url.split('/')[3]}`;
    const answer = answers[key];
    if (answer === 'stall') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { stats.inFlight--; reject(new Error('aborted')); });
      });
    }
    if (typeof answer === 'number') return Promise.resolve(done(response(answer, '')));
    return Promise.resolve(done(response(200, answer || '')));
  };
}

test('F80 regression: one stalled channel no longer hangs the sync; it is reported as timed out', async () => {
  const stats = { inFlight: 0, max: 0 };
  const logs = [];
  const seg = { id: 's1', startAt: '2026-09-28T18:00:00Z', endAt: '2026-09-28T20:00:00Z', title: 'Stream', isCancelled: false };
  const sync = createScheduleSync({
    fetch: fakeFetch({ 'twitch:good': twitchBody('good', [seg]), 'twitch:stuck': 'stall', 'youtube:@yt': 'no schedule here' }, stats),
    userAgent: () => 'UA', clientId: 'cid', runParallel, log: (t) => logs.push(t), timeoutMs: 50,
  });
  const started = Date.now();
  const events = await sync.syncSchedules({ twitch: ['good', 'stuck'], youtube: ['yt'], kick: [] });
  assert.ok(Date.now() - started < 2000, 'settled on the deadline');
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 's1');
  assert.ok(Array.isArray(events), 'a flat list, as the dashboard reads it');
  assert.ok(logs.some(l => /Twitch schedules failed for 1 of 2 streamers: stuck \(timed out/.test(l)), logs.join('\n'));
  assert.equal(stats.inFlight, 0, 'the stalled request was aborted, not left open');
});

test('F80: no more than three requests at a time', async () => {
  const stats = { inFlight: 0, max: 0 };
  const answers = {};
  const names = Array.from({ length: 10 }, (_, i) => `c${i}`);
  for (const n of names) answers[`twitch:${n}`] = twitchBody(n, []);
  const sync = createScheduleSync({ fetch: fakeFetch(answers, stats), userAgent: 'UA', clientId: 'cid', runParallel, timeoutMs: 1000 });
  await sync.syncSchedules({ twitch: names });
  assert.equal(SCHEDULE_CONCURRENCY, 3);
  assert.ok(stats.max <= 3, `max in flight ${stats.max}`);
});

test('F79 regression: 20 Kick streamers cost one log line, not twenty', async () => {
  const logs = [];
  const sync = createScheduleSync({ fetch: fakeFetch({}, { inFlight: 0, max: 0 }), userAgent: 'UA', clientId: 'cid', runParallel, log: (t) => logs.push(t) });
  const kick = Array.from({ length: 20 }, (_, i) => `k${i}`);
  const events = await sync.syncSchedules({ twitch: [], youtube: [], kick });
  assert.deepEqual(events, []);
  assert.equal(logs.length, 3, logs.join('\n'));
  assert.match(logs[0], /Syncing platform calendars for Twitch and YouTube/);
  assert.match(logs[1], /Kick has no public schedule API; 20 Kick streamers skipped/);
  assert.match(logs[2], /Sync complete\. Detected 0/);
  // No Kick streamers, no Kick line.
  logs.length = 0;
  await sync.syncSchedules({});
  assert.equal(logs.length, 2);
});

test('F80: HTTP errors and bad bodies are summarized per platform, capped at five names', async () => {
  const logs = [];
  const answers = {};
  const names = Array.from({ length: 8 }, (_, i) => `n${i}`);
  for (const n of names) answers[`twitch:${n}`] = 500;
  answers['youtube:@y'] = 429;
  const sync = createScheduleSync({ fetch: fakeFetch(answers, { inFlight: 0, max: 0 }), userAgent: 'UA', clientId: 'cid', runParallel, log: (t) => logs.push(t) });
  await sync.syncSchedules({ twitch: names, youtube: ['y'] });
  const twitchLine = logs.find(l => l.includes('Twitch schedules failed'));
  assert.match(twitchLine, /failed for 8 of 8 streamers: n0 \(HTTP 500\), n1 \(HTTP 500\), n2 \(HTTP 500\), n3 \(HTTP 500\), n4 \(HTTP 500\), and 3 more\./);
  assert.ok(logs.some(l => /YouTube schedules failed for 1 of 1 streamer: y \(HTTP 429\)/.test(l)));
  assert.equal(failureSummary('Twitch', [], 3), null);
});

test('Twitch segments: cancelled and undated ones are dropped; the local slot is computed', () => {
  const events = parseTwitchSchedule(JSON.parse(twitchBody('x', [
    { id: 'a', startAt: '2026-09-28T18:00:00Z', endAt: null, title: '', isCancelled: false },
    { id: 'b', startAt: '2026-09-29T18:00:00Z', title: 'gone', isCancelled: true },
    { id: 'c', startAt: null, title: 'no date' },
    { id: 'd', startAt: 'garbage', title: 'bad date' },
    null,
  ])), 'Streamer');
  assert.equal(events.length, 1);
  const start = new Date('2026-09-28T18:00:00Z');
  assert.deepEqual(events[0], {
    id: 'a', streamer: 'Streamer', platform: 'twitch', title: 'Twitch Stream', startAt: '2026-09-28T18:00:00Z', endAt: null,
    day: start.getDay(), time: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), type: 'auto',
  });
  assert.deepEqual(parseTwitchSchedule({ errors: [] }, 'x'), []);
  assert.deepEqual(parseTwitchSchedule(null, 'x'), []);
});

// A /live page for an upcoming stream, with the title as YouTube embeds it.
function upcomingPage(jsonTitle) {
  return `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"liveStreamability":{"liveStreamabilityRenderer":{"offlineSlate":{"liveStreamOfflineSlateRenderer":{"scheduledStartTime":"1790000000"}}}}},`
    + `"videoDetails":{"videoId":"abcdefghijk","title":${jsonTitle},"lengthSeconds":"0","thumbnail":{"thumbnails":[{"url":"x"}]},"author":"Chan"},`
    + `"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"other"}}}};</script>`;
}

test('F81 regression: YouTube titles are decoded from their JSON strings, whole', () => {
  const cases = [
    ['"Q\\u0026A with chat"', 'Q&A with chat'],
    ['"The \\"best\\" run"', 'The "best" run'],
    ['"Speedrun {any%} WR"', 'Speedrun {any%} WR'],
    ['"\\u003cb\\u003eBold\\u003c/b\\u003e"', '<b>Bold</b>'],
    ['"Caf\\u00e9 \\ud83d\\ude00 日本語"', 'Café \u{1F600} 日本語'],
    ['"back\\\\slash"', 'back\\slash'],
  ];
  for (const [json, expected] of cases) {
    const events = parseYoutubeSchedule(upcomingPage(json), 'chan');
    assert.equal(events.length, 1, json);
    assert.equal(events[0].title, expected, json);
    assert.equal(events[0].startAt, new Date(1790000000 * 1000).toISOString());
  }
});

test('F81: no title, a bad escape, or a title only far past videoDetails falls back', () => {
  assert.equal(extractYtVideoTitle('<html></html>', 'Fallback'), 'Fallback');
  assert.equal(extractYtVideoTitle('"videoDetails":{"videoId":"x","title":"\\x"}', 'Fallback'), 'Fallback');
  assert.equal(extractYtVideoTitle('"videoDetails":{"videoId":"x","title":"   "}', 'Fallback'), 'Fallback');
  const far = `"videoDetails":{"videoId":"x"${' '.repeat(5000)}},"title":"unrelated"`;
  assert.equal(extractYtVideoTitle(far, 'Fallback'), 'Fallback');
  assert.equal(extractYtVideoTitle(null, 'F'), 'F');
});

test('F81: the scanner\'s live title uses the same decoding', () => {
  const html = `<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk"><script>{"videoDetails":{"videoId":"abcdefghijk","title":"Tom \\u0026 Jerry \\"live\\" {24/7}","isLiveContent":true},"viewCount":"12"}</script>`;
  assert.equal(parseYoutubeLivePage(html).title, 'Tom & Jerry "live" {24/7}');
});
