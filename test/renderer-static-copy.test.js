// F95: the Settings and Logins copy says what the app actually does. Twitch
// API keys are optional (main.js falls back to a key-free scan), and Rumble is
// force-disabled, so the Logins page neither advertises it nor shows a working
// looking Connect button for it. F104: the Clips tab says its clips are
// Twitch-only.
// Run: node --test test/renderer-static-copy.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `no section ${id}`);
  return html.slice(start, html.indexOf('</section>', start));
}

test('F95: the Logins intro names the platforms that work and the real sign-in route', () => {
  const intro = /<section id="tab-logins"[\s\S]*?<div class="tab-header">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(html)[1];
  assert.doesNotMatch(intro, /rumble/i);
  for (const p of ['Twitch', 'Kick', 'YouTube']) assert.match(intro, new RegExp(p));
  assert.match(intro, /Connector extension/);
});

test('F95: the Rumble login card starts hidden but keeps the ids login.js looks up', () => {
  const logins = section('tab-logins');
  const card = /<div class="([^"]*\brumble-login-card\b[^"]*)"/.exec(logins);
  assert.ok(card, 'rumble card markup is still there');
  assert.ok(card[1].split(/\s+/).includes('hidden'), `class="${card[1]}"`);
  for (const id of ['rumble-disconnected-state', 'rumble-connected-state', 'rumble-username-val']) {
    assert.match(logins, new RegExp(`id="${id}"`), id);
  }
  // Every other platform card is still shown.
  for (const p of ['twitch', 'kick', 'youtube']) {
    const other = new RegExp(`<div class="([^"]*\\b${p}-login-card\\b[^"]*)"`).exec(logins);
    assert.ok(other && !other[1].split(/\s+/).includes('hidden'), p);
  }
});

test('F95: Twitch API credentials are described as optional, with the fallback', () => {
  const box = /<h3>Twitch API Credentials<\/h3>[\s\S]*?<div class="help-info-box">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(box, /<strong>Optional\.<\/strong>/);
  assert.match(box, /without any keys/);
  assert.match(box, /Helix/);
  assert.match(box, /falls back/);
  assert.doesNotMatch(box, /required|cannot be checked/i);
  // The help link still goes through the allowlisted external-link handler.
  assert.match(box, /<a href="#" data-external-url="https:\/\/dev\.twitch\.tv\/console">/);
  // A raw & in text is still valid HTML, but keep the entity form used here.
  assert.match(box, /Client ID &amp; Secret/);
});

test('F104: the Clips subtitle promises Twitch clips only, and no points auto-claim', () => {
  // src/clips.js asks Twitch GQL about Twitch streamers only, and the points
  // auto-claim is a Settings toggle (src/points.js), not part of this tab.
  const sub = /<div class="tab-header">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(section('tab-clips'))[1];
  assert.match(sub, /Twitch/);
  assert.doesNotMatch(sub, /auto-claim|channel points/i);
});

test('the YouTube paste is sent as typed: trimming it would drop a last-line empty cookie value', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'login.js'), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('const doImport = async () => {'));
  assert.match(fn, /window\.api\.setGoogleCookies\(raw\)/);
  assert.match(fn, /if \(!raw\.trim\(\)\)/);
});
