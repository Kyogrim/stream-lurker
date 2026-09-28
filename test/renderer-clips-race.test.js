// F92: a slower, older clips fetch must never paint over a newer one. Runs the
// real src/clips.js on the fake DOM from renderer-fake-dom.js with a fetch the
// test releases by hand.
// Run: node --test test/renderer-clips-race.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const flush = () => new Promise(resolve => setImmediate(resolve));

// One document for the file: appendLogMessage caches its console element.
const doc = createDocument();
const consoleEl = doc.add('div', 'console-logs');
const grid = doc.add('div', 'trending-clips-grid');
doc.add('div', 'saved-clips-list');
const refresh = doc.add('button', 'refresh-clips-btn');
const filter = doc.add('select', 'clips-filter-select');
filter.value = 'trending';
globalThis.document = doc;
globalThis.window = { api: {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const logs = () => consoleEl.children.map(c => c.textContent);
const shown = () => grid.children.map(c => c.querySelector('.clip-title')?.textContent ?? c.textContent.trim());

// Requests wait until the test answers them. Each records its login, filter
// period and signal. honourAbort makes a request reject when its signal fires,
// as the real fetch does.
let pending = [];
let honourAbort = false;
globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
  const body = JSON.parse(opts.body)[0];
  const req = {
    login: body.variables.login,
    period: /period: (\w+)/.exec(body.query)[1],
    signal: opts.signal,
    answer: (titles) => resolve({ json: async () => [{ data: { user: { clips: { edges: titles.map((title, i) => ({ node: { id: `${req.period}-${title}`, title, viewCount: 100 - i, createdAt: new Date(2026, 0, 1 + i).toISOString() } })) } } } }] }),
    fail: (err) => reject(err),
  };
  if (honourAbort) opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
  pending.push(req);
});
const take = login => {
  const i = pending.findIndex(r => r.login === login);
  assert.ok(i >= 0, `no pending request for ${login}`);
  return pending.splice(i, 1)[0];
};

let state;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  const clips = await load('src/clips.js');
  // The startup fetch is a 1 s timer; the tests drive every run themselves.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { clips.initClipsManager(); } finally { globalThis.setTimeout = realSetTimeout; }
});

function reset(streamers = ['a', 'b']) {
  pending = [];
  honourAbort = false;
  consoleEl.children = [];
  filter.value = 'trending';
  state.currentConfig = { streamers: streamers.map(username => ({ platform: 'twitch', username })) };
}

// A regression here tends to leave a run awaiting a request nobody answers.
const T = { timeout: 5000 };

test('F92: a slow trending run finishing after a latest run leaves the latest clips up', T, async () => {
  reset();
  const first = refresh.dispatch('click');          // startup / refresh: trending
  const oldA = take('a');
  assert.equal(oldA.period, 'LAST_WEEK');

  filter.value = 'latest';
  const second = filter.dispatch('change');         // user switches to latest
  assert.equal(oldA.signal.aborted, true, 'the older run was aborted');
  take('a').answer(['new-a']);
  await flush();
  take('b').answer(['new-b']);
  await second;
  assert.deepEqual(shown().sort(), ['new-a', 'new-b']);

  // The old request finally answers, as if abort were ignored.
  oldA.answer(['OLD-a']);
  await first;
  await flush();
  assert.deepEqual(shown().sort(), ['new-a', 'new-b']);
  assert.deepEqual(pending.map(r => r.login), [], 'the stale run stopped before its next request');
  assert.deepEqual(logs().filter(l => /\[Clips\]/.test(l)), ['[Clips] Loaded 2 latest clips.']);
});

test('F92: aborting the older run logs nothing and paints nothing', T, async () => {
  reset();
  honourAbort = true;
  const first = refresh.dispatch('click');
  const oldA = take('a');
  filter.value = 'popular';
  const second = filter.dispatch('change');
  await first;                                      // rejected by its abort
  assert.equal(oldA.signal.aborted, true);
  take('a').answer(['p-a']);
  await flush();
  take('b').answer(['p-b']);
  await second;
  assert.deepEqual(shown(), ['p-a', 'p-b']);
  assert.deepEqual(logs(), ['[Clips] Loaded 2 popular clips.'], 'no "Failed to fetch" line per streamer');
});

test('F92: a stale run cannot overwrite the "no streamers" message', T, async () => {
  reset();
  const first = refresh.dispatch('click');
  const oldA = take('a');
  state.currentConfig = { streamers: [] };          // user removed them meanwhile
  await refresh.dispatch('click');
  assert.match(grid.textContent, /No Twitch streamers monitored/);
  oldA.answer(['OLD']);
  await first;
  await flush();
  assert.match(grid.textContent, /No Twitch streamers monitored/);
});

test('F92: a stale run cannot overwrite the newer run\'s "Fetching" or empty state', T, async () => {
  reset(['a']);
  const first = refresh.dispatch('click');
  const oldA = take('a');
  filter.value = 'latest';
  const second = refresh.dispatch('click');
  assert.match(grid.textContent, /Fetching latest clips/);
  oldA.answer(['OLD']);
  await first;
  await flush();
  assert.match(grid.textContent, /Fetching latest clips/);
  take('a').answer([]);
  await second;
  assert.match(grid.textContent, /No latest clips found/);
});

test('F92: the current run still reports its own failures, and requests carry a timeout', T, async (t) => {
  reset();
  const timeouts = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  t.after(() => { AbortSignal.timeout = realTimeout; });

  const run = refresh.dispatch('click');
  const a = take('a');
  assert.ok(a.signal instanceof AbortSignal);
  assert.equal(a.signal.aborted, false);
  assert.deepEqual(timeouts, [15000], 'one hung request cannot hold the run forever');
  a.fail(new TypeError('network down'));
  await flush();
  take('b').answer(['only-b']);
  await run;
  assert.deepEqual(shown(), ['only-b']);
  assert.deepEqual(logs(), ['[Clips] Failed to fetch clips for a: network down', '[Clips] Loaded 1 trending clips.']);
});
