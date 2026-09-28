// What download-clip and open-clip-window accept from the dashboard. Both URLs
// come from the renderer, which only builds https URLs on Twitch hosts
// (TWITCH_MEDIA_HOSTS / TWITCH_PAGE_HOSTS in src/state.js); main holds them to
// the same lists, so a compromised page cannot point either at a LAN host or
// at http:. The file name is only the Save dialog's suggestion, but an
// absolute path or a device name there would steer the dialog. Pure, tested
// in test/main-clip-download.test.js.

const path = require('path');

const CLIP_MEDIA_HOSTS = ['twitch.tv', 'jtvnw.net', 'twitchcdn.net'];
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
  return httpsUrlOn(value, CLIP_MEDIA_HOSTS);
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
  name = name.replace(/\.mp4$/i, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) name = `_${name}`;
  name = name.slice(0, MAX_NAME_LENGTH - 4).replace(/[. ]+$/, '');
  return `${name || 'clip'}.mp4`;
}

module.exports = { CLIP_MEDIA_HOSTS, CLIP_PAGE_HOSTS, clipDownloadUrl, clipPageUrl, clipFileName };
