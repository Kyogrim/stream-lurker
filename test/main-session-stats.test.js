// Gate tests for main/session-stats.js (F76): a session's length is the
// minutes the ticker credited, capped by the wall-clock span, so a laptop
// sleeping with a stream open no longer records a ten-hour session; and old
// inflated records are repaired. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { MINUTE_MS, GLOBAL_LONGEST_KEY, sessionLengthMs, capLongestSessions } = require('../main/session-stats');

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
  assert.deepEqual(capLongestSessions(wt), ['kick:a', GLOBAL_LONGEST_KEY]);
  assert.equal(wt.streamerLongestMs['kick:a'], 30 * MINUTE_MS);
  assert.equal(wt.streamerLongestMs['twitch:b'], 2 * HOUR, 'a real record is untouched');
  assert.equal(wt.streamerLongestMs['youtube:gone'], 5 * HOUR, 'no total to compare against: left alone');
  // r2-18: the Lurk Stats headline follows, down to the largest remaining
  // per-streamer record (youtube:gone's, which nothing could lower).
  assert.equal(wt.longestSessionMs, 5 * HOUR, 'the global record is lowered to the largest per-streamer one');
  assert.deepEqual(capLongestSessions(wt), [], 'idempotent');
});

test('r2-18 regression: a global record inflated by sleep is lowered even when every per-streamer record is already fine', () => {
  // An install that ran the per-streamer repair before the global one existed.
  const wt = {
    streamers: { 'kick:a': 30, 'twitch:b': 600 },
    streamerLongestMs: { 'kick:a': 30 * MINUTE_MS, 'twitch:b': 2 * HOUR },
    longestSessionMs: 10 * HOUR,
  };
  assert.deepEqual(capLongestSessions(wt), [GLOBAL_LONGEST_KEY]);
  assert.equal(wt.longestSessionMs, 2 * HOUR);
});

test('r2-18: the global record is never raised, and is left alone with no per-streamer records to compare', () => {
  const lower = { streamers: { k: 600 }, streamerLongestMs: { k: 3 * HOUR }, longestSessionMs: HOUR };
  assert.deepEqual(capLongestSessions(lower), []);
  assert.equal(lower.longestSessionMs, HOUR, 'never raised');
  const none = { streamers: { k: 600 }, streamerLongestMs: {}, longestSessionMs: 4 * HOUR };
  assert.deepEqual(capLongestSessions(none), []);
  assert.equal(none.longestSessionMs, 4 * HOUR, 'no evidence against it');
  const junk = { streamers: {}, streamerLongestMs: { k: 'x', j: NaN }, longestSessionMs: 4 * HOUR };
  assert.deepEqual(capLongestSessions(junk), []);
  assert.equal(junk.longestSessionMs, 4 * HOUR, 'only numeric records count');
  const missing = { streamers: { k: 60 }, streamerLongestMs: { k: HOUR } };
  assert.deepEqual(capLongestSessions(missing), []);
  assert.equal(missing.longestSessionMs, undefined, 'an old config without the field stays without it');
});

test('capLongestSessions tolerates old or damaged shapes', () => {
  for (const bad of [undefined, null, 5, {}, { streamers: null, streamerLongestMs: {} }, { streamers: {}, streamerLongestMs: 'x' }]) {
    assert.deepEqual(capLongestSessions(bad), []);
  }
  assert.deepEqual(capLongestSessions({ streamers: { k: 'NaN' }, streamerLongestMs: { k: 5 } }), []);
});
