// Unit tests for the renderer's escaping and URL-vetting helpers (contract C2)
// and the pure data helpers behind the clip and calendar fixes.
// Run: node --test test/renderer-escape.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { decodeEntities } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

test('escapeHtml escapes all five characters, & first, and nothing else', async () => {
  const { escapeHtml } = await load('src/state.js');
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  // Already-escaped input is escaped again, so it displays as typed.
  assert.equal(escapeHtml('&lt;3'), '&amp;lt;3');
  assert.equal(escapeHtml('plain text · 🔥 ümlaut'), 'plain text · 🔥 ümlaut');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml({ toString: () => '"><img>' }), '&quot;&gt;&lt;img&gt;');
});

test('escapeHtml round-trips through the HTML parser for any string', async () => {
  const { escapeHtml } = await load('src/state.js');
  // Deterministic pseudo-random strings over a markup-heavy alphabet.
  const alphabet = `<>&"'=/ ;#x0aA\`\u00a0é🔥`;
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let n = 0; n < 500; n++) {
    let s = '';
    for (let len = next() % 40; len > 0; len--) s += [...alphabet][next() % [...alphabet].length];
    const out = escapeHtml(s);
    assert.doesNotMatch(out, /[<>"']/);
    assert.doesNotMatch(out, /&(?!amp;|lt;|gt;|quot;|#39;)/);
    assert.equal(decodeEntities(out), s);
  }
});

test('safeHttpsUrl accepts https on an allowed host (or subdomain) only', async () => {
  const { safeHttpsUrl, TWITCH_MEDIA_HOSTS, TWITCH_PAGE_HOSTS, STREAM_HOSTS } = await load('src/state.js');
  const ok = [
    ['https://static-cdn.jtvnw.net/twitch-clips-thumbnails-prod/x/preview.jpg', TWITCH_MEDIA_HOSTS],
    ['https://clips-media-assets2.twitch.tv/x-preview-480x272.jpg', TWITCH_MEDIA_HOSTS],
    ['https://production.assets.clips.twitchcdn.net/v2/media/1/x.mp4?sig=a&token=b', TWITCH_MEDIA_HOSTS],
    ['https://clips.twitch.tv/SomeSlug', TWITCH_PAGE_HOSTS],
    ['https://www.twitch.tv/chan/clip/slug', TWITCH_PAGE_HOSTS],
    ['https://twitch.tv/x', TWITCH_PAGE_HOSTS],
    ['https://kick.com/k', STREAM_HOSTS],
    ['HTTPS://WWW.YOUTUBE.COM/@x/live', STREAM_HOSTS],
  ];
  for (const [url, hosts] of ok) assert.equal(safeHttpsUrl(url, hosts), new URL(url).href, url);

  const bad = [
    'http://clips.twitch.tv/x', 'javascript:alert(1)', 'data:text/html,<script>1</script>',
    'https://twitch.tv.evil.tld/x', 'https://eviltwitch.tv/x', 'https://evil.tld/twitch.tv',
    'https://user:pass@clips.twitch.tv/x', 'https://clips.twitch.tv@evil.tld/x', '//clips.twitch.tv/x',
    '/relative', '', 'not a url', 'file:///C:/x', 'blob:https://clips.twitch.tv/x',
  ];
  for (const url of bad) assert.equal(safeHttpsUrl(url, TWITCH_PAGE_HOSTS), '', url);
  for (const v of [null, undefined, 42, {}, ['https://clips.twitch.tv/x']]) assert.equal(safeHttpsUrl(v, TWITCH_PAGE_HOSTS), '');
  // An attribute-breakout attempt is percent-encoded, never passed through raw.
  assert.doesNotMatch(safeHttpsUrl('https://clips.twitch.tv/x" onerror="y', TWITCH_PAGE_HOSTS), /["\s]/);
});

test('platform helpers keep their output for real platforms and refuse the rest', async () => {
  const s = await load('src/state.js');
  assert.equal(s.platformColorVar('Twitch'), 'var(--twitch-color)');
  assert.equal(s.platformColorVar('kick'), 'var(--kick-color)');
  assert.equal(s.platformColorVar('x);background:url(https://evil.tld/'), 'var(--text-muted)');
  assert.equal(s.platformColorVar(undefined), 'var(--text-muted)');
  assert.match(s.getPlatformSVG('YouTube'), /^<svg class="badge-logo"/);
  assert.equal(s.getPlatformSVG('constructor'), '');
  assert.equal(s.getPlatformSVG('__proto__'), '');
  assert.equal(s.formatViewerCount(999), 999);
  assert.equal(s.formatViewerCount(1500), '1.5K');
  assert.equal(s.formatViewerCount(2_500_000), '2.5M');
  assert.equal(s.formatViewerCount('1500'), '1.5K');
  assert.equal(s.formatViewerCount('<b>9</b>'), 0);
  assert.equal(s.formatViewerCount(undefined), 0);
});

test('streamWebviewSrc: platform URLs only, whatever the username holds', async () => {
  const { streamWebviewSrc } = await load('src/stream-webview.js');
  assert.equal(streamWebviewSrc('twitch', 'Name_1'), 'https://www.twitch.tv/name_1');
  assert.equal(streamWebviewSrc('youtube', 'chan'), 'https://www.youtube.com/@chan/live');
  const hostile = new URL(streamWebviewSrc('twitch', 'x" preload="file:///C:/evil.js'));
  assert.equal(hostile.hostname, 'www.twitch.tv');
  assert.doesNotMatch(hostile.href, /[" ]/);
  assert.equal(streamWebviewSrc('rumble', 'r', { resolvedUrl: 'javascript:alert(1)' }), '');
  assert.equal(streamWebviewSrc('unknown', 'x'), '');
});

test('parseSavedClips keeps clip objects with an id and drops the rest', async () => {
  const { parseSavedClips } = await load('src/clips.js');
  assert.deepEqual(parseSavedClips(null), []);
  assert.deepEqual(parseSavedClips(''), []);
  assert.deepEqual(parseSavedClips('{not json'), []);
  assert.deepEqual(parseSavedClips('{"id":"x"}'), []);
  assert.deepEqual(parseSavedClips('"<img src=x onerror=1>"'), []);
  const kept = parseSavedClips(JSON.stringify([{ id: 'a', title: '<img src=x onerror=1>' }, { id: 7 }, null, 'x', { title: 'no id' }, { id: {} }]));
  assert.deepEqual(kept, [{ id: 'a', title: '<img src=x onerror=1>' }, { id: 7 }]);
});

test('clipView turns any clip into plain display strings', async () => {
  const { clipView } = await load('src/clips.js');
  const title = '"><img src=x onerror=window.__pwned=1>';
  const v = clipView({ id: 12, slug: '../../evil name', title, viewCount: 12345, durationSeconds: 30, broadcaster: { displayName: 'Blushing <3 "q" & more' } });
  assert.deepEqual(v, { id: '12', title, author: 'Blushing <3 "q" & more', views: (12345).toLocaleString(), duration: '30s', fileName: 'evilname.mp4' });
  assert.deepEqual(clipView(null), { id: '', title: 'Untitled Clip', author: 'Unknown', views: '0', duration: '', fileName: 'clip.mp4' });
  assert.equal(clipView({ title: '' }, 'Untitled').title, 'Untitled');
  assert.equal(clipView({ broadcaster: null }).author, 'Unknown');
  assert.equal(clipView({ viewCount: 'lots' }).views, '0');
});

test('clip URL helpers only return Twitch https URLs', async () => {
  const c = await load('src/clips.js');
  assert.equal(c.clipThumbUrl({ thumbnailURL: 'https://static-cdn.jtvnw.net/a.jpg' }), 'https://static-cdn.jtvnw.net/a.jpg');
  assert.equal(c.clipThumbUrl({ thumbnailURL: 'javascript:alert(1)' }), '');
  assert.equal(c.clipThumbUrl(null), '');
  assert.equal(c.clipPageUrl({ url: 'https://clips.twitch.tv/Slug' }), 'https://clips.twitch.tv/Slug');
  assert.equal(c.clipPageUrl({ url: 'https://static-cdn.jtvnw.net/Slug' }), '', 'page URLs are twitch.tv only');
  assert.equal(c.clipSourceUrl({ videoQualities: [{ sourceURL: 'https://production.assets.clips.twitchcdn.net/x.mp4' }] }), 'https://production.assets.clips.twitchcdn.net/x.mp4');
  assert.equal(c.clipSourceUrl({ videoQualities: [{ sourceURL: 'https://evil.tld/x.mp4' }] }), '');
  assert.equal(c.clipSourceUrl({ videoQualities: 'nope' }), '');
  assert.equal(c.signedClipUrl('https://production.assets.clips.twitchcdn.net/x.mp4', { signature: 'ab&c', value: '{"t":1}' }),
    'https://production.assets.clips.twitchcdn.net/x.mp4?sig=ab%26c&token=%7B%22t%22%3A1%7D');
  assert.equal(c.signedClipUrl('https://production.assets.clips.twitchcdn.net/x.mp4', null), 'https://production.assets.clips.twitchcdn.net/x.mp4');
  assert.equal(c.signedClipUrl('https://evil.tld/x.mp4', { signature: 'a', value: 'b' }), '');
  assert.equal(c.legacyClipMp4Url({ thumbnailURL: 'https://clips-media-assets2.twitch.tv/AT-123-preview-480x272.jpg' }), 'https://clips-media-assets2.twitch.tv/AT-123.mp4');
  assert.equal(c.legacyClipMp4Url({ thumbnailURL: 'https://clips-media-assets2.twitch.tv/AT-123-480x272.jpg' }), 'https://clips-media-assets2.twitch.tv/AT-123.mp4');
  assert.equal(c.legacyClipMp4Url({ thumbnailURL: 'https://evil.tld/AT-123-preview-480x272.jpg' }), '');
});

test('normalizeCalendarEvent: integer day 0-6, plain strings, or null', async () => {
  const { normalizeCalendarEvent } = await load('src/calendar.js');
  assert.deepEqual(
    normalizeCalendarEvent({ id: 'x', day: '3', time: '18:00', streamer: '<b>', title: '" onmouseover="x', platform: 'twitch', type: 'auto' }),
    { day: 3, time: '18:00', streamer: '<b>', title: '" onmouseover="x', platform: 'twitch', isAuto: true },
  );
  assert.deepEqual(normalizeCalendarEvent({ day: 0 }), { day: 0, time: '', streamer: '', title: '', platform: '', isAuto: false });
  for (const day of [7, -1, 2.5, '3"] img', NaN, null, undefined, '', [], {}]) {
    assert.equal(normalizeCalendarEvent({ day, time: '1' }), null, `day ${String(day)}`);
  }
  assert.equal(normalizeCalendarEvent(null), null);
  assert.equal(normalizeCalendarEvent('x'), null);
  // Non-string fields become strings, so sorting by time never throws.
  assert.equal(normalizeCalendarEvent({ day: 1, time: 1800 }).time, '1800');
});
