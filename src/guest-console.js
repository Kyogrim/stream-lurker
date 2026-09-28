// Which lines the in-page quality/theatre script (src/inject.js) prints are
// worth a line in the activity console, and how they are worded there.
//
// inject.js logs only on state changes now (first failure, success, give-up),
// about two lines per channel. The per-cell dedupe below is the backstop in
// case a page loop ever logs every round again: a stuck Kick cell used to
// write 3-4 lines every 15 s and overwrite the 300-line console in minutes.
// Pure functions; multi-lurk.js wires them to each cell's webview.

// Only lines that start with one of these tags, the way inject.js prints them.
// A page (or an ad frame in it) can print anything, so a tag in the middle of
// a line is not ours.
const FORWARDED = [
  { tag: '[Twitch Quality]', label: 'Quality' },
  { tag: '[Kick Quality]', label: 'Quality' },
  { tag: '[Kick Theater]', label: 'Theater' },
];

export const GUEST_LOG_DEDUPE_MS = 60 * 1000;

// The console element keeps whole lines; a page printing a huge string after
// the tag should not fill it.
const MAX_FORWARDED_CHARS = 300;

// The activity-console line for a guest console message, or null when the
// message is not one we forward. `[Quality - name] rest` / `[Theater - name] rest`.
export function guestLogLine(message, username) {
  if (typeof message !== 'string') return null;
  for (const { tag, label } of FORWARDED) {
    if (!message.startsWith(tag)) continue;
    const rest = message.slice(tag.length).trim().slice(0, MAX_FORWARDED_CHARS);
    return rest ? `[${label} - ${username}] ${rest}` : null;
  }
  return null;
}

// A per-cell filter: true when `line` should be shown, false when the same
// line was shown less than windowMs ago. Old entries are dropped as it goes,
// so the map only ever holds the last window's distinct lines.
export function createLineDeduper(windowMs = GUEST_LOG_DEDUPE_MS) {
  const shownAt = new Map();
  return function shouldShow(line, now) {
    for (const [l, t] of shownAt) {
      if (now - t >= windowMs) shownAt.delete(l);
    }
    if (shownAt.has(line)) return false;
    shownAt.set(line, now);
    return true;
  };
}
