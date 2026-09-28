// What may cross each config boundary. config.json holds three kinds of data:
// the user's settings (the dashboard edits them), portable user data (the
// monitored list and watch history a backup carries between machines), and
// this install's own state (accounts, which describe the cookie jar; the
// extension pairing code; loaded extension folders; markers main keeps). Each
// entry point may only touch its own kind:
//
//   save-config (the dashboard)  rendererConfigPatch   settings only
//   Settings > Import            importedConfig        settings + user data
//   Settings > Export            exportableConfig      everything but secrets
//
// Before this, save-config replaced main's whole config with the dashboard's
// copy from page load (reverting account names and watch-time minutes main
// had written since, and letting a compromised page set the pairing code or
// add an extension folder), and Import merged every key of a file. Pure
// functions, tested in test/main-config-boundary.test.js.

const { SETTING_RANGES, clampSetting, MAX_LOGGED_ENTRIES } = require('./config-sanitize');

const KNOWN_PLATFORMS = ['twitch', 'kick', 'youtube', 'rumble'];
const STREAMER_MODES = ['auto', 'notify', 'ignore'];
// The Settings quality <select> (index.html).
const QUALITIES = ['160p', '360p', '480p', '720p', 'source'];

const BOOLEAN_SETTINGS = [
  'autoOpen', 'twitchEnabled', 'kickEnabled', 'youtubeEnabled',
  'autoClaimPoints', 'notificationsEnabled', 'launchOnStartup', 'startMinimized',
];
const STRING_SETTINGS = { twitchClientId: 200, twitchClientSecret: 200 };

// Every key the dashboard writes through window.api.saveConfig (settings.js,
// streamers.js, calendar.js, multi-lurk.js, onboarding.js, extensions.js,
// renderer.js). Anything else in its copy is ignored: main's value stays.
const RENDERER_KEYS = [
  ...BOOLEAN_SETTINGS, 'onboardingComplete',
  ...Object.keys(SETTING_RANGES), 'defaultQuality', ...Object.keys(STRING_SETTINGS),
  'streamers', 'calendarEvents', 'syncedCalendarEvents', 'disabledAutoQuality', 'extensions',
];

// Never read from an imported file: they describe this install, not the user.
// launchOnStartup is this machine's login item; onboardingComplete, the
// pairing code, accounts and the extension folders belong to this profile.
const IMPORT_KEYS = [
  ...BOOLEAN_SETTINGS.filter(k => k !== 'launchOnStartup'),
  ...Object.keys(SETTING_RANGES), 'defaultQuality', ...Object.keys(STRING_SETTINGS),
  'streamers', 'calendarEvents', 'syncedCalendarEvents', 'disabledAutoQuality', 'watchTime',
];

// Left out of an exported backup. The pairing code is what lets a local
// process write cookies into the app; the other two are markers about this
// machine's cookie jar. twitchClientSecret stays in on purpose: it is the
// user's own Twitch developer credential, restoring a setup elsewhere needs
// it, and the file goes where the user chose to save it.
const EXPORT_OMIT_KEYS = ['extensionPairingCode', 'youtubeExpiredFingerprint', 'signedOutPlatforms'];

const WATCH_MAPS = ['streamers', 'platforms', 'streamerSessions', 'daily', 'streamerLongestMs', 'streamerLastSeen'];
const WATCH_TOTALS = ['sessions', 'longestSessionMs'];

const MAX_EVENTS = 5000;
const MAX_EVENT_FIELDS = 20;
// Event field names are the dashboard's own (id, streamer, day, time, ...).
// Without a cap one key could be megabytes, and config.json is rewritten
// every minute.
const MAX_EVENT_KEY = 50;
const MAX_TEXT = 1000;
const MAX_FLAGS = 5000;
const MAX_USERNAME = 100;
// Entries the dashboard may add to the monitored list in one save. Far above
// any real lineup; it bounds what a compromised page can make main write.
const MAX_STREAMERS = 2000;
// Refusals logged one by one per save; the rest are counted in one line. The
// same cap as for streamer entries a load or an import sets aside.
const MAX_LOGGED_REFUSALS = MAX_LOGGED_ENTRIES;

// typeof [] and typeof null are 'object' too.
function isPlainObject(v) {
  return Object.prototype.toString.call(v) === '[object Object]';
}

function has(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// A number or a numeric string, clamped to the Settings slider's range.
// Anything else is refused (null) rather than coerced: null and '' would
// otherwise become 0.
function settingNumber(value, range) {
  const numeric = (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  return numeric ? clampSetting(value, range) : null;
}

// A list of calendar events: plain objects of short primitive fields. The
// shape of an event is the dashboard's business; this only keeps a hostile
// or damaged value from bloating config.json or carrying nested structures.
function cleanEventList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const ev of list) {
    if (out.length >= MAX_EVENTS) break;
    if (!isPlainObject(ev)) continue;
    const clean = {};
    let fields = 0;
    for (const [k, v] of Object.entries(ev)) {
      if (fields >= MAX_EVENT_FIELDS) break;
      if (k.length > MAX_EVENT_KEY) continue;
      if (typeof v === 'string') clean[k] = v.slice(0, MAX_TEXT);
      else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) clean[k] = v;
      else continue;
      fields++;
    }
    out.push(clean);
  }
  return out;
}

// disabledAutoQuality: { "platform:username": true }.
function cleanFlagMap(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n >= MAX_FLAGS) break;
    if (v !== true || !k || k.length > 200) continue;
    out[k] = true;
    n++;
  }
  return out;
}

// platform:username, lowercased: how the monitored list, watch history and
// the scanner identify a streamer. null for an entry with neither.
function streamerId(entry) {
  if (!isPlainObject(entry) || typeof entry.platform !== 'string') return null;
  const u = entry.username;
  if (!(typeof u === 'string' || (typeof u === 'number' && Number.isFinite(u)))) return null;
  return `${entry.platform.trim().toLowerCase()}:${String(u).trim().toLowerCase()}`;
}

// Characters no channel name has, that would change the URL a name is put
// into (kick.com/api/v1/channels/<name>, youtube.com/@<name>/live).
const BAD_NAME_CHARS = /[\s/\\?#%&<>"'`\u0000-\u001f\u007f]/;

// What each platform accepts as a channel name, case-insensitively (stored
// names keep the case the user typed). YouTube handles may use letters of any
// script since 2023, so \p{L} rather than A-Z; a leading @ is optional.
// Checked on input only (add-streamer, and entries an import brings in that
// this install does not have yet), never on load: watch history is keyed
// platform:username, so re-judging a stored entry would orphan it (F89).
const CHANNEL_NAME_RULES = {
  twitch: { pattern: /^[a-z0-9_]{1,25}$/i, hint: 'letters, numbers and _ only, up to 25 characters' },
  kick: { pattern: /^[a-z0-9_-]{1,100}$/i, hint: 'letters, numbers, _ and - only' },
  youtube: { pattern: /^@?[\p{L}\p{M}\p{N}._·-]{1,100}$/u, hint: 'a handle such as @name: letters, numbers, . _ and - only' },
  rumble: { pattern: /^[a-z0-9_.-]{1,100}$/i, hint: 'letters, numbers, . _ and - only' },
};
const PLATFORM_LABELS = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', rumble: 'Rumble' };

// null when `username` is a usable channel name on `platform`, otherwise a
// message for the user.
function channelNameProblem(platform, username) {
  const p = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  const rule = CHANNEL_NAME_RULES[p];
  if (!rule) return 'Unknown platform.';
  const name = typeof username === 'string' || (typeof username === 'number' && Number.isFinite(username)) ? String(username).trim() : '';
  if (!name) return 'Username cannot be empty';
  if (rule.pattern.test(name)) return null;
  const link = /[/:]/.test(name) ? ' Enter the channel name, not a link.' : '';
  return `That is not a valid ${PLATFORM_LABELS[p]} channel name (${rule.hint}).${link}`;
}

// An imported streamer entry, or the reason it is refused.
function importedStreamer(entry) {
  if (!isPlainObject(entry)) return { reason: 'not an object' };
  const platform = typeof entry.platform === 'string' ? entry.platform.trim().toLowerCase() : '';
  if (!KNOWN_PLATFORMS.includes(platform)) return { reason: 'unknown platform' };
  const raw = entry.username;
  if (!(typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw)))) return { reason: 'no username' };
  const username = String(raw).trim();
  if (!username) return { reason: 'empty username' };
  if (username.length > MAX_USERNAME || BAD_NAME_CHARS.test(username)) return { reason: 'not a channel name' };
  // A missing mode reads as 'auto' everywhere (getStreamerMode), so it stays missing.
  const out = { platform, username };
  if (STREAMER_MODES.includes(entry.mode)) out.mode = entry.mode;
  return { streamer: out };
}

// The dashboard's monitored list. It reorders, removes and changes modes of
// entries main already has; for those main's own stored entry is kept (so its
// name, spelled as stored, still keys the watch history) and only a valid
// `mode` is taken from the dashboard. Anything new must pass the same checks
// as add-streamer and an import: a known platform and a real channel name,
// because the name goes into scan URLs (kick.com/api/v1/channels/<name>).
// Returns { value, refused } where refused holds { entry, reason } (the
// caller logs a bounded number of them), or { reason } when the whole list is
// refused and main's stays.
function rendererStreamers(value, current) {
  if (!Array.isArray(value)) return { reason: 'not a list' };
  const stored = new Map();
  for (const s of Array.isArray(current) ? current : []) {
    const id = streamerId(s);
    if (id && !stored.has(id)) stored.set(id, s);
  }
  // Every entry beyond this must be new, and new ones stop at MAX_STREAMERS
  // anyway; refusing here also bounds the loop below.
  if (value.length > MAX_STREAMERS + stored.size) return { reason: `more than ${MAX_STREAMERS} entries` };
  const out = [];
  const refused = [];
  const seen = new Set();
  for (const entry of value) {
    const id = streamerId(entry);
    if (id && seen.has(id)) { refused.push({ entry, reason: 'duplicate' }); continue; }
    if (id && stored.has(id)) {
      seen.add(id);
      const kept = { ...stored.get(id) };
      if (STREAMER_MODES.includes(entry.mode)) kept.mode = entry.mode;
      out.push(kept);
      continue;
    }
    const r = importedStreamer(entry);
    if (r.reason) { refused.push({ entry, reason: r.reason }); continue; }
    const problem = channelNameProblem(r.streamer.platform, r.streamer.username);
    if (problem) { refused.push({ entry, reason: 'not a valid channel name' }); continue; }
    if (out.length >= MAX_STREAMERS) { refused.push({ entry, reason: `the list already has ${MAX_STREAMERS} entries` }); continue; }
    seen.add(id);
    out.push(r.streamer);
  }
  return { value: out, refused };
}

// A refused streamer entry, short enough for one log line whatever it holds.
function describeStreamer(entry) {
  if (!isPlainObject(entry)) return entry === null ? 'null' : `a ${Array.isArray(entry) ? 'list' : typeof entry}`;
  const part = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : typeof v).slice(0, 40);
  return `${part(entry.platform)}:${part(entry.username)}`;
}

// watchTime from a backup: plain objects of finite, non-negative numbers.
// `[]` used to pass the old typeof check, and every minute set on an array's
// named keys is dropped by JSON.stringify, so all new watch time was lost.
function importedWatchTime(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const key of WATCH_MAPS) {
    const src = value[key];
    const map = {};
    if (isPlainObject(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) map[k] = v;
      }
    }
    out[key] = map;
  }
  for (const key of WATCH_TOTALS) {
    const v = value[key];
    out[key] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  }
  for (const p of ['twitch', 'kick', 'youtube', 'rumble']) {
    if (!has(out.platforms, p)) out.platforms[p] = 0;
  }
  return out;
}

// Structural repair for the watchTime already in memory (config.json, or an
// older build's save): every container a plain object, every total a number.
// Entries are left alone; this only stops `[]` or null from swallowing every
// later minute. Returns the keys it had to replace, for the log.
function repairWatchTime(cfg) {
  const repaired = [];
  if (!isPlainObject(cfg.watchTime)) {
    if (cfg.watchTime !== undefined) repaired.push('watchTime');
    cfg.watchTime = {};
  }
  const wt = cfg.watchTime;
  for (const key of WATCH_MAPS) {
    if (!isPlainObject(wt[key])) {
      if (wt[key] !== undefined) repaired.push(`watchTime.${key}`);
      wt[key] = key === 'platforms' ? { twitch: 0, kick: 0, youtube: 0, rumble: 0 } : {};
    }
  }
  for (const key of WATCH_TOTALS) {
    if (typeof wt[key] !== 'number' || !Number.isFinite(wt[key])) {
      if (wt[key] !== undefined) repaired.push(`watchTime.${key}`);
      wt[key] = 0;
    }
  }
  return repaired;
}

// Settings read the same way from the dashboard and from a backup.
function readSetting(key, value) {
  if (BOOLEAN_SETTINGS.includes(key) || key === 'onboardingComplete') {
    return typeof value === 'boolean' ? { value } : { reason: 'not true or false' };
  }
  if (has(SETTING_RANGES, key)) {
    const n = settingNumber(value, SETTING_RANGES[key]);
    return n === null ? { reason: 'not a number' } : { value: n };
  }
  if (key === 'defaultQuality') {
    return QUALITIES.includes(value) ? { value } : { reason: 'not a known quality' };
  }
  if (has(STRING_SETTINGS, key)) {
    return typeof value === 'string' ? { value: value.trim().slice(0, STRING_SETTINGS[key]) } : { reason: 'not text' };
  }
  if (key === 'calendarEvents' || key === 'syncedCalendarEvents') {
    const list = cleanEventList(value);
    return list ? { value: list } : { reason: 'not a list' };
  }
  if (key === 'disabledAutoQuality') {
    const map = cleanFlagMap(value);
    return map ? { value: map } : { reason: 'not an object' };
  }
  return { reason: 'not a setting' };
}

// Extension folders are main's: the dashboard may drop entries (Remove) and
// reorder them, and may add only a folder the user just picked in main's own
// dialog (`approved`, filled by select-extension-folder). Anything else it
// sends would load code with file access into the session holding every
// platform login.
// `seen` is the list the dashboard last had (its last get-config, or its own
// last save). A folder main added after that (a catalog install that is still
// loading) is missing from the dashboard's copy because the copy is stale, not
// because the user removed it, so it is kept (`kept`) rather than dropped and
// unloaded. Without `seen` every folder the copy leaves out is dropped.
function rendererExtensions(value, current, approved, seen) {
  if (!Array.isArray(value)) return { reason: 'not a list' };
  const currentList = Array.isArray(current) ? current.filter(p => typeof p === 'string' && p) : [];
  const known = new Set(currentList);
  const out = [];
  const refused = [];
  const used = [];
  const kept = [];
  for (const p of value) {
    if (typeof p !== 'string' || !p || out.includes(p)) continue;
    if (known.has(p)) out.push(p);
    else if (approved && approved.has(p)) { out.push(p); used.push(p); }
    else refused.push(p);
  }
  if (seen) {
    for (const p of currentList) {
      if (!out.includes(p) && !seen.has(p)) { out.push(p); kept.push(p); }
    }
  }
  return { value: out, refused, used, kept };
}

// At most MAX_LOGGED_REFUSALS entries, then one line counting the rest, so a
// hostile list cannot flood the activity log.
function pushRefusals(refused, key, items, describe) {
  items.slice(0, MAX_LOGGED_REFUSALS).forEach(item => refused.push({ key, reason: describe(item) }));
  if (items.length > MAX_LOGGED_REFUSALS) refused.push({ key, reason: `${items.length - MAX_LOGGED_REFUSALS} more entries refused` });
}

// The keys the dashboard may change, validated. Returns { patch, refused,
// approvedUsed, keptExtensions }: patch holds only renderer-owned keys that
// were present and valid, and is merged over main's live config, so
// everything main owns (accounts, watch time, the pairing code, markers)
// always comes from main. `dashboardExtensions` is rendererExtensions' `seen`.
function rendererConfigPatch(incoming, current, { approvedExtensions, dashboardExtensions } = {}) {
  const patch = {};
  const refused = [];
  let approvedUsed = [];
  let keptExtensions = [];
  if (!isPlainObject(incoming)) return { patch, refused: [{ key: '(config)', reason: 'not an object' }], approvedUsed, keptExtensions };
  for (const key of RENDERER_KEYS) {
    // IPC keeps a key set to undefined; that is "not sent", not a bad value.
    if (!has(incoming, key) || incoming[key] === undefined) continue;
    const value = incoming[key];
    if (key === 'streamers') {
      const r = rendererStreamers(value, current && current.streamers);
      if (r.reason) { refused.push({ key, reason: r.reason }); continue; }
      patch.streamers = r.value;
      pushRefusals(refused, key, r.refused, (x) => `${x.reason}: ${describeStreamer(x.entry)}`);
      continue;
    }
    if (key === 'extensions') {
      const r = rendererExtensions(value, current && current.extensions, approvedExtensions, dashboardExtensions);
      if (r.reason) { refused.push({ key, reason: r.reason }); continue; }
      patch.extensions = r.value;
      approvedUsed = r.used;
      keptExtensions = r.kept;
      pushRefusals(refused, key, r.refused, (p) => `folder not picked in Stream Lurker's own dialog: ${String(p).slice(0, 160)}`);
      continue;
    }
    const r = readSetting(key, value);
    if (r.reason) refused.push({ key, reason: r.reason });
    else patch[key] = r.value;
  }
  return { patch, refused, approvedUsed, keptExtensions };
}

// A backup file, reduced to the portable keys and merged over `current`.
// Returns { config, dropped, ignored, refused }:
//   dropped  streamer entries that could not be used ({ index, entry, reason }),
//            for the caller to set aside rather than lose
//   ignored  keys in the file that are this install's own state or unknown
//   refused  portable keys whose value was unusable (this machine's kept)
// null when the file does not look like a backup at all.
function importedConfig(incoming, current) {
  if (!isPlainObject(incoming) || !Array.isArray(incoming.streamers) || !isPlainObject(incoming.watchTime)) return null;
  const next = { ...current };
  const refused = [];
  const dropped = [];
  const seen = new Set();
  const streamers = [];
  // What this install already monitors keeps its name as stored (F89).
  const existing = new Set((Array.isArray(current && current.streamers) ? current.streamers : [])
    .filter(s => isPlainObject(s) && typeof s.platform === 'string' && (typeof s.username === 'string' || typeof s.username === 'number'))
    .map(s => `${s.platform.trim().toLowerCase()}:${String(s.username).trim().toLowerCase()}`));
  incoming.streamers.forEach((entry, index) => {
    const r = importedStreamer(entry);
    if (r.reason) { dropped.push({ index, entry, reason: r.reason }); return; }
    const id = `${r.streamer.platform}:${r.streamer.username.toLowerCase()}`;
    if (!existing.has(id) && channelNameProblem(r.streamer.platform, r.streamer.username)) {
      dropped.push({ index, entry, reason: 'not a valid channel name' });
      return;
    }
    if (seen.has(id)) { dropped.push({ index, entry, reason: 'duplicate' }); return; }
    seen.add(id);
    streamers.push(r.streamer);
  });
  next.streamers = streamers;
  next.watchTime = importedWatchTime(incoming.watchTime);
  for (const key of IMPORT_KEYS) {
    if (key === 'streamers' || key === 'watchTime' || !has(incoming, key)) continue;
    const r = readSetting(key, incoming[key]);
    if (r.reason) refused.push({ key, reason: r.reason });
    else next[key] = r.value;
  }
  const ignored = Object.keys(incoming).filter(k => !IMPORT_KEYS.includes(k));
  return { config: next, dropped, ignored, refused };
}

// A copy for Settings > Export, without this install's secrets.
function exportableConfig(cfg) {
  const out = { ...cfg };
  for (const key of EXPORT_OMIT_KEYS) delete out[key];
  return out;
}

// The pairing code as stored: upper-case hex. Existing installs have 8
// characters and keep them (a new code would silently stop every paired
// extension's background re-sync); new ones get 32. Anything else (a number,
// a short string from a hand edit) is not a code, and the receiver's
// comparison would refuse the real extension forever, so it is replaced.
const PAIRING_CODE = /^[0-9A-F]{8,64}$/;
function normalizePairingCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return PAIRING_CODE.test(code) ? code : null;
}

function newPairingCode(randomBytes) {
  return randomBytes(16).toString('hex').toUpperCase();
}

// Platforms whose extension auto re-sync main refuses (config.signedOutPlatforms):
// { platform: timestamp } when the user signed it out in the app, and
// { platform: { at, reason: 'app-login' } } when they connected it inside the
// app, whose session a re-sync from the browser would replace (F53). Missing
// or damaged reads as "none", so upgraders behave as before, and any truthy
// value blocks, so an older build reading a newer file still refuses.
function isSignedOutIn(map, platform) {
  return isPlainObject(map) && has(map, platform) && !!map[platform];
}

// 'signed-out', 'app-login', or null when auto re-sync is allowed.
function signedOutReasonIn(map, platform) {
  if (!isSignedOutIn(map, platform)) return null;
  const v = map[platform];
  return isPlainObject(v) && v.reason === 'app-login' ? 'app-login' : 'signed-out';
}

function withSignedOut(map, platform, signedOut, now = Date.now(), reason = 'signed-out') {
  const out = isPlainObject(map) ? { ...map } : {};
  if (signedOut) out[platform] = reason === 'app-login' ? { at: now, reason } : now;
  else delete out[platform];
  return out;
}

module.exports = {
  KNOWN_PLATFORMS,
  STREAMER_MODES,
  QUALITIES,
  RENDERER_KEYS,
  IMPORT_KEYS,
  EXPORT_OMIT_KEYS,
  isPlainObject,
  rendererConfigPatch,
  importedConfig,
  importedStreamer,
  channelNameProblem,
  importedWatchTime,
  repairWatchTime,
  exportableConfig,
  normalizePairingCode,
  newPairingCode,
  isSignedOutIn,
  signedOutReasonIn,
  withSignedOut,
};
