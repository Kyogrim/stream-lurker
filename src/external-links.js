// Help links in index.html carry data-external-url instead of an inline
// onclick. The old handlers called require('electron'), which does not exist
// in this context-isolated renderer, so the links did nothing; inline handlers
// are also blocked by the CSP (script-src-attr 'none').

import { safeHttpsUrl } from './state.js';

// The hosts the static links point at. Anything else (or anything not https)
// is ignored, so markup that somehow gains the attribute can't open an
// arbitrary page in the user's browser.
export const EXTERNAL_LINK_HOSTS = ['github.com', 'twitch.tv'];

export function externalLinkUrl(el) {
  return safeHttpsUrl(el?.dataset?.externalUrl, EXTERNAL_LINK_HOSTS);
}

// One delegated listener, so links rendered later are covered too.
export function setupExternalLinks(doc = document, api = window.api) {
  doc.addEventListener('click', (e) => {
    const link = e.target?.closest?.('[data-external-url]');
    if (!link) return;
    // href="#" would otherwise scroll the tab to the top.
    e.preventDefault();
    const url = externalLinkUrl(link);
    if (url) api.openExternal(url);
    else console.warn('[Links] Refused external link:', link.dataset.externalUrl);
  });
}
