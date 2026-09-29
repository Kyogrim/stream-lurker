// Gate tests for main/schedule-sync.js and the YouTube title decoding in
// main/youtube-live.js: the calendar sync always settles (F80), a few requests
// at a time (F80), one log line for all of Kick (F79), and titles decoded from
// their JSON strings (F81). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createScheduleSync, parseTwitchSchedule, parseYoutubeSchedule, failureSummary, SCHEDULE_CONCURRENCY,
  MAX_TITLE, twitchScheduleFailure, streamerKey, inCalendarWindow, mergeSchedules, shouldStoreSchedule,
} = require('../main/schedule-sync');
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

// A fixed clock: the stored window is "today and the next six days", so the
// fixtures below stay inside or outside it whatever day the tests run.
const NOW = () => new Date('2026-09-27T12:00:00Z');
// A channel's /live page with nothing scheduled, and an EU consent page that
// also answers 200 but is not the channel at all.
const CHANNEL_PAGE = '<html><script>var ytInitialData = {"contents":{}};</script></html>';
const CONSENT_PAGE = '<html><form action="https://consent.youtube.com/save">Before you continue to YouTube</form></html>';

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
    fetch: fakeFetch({ 'twitch:good': twitchBody('good', [seg]), 'twitch:stuck': 'stall', 'youtube:@yt': CHANNEL_PAGE }, stats),
    userAgent: () => 'UA', clientId: 'cid', runParallel, log: (t) => logs.push(t), timeoutMs: 50,
  });
  const started = Date.now();
  const { events, failed, ok } = await sync.syncSchedules({ twitch: ['good', 'stuck'], youtube: ['yt'], kick: [], now: NOW });
  assert.ok(Date.now() - started < 2000, 'settled on the deadline');
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 's1');
  assert.deepEqual(failed, ['twitch:stuck']);
  assert.equal(ok, 2);
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
  const { events } = await sync.syncSchedules({ twitch: [], youtube: [], kick });
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

// ── G4.5 / F97: a failed fetch never costs a streamer its stored schedule ──

const SOON = '2026-09-28T18:00:00Z'; // inside the week NOW sees
const seg = (id, startAt = SOON, extra = {}) => ({ id, startAt, endAt: null, title: `${id} title`, isCancelled: false, ...extra });
const stored = (platform, streamer, id, startAt = SOON) => ({ id, streamer, platform, title: `old ${id}`, startAt, day: 1, time: '20:00', type: 'auto' });
const ytUpcoming = (sec, jsonTitle = '"Upcoming"') => `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"x":{"scheduledStartTime":"${sec}"}},"videoDetails":{"videoId":"abcdefghijk","title":${jsonTitle}}};</script>`;
const SOON_SEC = Date.parse('2026-09-29T15:00:00Z') / 1000;

function syncWith(answers, logs = []) {
  return createScheduleSync({ fetch: fakeFetch(answers, { inFlight: 0, max: 0 }), userAgent: 'UA', clientId: 'cid', runParallel, log: (t) => logs.push(t), timeoutMs: 200 });
}

test('G4.5 regression: every fetch failing stores nothing, and says so', async () => {
  const logs = [];
  const previous = [stored('twitch', 'Alpha', 'a1'), stored('youtube', 'Yoo', 'y1')];
  const sync = syncWith({ 'twitch:alpha': 503, 'youtube:@Yoo': 'stall' }, logs);
  const result = await sync.syncSchedules({ twitch: ['Alpha'], youtube: ['Yoo'], previous, now: NOW });
  assert.equal(result.ok, 0);
  assert.deepEqual(result.failed, ['twitch:Alpha', 'youtube:Yoo']);
  assert.equal(shouldStoreSchedule(result), false, 'the stored list must stay as it is');
  assert.deepEqual(result.events.map(e => e.id), ['a1', 'y1'], 'and what it reports is the previous schedule');
  assert.ok(logs.some(l => l === '[Calendar] Sync failed for all 2 streamers, kept previous schedule.'), logs.join('\n'));
  assert.ok(!logs.some(l => /Sync complete/.test(l)), 'no claim that it completed');
});

test('G4.5: one streamer failing keeps its old events; the others are replaced', async () => {
  const logs = [];
  const previous = [
    stored('twitch', 'Alpha', 'a-old'),
    stored('twitch', 'BRAVO', 'b-old'),     // config casing; the query lowercases
    stored('youtube', '@Chan', 'c-old'),    // saved with its @
    stored('twitch', 'removed', 'r-old'),   // no longer monitored
  ];
  const sync = syncWith({
    'twitch:alpha': twitchBody('alpha', [seg('a-new')]),
    'twitch:bravo': 500,
    'youtube:@Chan': CONSENT_PAGE,
  }, logs);
  const result = await sync.syncSchedules({ twitch: ['Alpha', 'BRAVO'], youtube: ['Chan'], previous, now: NOW });
  assert.equal(result.ok, 1);
  assert.deepEqual(result.failed, ['twitch:BRAVO', 'youtube:Chan']);
  assert.equal(shouldStoreSchedule(result), true);
  assert.deepEqual(result.events.map(e => e.id).sort(), ['a-new', 'b-old', 'c-old']);
  assert.ok(logs.some(l => /Sync failed for 2 streamers, kept previous schedule for them\./.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /YouTube schedules failed for 1 of 1 streamer: Chan \(not a YouTube channel page\)/.test(l)), logs.join('\n'));
});

test('G4.5: a GQL 200 with errors is a failure; an unknown user or no segments is a real empty schedule', async () => {
  const previous = [stored('twitch', 'errs', 'e-old'), stored('twitch', 'renamed', 'n-old'), stored('twitch', 'quiet', 'q-old')];
  const sync = syncWith({
    'twitch:errs': JSON.stringify([{ errors: [{ message: 'service timeout' }], data: null }]),
    'twitch:renamed': JSON.stringify([{ data: { user: null } }]),
    'twitch:quiet': twitchBody('quiet', []),
  });
  const result = await sync.syncSchedules({ twitch: ['errs', 'renamed', 'quiet'], previous, now: NOW });
  assert.deepEqual(result.failed, ['twitch:errs']);
  assert.equal(result.ok, 2);
  assert.deepEqual(result.events.map(e => e.id), ['e-old'], 'a renamed or quiet channel drops its old events');
  assert.equal(twitchScheduleFailure([{ errors: [{ message: 'x' }] }]), 'GQL error: x');
  assert.equal(twitchScheduleFailure({ errors: [{ message: 'batch' }] }), 'unexpected response', 'a rejected batch is not an array');
  assert.equal(twitchScheduleFailure([{}]), 'unexpected response');
  assert.equal(twitchScheduleFailure(null), 'unexpected response');
  assert.equal(twitchScheduleFailure([{ data: { user: null } }]), null);
});

test('G4.5: a YouTube channel page with nothing scheduled is empty; a consent or error page is a failure', async () => {
  const sync = syncWith({ 'youtube:@empty': CHANNEL_PAGE, 'youtube:@consent': CONSENT_PAGE, 'youtube:@up': ytUpcoming(SOON_SEC) });
  const previous = [stored('youtube', 'empty', 'e-old'), stored('youtube', 'consent', 'c-old')];
  const result = await sync.syncSchedules({ youtube: ['empty', 'consent', 'up'], previous, now: NOW });
  assert.deepEqual(result.failed, ['youtube:consent']);
  assert.deepEqual(result.events.map(e => e.id).sort(), ['c-old', `yt-up-${SOON_SEC}`]);
});

test('G4.5: with no Twitch or YouTube streamers left, the sync stores an empty list', async () => {
  const result = await syncWith({}).syncSchedules({ previous: [stored('twitch', 'gone', 'g-old')], now: NOW });
  assert.deepEqual(result, { events: [], failed: [], ok: 0 });
  assert.equal(shouldStoreSchedule(result), true);
  assert.equal(shouldStoreSchedule(null), false);
});

test('F03 layer 2: titles and names are stored as bounded strings, whatever the platform sent', async () => {
  const long = 'x'.repeat(5000);
  const sync = syncWith({
    'twitch:t': twitchBody('t', [
      seg('long', SOON, { title: long }),
      seg('num', SOON, { title: 12345 }),
      seg('obj', SOON, { title: { html: '<img src=x onerror=1>' } }),
      seg(42, SOON, { endAt: { not: 'a date' } }),
      seg('arr', ['2026-09-28T18:00:00Z']),
    ]),
    'youtube:@y': ytUpcoming(SOON_SEC, JSON.stringify('y'.repeat(900))),
  });
  const { events } = await sync.syncSchedules({ twitch: ['t'], youtube: ['y'], now: NOW });
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  assert.equal(byId.long.title.length, MAX_TITLE);
  assert.equal(MAX_TITLE, 200);
  assert.equal(byId.num.title, '12345');
  assert.equal(byId.obj.title, 'Twitch Stream', 'a non-text title falls back');
  assert.equal(byId['42'].id, '42');
  assert.equal(byId['42'].endAt, null);
  assert.equal(byId.arr, undefined, 'a non-string startAt is dropped');
  const yt = events.find(e => e.platform === 'youtube');
  assert.equal(yt.title.length, MAX_TITLE);
  for (const ev of events) {
    for (const k of ['id', 'streamer', 'title', 'time', 'startAt']) assert.equal(typeof ev[k], 'string', `${ev.id}.${k}`);
  }
});

test('F03 layer 2: carried-over events are made readable too; unusable ones are dropped', () => {
  const previous = [
    { ...stored('twitch', 'fail', 'ok1'), title: { x: 1 }, time: 2000 },
    { ...stored('twitch', 'fail', 'ok2'), title: 'z'.repeat(1000) },
    { ...stored('twitch', 'fail', 'bad'), startAt: 12345 },
    null, 'text', [stored('twitch', 'fail', 'nested')],
  ];
  const out = mergeSchedules({ failed: [{ platform: 'twitch', username: 'FAIL' }], previous, now: NOW() });
  assert.deepEqual(out.map(e => e.id), ['ok1', 'ok2']);
  assert.equal(out[0].title, 'Scheduled Stream');
  assert.equal(out[0].time, '2000');
  assert.equal(out[1].title.length, MAX_TITLE);
});

test('F91 point 5: only events on the calendar\'s seven days are stored', () => {
  const now = new Date(2026, 8, 27, 12, 0, 0); // local noon, 27 Sep
  const at = (d, h) => new Date(2026, 8, d, h, 0, 0).toISOString();
  const cases = [
    [at(26, 23), false], // yesterday
    [at(27, 0), true],   // today, midnight
    [at(27, 9), true],   // earlier today: still today's column
    [at(3 + 30, 23), true], // 3 Oct, the sixth day after today
    [at(4 + 30, 0), false], // 4 Oct: a week out
    ['not a date', false],
  ];
  for (const [startAt, expected] of cases) assert.equal(inCalendarWindow({ startAt }, now), expected, startAt);
  const fresh = [{ id: 'in', startAt: at(28, 20) }, { id: 'past', startAt: at(20, 20) }, { id: 'far', startAt: at(15 + 30, 20) }];
  assert.deepEqual(mergeSchedules({ fresh, now }).map(e => e.id), ['in']);
});

test('streamerKey: platform plus lowercased name, a YouTube @ optional', () => {
  assert.equal(streamerKey('Twitch', 'BRAVO'), 'twitch:bravo');
  assert.equal(streamerKey('youtube', '@Chan'), streamerKey('youtube', 'chan'));
  assert.notEqual(streamerKey('twitch', '@x'), streamerKey('twitch', 'x'), 'only YouTube names carry an optional @');
  assert.equal(streamerKey('kick', null), 'kick:');
});
