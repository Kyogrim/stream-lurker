// What download-clip and open-clip-window accept from the dashboard. Both URLs
// come from the renderer, which only builds https URLs on Twitch hosts
// (TWITCH_MEDIA_HOSTS / TWITCH_PAGE_HOSTS in src/state.js); main holds them to
// the same lists, so a compromised page cannot point either at a LAN host or
// at http:. The file name is only the Save dialog's suggestion, but an
// absolute path or a device name there would steer the dialog. Pure, tested
// in test/main-clip-download.test.js.

const path = require('path');

const CLIP_MEDIA_HOSTS = ['twitch.tv', 'jtvnw.net', 'twitchcdn.net'];
// Clip video files. Twitch serves every current clip (videoQualities[].sourceURL)
// from this one CloudFront distribution, checked against live GQL answers. It
// is named exactly: anyone can host on bare cloudfront.net. Must equal
// TWITCH_CLIP_FILE_HOSTS in src/state.js, which builds the URLs sent here.
const CLIP_FILE_HOSTS = [...CLIP_MEDIA_HOSTS, 'd1ndex63qxojbr.cloudfront.net'];
const CLIP_PAGE_HOSTS = ['twitch.tv'];
const MAX_NAME_LENGTH = 150;

function httpsUrlOn(value, hosts) {
  if (typeof value !== 'string' || !value) return '';
  let url;
  try { url = new URL(value); } catch (e) { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const host = url.hostname.toLowerCase();
  return hosts.some(h => host === h || host.endsWith(`.${h}`)) ? url.href : '';
}

// The normalized URL, or '' when it is not an https Twitch clip file.
function clipDownloadUrl(value) {
  return httpsUrlOn(value, CLIP_FILE_HOSTS);
}

// The normalized URL, or '' when it is not an https twitch.tv page.
function clipPageUrl(value) {
  return httpsUrlOn(value, CLIP_PAGE_HOSTS);
}

// A bare, legal Windows file name ending in .mp4: no folders, no characters
// Windows refuses, no trailing dots or spaces, no device name (CON, NUL, ...).
function clipFileName(value) {
  let name = path.win32.basename(String(value == null ? '' : value));
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim();
  // Trailing dots and spaces go before the extension does, or 'x.mp4.' kept
  // its .mp4 and got a second one.
  name = name.replace(/[. ]+$/, '').replace(/\.mp4$/i, '').replace(/[. ]+$/, '');
  // Windows reserves these with any extension, with spaces before it, and
  // with superscript digits; CONIN$ and CONOUT$ too.
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\s*\..*)?$/i.test(name)) name = `_${name}`;
  let cut = name.slice(0, MAX_NAME_LENGTH - 4);
  // Never half of a surrogate pair: it becomes U+FFFD on disk.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  name = cut.replace(/[. ]+$/, '');
  return `${name || 'clip'}.mp4`;
}

module.exports = { CLIP_MEDIA_HOSTS, CLIP_FILE_HOSTS, CLIP_PAGE_HOSTS, clipDownloadUrl, clipPageUrl, clipFileName };
