// F10 (verifier trap 4): clips open and download through main's bridges only.
// The old window.open fallbacks went to main's popup handler, which opens a
// link in the browser only right after a click in a focused window and denies
// it otherwise, so whether Watch/Download worked depended on timing. A refused
// open or download is now reported instead of vanishing.
// Runs the real src/clips.js on the fake DOM.
// Run: node --test test/renderer-handoff-clips.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const SAVED = {
  id: 'c1', slug: 'FunnyClip', url: 'https://clips.twitch.tv/FunnyClip', title: 'funny',
  thumbnailURL: 'https://clips-media-assets2.twitch.tv/abc-preview-480x272.jpg',
  broadcaster: { displayName: 'Alpha' },
  videoQualities: [{ sourceURL: 'https://production.assets.clips.twitchcdn.net/abc.mp4', quality: '1080' }],
};

const doc = createDocument();
const consoleEl = doc.add('div', 'console-logs');
const grid = doc.add('div', 'trending-clips-grid');
const saved = doc.add('div', 'saved-clips-list');
const refresh = doc.add('button', 'refresh-clips-btn');
const filter = doc.add('select', 'clips-filter-select');
filter.value = 'trending';
globalThis.document = doc;
const storageKeys = [];
globalThis.localStorage = { getItem: (k) => { storageKeys.push(k); return JSON.stringify([SAVED]); }, setItem: () => {} };

const calls = [];
const api = {};
globalThis.window = { api, open: (...args) => { calls.push(['window.open', ...args]); return null; } };
const logs = () => consoleEl.children.map(c => c.textContent);

globalThis.fetch = async (url, opts) => {
  const op = JSON.parse(opts.body)[0].operationName;
  if (op === 'GetClips') return { json: async () => [{ data: { user: { clips: { edges: [{ node: SAVED }] } } } }] };
  return { json: async () => [{ data: { clip: { playbackAccessToken: { signature: 'sig', value: 'tok' } } } }] };
};

let state;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  const clips = await load('src/clips.js');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;               // no startup fetch
  try { clips.initClipsManager(); } finally { globalThis.setTimeout = realSetTimeout; }
});

function reset() {
  calls.length = 0;
  consoleEl.children = [];
}

test('F10: Watch opens the clip through openClipWindow, never window.open', async () => {
  reset();
  api.openClipWindow = (url) => { calls.push(['openClipWindow', url]); return Promise.resolve({ success: true }); };
  await saved.querySelector('.play-btn').dispatch('click');
  await flush();
  assert.deepEqual(calls, [['openClipWindow', 'https://clips.twitch.tv/FunnyClip']]);
  assert.deepEqual(logs(), []);
});

test('F10: a refused or failed open is reported, not silently dropped', async () => {
  reset();
  api.openClipWindow = () => Promise.resolve({ success: false, error: 'Invalid URL' });
  await saved.querySelector('.play-btn').dispatch('click');
  await flush();
  api.openClipWindow = () => Promise.reject(new Error('IPC gone'));
  await saved.querySelector('.play-btn').dispatch('click');
  await flush();
  assert.deepEqual(logs(), ['[Clips] Could not open the clip: Invalid URL', '[Clips] Could not open the clip: IPC gone']);
  assert.ok(!calls.some(c => c[0] === 'window.open'));
});

test('F10: Download goes through downloadClip with the signed URL, and failures are reported', async () => {
  reset();
  state.currentConfig = { streamers: [{ platform: 'twitch', username: 'alpha' }] };
  await refresh.dispatch('click');
  await flush();
  const btn = grid.querySelector('.download-btn');
  assert.ok(btn, 'a clip card was drawn');

  api.downloadClip = (url, name) => { calls.push(['downloadClip', url, name]); return Promise.resolve({ success: true }); };
  await btn.dispatch('click');
  await flush();
  assert.deepEqual(calls, [['downloadClip', 'https://production.assets.clips.twitchcdn.net/abc.mp4?sig=sig&token=tok', 'FunnyClip.mp4']]);

  api.downloadClip = () => Promise.resolve({ success: false, error: 'Invalid URL or no main window' });
  await btn.dispatch('click');
  await flush();
  api.downloadClip = () => Promise.reject(new Error('IPC gone'));
  await btn.dispatch('click');
  await flush();
  assert.deepEqual(logs().filter(l => /download/i.test(l)), [
    '[Clips] Could not download funny: Invalid URL or no main window',
    '[Clips] Could not download funny: IPC gone',
  ]);
  assert.ok(!calls.some(c => c[0] === 'window.open'));
});

test('F10: saved clips are still read from the same storage key', () => {
  // main migrates the old file:// origin's localStorage into app://bundle
  // once; a renamed key would strand every saved clip there.
  assert.deepEqual(storageKeys, ['stream_lurker_saved_clips']);
  assert.equal(saved.querySelectorAll('.play-btn').length, 1);
});

test('F10: no renderer module falls back to window.open', () => {
  const skip = new Set(['inject.js', 'twitch-preload.js']); // run inside third-party pages
  const files = ['renderer.js', ...fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js') && !skip.has(f)).map(f => `src/${f}`)];
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'), /window\.open\s*\(/, f);
  }
});
