// The UI polish pass (picked from before/after screenshots of the real app):
//   F1  offline streamers with nothing to show are compact cards, sorted after
//       every card that still has something to show, starting their own row
//   F2  a long streamer name ends in "…" instead of pushing the badge out of
//       the card (which also scrolled the whole grid sideways)
//   F3  a live card's detail line stays one line, so every button lines up
//   F4  a multi-lurk cell's name and meta end before its buttons
//   F5  login cards are as tall as their content, three across
//   F6  Sign Out is the secondary button
//   F7  "Connected" is one success colour on every platform
//   F8  the 1-Click Login text is readable
//   F9  each platform switch shares a cell with its own label
//   F10 the per-platform tab limits sit together; Rumble's is hidden
//   F11 copy that matches the app
//   F12 login cards carry the platform logo, not a glowing dot
// The dashboard cards and login logos run the real modules on the fake DOM;
// the layout fixes are CSS, pinned statically so the bug cannot come back.
// Run: node --test test/renderer-polish.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument, injectedElements } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const css = read('style.css');
const html = read('index.html');

// The declarations of the first rule whose selector is exactly `selector`.
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule ${selector}`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}
const decl = (selector, prop) => {
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`).exec(rule(selector));
  return m ? m[1].trim() : null;
};

const doc = createDocument();
const grid = doc.add('div', 'streams-grid');
for (const id of ['total-streamers-stat', 'live-streamers-stat', 'containers-stat']) doc.add('span', id);
globalThis.document = doc;
globalThis.window = { api: {} };

let state, dashboard, login;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  dashboard = await load('src/dashboard.js');
  login = await load('src/login.js');
});

const card = (username) => grid.querySelectorAll('.stream-card')
  .find(c => c.querySelector('.streamer-username').textContent === username);

test('F1: before the first scan every card is a compact "Checking..." placeholder', () => {
  state.currentConfig = { streamers: [{ platform: 'twitch', username: 'alpha' }, { platform: 'kick', username: 'beta' }] };
  state.currentStatuses = [];
  state.activeContainers = [];
  dashboard.renderStreamsGrid();
  const cards = grid.querySelectorAll('.stream-card');
  assert.equal(cards.length, 2);
  for (const c of cards) {
    assert.ok(c.classList.contains('compact'), c.className);
    assert.match(c.textContent, /Checking\.\.\./);
    assert.equal(c.querySelector('.card-actions'), null, 'no dead button');
  }
});

test('F1: live first, then offline cards with something to show, then compact ones, each by priority', () => {
  state.currentConfig = { streamers: ['quiet1', 'open', 'broken', 'live', 'quiet2'].map(u => ({ platform: 'twitch', username: u })) };
  state.currentStatuses = [
    { platform: 'twitch', username: 'quiet1', isLive: false },
    { platform: 'twitch', username: 'open', isLive: false },
    { platform: 'twitch', username: 'broken', isLive: false, error: 'HTTP 503' },
    { platform: 'twitch', username: 'live', isLive: true, viewerCount: 1234, title: 't', category: 'Just Chatting' },
    { platform: 'twitch', username: 'quiet2', isLive: false },
  ];
  state.activeContainers = ['twitch:open'];
  dashboard.renderStreamsGrid();
  const order = grid.querySelectorAll('.stream-card').map(c => c.querySelector('.streamer-username').textContent);
  assert.deepEqual(order, ['live', 'open', 'broken', 'quiet1', 'quiet2']);

  // A stream that went offline with its cell still open keeps the button that closes it.
  const open = card('open');
  assert.ok(!open.classList.contains('compact'));
  const btn = open.querySelector('.card-actions button');
  assert.match(btn.textContent, /Close Container/);
  assert.equal(btn.getAttribute('disabled'), null);
  // A failed check keeps the line that says why.
  const broken = card('broken');
  assert.ok(!broken.classList.contains('compact'));
  assert.match(broken.textContent, /Error: HTTP 503/);
  // Plain offline: name and badge only.
  for (const name of ['quiet1', 'quiet2']) {
    const c = card(name);
    assert.ok(c.classList.contains('compact') && c.classList.contains('offline'), c.className);
    assert.equal(c.querySelector('.card-body'), null);
    assert.equal(c.querySelector('.card-actions'), null);
    assert.match(c.querySelector('.live-badge').textContent, /OFFLINE/);
  }
});

test('F1: isCompactCard is the one rule', () => {
  assert.equal(dashboard.isCompactCard({ isLive: false }, false), true);
  assert.equal(dashboard.isCompactCard({ isLive: true }, false), false);
  assert.equal(dashboard.isCompactCard({ isLive: false }, true), false, 'container open');
  assert.equal(dashboard.isCompactCard({ isLive: false, error: 'x' }, false), false, 'error to show');
});

test('F1/F2: a compact card still escapes the name', () => {
  state.currentConfig = { streamers: [{ platform: 'twitch', username: '<img src=x onerror=alert(1)>' }] };
  state.currentStatuses = [{ platform: 'twitch', username: '<img src=x onerror=alert(1)>', isLive: false }];
  state.activeContainers = [];
  dashboard.renderStreamsGrid();
  assert.deepEqual(injectedElements(doc, ['img', 'script']), []);
});

test('F1: compact cards start a row of their own, and rows are only as tall as their cards', () => {
  assert.equal(decl('.stream-card:not(.compact) + .stream-card.compact', 'grid-column-start'), '1');
  assert.equal(decl('.stream-card.compact', 'min-height'), '0');
  assert.equal(decl('.streams-grid', 'align-content'), 'start', 'rows no longer stretch into the spare height');
  assert.equal(decl('.streams-grid', 'align-items'), 'start');
});

test('F2: a long name ends in an ellipsis; the badge and avatar keep their size; no sideways scroll', () => {
  assert.equal(decl('.streamer-identity', 'min-width'), '0');
  assert.equal(decl('.streamer-username', 'text-overflow'), 'ellipsis');
  assert.equal(decl('.streamer-username', 'white-space'), 'nowrap');
  assert.equal(decl('.streamer-identity .platform-badge', 'flex-shrink'), '0');
  assert.match(rule('.live-badge'), /flex-shrink: 0;/);
  assert.equal(decl('.stream-card', 'min-width'), '0');
  assert.equal(decl('.streams-grid', 'overflow-x'), 'hidden');
  assert.equal(decl('::-webkit-scrollbar-corner', 'background'), 'transparent', 'was a white square');
});

test('F3: one detail line; only the category gives way', () => {
  state.currentConfig = { streamers: [{ platform: 'twitch', username: 'live' }] };
  state.currentStatuses = [{ platform: 'twitch', username: 'live', isLive: true, viewerCount: 40100, title: 't', category: 'ACE COMBAT 8: WINGS OF THEVE' }];
  dashboard.renderStreamsGrid();
  const details = card('live').querySelector('.stream-details');
  assert.match(details.querySelector('.detail-viewers').textContent, /40\.1K Lurkers/);
  assert.equal(details.querySelector('.detail-category').textContent, 'ACE COMBAT 8: WINGS OF THEVE');
  assert.equal(decl('.detail-item', 'white-space'), 'nowrap');
  assert.equal(decl('.detail-item', 'flex-shrink'), '0');
  assert.equal(decl('.detail-item.detail-category', 'text-overflow'), 'ellipsis');
  assert.equal(decl('.detail-item.detail-category', 'flex-shrink'), '1');
  assert.equal(decl('.viewers-dot', 'flex-shrink'), '0', 'the live dot never collapses');
});

test('F4: a cell header never runs under its buttons, and a narrow cell tightens them', () => {
  assert.equal(decl('.stream-cell-identity', 'overflow'), 'hidden');
  assert.equal(decl('.stream-cell-name', 'min-width'), '0');
  assert.equal(decl('.stream-cell-name', 'text-overflow'), 'ellipsis');
  assert.equal(decl('.stream-cell-actions', 'flex-shrink'), '0');
  assert.equal(decl('.stream-cell-identity .platform-badge', 'flex-shrink'), '0');
  assert.equal(decl('.stream-cell-header', 'container-type'), 'inline-size');
  // Same specificity, so the narrow-cell rule must come after the base one
  // or the base padding wins.
  const narrow = css.indexOf('@container (max-width: 480px)');
  assert.ok(narrow > css.indexOf('\n.cell-action-btn {'), 'after .cell-action-btn');
  assert.match(css.slice(narrow, css.indexOf('\n}', narrow)), /\.cell-action-btn \{ padding: 3px; \}/);
});

test('F5: login cards are as tall as their content, three across when there is room', () => {
  assert.equal(decl('.login-card', 'height'), null);
  assert.equal(decl('.login-card', 'min-height'), null);
  // 300 px: three across still fits a 1366 px screen (340 px dropped
  // YouTube to a second row below the fold).
  assert.equal(decl('.logins-grid', 'grid-template-columns'), 'repeat(auto-fit, minmax(300px, 1fr))');
  assert.equal(decl('.account-state-container p', 'text-wrap'), 'balance');
  assert.equal(decl('.logins-grid', 'align-items'), 'start');
});

test('F6/F7/F12: account cards: logo, one "Connected" colour, a secondary Sign Out', () => {
  for (const p of ['twitch', 'kick', 'youtube', 'rumble']) {
    const start = html.indexOf(`<div class="glass-panel login-card ${p}-login-card`);
    assert.ok(start >= 0, p);
    const next = html.indexOf('<div class="glass-panel login-card ', start + 1);
    const cardHtml = html.slice(start, next > 0 ? next : html.indexOf('</section>', start));
    assert.match(cardHtml, new RegExp(`<span class="platform-badge ${p} login-card-logo" data-logo="${p}"></span>`));
    assert.match(cardHtml, /stroke="var\(--connected-color\)" stroke-width="2\.5"/);
    assert.match(cardHtml, /color: var\(--connected-color\); margin: 0;">\w+ Connected<\/h4>/);
    assert.match(cardHtml, /drop-shadow\(0 0 10px var\(--connected-glow\)\)/);
    assert.match(cardHtml, /class="btn btn-sm btn-quiet logout-btn"/);
    assert.match(cardHtml, /class="btn btn-sm btn-cyan reauth-btn"/, 'Re-authenticate stays the filled one');
  }
  assert.doesNotMatch(html + css, /platform-icon-/, 'the glowing dots are gone');
  assert.match(css, /--connected-color: hsl\(142, 71%, 45%\);/);
  assert.match(rule('.btn-quiet'), /background-color: transparent;/);
  assert.match(rule('.btn-quiet.logout-btn:hover'), /color: var\(--danger-color\);/);
});

test('F12: login.js fills each card logo from getPlatformSVG, and nothing else', () => {
  const host = doc.createElement('div');
  const logos = ['twitch', 'kick', 'youtube', 'constructor'].map(p => {
    const el = doc.createElement('span');
    el.className = 'platform-badge login-card-logo';
    el.setAttribute('data-logo', p);
    return host.appendChild(el);
  });
  login.fillLoginCardLogos(host);
  for (const el of logos.slice(0, 3)) assert.match(el.innerHTML, /^<svg class="badge-logo"/);
  assert.equal(logos[3].innerHTML, '', 'an unknown platform gets no markup');
});

test('F8: the 1-Click Login text is at least 12.5 px (0.78rem) everywhere', () => {
  for (const sel of ['.ext-desc', '.ext-steps', '.ext-fallback', '.ext-code-btn']) {
    const size = parseFloat(decl(sel, 'font-size'));
    assert.ok(size >= 0.78, `${sel}: ${size}rem`);
  }
  assert.ok(parseFloat(/\.ext-conn \{ font-size: ([\d.]+)rem/.exec(css)[1]) >= 0.78);
  assert.ok(parseFloat(/\.ext-note,\n\.ext-sync \{\n  font-size: ([\d.]+)rem/.exec(css)[1]) >= 0.78);
});

test('F9: each platform switch shares a cell with its own label', () => {
  const start = html.indexOf('<div class="platform-toggle-grid">');
  assert.ok(start >= 0);
  const block = html.slice(start, html.indexOf('<span class="help-text">', start));
  const cells = block.split('<div class="platform-toggle-cell"').slice(1);
  assert.equal(cells.length, 4);
  [['Twitch', 'twitch'], ['Kick', 'kick'], ['YouTube', 'youtube'], ['Rumble', 'rumble']].forEach(([label, id], i) => {
    assert.match(cells[i], new RegExp(`>\\s*${label}\\b`), label);
    assert.match(cells[i], new RegExp(`id="${id}-enabled-toggle"`), `${label}'s own switch`);
  });
  assert.match(cells[3], /white-space: nowrap;/, 'COMING SOON does not wrap');
  assert.equal(decl('.platform-toggle-cell:nth-child(even)', 'border-left'), '1px solid var(--panel-border)');
  // In a narrow cell the switch keeps its size and the label wraps instead
  // (at 1366 px Rumble's switch was squeezed to a dot).
  assert.equal(decl('.platform-toggle-cell .switch', 'flex-shrink'), '0');
  assert.equal(decl('.platform-toggle-cell .toggle-label', 'flex-wrap'), 'wrap');
});

test('F10: the per-platform tab limits sit together; Rumble\'s is hidden', () => {
  const at = id => html.indexOf(`id="${id}"`);
  const [tw, ki, yt, ru] = ['max-twitch-tabs-slider', 'max-kick-tabs-slider', 'max-youtube-tabs-slider', 'max-rumble-tabs-slider'].map(at);
  const activity = html.indexOf('<label>Automated Activity Toggles</label>');
  assert.ok(tw < ki && ki < yt && yt < ru && ru < activity, 'Twitch, Kick, YouTube, Rumble, then the next section');
  const rumbleGroup = html.lastIndexOf('<div class="settings-group', ru);
  assert.match(html.slice(rumbleGroup, ru), /^<div class="settings-group hidden">/);
});

test('F11: the copy matches the app', () => {
  assert.match(html, /<p>Add or remove Twitch, Kick and YouTube streamers from your monitoring list\.<\/p>/);
  assert.match(html, />Click Scan Live to list the channels you follow that are live now\.</);
  assert.match(html, />Start Time<\/label>/);
  assert.doesNotMatch(html, /24h format/, 'the field shows the system clock format');
});
