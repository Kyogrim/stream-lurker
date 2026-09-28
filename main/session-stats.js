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
// keys that were lowered. Idempotent; leaves anything it cannot compare alone.
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
  return repaired;
}

module.exports = { MINUTE_MS, sessionLengthMs, capLongestSessions };
