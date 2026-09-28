// The <webview> element for a Multi-Lurk grid cell.
//
// Built with DOM calls, not markup, so no config string (usernames can hold
// anything after an import) can add attributes to it, and its src is only ever
// an https URL on a platform host.

import { streamUrl, safeHttpsUrl, STREAM_HOSTS, appendLogMessage } from './state.js';

export function streamWebviewSrc(platform, username, status) {
  return safeHttpsUrl(streamUrl(platform, username, status), STREAM_HOSTS);
}

// partition is set before src and before the element is attached, which is
// when it navigates.
export function createStreamWebview(platform, username, status) {
  const webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:default');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('muted', '');
  const src = streamWebviewSrc(platform, username, status);
  if (src) webview.setAttribute('src', src);
  else appendLogMessage(`[Lurk] Not loading ${username} on ${String(platform).toUpperCase()}: stream URL is not on a known platform host.`);
  return webview;
}
