// What one scan's results do to the open cells: auto-close, go-live alerts,
// auto-open and tab-limit preemption. main.js supplies the state and the
// effects (notify, spawn, close); the decisions live here so they run under
// plain Node, scan after scan, in test/main-scan-planner.test.js.

const { SETTING_RANGES, clampSetting, scanIntervalMs, streamerPlatform, streamerName } = require('./config-sanitize');
const { OFFLINE_CONFIRMATIONS, offlineMinSpanMs } = require('./stream-liveness');

// Alert and open-dedupe entries not seen for this long are dropped. Every
// sighting refreshes an entry, so this is time since last seen: a 24/7 stream
// is not re-alerted or reopened once a day.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const TAB_LIMIT_KEYS = {
  twitch: 'maxTwitchTabs',
  kick: 'maxKickTabs',
  youtube: 'maxYoutubeTabs',
  rumble: 'maxRumbleTabs',
};

function streamKey(platform, username) {
  return `${String(platform).toLowerCase()}:${String(username).toLowerCase()}`;
}

// One live broadcast's identity, `platform:username:<id>`. The id is the
// platform's own broadcast id when there is one (YouTube's video id), else the
// start time, else the day. Never the scan time: that made every scan a new
// go-live. The prefix shape is relied on by clearSessionsFor.
function sessionKeyFor(stream, now) {
  let id = stream.sessionId ? String(stream.sessionId) : '';
  if (!id && stream.liveSince) id = String(stream.liveSince).substring(0, 19);
  if (!id) id = new Date(now).toDateString();
  return `${streamKey(stream.platform, stream.username)}:${id}`;
}

function evictStale(map, now, ttlMs = SESSION_TTL_MS) {
  for (const [key, seenAt] of map) {
    if (now - seenAt > ttlMs) map.delete(key);
  }
}

// Forget every session recorded for one stream, so it can be opened again.
function clearSessionsFor(map, key) {
  const prefix = `${key}:`;
  for (const k of map.keys()) {
    if (k.startsWith(prefix)) map.delete(k);
  }
}

// A platform's tab limit, safe against null/NaN from an old or imported config
// (`count >= null` is always true, which silently stopped every auto-open).
function tabLimitFor(config, platform) {
  // Own keys only: 'constructor' or '__proto__' must not find Object's.
  const key = Object.prototype.hasOwnProperty.call(TAB_LIMIT_KEYS, platform) ? TAB_LIMIT_KEYS[platform] : null;
  if (!key) return 2;
  return clampSetting(config[key], SETTING_RANGES[key]);
}

// config.streamers order is the lurk priority: index 0 is the highest. First
// occurrence wins for a duplicated entry.
function buildPriorityMap(streamers) {
  const map = new Map();
  (Array.isArray(streamers) ? streamers : []).forEach((s, i) => {
    const platform = streamerPlatform(s);
    const username = streamerName(s);
    if (!platform || !username) return;
    const key = streamKey(platform, username);
    if (!map.has(key)) map.set(key, i);
  });
  return map;
}

// The open stream to close so a higher-priority one can take its slot: the
// lowest-priority open stream on that platform, if it ranks strictly below
// the incoming one. Ties keep the earliest-opened. null when nothing ranks
// below the incoming stream.
function choosePreemption(activeKeys, priorities, incomingKey) {
  const rank = k => (priorities.has(k) ? priorities.get(k) : Infinity);
  let victim = null;
  for (const key of activeKeys) {
    if (key === incomingKey) continue;
    if (victim === null || rank(key) > rank(victim)) victim = key;
  }
  if (victim === null || !(rank(victim) > rank(incomingKey))) return null;
  return { key: victim, username: victim.slice(victim.indexOf(':') + 1), index: rank(victim), incomingIndex: rank(incomingKey) };
}

function activeKeysOn(activeWindows, platform) {
  return Array.from(activeWindows.keys()).filter(k => k.startsWith(`${platform}:`));
}

// Applies one scan's results.
//
// ctx:
//   now, config, intervalMs (the scan interval; scanIntervalMs(config) when
//   absent), activeWindows (Map, key -> true), openedSessions and
//   notifiedSessions (Map, sessionKey -> last seen ms), liveness
//   (createStreamLiveness), modeOf(platform, username) -> 'auto'|'notify'|'ignore',
//   notify(stream), spawn(platform, username) (adds to activeWindows),
//   closeTab(platform, username) (tells the dashboard; called after the key
//   has left activeWindows, so what it reports is already current), log(text).
function applyScanResults(results, ctx) {
  const { now, config, activeWindows, openedSessions, notifiedSessions, liveness, modeOf, notify, spawn, closeTab, log } = ctx;

  // Once per scan, not once per live stream.
  evictStale(openedSessions, now);
  evictStale(notifiedSessions, now);

  // Once per key: a streamer listed twice must not count two offline results
  // from one scan as the two consecutive scans auto-close waits for.
  const scanned = new Set();
  for (const stream of results) {
    const key = streamKey(stream.platform, stream.username);
    if (scanned.has(key)) continue;
    scanned.add(key);
    liveness.observe(key, stream, now);
  }
  liveness.retain(scanned);

  // Sort results in the order of config.streamers priority, so the
  // higher-priority stream claims a free slot first.
  const priorities = buildPriorityMap(config.streamers);
  const ordered = [...results].sort((a, b) => {
    const idxA = priorities.get(streamKey(a.platform, a.username)) ?? Infinity;
    const idxB = priorities.get(streamKey(b.platform, b.username)) ?? Infinity;
    return idxA - idxB;
  });

  // Auto-close. An errored check never closes anything: a timeout or a 403
  // says nothing about the stream. Two offline scans seconds apart (Scan Now
  // right after a scheduled scan) are one observation, so the confirmations
  // must also span part of an interval (see stream-liveness.js).
  const intervalMs = Number.isFinite(ctx.intervalMs) ? ctx.intervalMs : scanIntervalMs(config);
  for (const stream of ordered) {
    if (stream.isLive || stream.error) continue;
    const key = streamKey(stream.platform, stream.username);
    if (!activeWindows.has(key)) continue;
    const streak = liveness.offlineStreak(key);
    if (streak < OFFLINE_CONFIRMATIONS) {
      log(`[Lurk] ${stream.username} on ${stream.platform.toUpperCase()} reported offline (${streak}/${OFFLINE_CONFIRMATIONS}). Closing it if the next scan agrees.`);
      continue;
    }
    if (!liveness.offlineConfirmed(key, now, intervalMs)) {
      const since = Math.round((now - liveness.offlineSince(key)) / 1000);
      const wait = Math.ceil(offlineMinSpanMs(intervalMs) / 1000);
      log(`[Lurk] ${stream.username} on ${stream.platform.toUpperCase()} reported offline again, ${since} s after the first. Closing it if a scan at least ${wait} s after that one agrees.`);
      continue;
    }
    log(`[Lurk] Streamer ${stream.username} on ${stream.platform.toUpperCase()} went offline. Auto-closing container.`);
    activeWindows.delete(key);
    closeTab(stream.platform, stream.username);
    // Without this, a stream that comes back (or was never really gone) stays
    // closed for the rest of the broadcast: its session key still reads as
    // already opened.
    clearSessionsFor(openedSessions, key);
  }

  // Go-live alerts and auto-open.
  //
  // Notifying and opening are deliberately independent: the notification used to
  // live inside `if (config.autoOpen)`, so anyone who turned auto-open off got no
  // alerts at all. Each streamer's mode decides what happens —
  //   auto   → notify + open (subject to auto-open and tab limits)
  //   notify → notify only
  //   ignore → neither, though it's still scanned and shown as live
  for (const stream of ordered) {
    if (!stream.isLive) continue;
    const platform = String(stream.platform).toLowerCase();
    const username = String(stream.username).toLowerCase();
    const key = `${platform}:${username}`;
    const sessionKey = sessionKeyFor(stream, now);

    const mode = modeOf(platform, username);
    if (mode === 'ignore') continue;

    // Alert once per go-live. Tracked separately from openedSessions so a
    // stream that can't open yet (tab limit) doesn't re-alert every scan
    // while still being retried for opening below. Refreshed on every
    // sighting so eviction measures time since last seen.
    const alerted = notifiedSessions.has(sessionKey);
    notifiedSessions.set(sessionKey, now);
    if (!alerted) {
      log(`[Lurk] Detected live stream: ${stream.username} on ${stream.platform.toUpperCase()}!`);
      notify(stream);
    }

    // Refreshed even when auto-open is off, but never created here: a stream
    // held back by the tab limit must stay absent so later scans retry it.
    if (openedSessions.has(sessionKey)) openedSessions.set(sessionKey, now);

    // Everything past here is about actually opening the stream.
    if (!config.autoOpen || mode !== 'auto') continue;
    if (openedSessions.has(sessionKey)) continue;

    // Already open (by hand, restored, or before a restart): nothing to open,
    // and it must not compete with itself for a slot. Recording the session
    // means a cell the user closes stays closed for this broadcast, as an
    // auto-opened one does.
    if (activeWindows.has(key)) {
      openedSessions.set(sessionKey, now);
      continue;
    }

    const maxTabs = tabLimitFor(config, platform);
    const openOnPlatform = activeKeysOn(activeWindows, platform);
    const currentCount = openOnPlatform.length;
    if (currentCount >= maxTabs) {
      const victim = choosePreemption(openOnPlatform, priorities, key);
      if (!victim) {
        log(`[Lurk] Limit reached: Skip auto-opening ${stream.platform.toUpperCase()} stream for ${stream.username} (Active: ${currentCount}/${maxTabs})`);
        continue;
      }
      log(`[Lurk] Preempting: Closing lower-priority active stream ${victim.username} on ${platform.toUpperCase()} (priority index ${victim.index}) to open higher-priority stream ${stream.username} (priority index ${victim.incomingIndex}).`);
      activeWindows.delete(victim.key);
      closeTab(stream.platform, victim.username);
      // So the preempted stream is reopened when capacity frees up (a 24/7
      // stream's session key never changes).
      clearSessionsFor(openedSessions, victim.key);
    }

    spawn(stream.platform, stream.username);
    openedSessions.set(sessionKey, now);
  }
}

module.exports = {
  SESSION_TTL_MS,
  streamKey,
  sessionKeyFor,
  evictStale,
  clearSessionsFor,
  tabLimitFor,
  buildPriorityMap,
  choosePreemption,
  applyScanResults,
};
