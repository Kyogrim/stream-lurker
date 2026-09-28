// Static checks on index.html for the handoff fixes:
//   F57  the Extensions tab no longer promises ad blocking: the app's own
//        session.webRequest listeners keep uBlock Origin from filtering any
//        network request, and Twitch/Kick ads are part of the video anyway
//   F17  the 1-click login panel has Copy and New code buttons and the note /
//        sync lines src/login.js writes to
// Run: node --test test/renderer-handoff-static.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `no section ${id}`);
  return html.slice(start, html.indexOf('</section>', start));
}

test('F57: nothing on the page promises that an extension blocks ads', () => {
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /adblock/i);
  assert.doesNotMatch(text, /to block ads/i);
  assert.doesNotMatch(text, /pre-?rolls?\s*\/\s*mid-?rolls?/i);
  assert.doesNotMatch(html, /github\.com\/gorhill\/uBlock/, 'no download link recommending it');
  const nav = /<button class="nav-btn" data-tab="extensions">([\s\S]*?)<\/button>/.exec(html)[1].replace(/<[^>]+>/g, ' ').trim();
  assert.equal(nav, 'Extensions');
});

test('F57: the Extensions tab says plainly that ad blockers do not work here', () => {
  const tab = section('tab-extensions').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(tab, /Ad blockers do not block ads here\./);
  assert.match(tab, /does not let them block network requests/);
  assert.match(tab, /Quick Guide to Load an Unpacked Extension/);
  // The button the guide names is the real one.
  assert.match(tab, /Add Unpacked Extension Folder/);
  assert.match(html, /id="add-extension-btn"[\s\S]*?Add Unpacked Extension Folder/);
});

test('F17: the extension panel has the controls src/login.js wires', () => {
  const logins = section('tab-logins');
  for (const id of ['ext-pairing-code', 'ext-conn-status', 'ext-open-folder', 'ext-copy-code', 'ext-new-code', 'ext-panel-note', 'ext-sync-status']) {
    assert.match(logins, new RegExp(`id="${id}"`), id);
  }
  for (const id of ['ext-copy-code', 'ext-new-code']) {
    assert.match(logins, new RegExp(`<button id="${id}"[^>]*type="button"`), `${id} is a plain button`);
  }
  // Written by login.js through textContent, and start hidden.
  assert.match(logins, /<p class="ext-note hidden" id="ext-panel-note"/);
  assert.match(logins, /<p class="ext-sync hidden" id="ext-sync-status"/);
});

test('every window.api method the dashboard calls is exposed by preload.js', () => {
  // The bridges these fixes lean on (getStatuses, getExtensionStatus,
  // rotatePairingCode, openExtensionFolder, openClipWindow, downloadClip)
  // must exist, or the call throws and the feature silently does nothing.
  const root = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const exposed = new Set([...preload.matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1]));
  const skip = new Set(['inject.js', 'twitch-preload.js', 'points.js']);
  const files = ['renderer.js', ...fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js') && !skip.has(f)).map(f => `src/${f}`)];
  const missing = [];
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/window\.api\.(\w+)/g)) {
      if (!exposed.has(m[1])) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  for (const name of ['getStatuses', 'getExtensionStatus', 'rotatePairingCode', 'openExtensionFolder', 'openClipWindow', 'downloadClip']) {
    assert.ok(exposed.has(name), name);
  }
});

test('F17: the pairing code can be selected by hand', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  // The global `* { user-select: none }` would otherwise leave typing all 32
  // characters as the only way to move a new code into the extension.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(m => m[1].split(',').some(sel => sel.trim() === '#ext-pairing-code'))
    .map(m => m[2]);
  assert.ok(rules.length, 'no #ext-pairing-code rule');
  assert.ok(rules.some(r => /user-select:\s*text/.test(r)), rules.join('\n---\n'));
});
