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

const { SETTING_RANGES, clampSetting } = require('./config-sanitize');

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
const MAX_TEXT = 1000;
const MAX_FLAGS = 5000;
const MAX_USERNAME = 100;

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

// The dashboard's copy of one streamer entry, reduced to the fields a
// streamer has. Entries that are not objects pass through untouched, so the
// config normalizer drops them and sets them aside (sanitizeIncomingConfig).
function rendererStreamer(entry) {
  if (!isPlainObject(entry)) return entry;
  const out = { platform: entry.platform, username: entry.username };
  if (STREAMER_MODES.includes(entry.mode)) out.mode = entry.mode;
  return out;
}

// Characters no channel name has, that would change the URL a name is put
// into (kick.com/api/v1/channels/<name>, youtube.com/@<name>/live).
const BAD_NAME_CHARS = /[\s/\\?#%&<>"'`\u0000-\u001f\u007f]/;

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
function rendererExtensions(value, current, approved) {
  if (!Array.isArray(value)) return { reason: 'not a list' };
  const known = new Set(Array.isArray(current) ? current : []);
  const out = [];
  const refused = [];
  const used = [];
  for (const p of value) {
    if (typeof p !== 'string' || !p || out.includes(p)) continue;
    if (known.has(p)) out.push(p);
    else if (approved && approved.has(p)) { out.push(p); used.push(p); }
    else refused.push(p);
  }
  return { value: out, refused, used };
}

// The keys the dashboard may change, validated. Returns { patch, refused,
// approvedUsed }: patch holds only renderer-owned keys that were present and
// valid, and is merged over main's live config, so everything main owns
// (accounts, watch time, the pairing code, markers) always comes from main.
function rendererConfigPatch(incoming, current, { approvedExtensions } = {}) {
  const patch = {};
  const refused = [];
  let approvedUsed = [];
  if (!isPlainObject(incoming)) return { patch, refused: [{ key: '(config)', reason: 'not an object' }], approvedUsed };
  for (const key of RENDERER_KEYS) {
    // IPC keeps a key set to undefined; that is "not sent", not a bad value.
    if (!has(incoming, key) || incoming[key] === undefined) continue;
    const value = incoming[key];
    if (key === 'streamers') {
      if (Array.isArray(value)) patch.streamers = value.map(rendererStreamer);
      else refused.push({ key, reason: 'not a list' });
      continue;
    }
    if (key === 'extensions') {
      const r = rendererExtensions(value, current && current.extensions, approvedExtensions);
      if (r.reason) { refused.push({ key, reason: r.reason }); continue; }
      patch.extensions = r.value;
      approvedUsed = r.used;
      for (const p of r.refused) refused.push({ key, reason: `folder not picked in Stream Lurker's own dialog: ${String(p).slice(0, 160)}` });
      continue;
    }
    const r = readSetting(key, value);
    if (r.reason) refused.push({ key, reason: r.reason });
    else patch[key] = r.value;
  }
  return { patch, refused, approvedUsed };
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
  incoming.streamers.forEach((entry, index) => {
    const r = importedStreamer(entry);
    if (r.reason) { dropped.push({ index, entry, reason: r.reason }); return; }
    const id = `${r.streamer.platform}:${r.streamer.username.toLowerCase()}`;
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

// Platforms the user signed out of in the app (config.signedOutPlatforms,
// { platform: timestamp }). Missing or damaged reads as "none", so upgraders
// behave as before.
function isSignedOutIn(map, platform) {
  return isPlainObject(map) && has(map, platform) && !!map[platform];
}

function withSignedOut(map, platform, signedOut, now = Date.now()) {
  const out = isPlainObject(map) ? { ...map } : {};
  if (signedOut) out[platform] = now;
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
  importedWatchTime,
  repairWatchTime,
  exportableConfig,
  normalizePairingCode,
  newPairingCode,
  isSignedOutIn,
  withSignedOut,
};
