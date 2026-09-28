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
// synchronously (webview not attached).
function fakeCell(username, { mode = 'ok', answer = false, crashed = false, loading = false, attached = true, connected = true } = {}) {
  const calls = [];
  let settle = null;
  const webview = {
    isConnected: connected,
    isCrashed() { if (!attached) throw new Error('The WebView must be attached to the DOM'); return crashed; },
    isLoadingMainFrame() { if (!attached) throw new Error('The WebView must be attached to the DOM'); return loading; },
    executeJavaScript(code) {
      calls.push(code);
      if (mode === 'throw') throw new Error('The WebView must be attached to the DOM');
      if (mode === 'reject') return Promise.reject(new Error('Script failed to execute'));
      if (mode === 'hang') return new Promise(resolve => { settle = resolve; });
      return Promise.resolve(answer);
    },
  };
  const cell = {
    isConnected: connected,
    dataset: { username },
    querySelector: (sel) => (sel === 'webview' ? webview : null),
  };
  return { cell, webview, calls, finish: (v) => settle && settle(v) };
}

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
