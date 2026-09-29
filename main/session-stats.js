// Lurk-session length for the longest-session stats. Tested in
// test/main-session-stats.test.js.
//
// Why: a session was measured as wall-clock time from open to close. A stream
// left open while a laptop slept for ten hours recorded a ten-hour session,
// while the minute ticker (which does not run during sleep) credited only the
// awake minutes, so Lurk Stats could show a longest session longer than that
// streamer's total watch time.

const MINUTE_MS = 60 * 1000;

// Never longer than the wall-clock span (already cut at the last scan that
// confirmed the stream live, see stream-liveness.js), and never longer than
// the minutes the ticker actually credited: sleep, outages and a dead
// dashboard earn no credit, so they do not lengthen a session either.
function sessionLengthMs({ startMs, endMs, creditedMinutes }) {
  const wall = Math.max(0, endMs - startMs);
  const credited = Math.max(0, Number(creditedMinutes) || 0) * MINUTE_MS;
  return Math.min(wall, credited);
}

// One-time repair for values recorded under the old wall-clock rule: a single
// session cannot be longer than all of that streamer's watch time. Returns the
// keys that were lowered, GLOBAL_LONGEST_KEY for the overall record.
// Idempotent; leaves anything it cannot compare alone.
//
// The overall record (the Lurk Stats headline) is lowered too. finalizeSession
// has only ever written it together with the per-streamer record, so it was
// always the largest of them, and Math.max never brings it down by itself:
// left alone it kept showing the sleep-inflated session after every
// per-streamer record was repaired.
const GLOBAL_LONGEST_KEY = 'longestSessionMs';

function capLongestSessions(watchTime) {
  const repaired = [];
  if (!watchTime || typeof watchTime !== 'object') return repaired;
  const longest = watchTime.streamerLongestMs;
  const totals = watchTime.streamers;
  if (!longest || typeof longest !== 'object' || !totals || typeof totals !== 'object') return repaired;
  for (const [key, ms] of Object.entries(longest)) {
    const minutes = totals[key];
    if (typeof ms !== 'number' || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) continue;
    const cap = minutes * MINUTE_MS;
    if (ms > cap) {
      longest[key] = cap;
      repaired.push(key);
    }
  }
  // Only against real per-streamer records: with none, there is nothing to
  // say the overall one is wrong.
  const records = Object.values(longest).filter(ms => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0);
  const overall = watchTime[GLOBAL_LONGEST_KEY];
  if (records.length && typeof overall === 'number' && Number.isFinite(overall)) {
    const ceiling = Math.max(...records);
    if (overall > ceiling) {
      watchTime[GLOBAL_LONGEST_KEY] = ceiling;
      repaired.push(GLOBAL_LONGEST_KEY);
    }
  }
  return repaired;
}

module.exports = { MINUTE_MS, GLOBAL_LONGEST_KEY, sessionLengthMs, capLongestSessions };
