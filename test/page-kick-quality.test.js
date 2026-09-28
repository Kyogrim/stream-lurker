// Runs the real Kick branch of qualityAndTheaterScript (src/inject.js)
// against a fake Kick player, on fake time (F44, F45, F87).
// Run: node --test test/page-kick-quality.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage } = require('./page-fake-dom');

let qualityAndTheaterScript;
test.before(async () => { ({ qualityAndTheaterScript } = await import('../src/inject.js')); });

// A Kick player: settings cog opening a bottom-right menu of rendition rows,
// and a theater button. Options model the page:
//   options       rendition row labels, in menu order
//   toggleOn      the DOM event the cog and theater button react to ('click'
//                 like a plain onClick, 'pointerdown' like a Radix trigger)
//   closeOnSelect the page closes the menu itself after a pick
//   theater       'off' | 'on' | 'dead' (a button whose click does nothing)
//   cog           false for a player with no findable settings button
//   furniture     the cog sits in an always-visible bottom control bar that
//                 says "Autoplay", which findActiveMenu's first branch takes
//                 for the menu
//   closeAfter    ms after opening, the page closes the menu on its own
// Escape on the document closes the menu, as Radix-style menus do. Each
// Escape's target is recorded in stats.escapeTargets ('document', 'menu',
// or 'other').
function kickPage({
  pathname = '/streamer',
  options = ['Auto', '1080p60', '720p60', '480p30', '360p30', '160p30'],
  selected = 'Auto',
  toggleOn = 'click',
  closeOnSelect = false,
  theater = 'off',
  cog: hasCog = true,
  furniture = false,
  closeAfter = 0,
  height = 1080,
} = {}) {
  const page = makePage({ host: 'kick.com', pathname });
  const { doc } = page;
  const stats = { cogToggles: 0, opens: 0, theaterToggles: 0, picks: 0, escapes: 0, escapeTargets: [] };
  const container = doc.body.appendChild(doc.el('div', { id: 'video-player' }, '', { left: 0, top: 0, width: 1280, height: 720 }));
  const holder = container.appendChild(doc.el('div', { class: 'video-holder' }));
  const video = holder.appendChild(doc.el('video', {}, '', { left: 0, top: 0, width: 1280, height: 720 }));
  video.videoHeight = height;
  video.paused = false;
  video.play = () => {};
  let menu = null;
  let current = selected;

  const closeMenu = () => { if (menu) menu.remove(); menu = null; };
  doc.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    stats.escapes++;
    stats.escapeTargets.push(ev.target === doc ? 'document' : (menu && menu.contains(ev.target) ? 'menu' : 'other'));
    closeMenu();
  });
  const bar = furniture
    ? container.appendChild(doc.el('div', { class: 'controls-bar' }, 'Autoplay', { left: 0, top: 680, width: 1280, height: 40 }))
    : container;
  const cog = hasCog
    ? bar.appendChild(doc.el('button', { 'aria-label': 'Settings' }, '', { left: 1200, top: 680, width: 32, height: 32 }))
    : null;
  if (cog) {
    cog.addEventListener(toggleOn, () => {
      stats.cogToggles++;
      if (menu) { closeMenu(); return; }
      stats.opens++;
      const m = menu = container.appendChild(doc.el('div', { role: 'menu', class: 'z-50 rounded' }, '', { left: 1000, top: 400, width: 250, height: 280 }));
      if (closeAfter) page.clock.setTimeout(() => { if (menu === m) closeMenu(); }, closeAfter);
      options.forEach((label, i) => {
        const row = menu.appendChild(doc.el('div', { role: 'menuitemradio', 'aria-checked': String(label === current) }, '', { left: 1000, top: 400 + i * 40, width: 250, height: 40 }));
        row.appendChild(doc.el('span', { class: 'pointer-events-none' }, label, { left: 1010, top: 405 + i * 40, width: 80, height: 30 }));
        row.addEventListener('click', () => {
          stats.picks++;
          current = label;
          const m = /^(\d{3,4})p/.exec(label);
          if (m) video.videoHeight = Number(m[1]);
          if (closeOnSelect) closeMenu();
        });
      });
    });
  }

  // Bottom-left: findSettingsCog's last fallback takes any small control near
  // the bottom-right corner as the cog, which would make this the "cog".
  const tbtn = container.appendChild(doc.el('button', { 'aria-label': theater === 'on' ? 'Exit theater mode' : 'Theater mode' }, '', { left: 20, top: 680, width: 32, height: 32 }));
  const icon = tbtn.appendChild(doc.el('path', { d: theater === 'on' ? 'M1' : 'M0' }));
  tbtn.addEventListener(toggleOn, () => {
    stats.theaterToggles++;
    if (theater === 'dead') return;
    const on = tbtn.getAttribute('aria-label') === 'Exit theater mode';
    tbtn.setAttribute('aria-label', on ? 'Theater mode' : 'Exit theater mode');
    icon.setAttribute('d', on ? 'M0' : 'M1');
  });

  return {
    ...page, stats, video, tbtn,
    get menuOpen() { return !!menu && menu.isConnected; },
    get selected() { return current; },
    get theaterOn() { return tbtn.getAttribute('aria-label') === 'Exit theater mode'; },
    start(quality = '160p') { page.run(qualityAndTheaterScript(quality)); },
  };
}

test('160p: one click opens the menu, 160p30 is picked, one click closes it (F44, F45)', async () => {
  const p = kickPage();
  p.start('160p');
  await p.clock.advance(5000);
  assert.equal(p.selected, '160p30');
  assert.equal(p.menuOpen, false);
  assert.equal(p.stats.cogToggles, 2, 'directClick used to fire two clicks per call');
  await p.clock.advance(3000);
  assert.deepEqual(p.logText('[Kick Quality]'), ['[Kick Quality] Quality set to 160p30 on /streamer.']);
});

test('once resolved, ten minutes of 1080p ads never reopen the menu (F44)', async () => {
  const p = kickPage();
  p.start('160p');
  await p.clock.advance(10_000);
  const toggles = p.stats.cogToggles;
  p.video.videoHeight = 1080;
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.cogToggles, toggles);
  assert.equal(p.logText('[Kick Quality]').length, 1);
});

test('Radix-style triggers that toggle on pointerdown also toggle exactly once per call', async () => {
  const p = kickPage({ toggleOn: 'pointerdown' });
  p.start('160p');
  await p.clock.advance(10_000);
  assert.equal(p.stats.cogToggles, 2);
  assert.equal(p.menuOpen, false);
  assert.equal(p.theaterOn, true);
});

test('Source picks the top rendition, not the Auto row listed first (F87)', async () => {
  const p = kickPage();
  p.start('source');
  await p.clock.advance(10_000);
  assert.equal(p.selected, '1080p60');
  assert.equal(p.stats.opens, 1);
});

test('no rendition under the cap: the lowest one is taken and the loop ends (F44)', async () => {
  const p = kickPage({ options: ['Auto', '1080p60'] });
  p.start('160p');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.selected, '1080p60');
  assert.equal(p.stats.opens, 1);
});

test('a menu the page closed itself is not toggled back open (F44)', async () => {
  const p = kickPage({ closeOnSelect: true });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.selected, '160p30');
  assert.equal(p.stats.cogToggles, 1);
  assert.equal(p.menuOpen, false);
});

test('a menu with no renditions: bounded tries, menu closed each time, two log lines (F44)', async () => {
  const p = kickPage({ options: ['Auto'] });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  // The old loop opened it every 15 s and wrote 3-4 console lines each time.
  assert.equal(p.stats.opens, 7);
  assert.equal(p.menuOpen, false);
  const lines = p.logText('[Kick Quality]');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /Could not set 160p on \/streamer \(no quality option fits 160p\)/);
  assert.match(lines[1], /Giving up on 160p for \/streamer after 7 attempts/);
});

test('a control bar mistaken for the menu is never used to decide "open": the menu the click opened is (F44)', async () => {
  const p = kickPage({ furniture: true });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  // The heuristic reads the bar, so no rendition is found and the budget runs
  // out. A toggle keyed on the always-visible bar would reopen a menu the page
  // had closed; the close is keyed on the role="menu" element that appeared
  // after the cog click instead: one toggle to open, one to close, per round.
  assert.equal(p.stats.opens, 7);
  assert.equal(p.stats.cogToggles, 14);
  assert.equal(p.stats.escapes, 0);
  assert.equal(p.menuOpen, false);
});

test('a control bar and a menu the page already closed: no toggle and no blind Escape', async () => {
  // Nothing concrete is left to close: the bar is furniture and the menu is
  // gone. An Escape at the document here lands on the page's own hotkeys.
  const p = kickPage({ furniture: true, closeAfter: 200 });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  assert.equal(p.stats.opens, 7);
  assert.equal(p.stats.cogToggles, 7, 'only the opening clicks');
  assert.deepEqual(p.stats.escapeTargets, []);
  assert.equal(p.menuOpen, false);
});

test('a menu the page closed itself gets neither a toggle nor an Escape', async () => {
  const p = kickPage({ closeOnSelect: true });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.stats.cogToggles, 1);
  assert.equal(p.stats.escapes, 0);
});

test('no settings cog: the video is clicked once per channel, not every 15 s (F44)', async () => {
  const p = kickPage({ cog: false });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  assert.equal(p.video.counts.click, 1);
  const lines = p.logText('[Kick Quality]');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /Giving up on 160p for \/streamer after 7 attempts \(settings button not found\)/);
});

test('theater off: clicked once, confirmed, latched (F45)', async () => {
  const p = kickPage();
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.theaterOn, true);
  assert.equal(p.stats.theaterToggles, 1);
});

test('theater already on ("Exit theater mode"): never clicked (F45)', async () => {
  const p = kickPage({ theater: 'on' });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.theaterOn, true);
  assert.equal(p.stats.theaterToggles, 0);
});

test('a theater button that does nothing is tried five times, then left alone (F45)', async () => {
  const p = kickPage({ theater: 'dead' });
  p.start('160p');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.theaterToggles, 5);
  assert.equal(p.logText('[Kick Theater]').length, 1);
});

test('a grid relayout right after a theater click that did nothing is not taken as confirmation', async () => {
  const p = kickPage({ theater: 'dead' });
  p.start('160p');
  await p.clock.advance(3000);
  assert.equal(p.stats.theaterToggles, 1);
  // Another cell auto-opens and the grid shrinks this one before the next tick.
  p.video.rect = { left: 0, top: 0, width: 640, height: 360 };
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.theaterToggles, 5, 'still retried: only the button can confirm a click');
  assert.match(p.logText('[Kick Theater]')[0] || '', /did not respond after 5 clicks/);
});
