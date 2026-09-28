// index.html hardening: the Content-Security-Policy (F07), no inline script
// or handlers (F94), and nothing render/script-blocking fetched from the
// network (G4.7). Run: node --test test/renderer-csp.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const RAW_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// Comments may mention handlers; only real markup counts.
const HTML = RAW_HTML.replace(/<!--[\s\S]*?-->/g, '');

function cspDirectives() {
  const metas = [...HTML.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/gi)];
  assert.equal(metas.length, 1, 'exactly one CSP meta tag');
  const map = new Map();
  for (const part of metas[0][1].split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    assert.ok(!map.has(name), `duplicate directive ${name}`);
    map.set(name, sources);
  }
  return { map, index: metas[0].index };
}

const startTags = tag => [...HTML.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map(m => ({ attrs: m[1], index: m.index }));
const attr = (attrs, name) => (attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1];

test('F07: scripts only from the app itself, never inline, never remote', () => {
  const { map } = cspDirectives();
  assert.deepEqual(map.get('script-src'), ["'self'"]);
  assert.deepEqual(map.get('script-src-attr'), ["'none'"]);
  assert.deepEqual(map.get('default-src'), ["'self'"]);
  assert.deepEqual(map.get('object-src'), ["'none'"]);
  assert.deepEqual(map.get('base-uri'), ["'none'"]);
  assert.deepEqual(map.get('form-action'), ["'none'"]);
  for (const [name, sources] of map) {
    assert.ok(!sources.includes("'unsafe-eval'"), `${name} allows eval`);
    assert.ok(!sources.includes('*') && !sources.includes('http:') && !sources.includes('wss:') && !sources.includes('ws:'), `${name} is too broad`);
    if (name !== 'style-src') assert.ok(!sources.includes("'unsafe-inline'"), `${name} allows inline`);
    // Only frames keep the https: scheme, so <webview> guests behave as before.
    if (name !== 'frame-src') assert.ok(!sources.includes('https:'), `${name} allows any https origin`);
  }
});

test("C3: every directive that loads anything is based on 'self'", () => {
  const { map } = cspDirectives();
  for (const [name, sources] of map) {
    if (sources.length === 1 && sources[0] === "'none'") continue;
    assert.ok(sources.includes("'self'"), `${name} lacks 'self'`);
  }
});

test('F07: the policy governs everything the page loads', () => {
  const { index } = cspDirectives();
  for (const tag of ['link', 'script', 'style']) {
    for (const t of startTags(tag)) assert.ok(t.index > index, `<${tag}> precedes the CSP meta tag`);
  }
});

test('F07: remote hosts in the policy match what the renderer actually uses', async () => {
  const { map } = cspDirectives();
  const { TWITCH_MEDIA_HOSTS } = await load('src/state.js');
  const { WEB_FONTS_HREF } = await load('src/fonts.js');
  // Clip thumbnails are validated against TWITCH_MEDIA_HOSTS before use.
  for (const host of TWITCH_MEDIA_HOSTS) assert.ok(map.get('img-src').includes(`https://*.${host}`), `img-src misses ${host}`);
  // The clips tab fetches Twitch GQL; nothing else in the renderer fetches.
  assert.deepEqual(map.get('connect-src'), ["'self'", 'https://gql.twitch.tv']);
  assert.ok(map.get('style-src').includes(new URL(WEB_FONTS_HREF).origin));
  assert.ok(map.get('font-src').includes('https://fonts.gstatic.com'));
});

test('F94/F07: index.html has no inline script, inline handler or javascript: URL', () => {
  for (const s of startTags('script')) {
    assert.ok(attr(s.attrs, 'src'), 'inline <script> would be blocked by script-src');
    assert.ok(!/^(https?:)?\/\//i.test(attr(s.attrs, 'src')), 'remote script');
  }
  assert.doesNotMatch(HTML, /<[^>]*\son[a-z]+\s*=/i, 'inline on* handler');
  assert.doesNotMatch(HTML, /javascript:/i);
  assert.doesNotMatch(HTML, /require\(/, 'require() does not exist in the context-isolated renderer');
});

test('F94: help links carry an allowlisted data-external-url', async () => {
  const { externalLinkUrl } = await load('src/external-links.js');
  const urls = [...HTML.matchAll(/data-external-url="([^"]*)"/g)].map(m => m[1]);
  // F57 removed the uBlock Origin download link: ad blockers cannot block
  // network requests in the app, so the page no longer recommends one.
  assert.deepEqual(urls.sort(), ['https://dev.twitch.tv/console']);
  for (const url of urls) assert.equal(externalLinkUrl({ dataset: { externalUrl: url } }), url);
});

test('F94: one delegated listener opens allowlisted links and ignores the rest', async () => {
  const { setupExternalLinks, externalLinkUrl } = await load('src/external-links.js');
  let handler = null;
  const doc = { addEventListener: (type, fn) => { assert.equal(type, 'click'); handler = fn; } };
  const opened = [];
  setupExternalLinks(doc, { openExternal: url => opened.push(url) });
  assert.equal(typeof handler, 'function');

  const click = (link) => {
    let prevented = false;
    const target = { closest: sel => (sel === '[data-external-url]' ? link : null) };
    handler({ target, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(click({ dataset: { externalUrl: 'https://github.com/gorhill/uBlock/releases' } }), true);
    assert.equal(click({ dataset: { externalUrl: 'https://dev.twitch.tv/console' } }), true);
    assert.equal(click({ dataset: { externalUrl: 'https://evil.tld/' } }), true, 'still stops the # jump');
    assert.equal(click({ dataset: { externalUrl: 'http://github.com/' } }), true);
    assert.equal(click({ dataset: { externalUrl: 'javascript:alert(1)' } }), true);
    assert.equal(click(null), false, 'other clicks are left alone');
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(opened, ['https://github.com/gorhill/uBlock/releases', 'https://dev.twitch.tv/console']);
  assert.equal(externalLinkUrl({ dataset: { externalUrl: 'https://github.com.evil.tld/' } }), '');
  assert.equal(externalLinkUrl({}), '');
});

test('G4.7: nothing render- or script-blocking is fetched from the network', () => {
  for (const l of startTags('link')) {
    const rel = (attr(l.attrs, 'rel') || '').toLowerCase();
    const href = attr(l.attrs, 'href') || '';
    if (rel.split(/\s+/).includes('stylesheet')) {
      assert.ok(!/^(https?:)?\/\//i.test(href), `parser-inserted remote stylesheet ${href}`);
    }
  }
  // Outside the CSP (which has to allow them), the page itself never names the
  // font hosts: src/fonts.js attaches the stylesheet once the window has loaded.
  const withoutCsp = HTML.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
  assert.doesNotMatch(withoutCsp, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'Google Fonts must be attached from script');
  // The CSS falls back to system fonts while (or if) the web fonts never load.
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(css, /--font-sans:\s*'Outfit',\s*sans-serif;/);
  assert.match(css, /--font-mono:\s*'JetBrains Mono',\s*monospace;/);
});

// A script-inserted stylesheet still holds the window's load event until its
// request settles, and main credits watch time only from did-finish-load
// (that event). Checked in Chrome 152: a stalled stylesheet inserted from a
// module script kept readyState at 'interactive' for as long as it stalled.
test('G4.7: renderer.js defers the fonts to the load event, never attaching them itself', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  assert.match(src, /^loadWebFontsAfterLoad\(\);$/m, 'top-level, never awaited');
  assert.doesNotMatch(src, /\bloadWebFonts\(/, 'no direct loadWebFonts() call, which would hold the load event');
});

test('G4.7: loadWebFontsAfterLoad waits for the load event while the document is still loading', async () => {
  const { loadWebFontsAfterLoad, WEB_FONTS_HREF } = await load('src/fonts.js');
  const makeDoc = readyState => {
    const head = { children: [], appendChild(el) { this.children.push(el); return el; } };
    return {
      readyState,
      head,
      createElement: tag => ({ tagName: tag.toUpperCase() }),
      getElementById: id => head.children.find(el => el.id === id) || null,
    };
  };
  for (const readyState of ['loading', 'interactive']) {
    const doc = makeDoc(readyState);
    const listeners = [];
    const win = { addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }) };
    assert.equal(loadWebFontsAfterLoad(win, doc), null);
    assert.equal(doc.head.children.length, 0, `${readyState}: nothing attached before load`);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, 'load', 'not DOMContentLoaded, which comes before load');
    assert.deepEqual(listeners[0].opts, { once: true });
    doc.readyState = 'complete';
    listeners[0].fn();
    assert.equal(doc.head.children.length, 1);
    assert.equal(doc.head.children[0].href, WEB_FONTS_HREF);
  }
  // Already loaded (a late import): attached at once, no listener left behind.
  const done = makeDoc('complete');
  const win = { addEventListener: () => assert.fail('no listener once loaded') };
  assert.equal(loadWebFontsAfterLoad(win, done).href, WEB_FONTS_HREF);
  assert.equal(done.head.children.length, 1);
});

test('G4.7: loadWebFonts appends one non-blocking stylesheet link, once', async () => {
  const { loadWebFonts, WEB_FONTS_HREF } = await load('src/fonts.js');
  const head = { children: [], appendChild(el) { this.children.push(el); return el; } };
  const doc = {
    head,
    createElement: tag => ({ tagName: tag.toUpperCase() }),
    getElementById: id => head.children.find(el => el.id === id) || null,
  };
  const link = loadWebFonts(doc);
  assert.equal(link.tagName, 'LINK');
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.href, WEB_FONTS_HREF);
  assert.equal(new URL(WEB_FONTS_HREF).protocol, 'https:');
  assert.equal(head.children.length, 1);
  assert.equal(loadWebFonts(doc), null, 'idempotent');
  assert.equal(head.children.length, 1);
  assert.equal(loadWebFonts({}), null, 'no <head>: no-op, no throw');
});
