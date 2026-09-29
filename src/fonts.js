// Web fonts are attached from script rather than a <link> in index.html. A
// parser-inserted stylesheet in <head> is render- and script-blocking: where
// Google is blackholed (some corporate/school networks, a stalled proxy) the
// window stayed unshown and renderer.js did not run until the connection timed
// out. A script-inserted stylesheet blocks neither; the fallbacks in style.css
// (--font-sans / --font-mono) cover the wait and the offline case.

export const WEB_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap';

export function loadWebFonts(doc = document) {
  if (!doc?.head || doc.getElementById('web-fonts')) return null;
  const link = doc.createElement('link');
  link.id = 'web-fonts';
  link.rel = 'stylesheet';
  link.href = WEB_FONTS_HREF;
  doc.head.appendChild(link);
  return link;
}

// Not before the window's load event, though. A script-inserted stylesheet
// still holds that event until its request settles, and main starts crediting
// watch time on did-finish-load, which is that event: where the font request
// stalled, nothing was credited for ~21 s (Google blackholed) or for as long
// as a stalling proxy held it. Blink sends did-finish-load straight after
// dispatching `load`, so a request started from the handler cannot delay it.
export function loadWebFontsAfterLoad(win = window, doc = document) {
  if (doc?.readyState === 'complete') return loadWebFonts(doc);
  win?.addEventListener?.('load', () => loadWebFonts(doc), { once: true });
  return null;
}
