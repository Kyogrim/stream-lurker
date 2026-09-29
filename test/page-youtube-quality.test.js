// Runs the real YouTube branch of qualityAndTheaterScript (src/inject.js)
// against a fake YouTube player (F87: Source used to select Auto).
// Run: node --test test/page-youtube-quality.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage } = require('./page-fake-dom');

let qualityAndTheaterScript;
test.before(async () => { ({ qualityAndTheaterScript } = await import('../src/inject.js')); });

const REAL_MENU = ['1080p Premium', '1080p60 HD', '720p60', '480p', '360p', '240p', '144p', 'Auto (720p)'];

function youtubePage({ options = REAL_MENU } = {}) {
  const page = makePage({ host: 'www.youtube.com', pathname: '/@someone/live' });
  const { doc } = page;
  const player = doc.body.appendChild(doc.el('div', { class: 'html5-video-player' }, '', { left: 0, top: 0, width: 1280, height: 720 }));
  const cog = player.appendChild(doc.el('button', { class: 'ytp-button ytp-settings-button' }, '', { left: 1200, top: 680, width: 40, height: 40 }));
  const menu = player.appendChild(doc.el('div', { class: 'ytp-popup ytp-settings-menu' }, '', { left: 900, top: 200, width: 300, height: 400 }));
  menu.style.display = 'none';
  let current = 'Auto (720p)';
  const showMain = () => {
    menu.textContent = '';
    menu.appendChild(doc.el('div', { class: 'ytp-menuitem' }, 'Playback speedNormal'));
    const q = menu.appendChild(doc.el('div', { class: 'ytp-menuitem' }, 'Quality' + current));
    q.addEventListener('click', () => {
      menu.textContent = '';
      for (const label of options) {
        const row = menu.appendChild(doc.el('div', { class: 'ytp-menuitem' }, label));
        row.addEventListener('click', () => { current = label; });
      }
    });
  };
  cog.addEventListener('click', () => {
    if (menu.style.display === 'none') { showMain(); menu.style.display = ''; } else { menu.style.display = 'none'; }
  });
  return {
    ...page,
    get selected() { return current; },
    get menuOpen() { return menu.style.display !== 'none'; },
    start(q) { page.run(qualityAndTheaterScript(q)); },
  };
}

test('Source selects the top real rendition, not Auto and not Premium (F87)', async () => {
  const p = youtubePage();
  p.start('source');
  await p.clock.advance(10_000);
  assert.equal(p.selected, '1080p60 HD');
  assert.equal(p.menuOpen, false);
  assert.equal(JSON.parse(p.store.get('yt-player-quality')).data, 'highres');
});

test('160p still lands on 144p, and 480p on 480p', async () => {
  let p = youtubePage();
  p.start('160p');
  await p.clock.advance(10_000);
  assert.equal(p.selected, '144p');
  assert.equal(JSON.parse(p.store.get('yt-player-quality')).data, 'tiny');
  p = youtubePage();
  p.start('480p');
  await p.clock.advance(10_000);
  assert.equal(p.selected, '480p');
});

test('Source falls back to Auto only when no row carries a resolution', async () => {
  const p = youtubePage({ options: ['Auto'] });
  p.start('source');
  await p.clock.advance(10_000);
  assert.equal(p.selected, 'Auto');
});
