// Gate tests for main/session-stats.js (F76): a session's length is the
// minutes the ticker credited, capped by the wall-clock span, so a laptop
// sleeping with a stream open no longer records a ten-hour session; and old
// inflated records are repaired. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { MINUTE_MS, sessionLengthMs, capLongestSessions } = require('../main/session-stats');

const T0 = Date.UTC(2026, 8, 27);
const HOUR = 60 * MINUTE_MS;

test('regression F76: ten hours of sleep inside a session do not count', () => {
  // 30 awake minutes, then the lid closed for 10 h, then closed on resume.
  assert.equal(sessionLengthMs({ startMs: T0, endMs: T0 + 30 * MINUTE_MS + 10 * HOUR, creditedMinutes: 30 }), 30 * MINUTE_MS);
});

test('never longer than the wall-clock span (the first tick can land a second after opening)', () => {
  assert.equal(sessionLengthMs({ startMs: T0, endMs: T0 + 90 * 1000, creditedMinutes: 2 }), 90 * 1000);
});

test('uncredited sessions (dead dashboard, stale liveness) are zero; a missing counter reads as 0', () => {
  assert.equal(sessionLengthMs({ startMs: T0, endMs: T0 + HOUR, creditedMinutes: 0 }), 0);
  assert.equal(sessionLengthMs({ startMs: T0, endMs: T0 + HOUR, creditedMinutes: undefined }), 0);
  assert.equal(sessionLengthMs({ startMs: T0, endMs: T0 - 5, creditedMinutes: 3 }), 0, 'clock stepped back');
});

test('capLongestSessions lowers only records longer than the streamer total', () => {
  const wt = {
    streamers: { 'kick:a': 30, 'twitch:b': 600 },
    streamerLongestMs: { 'kick:a': 10 * HOUR, 'twitch:b': 2 * HOUR, 'youtube:gone': 5 * HOUR },
    longestSessionMs: 10 * HOUR,
  };
  assert.deepEqual(capLongestSessions(wt), ['kick:a']);
  assert.equal(wt.streamerLongestMs['kick:a'], 30 * MINUTE_MS);
  assert.equal(wt.streamerLongestMs['twitch:b'], 2 * HOUR, 'a real record is untouched');
  assert.equal(wt.streamerLongestMs['youtube:gone'], 5 * HOUR, 'no total to compare against: left alone');
  assert.equal(wt.longestSessionMs, 10 * HOUR, 'the global record is not rewritten');
  assert.deepEqual(capLongestSessions(wt), [], 'idempotent');
});

test('capLongestSessions tolerates old or damaged shapes', () => {
  for (const bad of [undefined, null, 5, {}, { streamers: null, streamerLongestMs: {} }, { streamers: {}, streamerLongestMs: 'x' }]) {
    assert.deepEqual(capLongestSessions(bad), []);
  }
  assert.deepEqual(capLongestSessions({ streamers: { k: 'NaN' }, streamerLongestMs: { k: 5 } }), []);
});
