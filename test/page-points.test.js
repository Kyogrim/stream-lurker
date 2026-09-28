// Channel-points claiming: the poller in src/points.js (F41) and the claim
// script it injects, autoClaimPointsScript in src/inject.js (F48).
// Run: node --test test/page-points.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage } = require('./page-fake-dom');

let points, inject, state;
test.before(async () => {
  inject = await import('../src/inject.js');
  ({ state } = await import('../src/state.js'));
  points = await import('../src/points.js');
});
test.beforeEach(() => { state.currentConfig = { autoClaimPoints: true }; });

// ------------------------------------------------------ the claim script

function twitchChannelPage({ chest = true, disabled = false, withSummary = true } = {}) {
  const page = makePage({ host: 'www.twitch.tv', pathname: '/somechannel' });
  const { doc } = page;
  const clicks = [];
  const track = (el, name) => { el.addEventListener('click', () => clicks.push(name)); return el; };
  // Generic secondary buttons sit before the chest in document order (header,
  // channel info): the old selector list clicked the first of these.
  track(doc.body.appendChild(doc.el('button', { class: 'tw-button-restyle--secondary' }, 'Follow')), 'follow');
  track(doc.body.appendChild(doc.el('button', { class: 'tw-button-restyle--secondary' }, 'Subscribe')), 'subscribe');
  const chat = doc.body.appendChild(doc.el('div', { class: 'chat-input' }));
  const summary = chat.appendChild(doc.el('div', withSummary ? { class: 'community-points-summary' } : {}));
  track(summary.appendChild(doc.el('button', { 'aria-label': 'Bits' }, 'Bits')), 'bits');
  if (chest) {
    const btn = track(summary.appendChild(doc.el('button', { 'aria-label': 'Bonus abholen' })), 'chest');
    btn.disabled = disabled;
    btn.appendChild(doc.el('div', { class: 'claimable-bonus__icon tw-flex' }));
  }
  return { ...page, clicks };
}

test('claims the chest, never the secondary buttons ahead of it (F48)', () => {
  const p = twitchChannelPage();
  assert.equal(p.run(inject.autoClaimPointsScript()), true);
  assert.deepEqual(p.clicks, ['chest']);
});

test('with no chest it clicks nothing and reports false (F48)', () => {
  const p = twitchChannelPage({ chest: false });
  assert.equal(p.run(inject.autoClaimPointsScript()), false);
  assert.deepEqual(p.clicks, []);
});

test('the class hook works in any locale and without the summary wrapper', () => {
  const p = twitchChannelPage({ withSummary: false });
  assert.equal(p.run(inject.autoClaimPointsScript()), true);
  assert.deepEqual(p.clicks, ['chest']);
});

test('a disabled chest button is left alone', () => {
  const p = twitchChannelPage({ disabled: true });
  assert.equal(p.run(inject.autoClaimPointsScript()), false);
  assert.deepEqual(p.clicks, []);
});

test('the aria-label fallback only ever clicks a button', () => {
  const p = makePage({ host: 'www.twitch.tv', pathname: '/x' });
  const clicks = [];
  const div = p.doc.body.appendChild(p.doc.el('div', { 'aria-label': 'Claim Bonus' }));
  div.addEventListener('click', () => clicks.push('div'));
  assert.equal(p.run(inject.autoClaimPointsScript()), false);
  const btn = p.doc.body.appendChild(p.doc.el('button', { 'aria-label': 'Claim Bonus' }));
  btn.addEventListener('click', () => clicks.push('button'));
  assert.equal(p.run(inject.autoClaimPointsScript()), true);
  assert.deepEqual(clicks, ['button']);
});

// ----------------------------------------------------------- the poller

// A Twitch cell as pollOnce sees it. mode: 'ok' answers `answer`, 'hang'
// never settles (crashed or hung guest), 'reject' fails, 'throw' throws
// synchronously (webview not attached). `guest` is live: tests flip crashed,
// loading or mode mid-test the way a crash and a reload would. emit() fires a
// webview event such as 'render-process-gone' at whatever is listening, with
// the fields the real event carries in detail.
function fakeCell(username, { mode = 'ok', answer = false, crashed = false, loading = false, attached = true, connected = true } = {}) {
  const guest = { mode, answer, crashed, loading, attached };
  const calls = [];
  const settles = [];
  const listeners = new Map();
  const webview = {
    isConnected: connected,
    isCrashed() { if (!guest.attached) throw new Error('The WebView must be attached to the DOM'); return guest.crashed; },
    isLoadingMainFrame() { if (!guest.attached) throw new Error('The WebView must be attached to the DOM'); return guest.loading; },
    executeJavaScript(code) {
      calls.push(code);
      if (guest.mode === 'throw') throw new Error('The WebView must be attached to the DOM');
      if (guest.mode === 'reject') return Promise.reject(new Error('Script failed to execute'));
      if (guest.mode === 'hang') return new Promise(resolve => { settles.push(resolve); });
      return Promise.resolve(guest.answer);
    },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); },
  };
  const cell = {
    isConnected: connected,
    dataset: { username },
    querySelector: (sel) => (sel === 'webview' ? webview : null),
  };
  return {
    cell, webview, calls, guest,
    // Settles the i-th hung call (default: the latest).
    finish: (v, i = settles.length - 1) => settles[i] && settles[i](v),
    emit: (type, detail = {}) => { for (const fn of (listeners.get(type) || []).slice()) fn({ type, ...detail }); },
    listenerCount: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
}

// The 'did-start-navigation' fields of a reload, or a new page, in the cell.
const NEW_DOCUMENT = { url: 'https://www.twitch.tv/somechannel', isMainFrame: true, isInPlace: false };

test('a hung cell no longer blocks the cells after it (F41)', async () => {
  const dead = fakeCell('dead', { mode: 'hang' });
  const a = fakeCell('alpha', { answer: true });
  const b = fakeCell('beta', { answer: false });
  const log = [];
  const t0 = Date.now();
  await points.pollOnce({ cells: [dead.cell, a.cell, b.cell], timeoutMs: 50, log: (m) => log.push(m) });
  assert.ok(Date.now() - t0 < 1000, 'the poll returned despite the hung call');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.deepEqual(log.sort(), [
    '[Points - dead] Polling process error: no answer from the page after 0.05s',
    '[Rewards - alpha] Claimed channel points chest!',
  ]);
});

test('pending calls into a hung cell never grow past one (F41)', async () => {
  const dead = fakeCell('dead', { mode: 'hang' });
  const live = fakeCell('live', { answer: false });
  const log = [];
  for (let i = 0; i < 25; i++) {
    await points.pollOnce({ cells: [dead.cell, live.cell], timeoutMs: 20, log: (m) => log.push(m) });
  }
  assert.equal(dead.calls.length, 1, 'one stuck call, not one per poll');
  assert.equal(live.calls.length, 25, 'the live cell is claimed every poll');
  assert.equal(log.length, 1, 'the stuck cell is reported once');
  // When the guest finally answers, it is polled again.
  dead.finish(false);
  await new Promise(r => setImmediate(r));
  await points.pollOnce({ cells: [dead.cell], timeoutMs: 20, log: () => {} });
  assert.equal(dead.calls.length, 2);
});

test('crashed, loading, detached and unattached guests are skipped without a call (F41)', async () => {
  const cells = [
    fakeCell('crashed', { crashed: true }),
    fakeCell('loading', { loading: true }),
    fakeCell('gone', { connected: false }),
    fakeCell('unattached', { attached: false }),
  ];
  await points.pollOnce({ cells: cells.map(c => c.cell), timeoutMs: 20, log: () => {} });
  for (const c of cells) assert.equal(c.calls.length, 0, c.cell.dataset.username);
});

test('a cell multi-lurk.js flagged as crashed is skipped until the flag clears (F15, F41)', async () => {
  // A failed load: Chromium's error page is alive and done loading, so only
  // the cell's flag says there is nothing to claim on it.
  const failed = fakeCell('failed');
  failed.cell.dataset.crashed = 'true';
  const healthy = fakeCell('healthy');
  await points.pollOnce({ cells: [failed.cell, healthy.cell], timeoutMs: 20, log: () => {} });
  assert.equal(failed.calls.length, 0);
  assert.equal(healthy.calls.length, 1);
  // Recovered: multi-lurk.js deletes the flag once a platform page loads.
  delete failed.cell.dataset.crashed;
  await points.pollOnce({ cells: [failed.cell], timeoutMs: 20, log: () => {} });
  assert.equal(failed.calls.length, 1);
});

test('a call left hanging by a guest crash does not stop claims after the cell recovers (F41)', async () => {
  // Both cells have a call in flight when their guest renderer dies; that
  // call is never answered. multi-lurk.js flags the cell, reloads the same
  // <webview> and clears the flag once a platform page is up again. Only the
  // first cell's webview reports that through its events; the second is the
  // control: with no event, its hung call still holds it.
  const phoenix = fakeCell('phoenix', { mode: 'hang' });
  const control = fakeCell('control', { mode: 'hang' });
  const both = [phoenix, control];
  const poll = () => points.pollOnce({ cells: both.map(c => c.cell), timeoutMs: 20, log: () => {} });
  await poll();

  for (const c of both) { c.guest.crashed = true; c.cell.dataset.crashed = 'true'; }
  phoenix.emit('render-process-gone');
  await poll();
  for (const c of both) assert.equal(c.calls.length, 1, `${c.cell.dataset.username}: nothing is sent into a dead guest`);

  for (const c of both) { c.guest.crashed = false; c.guest.loading = true; c.guest.mode = 'ok'; }
  // A reload fires both; the main-frame navigation is what releases.
  phoenix.emit('did-start-navigation', NEW_DOCUMENT);
  phoenix.emit('did-start-loading');
  await poll();
  for (const c of both) assert.equal(c.calls.length, 1, `${c.cell.dataset.username}: nothing is sent into a loading page`);

  for (const c of both) { c.guest.loading = false; delete c.cell.dataset.crashed; }
  for (let i = 0; i < 3; i++) await poll();
  assert.equal(phoenix.calls.length, 4, 'the recovered cell is claimed on every poll again');
  assert.equal(control.calls.length, 1, 'without a crash or load event the hung call still holds the cell');
  assert.equal(phoenix.listenerCount(), 0, 'release removes its listeners');
});

test('each page-lifetime event releases a hung call, and only once (F41)', async () => {
  for (const [type, detail] of [['render-process-gone'], ['did-start-navigation', NEW_DOCUMENT], ['destroyed']]) {
    const c = fakeCell(type, { mode: 'hang' });
    const poll = () => points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
    await poll();
    c.emit(type, detail);
    await poll();
    assert.equal(c.calls.length, 2, `${type} releases the hold`);
    // The first page answers late. That must not free the call made into the
    // new page, or a stuck new page would get a call every 30 s again.
    c.finish(false, 0);
    await new Promise(r => setImmediate(r));
    for (let i = 0; i < 5; i++) await poll();
    assert.equal(c.calls.length, 2, `${type}: a late answer from the old page leaves the new hold alone`);
    c.finish(false, 1);
    await new Promise(r => setImmediate(r));
    await poll();
    assert.equal(c.calls.length, 3, `${type}: the new call's own answer releases it`);
  }
});

test('frame activity that keeps the page does not release a hung call', async () => {
  // did-start-loading fires when any frame starts loading: every ad or embed
  // load in a hung page used to release the hold and let one more
  // never-answered call through, each with a reply listener pending in main.
  const c = fakeCell('hung', { mode: 'hang' });
  const poll = () => points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
  await poll();
  const keepsPage = [
    ['did-start-loading'],
    ['did-start-navigation', { url: 'https://ads.example/frame', isMainFrame: false, isInPlace: false }],
    ['did-start-navigation', { url: 'https://www.twitch.tv/raidtarget', isMainFrame: true, isInPlace: true }],
  ];
  for (let i = 0; i < 20; i++) {
    for (const [type, detail] of keepsPage) c.emit(type, detail);
    await poll();
  }
  assert.equal(c.webview.isLoadingMainFrame(), false, 'the main frame never started loading');
  assert.equal(c.calls.length, 1, 'still the one stuck call');
  // A new document in the main frame does end the page.
  c.emit('did-start-navigation', NEW_DOCUMENT);
  await poll();
  assert.equal(c.calls.length, 2);
});

test('a navigation event without its frame fields releases rather than holding for good', async () => {
  // A hold that is never released skips the cell for good (F41); an early
  // release costs one pending call.
  const c = fakeCell('bare', { mode: 'hang' });
  const poll = () => points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
  await poll();
  c.emit('did-start-navigation');
  await poll();
  assert.equal(c.calls.length, 2);
});

test('a healthy cell polled all day leaves no listeners behind (F41)', async () => {
  const c = fakeCell('steady');
  for (let i = 0; i < 200; i++) await points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
  assert.equal(c.calls.length, 200);
  assert.equal(c.listenerCount(), 0);
});

test('one round trip per cell: the claim script is sent, no separate cookie probe', async () => {
  const c = fakeCell('alpha');
  await points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
  assert.deepEqual(c.calls, [inject.autoClaimPointsScript()]);
});

test('a rejected or throwing call is logged and does not stop the others', async () => {
  const bad = fakeCell('bad', { mode: 'reject' });
  const unattached = fakeCell('odd', { mode: 'throw' });
  const good = fakeCell('good', { answer: true });
  const log = [];
  await points.pollOnce({ cells: [bad.cell, unattached.cell, good.cell], timeoutMs: 20, log: (m) => log.push(m) });
  assert.ok(log.includes('[Points - bad] Polling process error: Script failed to execute'));
  assert.ok(log.includes('[Points - odd] Polling process error: The WebView must be attached to the DOM'));
  assert.ok(log.includes('[Rewards - good] Claimed channel points chest!'));
  // A rejected call settled, so that cell is polled again next time.
  await points.pollOnce({ cells: [bad.cell], timeoutMs: 20, log: () => {} });
  assert.equal(bad.calls.length, 2);
});

test('nothing runs without a config or with auto-claim off', async () => {
  const c = fakeCell('alpha');
  state.currentConfig = null;
  await points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
  state.currentConfig = { autoClaimPoints: false };
  await points.pollOnce({ cells: [c.cell], timeoutMs: 20, log: () => {} });
  assert.equal(c.calls.length, 0);
});

test('pollTick runs one poll at a time and releases the flag after a hang times out', async () => {
  const dead = fakeCell('dead', { mode: 'hang' });
  const live = fakeCell('live');
  const opts = { cells: [dead.cell, live.cell], timeoutMs: 40, log: () => {} };
  const first = points.pollTick(opts);
  assert.equal(await points.pollTick(opts), false, 'overlapping tick is skipped');
  assert.equal(await first, true);
  assert.equal(await points.pollTick(opts), true, 'the flag was released');
  assert.equal(live.calls.length, 2);
});
