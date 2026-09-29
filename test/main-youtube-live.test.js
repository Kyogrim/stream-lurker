// Gate tests for main/youtube-live.js. The fixtures reproduce the parts of a
// real /live page the parser reads: the canonical link, videoDetails, the
// player microformat's liveBroadcastDetails and viewCount. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYoutubeLivePage } = require('../main/youtube-live');

function livePage({ videoId = 'jfKfPfyJRdk', start = '2026-09-27T06:00:04+00:00', extra = '' } = {}) {
  const broadcast = start === null ? '' : `,"liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"${start}"}`;
  return `<!DOCTYPE html><html><head><link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"></head><body>`
    + `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${videoId}","title":"lofi hip hop radio","isLiveContent":true},`
    + `"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"}${broadcast}}},`
    + `"viewCount":"31337"${extra}};</script></body></html>`;
}

test('F12: a live page yields a stable session id and the real start time', () => {
  const first = parseYoutubeLivePage(livePage());
  assert.deepEqual(first, {
    isLive: true,
    title: 'lofi hip hop radio',
    viewerCount: 31337,
    liveSince: '2026-09-27T06:00:04.000Z',
    sessionId: 'jfKfPfyJRdk',
  });
  // Same page an hour later: identical identity (the old code returned the scan time).
  assert.deepEqual(parseYoutubeLivePage(livePage()), first);
});

test('F12: video ids with - and _ are kept whole', () => {
  assert.equal(parseYoutubeLivePage(livePage({ videoId: 'a-B_c-D_e1Z' })).sessionId, 'a-B_c-D_e1Z');
});

test('F12: no start time means no uptime, never the scan time', () => {
  const page = parseYoutubeLivePage(livePage({ start: null }));
  assert.equal(page.isLive, true);
  assert.equal(page.liveSince, '');
  assert.equal(page.sessionId, 'jfKfPfyJRdk', 'the session is still keyed by the video id');
  assert.equal(parseYoutubeLivePage(livePage({ start: 'not a date' })).liveSince, '');
});

test('F12: only liveBroadcastDetails supplies the start time', () => {
  const html = livePage({ start: null, extra: ',"someOtherObject":{"startTimestamp":"2001-01-01T00:00:00Z"}' });
  assert.equal(parseYoutubeLivePage(html).liveSince, '');
});

test('offline, upcoming and malformed pages are not live', () => {
  assert.deepEqual(parseYoutubeLivePage('<link rel="canonical" href="https://www.youtube.com/@lofigirl">'), { isLive: false });
  assert.deepEqual(parseYoutubeLivePage(livePage({ extra: ',"upcomingEventData":{"startTime":"1"}' })), { isLive: false });
  assert.deepEqual(parseYoutubeLivePage(livePage({ extra: ',"offlineSlate":{}' })), { isLive: false });
  assert.deepEqual(parseYoutubeLivePage('<html>no canonical</html>'), { isLive: false });
  assert.deepEqual(parseYoutubeLivePage(undefined), { isLive: false });
});
