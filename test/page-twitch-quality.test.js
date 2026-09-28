// Runs the real Twitch branch of qualityAndTheaterScript (src/inject.js)
// against a fake Twitch player, on fake time (F43, F44, F45).
// Run: node --test test/page-twitch-quality.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, FakeKeyboardEvent } = require('./page-fake-dom');

let qualityAndTheaterScript;
test.before(async () => { ({ qualityAndTheaterScript } = await import('../src/inject.js')); });

// A Twitch player as the script sees it: settings cog, a settings menu whose
// first view has the Quality row, and a quality submenu of radio options.
// Selecting an option switches the video's height. Options model the page:
//   rowText       the Quality row's text (localized), or null for no row
//   closeOnSelect the page closes the menu itself after a pick
//   cogExpanded   the cog exposes aria-expanded
//   theatre       'on' (already in theatre), 'es' (a Spanish button whose
//                 label flips to "Salir del modo cine", which isTheater does
//                 not recognise), 'hook' (only the persistent-player--theatre
//                 layout class changes), 'dead' (a click that does nothing),
//                 'none' (no theatre button at all: the Alt+T fallback)
//   hotkey        the page's Alt+T handler switches theatre on synthetic
//                 presses too (stats.altT records every Alt+T it sees)
//   menuHooks     'player' (data-a-target and role="menu", inside the
//                 player), 'portal' (role="menu" only, rendered under <body>
//                 like a React portal, so neither hook in twitchMenuNode
//                 matches) or 'none' (no hook at all)
//   cogControls   the cog names the menu in aria-controls
//   stickyCog     the cog only opens the menu; a second click leaves it open
// Escape reaching the document closes the menu when it was aimed inside it,
// and otherwise acts as a page hotkey that leaves theatre mode. Each Escape's
// target is recorded in stats.escapes ('document', 'menu' or 'other').
function twitchPage({
  pathname = '/somechannel',
  options = ['Auto', '1080p60 (Quelle)', '720p60', '480p', '360p', '160p'],
  selected = 'Auto',
  rowText = 'Qualität',
  closeOnSelect = false,
  cogExpanded = false,
  height = 1080,
  theatre = 'on',
  hotkey = false,
  rowDelay = 0,
  menuHooks = 'player',
  cogControls = false,
  stickyCog = false,
} = {}) {
  const page = makePage({ host: 'www.twitch.tv', pathname });
  const { doc } = page;
  const stats = { cogClicks: 0, optionClicks: 0, opens: 0, theatreClicks: 0, altT: [], escapes: [] };
  const playerClass = theatre === 'on' ? 'video-player video-player--theatre' : 'video-player';
  const player = doc.body.appendChild(doc.el('div', { class: playerClass, 'data-a-target': 'video-player' }, '', { left: 0, top: 0, width: 1280, height: 720 }));
  let rowTextNow = rowText;
  // Twitch's hotkeys listen at the document, where a real keypress lands.
  doc.addEventListener('keydown', (e) => {
    if (!e.altKey || e.key !== 't') return;
    stats.altT.push(e.isTrusted ? 'native' : 'synthetic');
    if (hotkey) doc.body.setAttribute('class', doc.body.className ? '' : 'persistent-player--theatre');
  });
  if (theatre !== 'on' && theatre !== 'none') {
    const tbtn = player.appendChild(doc.el('button', { 'data-a-target': 'player-theatre-mode-button', 'aria-label': 'Modo cine (alt+t)' }, '', { left: 1150, top: 680, width: 30, height: 30 }));
    tbtn.addEventListener('click', () => {
      stats.theatreClicks++;
      if (theatre === 'dead') return;
      if (theatre === 'hook') {
        // Today's Twitch layout class; the label is left alone on purpose.
        const on = doc.body.className.includes('persistent-player--theatre');
        doc.body.setAttribute('class', on ? '' : 'persistent-player--theatre');
        return;
      }
      const on = tbtn.getAttribute('aria-label').startsWith('Salir');
      tbtn.setAttribute('aria-label', on ? 'Modo cine (alt+t)' : 'Salir del modo cine (alt+t)');
    });
    stats.theatreButton = tbtn;
  }
  const video = player.appendChild(doc.el('video', {}, '', { left: 0, top: 0, width: 1280, height: 720 }));
  video.videoHeight = height;
  const cog = player.appendChild(doc.el('button', { 'data-a-target': 'player-settings-button', 'aria-label': 'Einstellungen' }, '', { left: 1200, top: 680, width: 30, height: 30 }));
  if (cogExpanded) cog.setAttribute('aria-expanded', 'false');
  if (cogControls) cog.setAttribute('aria-controls', 'settings-popover');
  // Like React's portal root: exists from the start, so anything a test
  // appends to <body> later comes after the portalled menu in document order.
  const portalRoot = doc.body.appendChild(doc.el('div', { id: 'portal-root' }));
  let menu = null;
  let current = selected;

  const setExpanded = () => { if (cogExpanded) cog.setAttribute('aria-expanded', menu ? 'true' : 'false'); };
  const closeMenu = () => { if (menu) menu.remove(); menu = null; setExpanded(); };
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const inMenu = !!menu && menu.contains(e.target);
    stats.escapes.push(e.target === doc ? 'document' : (inMenu ? 'menu' : 'other'));
    if (inMenu) closeMenu();
    else player.setAttribute('class', player.className.replace(' video-player--theatre', ''));
  });
  const openMenu = () => {
    stats.opens++;
    const hooks = { player: { 'data-a-target': 'player-settings-menu', role: 'menu' }, portal: { role: 'menu' }, none: {} }[menuHooks];
    const parent = menuHooks === 'portal' ? portalRoot : player;
    const m = menu = parent.appendChild(doc.el('div', { id: 'settings-popover', ...hooks }, '', { left: 900, top: 300, width: 300, height: 380 }));
    const addRow = () => {
      if (rowTextNow === null || menu !== m) return;
      const row = m.appendChild(doc.el('button', { 'data-a-target': 'player-settings-menu-item-quality', role: 'menuitem' }, rowTextNow, { left: 900, top: 300, width: 300, height: 30 }));
      row.appendChild(doc.el('span', {}, current));
      row.addEventListener('click', showQualitySubmenu);
    };
    if (rowDelay) page.clock.setTimeout(addRow, rowDelay); else addRow();
    m.appendChild(doc.el('button', { role: 'menuitem' }, 'Erweitert', { left: 900, top: 330, width: 300, height: 30 }));
    setExpanded();
  };
  function showQualitySubmenu() {
    menu.textContent = '';
    options.forEach((label, i) => {
      const opt = menu.appendChild(doc.el('div', { 'data-a-target': 'player-settings-submenu-quality-option' }, '', { left: 900, top: 300 + i * 30, width: 300, height: 30 }));
      const input = opt.appendChild(doc.el('input', { type: 'radio', name: 'quality', id: `q${i}` }));
      input.checked = label === current;
      const lab = opt.appendChild(doc.el('label', { class: 'tw-radio__label', for: `q${i}` }, label, { left: 920, top: 300 + i * 30, width: 200, height: 30 }));
      lab.addEventListener('click', () => { stats.optionClicks++; });
      input.addEventListener('change', () => {
        current = label;
        const m = /^(\d{3,4})p/.exec(label);
        if (m) video.videoHeight = Number(m[1]);
        if (closeOnSelect) closeMenu();
      });
    });
  }
  cog.addEventListener('click', () => {
    stats.cogClicks++;
    if (menu) { if (!stickyCog) closeMenu(); } else openMenu();
  });

  return {
    ...page, stats, player, video, cog,
    get menuOpen() { return !!menu && menu.isConnected; },
    get selected() { return current; },
    get theatreOn() { return stats.theatreButton.getAttribute('aria-label').startsWith('Salir'); },
    select(label) { current = label; },
    setRowText(t) { rowTextNow = t; },
    start(quality = '160p') { page.run(qualityAndTheaterScript(quality)); },
  };
}

test('German UI: the Quality row is found by data-a-target, 160p is picked, the menu is closed (F43)', async () => {
  const p = twitchPage();
  p.start('160p');
  await p.clock.advance(4000);
  assert.equal(p.selected, '160p');
  assert.equal(p.menuOpen, false);
  assert.equal(p.stats.cogClicks, 2, 'one open, one close');
  await p.clock.advance(3000);
  assert.deepEqual(p.logText('[Twitch Quality]'), ['[Twitch Quality] Quality set to 160p on /somechannel.']);
  // __qualityState is the gate here; __qualitySet belongs to the YouTube branch.
  assert.equal(p.ctx.__qualitySet, undefined);
});

test('once resolved, an ad at 1080p never reopens the menu (F44)', async () => {
  const p = twitchPage();
  p.start('160p');
  await p.clock.advance(10_000);
  const clicks = p.stats.cogClicks;
  p.video.videoHeight = 1080;
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.cogClicks, clicks);
  assert.equal(p.menuOpen, false);
});

test('a source-only channel settles on its only rendition instead of flashing the menu forever (F44)', async () => {
  const p = twitchPage({ options: ['Auto', '1080p60 (Source)'], rowText: 'Quality' });
  p.start('160p');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.selected, '1080p60 (Source)');
  assert.equal(p.stats.opens, 1);
  assert.equal(p.menuOpen, false);
  assert.deepEqual(p.logText('[Twitch Quality]'), ['[Twitch Quality] Quality set to 1080p60 (Source) on /somechannel.']);
});

test('no Quality row: bounded tries, the menu closed each time, two log lines, then silence (F43, F44)', async () => {
  const p = twitchPage({ rowText: null });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  // The old code opened it every 15 s: 240 times in this hour.
  assert.equal(p.stats.opens, 7);
  assert.equal(p.stats.cogClicks, 14);
  assert.equal(p.menuOpen, false);
  const lines = p.logText('[Twitch Quality]');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /Could not set 160p on \/somechannel \(Quality row not found in the settings menu\)/);
  assert.match(lines[1], /Giving up on 160p for \/somechannel after 7 attempts/);
});

test('a quality row that only works after a long ad is still used (backoff, not a 1-minute budget)', async () => {
  const p = twitchPage({ rowText: null });
  p.start('160p');
  // Four quick tries fail inside the first minute (say, during a pre-roll).
  await p.clock.advance(150_000);
  assert.equal(p.stats.opens, 4);
  p.setRowText('Qualität');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.selected, '160p');
  assert.equal(p.menuOpen, false);
});

test('a menu the page already closed is not toggled back open (F44)', async () => {
  const p = twitchPage({ closeOnSelect: true });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.selected, '160p');
  assert.equal(p.stats.cogClicks, 1, 'the blind close click used to reopen it');
  assert.equal(p.menuOpen, false);
});

test('no concrete menu node to aim at: no Escape reaches the page hotkeys, theatre stays on', async () => {
  // Neither menu hook matches and the Quality row is never found, so nothing
  // says whether a menu is open or where it is. The old fallback sent Escape
  // to the document, where a page hotkey can leave theatre mode, which the
  // script has already latched and would never restore.
  const p = twitchPage({ rowText: null, menuHooks: 'none' });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  assert.deepEqual(p.stats.escapes, []);
  assert.match(p.player.className, /video-player--theatre/);
  assert.equal(p.stats.cogClicks, 7, 'one click per attempt, no close keyed on a guess');
  const lines = p.logText('[Twitch Quality]');
  assert.match(lines[lines.length - 1], /Giving up on 160p for \/somechannel after 7 attempts/);
});

test('a menu no selector finds is still closed through the element the cog names in aria-controls', async () => {
  const p = twitchPage({ rowText: null, menuHooks: 'none', cogControls: true });
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  assert.equal(p.stats.opens, 7);
  assert.equal(p.stats.cogClicks, 14, 'one open and one close per attempt');
  assert.equal(p.menuOpen, false);
  assert.deepEqual(p.stats.escapes, []);
});

test('a role="menu" portal the cog click brought up is closed, and only that one', async () => {
  // Rendered outside the player twitchMenuNode searches. A role="menu" that
  // was already on screen before the click (the page's own, here later in
  // document order) is not ours: keyed on it, the close would toggle the cog
  // and then send Escape at a menu that is not the settings menu.
  const p = twitchPage({ rowText: null, menuHooks: 'portal' });
  const other = p.doc.body.appendChild(p.doc.el('div', { role: 'menu' }, 'Kanal', { left: 0, top: 0, width: 200, height: 100 }));
  p.start('160p');
  await p.clock.advance(60 * 60_000);
  assert.equal(p.stats.opens, 7);
  assert.equal(p.stats.cogClicks, 14, 'one open and one close per attempt');
  assert.equal(p.menuOpen, false);
  assert.equal(other.isConnected, true);
  assert.deepEqual(p.stats.escapes, []);
});

test('a cog that will not close its menu gets one Escape aimed into the menu, not the page', async () => {
  const p = twitchPage({ stickyCog: true });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.selected, '160p');
  assert.equal(p.menuOpen, false);
  assert.deepEqual(p.stats.escapes, ['menu']);
  assert.match(p.player.className, /video-player--theatre/);
});

test('aria-expanded on the cog is honoured when present', async () => {
  const p = twitchPage({ cogExpanded: true });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.selected, '160p');
  assert.equal(p.menuOpen, false);
  assert.equal(p.cog.getAttribute('aria-expanded'), 'false');
});

test('Source in a German UI picks the top rendition, whatever the label says', async () => {
  const p = twitchPage({ options: ['Auto', '1080p60 (Quelle)', '720p60', '160p'] });
  p.start('source');
  await p.clock.advance(60_000);
  assert.equal(p.selected, '1080p60 (Quelle)');
  assert.equal(p.stats.opens, 1);
});

test('an already selected rendition resolves without clicking it again', async () => {
  const p = twitchPage({ selected: '160p', height: 1080 });
  p.start('160p');
  await p.clock.advance(60_000);
  assert.equal(p.stats.optionClicks, 0);
  assert.equal(p.stats.opens, 1);
  assert.deepEqual(p.logText('[Twitch Quality]'), ['[Twitch Quality] Quality set to 160p on /somechannel.']);
});

test('a raid to another channel in the same document is capped too', async () => {
  const p = twitchPage();
  p.start('160p');
  await p.clock.advance(30_000);
  assert.equal(p.stats.opens, 1);
  p.ctx.location.pathname = '/raidtarget';
  p.select('Auto');
  p.video.videoHeight = 1080;
  await p.clock.advance(30_000);
  assert.equal(p.stats.opens, 2);
  assert.equal(p.selected, '160p');
  assert.deepEqual(p.logText('Quality set to').map(s => s.replace('[Twitch Quality] ', '')),
    ['Quality set to 160p on /somechannel.', 'Quality set to 160p on /raidtarget.']);
});

test('auto quality disabled: hands off; re-enabled: caps again', async () => {
  const p = twitchPage();
  p.ctx.__autoQualityDisabled = true;
  p.start('160p');
  await p.clock.advance(5 * 60_000);
  assert.equal(p.stats.cogClicks, 0);
  p.ctx.__autoQualityDisabled = false;
  await p.clock.advance(30_000);
  assert.equal(p.selected, '160p');
});

test('switching auto quality off in the middle of a walk drops that walk cleanly', async () => {
  // The row renders too late (3.5 s > the 3 s wait), so the walk that starts
  // at 3 s runs until 6 s and fails, and the 6 s tick lands inside it.
  const p = twitchPage({ rowDelay: 3500 });
  p.start('160p');
  await p.clock.advance(3100);
  assert.equal(p.ctx.__qualityBusy, true, 'a walk is in progress');
  p.ctx.__autoQualityDisabled = true;
  await p.clock.advance(60_000);
  assert.deepEqual(p.logs.filter(l => l.text.includes('undefined')), []);
  assert.equal(p.ctx.__qualityState, null);
  assert.equal(p.menuOpen, false);
});

test('nothing playing yet (offline page): the menu is never touched', async () => {
  const p = twitchPage({ height: 0 });
  p.start('160p');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.cogClicks, 0);
});

test('theatre button in an unrecognised locale: one click, confirmed by the label change, no flip-flop (F45)', async () => {
  const p = twitchPage({ theatre: 'es' });
  p.start('160p');
  await p.clock.advance(5 * 60_000);
  assert.equal(p.stats.theatreClicks, 1);
  assert.equal(p.theatreOn, true);
  assert.equal(p.ctx.__twitchTheaterLatched, true);
});

test('theatre detected by the current layout class, whatever the UI language', async () => {
  const p = twitchPage({ theatre: 'hook' });
  p.start('160p');
  await p.clock.advance(5 * 60_000);
  assert.equal(p.stats.theatreClicks, 1);
  assert.equal(p.doc.body.className, 'persistent-player--theatre');
  assert.equal(p.ctx.__twitchTheaterLatched, true);
});

test('a theatre button that does nothing is clicked five times, then left alone (F45)', async () => {
  const p = twitchPage({ theatre: 'dead' });
  p.start('160p');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.theatreClicks, 5);
  assert.deepEqual(p.stats.altT, [], 'the button path never presses Alt+T');
});

test('a grid relayout right after a theatre click that did nothing is not taken as confirmation', async () => {
  const p = twitchPage({ theatre: 'dead' });
  p.start('160p');
  await p.clock.advance(3000);
  assert.equal(p.stats.theatreClicks, 1);
  // Another cell auto-opens and the grid shrinks this one before the next tick.
  p.player.rect = { left: 0, top: 0, width: 640, height: 360 };
  await p.clock.advance(10 * 60_000);
  assert.equal(p.stats.theatreClicks, 5, 'still retried: only the button can confirm a click');
});

// ------------------------------------------------ no button: Alt+T (F42)

const needAltT = (p) => p.logText('[Twitch Theater] Need Alt+T').length;
const nativeAltT = (extra = {}) => new FakeKeyboardEvent('keydown', { key: 't', code: 'KeyT', keyCode: 84, altKey: true, isTrusted: true, ...extra });

test('no theatre button: one synthetic Alt+T, seen once, then asks that slow down (F42)', async () => {
  const p = twitchPage({ theatre: 'none' });
  p.start('160p');
  await p.clock.advance(3000);
  // The old tick dispatched one event object to the video, the document and
  // the window: the page's handler saw it up to three times per tick.
  assert.deepEqual(p.stats.altT, ['synthetic']);
  assert.equal(p.video.counts.keydown, 1);
  assert.equal(needAltT(p), 0, 'the press gets a tick to show before any ask');
  await p.clock.advance(15_000);
  assert.equal(needAltT(p), 5, 'the first five ticks after it ask');
  await p.clock.advance(10 * 60_000 - 18_000);
  // Then one every 30 s (48 s, 78 s, ... 588 s). The old script asked on all
  // 200 ticks of these ten minutes.
  assert.equal(needAltT(p), 5 + 19);
  assert.deepEqual(p.stats.altT, ['synthetic'], 'never pressed again');
  assert.equal(p.ctx.__twitchTheaterLatched, undefined);
});

test('an unseen cell keeps asking, so the renderer can answer once it is seen (F42)', async () => {
  // theater-key.js only presses for a visible cell in a focused window: a
  // cutoff here would leave a cell opened while the user was away without
  // theatre mode for good.
  const p = twitchPage({ theatre: 'none' });
  p.start('160p');
  await p.clock.advance(6 * 60 * 60_000);
  const before = needAltT(p);
  await p.clock.advance(60_000);
  assert.equal(needAltT(p) - before, 2);
});

test('a native Alt+T ends the fallback; synthetic or other keys do not (F42)', async () => {
  const p = twitchPage({ theatre: 'none' });
  p.start('160p');
  await p.clock.advance(6000);
  assert.equal(needAltT(p), 1);
  // A page script cannot forge isTrusted, and other trusted keys are not it.
  p.ctx.dispatchEvent(nativeAltT({ isTrusted: false }));
  p.ctx.dispatchEvent(nativeAltT({ key: 'x', code: 'KeyX', keyCode: 88 }));
  p.ctx.dispatchEvent(nativeAltT({ altKey: false }));
  await p.clock.advance(3000);
  assert.equal(needAltT(p), 2);
  assert.equal(p.ctx.__twitchTheaterLatched, undefined);
  // The renderer's sendInputEvent is trusted input.
  p.ctx.dispatchEvent(nativeAltT());
  assert.equal(p.ctx.__twitchTheaterLatched, true);
  await p.clock.advance(10 * 60_000);
  assert.equal(needAltT(p), 2);
  assert.equal(p.video.counts.keydown, 1);
});

test('a page that honours the synthetic press latches without asking the renderer', async () => {
  const p = twitchPage({ theatre: 'none', hotkey: true });
  p.start('160p');
  await p.clock.advance(10 * 60_000);
  assert.equal(p.doc.body.className, 'persistent-player--theatre');
  assert.equal(p.ctx.__twitchTheaterLatched, true);
  assert.deepEqual(p.stats.altT, ['synthetic']);
  assert.equal(needAltT(p), 0);
});

test('no video yet: no press and no ask until the player has one', async () => {
  const p = twitchPage({ theatre: 'none' });
  p.video.remove();
  p.start('160p');
  await p.clock.advance(60_000);
  assert.deepEqual(p.stats.altT, []);
  assert.equal(needAltT(p), 0);
  p.player.appendChild(p.video);
  await p.clock.advance(6000);
  assert.deepEqual(p.stats.altT, ['synthetic']);
  assert.equal(needAltT(p), 1);
});
