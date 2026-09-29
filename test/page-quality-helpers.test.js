// Gate tests for the page-side helpers in src/inject.js (F43, F44, F45, F87).
// These exact functions are serialized into the injected page script, so what
// passes here is what runs inside twitch.tv / kick.com / youtube.com.
// Run: node --test test/page-quality-helpers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage } = require('./page-fake-dom');

let m;
test.before(async () => { m = await import('../src/inject.js'); });

// ------------------------------------------------------------ renditions

test('parseRendition reads resolution and fps, anchored at the start', () => {
  assert.deepEqual(m.parseRendition('1080p60 (Source)'), { height: 1080, fps: 60 });
  assert.deepEqual(m.parseRendition('  720p  '), { height: 720, fps: 0 });
  assert.deepEqual(m.parseRendition('2160p60 4K'), { height: 2160, fps: 60 });
  assert.deepEqual(m.parseRendition('160p30'), { height: 160, fps: 30 });
  // Unanchored parsing read YouTube's Auto row as a 720p rendition.
  assert.equal(m.parseRendition('Auto (720p)'), null);
  assert.equal(m.parseRendition('Quality 1080p60'), null);
  assert.equal(m.parseRendition('Auto'), null);
  assert.equal(m.parseRendition(null), null);
});

test('source picks the top rendition, never Auto or Premium (F87 YouTube fixture)', () => {
  const yt = ['Auto (720p)', '1080p60', '1080p Premium', '720p60', '480p', '144p'];
  assert.equal(yt[m.pickRendition(yt, 'source')], '1080p60');
  // Premium listed first and highest still loses: it opens an upsell.
  const prem = ['1080p Premium', '1080p', '720p60', 'Auto (1080p)'];
  assert.equal(prem[m.pickRendition(prem, 'source')], '1080p');
  // fps breaks the tie between equal heights.
  const fps = ['1080p', '1080p60', '720p'];
  assert.equal(fps[m.pickRendition(fps, 'source')], '1080p60');
});

test('source on Kick ignores a leading Auto row (F87)', () => {
  const kick = ['Auto', '1080p60', '720p60', '480p30', '360p30', '160p30'];
  assert.equal(kick[m.pickRendition(kick, 'source')], '1080p60');
  // An explicit Source/Original row wins even without a resolution.
  assert.equal(m.pickRendition(['Auto', 'Original', '720p60'], 'source'), 1);
});

test('source works in any Twitch locale: the highest row, not the word "Source" (F43)', () => {
  const de = ['Auto', '1080p60 (Quelle)', '720p60', '480p', '360p', '160p'];
  assert.equal(de[m.pickRendition(de, 'source')], '1080p60 (Quelle)');
  const en = ['Auto', '1080p60 (Source)', '720p60', '160p'];
  assert.equal(en[m.pickRendition(en, 'source')], '1080p60 (Source)');
});

test('a cap takes the best rendition at or under it', () => {
  const tw = ['Auto', '1080p60 (Source)', '720p60', '720p', '480p', '360p', '160p'];
  assert.equal(tw[m.pickRendition(tw, '160p')], '160p');
  assert.equal(tw[m.pickRendition(tw, '720p')], '720p60');
  assert.equal(tw[m.pickRendition(tw, '480p')], '480p');
  // No 480p offered: the closest one under the cap, not the lowest.
  const gap = ['Auto', '1080p60', '720p60', '360p30', '160p30'];
  assert.equal(gap[m.pickRendition(gap, '480p')], '360p30');
  // YouTube has no 160p; 144p is the rendition under the cap.
  const yt = ['2160p60 4K', '1080p60 HD', '720p60', '480p', '360p', '240p', '144p', 'Auto (1080p60)'];
  assert.equal(yt[m.pickRendition(yt, '160p')], '144p');
});

test('a source-only channel resolves to its only rendition instead of looping (F44)', () => {
  const only = ['Auto', '1080p60 (Source)'];
  assert.equal(only[m.pickRendition(only, '160p')], '1080p60 (Source)');
  // Nothing under the cap: the cheapest one offered.
  const two = ['1080p60', '1080p30', '936p60'];
  assert.equal(two[m.pickRendition(two, '160p')], '936p60');
});

test('pickRendition returns -1 when nothing is a rendition or the setting is unknown', () => {
  assert.equal(m.pickRendition(['Auto', 'Quality', 'Advanced'], '160p'), -1);
  assert.equal(m.pickRendition([], 'source'), -1);
  assert.equal(m.pickRendition(['720p'], 'bogus'), -1);
  assert.equal(m.pickRendition(['720p'], undefined), -1);
});

test('isQualityLabel matches "quality" across locales and nothing else (F43)', () => {
  for (const word of ['Quality', 'Qualität', 'Calidad', 'Qualidade', 'Qualità', 'Qualité', 'Качество',
    'Jakość', 'Kalite', 'Kwaliteit', 'Kvalitet', 'Laatu', '画質', '画质', '品質', '화질', '품질', 'Chất lượng']) {
    assert.ok(m.isQualityLabel(word), word);
  }
  assert.ok(m.isQualityLabel('Qualität\n1080p60'));
  // Not the Kick row regex: resolutions and Auto would pick a rendition row.
  for (const other of ['720p', '1080p60 (Quelle)', 'Auto', 'Source', 'Erweitert', 'Advanced', '', null]) {
    assert.equal(m.isQualityLabel(other), false, String(other));
  }
});

// ------------------------------------------------------ the attempt budget

const obs = (over = {}) => Object.assign({ key: '/chan', quality: '160p', now: 1_000_000, videoHeight: 1080 }, over);

test('qualityStep waits for a decoded frame before spending an attempt', () => {
  const s = m.qualityStep(null, obs({ videoHeight: 0 }));
  assert.equal(s.action, 'idle');
  assert.equal(s.st.attempts, 0);
});

test('qualityStep: four tries 15 s apart, then minutes apart, then one give-up', () => {
  let st = null;
  let t = 1_000_000;
  const actions = [];
  const logs = [];
  // One hour of 3 s ticks against a page where every attempt fails.
  for (let i = 0; i < 1200; i++, t += 3000) {
    const s = m.qualityStep(st, obs({ now: t }));
    st = s.st;
    if (s.log) logs.push(s.log);
    if (s.action === 'attempt') {
      const rec = m.qualityRecord(st, { fail: 'Quality row not found' }, t);
      st = rec.st;
      if (rec.log) logs.push(rec.log);
    }
    actions.push(s.action);
  }
  assert.equal(actions.filter(a => a === 'attempt').length, 7);
  assert.equal(actions.filter(a => a === 'gaveup').length, 1);
  const at = actions.map((a, i) => (a === 'attempt' ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(at.slice(1).map((v, i) => (v - at[i]) * 3000), [15000, 15000, 15000, 120000, 300000, 600000]);
  // The give-up lands one tick after the last attempt, about 18 minutes in.
  const gaveUpAt = actions.indexOf('gaveup') * 3000;
  assert.ok(gaveUpAt > 17 * 60_000 && gaveUpAt < 19 * 60_000, String(gaveUpAt));
  // An hour of ticks, two log lines: the first failure and the give-up.
  assert.equal(logs.length, 2, logs.join('\n'));
  assert.match(logs[1], /^Giving up on 160p for \/chan after 7 attempts \(Quality row not found\)\.$/);
});

test('a resolved channel ignores later heights (ads) but a new channel or quality starts over', () => {
  let s = m.qualityStep(null, obs());
  s = { st: m.qualityRecord(s.st, { picked: { label: '160p', height: 160, checked: false } }, 1_000_000).st };
  let r = m.qualityStep(s.st, obs({ now: 1_003_000, videoHeight: 160 }));
  assert.equal(r.action, 'resolved');
  assert.equal(r.log, 'Quality set to 160p on /chan.');
  // An ad at 1080p for ten minutes: never another attempt.
  let st = r.st;
  for (let t = 1_006_000; t < 1_606_000; t += 3000) {
    r = m.qualityStep(st, obs({ now: t, videoHeight: 1080 }));
    assert.equal(r.action, 'idle');
    st = r.st;
  }
  // A raid lands on another channel in the same document.
  assert.equal(m.qualityStep(st, obs({ key: '/raided', now: 1_700_000 })).action, 'attempt');
  // The user changed the setting.
  assert.equal(m.qualityStep(st, obs({ quality: '360p', now: 1_700_000 })).action, 'attempt');
});

test('a pick that never takes is retried, then counted toward the give-up', () => {
  let s = m.qualityStep(null, obs());
  let st = m.qualityRecord(s.st, { picked: { label: '160p', height: 160, checked: false } }, 1_000_000).st;
  // Still 1080 inside the 20 s verify window: wait.
  assert.equal(m.qualityStep(st, obs({ now: 1_010_000 })).action, 'idle');
  // Past the window: retry, logging the first failure once.
  const r = m.qualityStep(st, obs({ now: 1_021_000 }));
  assert.equal(r.action, 'attempt');
  assert.match(r.log, /Could not confirm 160p on \/chan \(the player stayed at 1080p after picking 160p\)/);
  // The retry finds the row already selected: done, even though an ad still shows 1080.
  const done = m.qualityRecord(r.st, { picked: { label: '160p', height: 160, checked: true } }, 1_022_000);
  assert.equal(done.st.resolved, true);
  assert.equal(done.log, 'Quality set to 160p on /chan.');
});

test('a source pick or a source-only channel resolves without a height match', () => {
  let s = m.qualityStep(null, obs({ quality: 'source', videoHeight: 480 }));
  let st = m.qualityRecord(s.st, { picked: { label: '1080p60', height: null, checked: false } }, 1_000_000).st;
  assert.equal(m.qualityStep(st, obs({ quality: 'source', now: 1_003_000, videoHeight: 480 })).action, 'resolved');
  s = m.qualityStep(null, obs());
  st = m.qualityRecord(s.st, { picked: { label: '1080p60 (Source)', height: 1080, checked: false } }, 1_000_000).st;
  assert.equal(m.qualityStep(st, obs({ now: 1_003_000, videoHeight: 1080 })).action, 'resolved');
});

test('qualityRecord logs only the first failure per channel', () => {
  const st0 = m.qualityStep(null, obs()).st;
  const a = m.qualityRecord(st0, { fail: 'settings button not found' }, 1);
  assert.match(a.log, /^Could not set 160p on \/chan \(settings button not found\); will retry a few times\.$/);
  const b = m.qualityRecord(a.st, { fail: 'settings button not found' }, 2);
  assert.equal(b.log, '');
  assert.equal(m.qualityRecord(a.st, undefined, 3).st.lastFail, 'unknown error');
});

// ------------------------------------------------------------ Kick theater

test('theaterStep never clicks a button that already says theater is on (F45)', () => {
  const r = m.theaterStep(null, { found: true, on: true, sig: 'exit theater mode' });
  assert.equal(r.action, 'latched');
  assert.equal(r.st.clicks, 0);
});

test('theaterStep latches only after a later tick shows the click changed something', () => {
  let r = m.theaterStep(null, { found: true, on: false, sig: 'a' });
  assert.equal(r.action, 'click');
  r = m.theaterStep(r.st, { found: true, on: false, sig: 'b' });
  assert.equal(r.action, 'latched');
  assert.equal(m.theaterStep(r.st, { found: true, on: false, sig: 'c' }).action, 'idle');
});

test('theaterStep stops after 5 clicks that change nothing', () => {
  let st = null;
  const actions = [];
  for (let i = 0; i < 50; i++) {
    const r = m.theaterStep(st, { found: true, on: false, sig: 'same' });
    st = r.st;
    actions.push(r.action);
  }
  assert.equal(actions.filter(a => a === 'click').length, 5);
  assert.equal(actions.filter(a => a === 'gaveup').length, 1);
  assert.equal(m.theaterStep(null, { found: false, on: false, sig: '' }).action, 'idle');
});

test('altTStep: one synthetic press once a video exists, then asks that slow down but never stop (F42)', () => {
  let st = null;
  const tick = (video, now) => {
    const prev = st;
    const r = m.altTStep(st, { video, now });
    if (prev) assert.notEqual(r.st, prev, 'state is copied, not mutated');
    st = r.st;
    return (r.synthetic ? 'press' : '') + (r.request ? 'ask' : '') || '-';
  };
  assert.equal(tick(false, 0), '-', 'no video: nothing to press yet');
  assert.equal(tick(true, 3000), 'press');
  const fast = [6000, 9000, 12000, 15000, 18000].map(t => tick(true, t));
  assert.deepEqual(fast, ['ask', 'ask', 'ask', 'ask', 'ask']);
  assert.equal(tick(true, 21000), '-');
  assert.equal(tick(true, 47999), '-');
  assert.equal(tick(true, 48000), 'ask');
  assert.equal(tick(false, 78000), '-', 'the player lost its video');
  assert.equal(tick(true, 81000), 'ask');
  // A day later it still asks, twice a minute, and never presses again.
  const day = [];
  for (let t = 84000; t <= 84000 + 24 * 3600000; t += 3000) day.push(tick(true, t));
  assert.equal(day.includes('press'), false);
  assert.equal(day.filter(a => a === 'ask').length, 2 * 24 * 60);
});

// ------------------------------------------------------------ directClick

function clickHarness(extra = {}) {
  const page = makePage({ host: 'kick.com' });
  Object.assign(page.ctx, extra);
  const directClick = page.run(`(${m.directClick.toString()})`);
  return { page, doc: page.doc, directClick };
}

test('directClick fires exactly one click, after down/up, at the element centre (F45)', () => {
  const { doc, directClick } = clickHarness();
  const btn = doc.body.appendChild(doc.el('button', { 'aria-label': 'Theater mode' }, '', { left: 100, top: 40, width: 30, height: 20 }));
  const seen = [];
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) btn.addEventListener(t, ev => seen.push([t, ev.clientX, ev.clientY]));
  let toggles = 0;
  btn.addEventListener('click', () => { toggles++; });
  directClick(btn);
  assert.deepEqual(seen.map(s => s[0]), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  assert.ok(seen.every(s => s[1] === 115 && s[2] === 50), JSON.stringify(seen));
  // Two clicks per call turned every toggle into a no-op.
  assert.equal(toggles, 1);
});

test('directClick retargets only to a semantic control', () => {
  const { doc, directClick } = clickHarness();
  const item = doc.body.appendChild(doc.el('div', { role: 'menuitemradio' }, '', { left: 0, top: 0, width: 80, height: 20 }));
  const span = item.appendChild(doc.el('span', {}, '720p60', { left: 5, top: 5, width: 40, height: 10 }));
  directClick(span);
  assert.equal(item.counts.click, 1);
  assert.equal(span.counts.click || 0, 0);
});

test('directClick no longer lands on a Tailwind wrapper above the option', () => {
  const { doc, directClick } = clickHarness();
  // <div class="pointer-events-auto"> <div class="flex" onClick> <span>160p30</span>
  const list = doc.body.appendChild(doc.el('div', { class: 'menu-list pointer-events-auto cursor-pointer btn-group' }, '', { left: 0, top: 0, width: 200, height: 200 }));
  const row = list.appendChild(doc.el('div', { class: 'flex items-center' }, '', { left: 0, top: 0, width: 200, height: 20 }));
  const span = row.appendChild(doc.el('span', {}, '160p30', { left: 0, top: 0, width: 50, height: 20 }));
  let picked = 0;
  row.addEventListener('click', () => { picked++; });
  directClick(span);
  // The old [class*="pointer"]/[class*="btn"] retarget fired on `list`, above
  // the row, so the row's handler never ran.
  assert.equal(picked, 1);
  assert.equal(span.counts.click, 1);
  assert.equal(list.counts.click || 0, 0);
});

test('directClick falls back to one el.click() when synthetic events are unavailable', () => {
  const { doc, directClick } = clickHarness({ PointerEvent: function () { throw new Error('no PointerEvent'); } });
  const btn = doc.body.appendChild(doc.el('button', {}, 'x', { left: 0, top: 0, width: 10, height: 10 }));
  let clicks = 0;
  btn.addEventListener('click', () => { clicks++; });
  directClick(btn);
  assert.equal(clicks, 1);
  directClick(null);
});

test('every helper survives toString() serialization into the page script', async () => {
  const page = makePage({ host: 'example.com' });
  for (const name of ['parseRendition', 'pickRendition', 'isQualityLabel', 'qualityStep', 'qualityRecord', 'theaterStep', 'altTStep', 'directClick']) {
    const fn = page.run(`(${m[name].toString()})`);
    assert.equal(typeof fn, 'function', name);
  }
  const pick = page.run(`(function(){ const parseRendition = ${m.parseRendition.toString()}; return ${m.pickRendition.toString()}; })()`);
  assert.equal(pick(['Auto', '480p', '160p'], '160p'), 2);
  for (const q of ['160p', '360p', '480p', '720p', 'source']) {
    assert.doesNotThrow(() => new (require('node:vm').Script)(m.qualityAndTheaterScript(q)), q);
  }
});
