// Regression harness for the renderer XSS findings (F01 clips, F02 stream
// cards, F03 calendar, F89 usernames / <webview>). Runs the real renderer
// modules against a recording fake DOM (renderer-fake-dom.js) with hostile
// data, and checks what the HTML parser would have been handed.
// Run: node --test test/renderer-xss-harness.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, injectedElements } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

// Tag injection, attribute breakout with either quote, a closing-tag escape,
// and ordinary text that looks like markup and must survive literally.
const PAYLOADS = [
  '<img src=x onerror=window.__pwned=1>',
  '"><img src=x onerror=window.__pwned=1>',
  '" onmouseover="window.__pwned=1',
  "' onmouseover='window.__pwned=1",
  '</p><script>window.__pwned=1</script>',
  'Blushing <3 "quoted" & more &amp; stuff',
];

function install(doc, { api = {}, storage = {}, fetchImpl } = {}) {
  const saved = {
    document: globalThis.document, window: globalThis.window,
    localStorage: globalThis.localStorage, fetch: globalThis.fetch,
  };
  globalThis.document = doc;
  globalThis.window = { api };
  globalThis.localStorage = {
    getItem: k => (Object.hasOwn(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  };
  if (fetchImpl) globalThis.fetch = fetchImpl;
  return () => Object.assign(globalThis, saved);
}

// No element the parser built carries an on* attribute or is a script-like
// tag, and no raw payload string was ever handed to innerHTML. With
// `domOnly`, the data must not have reached innerHTML even escaped: those
// modules fill text through DOM properties.
function assertNoRawPayload(doc, { extra = [], domOnly = false } = {}) {
  assert.deepEqual(injectedElements(doc).map(el => el.tagName), [], 'the parser produced an injected element');
  for (const html of doc.htmlLog) {
    for (const raw of [...PAYLOADS, ...extra]) {
      assert.ok(!html.includes(raw), `raw payload reached innerHTML: ${raw}`);
    }
    if (domOnly) assert.doesNotMatch(html, /__pwned/, `data reached innerHTML: ${html.slice(0, 120)}`);
  }
}

test('F01: clip titles, authors and URLs never reach the HTML parser', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const grid = doc.add('div', 'trending-clips-grid');
  const savedList = doc.add('div', 'saved-clips-list');
  const refresh = doc.add('button', 'refresh-clips-btn');
  const filter = doc.add('select', 'clips-filter-select');
  filter.value = 'trending';

  // An older build could have stored any of this; it must render inertly.
  const poisonedSaved = [
    { id: 'saved-1', title: PAYLOADS[1], broadcaster: { displayName: PAYLOADS[0] }, thumbnailURL: 'javascript:alert(1)', url: 'https://evil.tld/clip' },
    { id: 'saved-2', title: PAYLOADS[5], broadcaster: { displayName: 'ok' }, thumbnailURL: 'https://static-cdn.jtvnw.net/c/x-preview-480x272.jpg', url: 'https://clips.twitch.tv/GoodSlug' },
    'not a clip', null, { title: 'no id' },
  ];
  const storage = { stream_lurker_saved_clips: JSON.stringify(poisonedSaved) };

  const apiCalls = [];
  const api = {
    openClipWindow: url => apiCalls.push(['open', url]),
    downloadClip: (url, name) => apiCalls.push(['download', url, name]),
  };
  const clips = PAYLOADS.map((title, i) => ({
    // Descending view counts keep the grid in PAYLOADS order (trending sorts by views).
    id: `c${i}`, slug: `Slug${i}`, title, viewCount: 2000 - i, durationSeconds: 30,
    url: i === 0 ? 'javascript:alert(1)' : `https://clips.twitch.tv/Slug${i}`,
    thumbnailURL: i === 1 ? 'https://static-cdn.jtvnw.net/x.jpg" onerror="window.__pwned=1' : `https://clips-media-assets2.twitch.tv/x${i}-preview-480x272.jpg`,
    broadcaster: { displayName: PAYLOADS[(i + 1) % PAYLOADS.length] },
    videoQualities: i === 2 ? [{ sourceURL: 'https://evil.tld/x.mp4' }] : [{ sourceURL: `https://production.assets.clips.twitchcdn.net/v2/media/${i}/x.mp4` }],
  }));
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)[0];
    if (body.operationName === 'GetClips') {
      return { json: async () => [{ data: { user: { clips: { edges: [...clips.map(node => ({ node })), { node: null }, null] } } } }] };
    }
    return { json: async () => [{ data: { clip: { playbackAccessToken: { signature: 'abc123', value: '{"a":"b c"}' } } } }] };
  };
  const restore = install(doc, { api, storage, fetchImpl });
  t.after(restore);

  const { state } = await load('src/state.js');
  state.currentConfig = { streamers: [{ platform: 'twitch', username: 'someone' }] };
  const mod = await load('src/clips.js');
  mod.initClipsManager();
  await refresh.dispatch('click');

  // Saved clips: rendered from storage, garbage entries dropped.
  const savedCards = savedList.children;
  assert.equal(savedCards.length, 2);
  assert.equal(savedCards[0].querySelector('.clip-title').textContent, PAYLOADS[1]);
  assert.equal(savedCards[0].querySelector('.clip-title').title, PAYLOADS[1]);
  assert.equal(savedCards[0].querySelector('.clip-author').textContent, PAYLOADS[0]);
  assert.equal(savedCards[0].querySelector('.clip-thumb').src, '', 'javascript: thumbnail must not load');
  assert.equal(savedCards[1].querySelector('.clip-title').textContent, PAYLOADS[5]);
  assert.equal(savedCards[1].querySelector('.clip-thumb').src, 'https://static-cdn.jtvnw.net/c/x-preview-480x272.jpg');

  // Trending grid: one card per clip, text literal, exactly one <img> each.
  const cards = grid.children;
  assert.equal(cards.length, PAYLOADS.length);
  cards.forEach((card, i) => {
    assert.equal(card.querySelector('.clip-title').textContent, PAYLOADS[i]);
    assert.equal(card.querySelector('.clip-title').title, PAYLOADS[i]);
    assert.equal(card.querySelector('.clip-author').textContent, PAYLOADS[(i + 1) % PAYLOADS.length]);
    assert.equal(card.querySelectorAll('img').length, 1);
    assert.equal(card.querySelector('.save-btn').dataset.clipId, `c${i}`);
  });
  // A quote in a thumbnail URL is percent-encoded by URL parsing and set as a
  // property, so it cannot open a new attribute.
  assert.doesNotMatch(cards[1].querySelector('.clip-thumb').src, /"/);
  assert.match(cards[1].querySelector('.clip-thumb').src, /^https:\/\/static-cdn\.jtvnw\.net\//);
  assertNoRawPayload(doc, { domOnly: true });

  // Watch: a non-Twitch clip URL is refused, a Twitch one opens.
  await cards[0].querySelector('.play-btn').dispatch('click');
  await cards[3].querySelector('.play-btn').dispatch('click');
  await savedCards[0].querySelector('.play-btn').dispatch('click');
  assert.deepEqual(apiCalls, [['open', 'https://clips.twitch.tv/Slug3']]);

  // Download: signed Twitch CDN URL; an off-host source falls back to the
  // thumbnail-derived MP4 on the Twitch CDN.
  apiCalls.length = 0;
  await cards[3].querySelector('.download-btn').dispatch('click');
  await cards[2].querySelector('.download-btn').dispatch('click');
  assert.deepEqual(apiCalls, [
    ['download', 'https://production.assets.clips.twitchcdn.net/v2/media/3/x.mp4?sig=abc123&token=%7B%22a%22%3A%22b%20c%22%7D', 'Slug3.mp4'],
    ['download', 'https://clips-media-assets2.twitch.tv/x2.mp4', 'Slug2.mp4'],
  ]);

  // Saving a hostile clip persists it; re-rendering stays inert.
  await cards[0].querySelector('.save-btn').dispatch('click');
  assert.equal(savedList.children.length, 3);
  assert.equal(savedList.children[2].querySelector('.clip-title').textContent, PAYLOADS[0]);
  assert.equal(cards[0].querySelector('.save-btn').title, 'Unsave');
  // Removing it from the saved list un-hearts the grid card (matched by id,
  // never through a selector built from stored data).
  await savedList.children[2].querySelector('.remove-btn').dispatch('click');
  assert.equal(cards[0].querySelector('.save-btn').title, 'Save');
  assertNoRawPayload(doc, { domOnly: true });
});

test('F02: stream titles, categories, errors and usernames render as text', async (t) => {
  const doc = createDocument();
  doc.add('div', 'streams-grid');
  for (const id of ['total-streamers-stat', 'live-streamers-stat', 'containers-stat', 'live-now-count', 'live-now-pop-count']) doc.add('span', id);
  doc.add('button', 'live-now-btn');
  doc.add('div', 'live-now-list');
  const restore = install(doc, { api: { openStreamContainer() {}, closeStreamContainer() {} } });
  t.after(restore);

  const { state } = await load('src/state.js');
  const { renderStreamsGrid, updateStats } = await load('src/dashboard.js');
  const { renderLiveNow } = await load('src/live-now.js');

  const hostileUser = 'x" onmouseover="window.__pwned=1';
  const errorPage = '<html><style>body{display:none}</style><img src=x onerror=window.__pwned=1>502</html>';
  state.currentConfig = { streamers: [{ platform: 'twitch', username: hostileUser }, { platform: 'kick', username: 'k' }, { platform: 'evil" x="', username: 'y' }] };
  state.activeContainers = [];

  // Before the first scan: placeholders.
  state.currentStatuses = [];
  renderStreamsGrid();
  const placeholders = doc.getElementById('streams-grid').children;
  assert.equal(placeholders[0].querySelector('.streamer-username').textContent, hostileUser);
  assertNoRawPayload(doc, { extra: [hostileUser] });

  state.currentStatuses = [
    { platform: 'twitch', username: hostileUser, isLive: true, title: PAYLOADS[0], category: PAYLOADS[1], viewerCount: 1500 },
    { platform: 'kick', username: 'k', isLive: false, error: errorPage },
    { platform: 'evil" x="', username: 'y', isLive: true, title: PAYLOADS[2], category: '', viewerCount: '<b>9</b>' },
  ];
  renderStreamsGrid();
  updateStats();
  renderLiveNow();

  const cards = doc.getElementById('streams-grid').children;
  assert.equal(cards.length, 3);
  const live = cards.find(c => c.querySelector('.streamer-username').textContent === hostileUser);
  assert.equal(live.querySelector('.stream-title').textContent, PAYLOADS[0]);
  assert.ok(live.querySelectorAll('.detail-item').some(d => d.textContent === PAYLOADS[1]));
  const offline = cards.find(c => c.querySelector('.streamer-username').textContent === 'k');
  assert.equal(offline.querySelector('.detail-item').textContent, `Error: ${errorPage}`);
  // An unknown platform can't break out of the class attribute.
  const odd = cards.find(c => c.querySelector('.streamer-username').textContent === 'y');
  assert.equal(odd.querySelector('.platform-badge').className, 'platform-badge evil" x="');
  assert.equal(odd.querySelector('.platform-badge').getAttribute('x'), null);

  const rows = doc.getElementById('live-now-list').children;
  assert.equal(rows.length, 2);
  const row = rows.find(r => r.querySelector('.live-now-item-name').textContent === hostileUser);
  assert.equal(row.querySelector('.live-now-cat').textContent, PAYLOADS[1]);
  // viewerCount is coerced to a number before it is interpolated.
  const oddRow = rows.find(r => r.querySelector('.live-now-item-name').textContent === 'y');
  assert.equal(oddRow.querySelector('.live-now-viewers').textContent, '0');

  assert.equal(doc.created.filter(el => ['STYLE', 'HTML'].includes(el.tagName)).length, 0, 'error page markup was parsed');
  assertNoRawPayload(doc, { extra: [hostileUser, errorPage] });
});

test('F03: stored calendar events render as text and malformed ones are skipped', async (t) => {
  const doc = createDocument();
  doc.add('div', null, 'days-columns');
  const restore = install(doc, { api: { saveConfig: async () => ({}) } });
  t.after(restore);

  const { state } = await load('src/state.js');
  const { renderCalendar } = await load('src/calendar.js');

  state.currentConfig = {
    calendarEvents: [
      { id: 'm1', type: 'manual', day: 2, time: PAYLOADS[3], streamer: PAYLOADS[0], title: PAYLOADS[1], platform: 'twitch' },
    ],
  };
  state.platformSchedules = [
    { id: 'a1', type: 'auto', day: '3', time: '18:00', streamer: 'streamer', title: PAYLOADS[2], platform: 'x);background:url(https://evil.tld/' },
    { id: 'a2', type: 'auto', day: '3"] , img', time: '19:00', streamer: 's', title: 'bad day', platform: 'twitch' },
    { id: 'a3', type: 'auto', day: 9, time: '19:00', streamer: 's', title: 'out of range', platform: 'twitch' },
    { id: 'a4', type: 'auto', day: 4, streamer: 's', title: 'no time', platform: 'kick' },
    null,
    'garbage',
  ];

  renderCalendar();

  const cards = doc.querySelectorAll('.calendar-event-card');
  assert.deepEqual(cards.map(c => c.querySelector('.cal-ev-title').textContent).sort(), [PAYLOADS[1], PAYLOADS[2], 'no time'].sort());
  const manual = cards.find(c => c.classList.contains('manual'));
  assert.equal(manual.querySelector('.cal-ev-streamer').textContent, PAYLOADS[0]);
  assert.equal(manual.querySelector('.cal-ev-time').textContent, PAYLOADS[3]);
  assert.equal(manual.querySelector('.cal-ev-title').title, PAYLOADS[1]);
  assert.ok(manual.querySelector('.delete-event-btn'), 'manual events keep their delete button');
  const auto = cards.find(c => c.querySelector('.cal-ev-title').textContent === PAYLOADS[2]);
  assert.equal(auto.querySelector('.delete-event-btn'), null);
  // An unknown platform can't inject into the card's cssText.
  assert.match(auto.style.cssText, /border-left: 3px solid var\(--text-muted\);/);
  assert.doesNotMatch(auto.style.cssText, /evil/);
  assertNoRawPayload(doc, { domOnly: true });

  // Deleting the manual event goes through the stored object, not the view.
  await manual.querySelector('.delete-event-btn').dispatch('click');
  assert.deepEqual(state.currentConfig.calendarEvents, []);
});

test('F89: the stream <webview> is built from DOM calls with a vetted src', async (t) => {
  const doc = createDocument();
  const restore = install(doc);
  t.after(restore);
  const { createStreamWebview } = await load('src/stream-webview.js');

  const wv = createStreamWebview('twitch', 'x" webpreferences="contextIsolation=no" preload="file:///C:/evil.js', undefined);
  assert.equal(wv.tagName, 'WEBVIEW');
  assert.deepEqual(Object.keys(wv.attributes), ['partition', 'allowpopups', 'muted', 'src']);
  assert.equal(wv.attributes.partition, 'persist:default');
  assert.equal(new URL(wv.attributes.src).hostname, 'www.twitch.tv');
  assert.deepEqual(doc.htmlLog, [], 'the webview must not go through innerHTML');

  // Rumble's resolved URL comes from a scan result: only https on rumble.com.
  assert.equal(createStreamWebview('rumble', 'r', { resolvedUrl: 'javascript:alert(1)' }).attributes.src, undefined);
  assert.equal(createStreamWebview('rumble', 'r', { resolvedUrl: 'https://evil.tld/live' }).attributes.src, undefined);
  assert.equal(createStreamWebview('rumble', 'r', { resolvedUrl: 'https://rumble.com/v1-live.html' }).attributes.src, 'https://rumble.com/v1-live.html');
  assert.equal(createStreamWebview('youtube', '@Chan', undefined).attributes.src, 'https://www.youtube.com/@chan/live');
  assert.equal(createStreamWebview('kick', 'k-1', undefined).attributes.src, 'https://kick.com/k-1');
});
