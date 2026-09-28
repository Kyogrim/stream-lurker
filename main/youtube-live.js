// Reads a YouTube channel's /live page (keyless: the canonical link points at
// /watch?v= only while a broadcast is on). Tested against page fixtures in
// test/main-youtube-live.test.js.
//
// The session identity must hold still for the whole broadcast, because the
// scanner keys its go-live alert and auto-open dedupe on it. It used to be the
// scan time, so every scan re-alerted, reopened a cell the user had closed and
// counted a new session.

// Any of these on the page means the canonical /watch link is a scheduled or
// ended broadcast, not a live one.
const NOT_LIVE_MARKERS = [
  'upcomingEventData',
  'scheduledStartTime',
  'liveStreamOfflineSlateRenderer',
  'offlineSlate',
  'LIVE_STREAM_OFFLINE',
  'isUpcoming',
];

// Video ids use - and _ as well as word characters.
const VIDEO_ID = /[?&]v=([\w-]{11})/;
// Anchored on liveBroadcastDetails: the 1 MB page embeds other objects that
// carry their own startTimestamp.
const BROADCAST_START = /"liveBroadcastDetails":\{[^}]*"startTimestamp":"([^"]+)"/;

// How far past "videoDetails": the title may be. It is the object's second
// key; the bound keeps a page whose videoDetails has no title from picking up
// some later, unrelated "title".
const VIDEO_DETAILS_WINDOW = 4000;

// The video title from a watch or /live page, decoded from its JSON string
// (& is "&", \" is a quote). The old pattern stopped at the first
// escaped quote and at the first "}" in the title, and showed escapes
// literally. The decoded text can hold < and >: it is plain text, and every
// place that shows it must treat it so. `fallback` when there is none.
function extractYtVideoTitle(html, fallback) {
  const page = typeof html === 'string' ? html : '';
  const at = page.indexOf('"videoDetails":');
  if (at < 0) return fallback;
  const m = page.slice(at, at + VIDEO_DETAILS_WINDOW).match(/"title":("(?:[^"\\]|\\.)*")/);
  if (!m) return fallback;
  try {
    const title = JSON.parse(m[1]);
    return typeof title === 'string' && title.trim() ? title : fallback;
  } catch (e) {
    return fallback;
  }
}

// Returns { isLive: false } or { isLive: true, title, viewerCount, liveSince,
// sessionId }. liveSince is the broadcast's real start as ISO text, or '' when
// the page does not say (the dashboard then shows no uptime rather than a
// wrong one). sessionId is the video id, stable for the broadcast and new when
// a 24/7 channel restarts it.
function parseYoutubeLivePage(html) {
  const page = typeof html === 'string' ? html : '';
  const canonicalMatch = page.match(/<link rel="canonical" href="([^"]+)"/);
  if (!canonicalMatch) return { isLive: false };
  const canonicalUrl = canonicalMatch[1];
  if (!canonicalUrl.includes('/watch?v=') || NOT_LIVE_MARKERS.some(m => page.includes(m))) {
    return { isLive: false };
  }

  const title = extractYtVideoTitle(page, 'YouTube Live Stream');

  let viewerCount = 0;
  const viewCountMatch = page.match(/"viewCount":"([^"]+)"/);
  if (viewCountMatch) viewerCount = parseInt(viewCountMatch[1], 10) || 0;

  let liveSince = '';
  const startMatch = page.match(BROADCAST_START);
  if (startMatch) {
    const t = Date.parse(startMatch[1]);
    if (Number.isFinite(t)) liveSince = new Date(t).toISOString();
  }

  const idMatch = canonicalUrl.match(VIDEO_ID);
  return { isLive: true, title, viewerCount, liveSince, sessionId: idMatch ? idMatch[1] : '' };
}

module.exports = { parseYoutubeLivePage, extractYtVideoTitle };
