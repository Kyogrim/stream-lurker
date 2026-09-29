// G2.2 (second guard): a malformed streamer entry that reaches the renderer
// anyway must not throw out of the Manage Streamers list (which also ran
// during startup), and a reorder must not drop an entry the list skipped.
// Runs the real src/streamers.js on the fake DOM.
// Run: node --test test/renderer-handoff-streamers.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const doc = createDocument();
doc.add('div', 'console-logs');
const list = doc.add('div', 'monitored-channels-list');
const grid = doc.add('div', 'streams-grid');
for (const id of ['total-streamers-stat', 'live-streamers-stat', 'containers-stat']) doc.add('span', id);
globalThis.document = doc;

const saves = [];
globalThis.window = { api: { saveConfig: cfg => { saves.push(cfg.streamers.slice()); return Promise.resolve(true); } } };

let state, streamers, dashboard;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  streamers = await load('src/streamers.js');
  dashboard = await load('src/dashboard.js');
});

const names = () => list.querySelectorAll('.list-item-name').map(el => el.textContent);

test('G2.2: bad entries are skipped, good ones still listed', () => {
  const weird = { platform: 'tiktok', username: 'elsewhere' };
  state.currentConfig = {
    streamers: [
      null, 'str', 42, { username: 'noplatform' }, { platform: null, username: 'x' },
      { platform: ['twitch'], username: 'array' }, { platform: 'constructor', username: 'proto' },
      { platform: '__proto__', username: 'proto2' },
      { platform: 'Twitch', username: 'Alpha' }, { platform: 'kick', username: 'beta' }, weird,
    ],
  };
  state.currentStatuses = [];
  state.activeContainers = [];
  assert.doesNotThrow(() => streamers.renderMonitoredList());
  assert.deepEqual(names(), ['Alpha', 'beta']);
  // The same render also draws the monitor grid and the counters.
  // (Unknown platforms keep their placeholder card there, as before.)
  assert.deepEqual(grid.querySelectorAll('.streamer-username').map(el => el.textContent), ['proto', 'proto2', 'Alpha', 'beta', 'elsewhere']);
  assert.doesNotThrow(() => dashboard.updateStats());
  assert.equal(String(doc.getElementById('total-streamers-stat').textContent), '5');
});

test('G2.2: monitoredStreamers keeps the renderable entries, same objects, same order', async () => {
  const { monitoredStreamers } = await load('src/state.js');
  const a = { platform: 'twitch', username: 'a', mode: 'notify' };
  const b = { platform: 'rumble', username: 'b' };
  assert.deepEqual(monitoredStreamers({ streamers: [null, a, { platform: 'kick' }, { platform: 'kick', username: 5 }, b, [], 'x'] }), [a, b]);
  assert.equal(monitoredStreamers({ streamers: [a] })[0], a, 'the stored object, so a mode change persists');
  for (const cfg of [null, {}, { streamers: null }, { streamers: {} }, { streamers: 'x' }]) {
    assert.deepEqual(monitoredStreamers(cfg), [], String(cfg && cfg.streamers));
  }
  // No argument reads the live config.
  state.currentConfig = { streamers: [a] };
  assert.deepEqual(monitoredStreamers(), [a]);
});

test('G2.2: a streamers value that is not a list shows the empty state', () => {
  for (const value of [null, undefined, {}, 'x']) {
    state.currentConfig = { streamers: value };
    assert.doesNotThrow(() => streamers.renderMonitoredList(), String(value));
    assert.match(list.textContent, /No channels added/);
  }
});

test('G2.2: a reorder keeps the entries it could not group, after the rest', async () => {
  saves.length = 0;
  const weird = { platform: 'tiktok', username: 'elsewhere' };
  const a = { platform: 'twitch', username: 'a' };
  const b = { platform: 'twitch', username: 'b' };
  const k = { platform: 'kick', username: 'k' };
  state.currentConfig = { streamers: [weird, a, k, b] };
  streamers.renderMonitoredList();
  // "Move down" on the first Twitch row.
  const row = list.querySelectorAll('.list-item').find(r => r.querySelector('.list-item-name').textContent === 'a');
  await row.querySelector('.down-btn').dispatch('click');
  await flush();
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], [b, a, k, weird], 'reordered, and the tiktok entry is still there');
});
