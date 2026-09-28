// Normalizes the parts of config.json the scanner and startup depend on,
// wherever a config enters the process: loadConfig, Settings > Import, and
// save-config.
// A hand-edited or damaged value used to break scanning for good: a null
// checkInterval became a 1 ms scan loop, and one streamer entry without a
// platform made every scan throw. Pure functions, tested under plain Node in
// test/main-config-sanitize.test.js.

// Ranges match the Settings sliders (index.html). The default is what a value
// that is not a number at all falls back to; a number out of range is clamped.
const SETTING_RANGES = {
  checkInterval: { min: 1, max: 60, def: 3 },
  maxTwitchTabs: { min: 1, max: 10, def: 2 },
  maxKickTabs: { min: 1, max: 10, def: 2 },
  maxYoutubeTabs: { min: 1, max: 10, def: 2 },
  maxRumbleTabs: { min: 1, max: 10, def: 2 },
};

// null, '' and non-numeric strings fall back to the default rather than going
// through Number(), which turns null and '' into 0 and so into the fastest
// legal scan rate. The upper bound matters as much as the lower one: Node also
// turns an interval past 2^31-1 ms into 1 ms.
function clampSetting(value, range) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return range.def;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

// The scan interval in ms, clamped even if a bad value slipped past the
// normalizer: setInterval turns 0, NaN and anything past 2^31-1 into 1 ms.
function scanIntervalMs(cfg) {
  return clampSetting(cfg && cfg.checkInterval, SETTING_RANGES.checkInterval) * 60 * 1000;
}

// Clamps every numeric setting in place. Returns what changed, for the log.
function normalizeConfigNumbers(cfg) {
  const changes = [];
  if (!cfg || typeof cfg !== 'object') return changes;
  for (const [key, range] of Object.entries(SETTING_RANGES)) {
    // A missing key keeps its in-code default (loadConfig merges over them).
    if (!(key in cfg)) continue;
    const to = clampSetting(cfg[key], range);
    if (to !== cfg[key]) {
      changes.push({ key, from: cfg[key], to });
      cfg[key] = to;
    }
  }
  return changes;
}

// The monitored list, reduced to entries every consumer can read: an object
// with a string platform and a non-empty username. A numeric username is a
// plausible channel name, so it is kept as a string. Unknown platforms (Rumble,
// anything newer) are kept; the scanner and the UI already skip them. mode and
// any other field are left alone, so a missing mode still reads as 'auto'.
// Returns the kept list and what was dropped, so the caller can preserve it.
function normalizeStreamers(value) {
  if (!Array.isArray(value)) {
    const dropped = value === undefined || value === null
      ? []
      : [{ entry: value, reason: 'the streamers value is not a list' }];
    return { streamers: [], dropped };
  }
  const streamers = [];
  const dropped = [];
  value.forEach((entry, index) => {
    const reason = rejectReason(entry);
    if (reason) {
      dropped.push({ index, entry, reason });
      return;
    }
    const platform = entry.platform.trim().toLowerCase();
    const username = String(entry.username).trim();
    streamers.push(platform === entry.platform && username === entry.username
      ? entry
      : { ...entry, platform, username });
  });
  return { streamers, dropped };
}

function rejectReason(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  if (typeof entry.platform !== 'string') return 'no platform';
  const u = entry.username;
  if (!(typeof u === 'string' || (typeof u === 'number' && Number.isFinite(u)))) return 'no username';
  if (!String(u).trim()) return 'empty username';
  return null;
}

// The unpacked-extension list: path strings only. A null or {} here (a hand
// edit, an old backup) made loadExtensions throw before the window and tray
// existed, leaving an invisible process holding the profile. Array.isArray,
// not `|| []`: {} and numbers are truthy. Returns null when already clean.
function normalizeExtensions(value) {
  if (value === undefined) return null;
  const list = Array.isArray(value) ? value.filter(p => typeof p === 'string' && p) : [];
  if (Array.isArray(value) && list.length === value.length) return null;
  return {
    extensions: list,
    change: { key: 'extensions', from: Array.isArray(value) ? `${value.length} entries` : value, to: `${list.length} extension path${list.length === 1 ? '' : 's'}` },
  };
}

// All normalizers over one config object, in place.
function sanitizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { clamped: [], dropped: [] };
  const clamped = normalizeConfigNumbers(cfg);
  const { streamers, dropped } = normalizeStreamers(cfg.streamers);
  cfg.streamers = streamers;
  const ext = normalizeExtensions(cfg.extensions);
  if (ext) {
    cfg.extensions = ext.extensions;
    clamped.push(ext.change);
  }
  return { clamped, dropped };
}

// The platform of a streamer entry, lowercased, or '' when it has none. For
// code that must not throw on an entry the normalizer has not seen yet.
function streamerPlatform(entry) {
  return entry && typeof entry.platform === 'string' ? entry.platform.toLowerCase() : '';
}

function streamerName(entry) {
  const u = entry && entry.username;
  return typeof u === 'string' || typeof u === 'number' ? String(u) : '';
}

module.exports = {
  SETTING_RANGES,
  clampSetting,
  scanIntervalMs,
  normalizeConfigNumbers,
  normalizeStreamers,
  normalizeExtensions,
  sanitizeConfig,
  streamerPlatform,
  streamerName,
};
