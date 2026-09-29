// The 1-click login panel in Platform Logins (src/login.js with the wording in
// src/extension-status.js), run on the fake DOM:
//   F17   "New code" replaces the pairing code after a confirm and shows the
//         new one at once; "Copy" puts the code (never the dash) on the clipboard
//   G2.4  a receiver that could not bind any port says why
//   F82   a folder that failed to open is reported with its path
//   F96   the extension's last automatic sync is shown, with a warning when a
//         platform's latest attempt failed or a wrong pairing code was refused
//         (get-extension-info's autoSync and codeRejectedAt; lastAutoSync alone
//         hid a failure behind the next platform's success)
//   C1    a code from before 32 characters gets a note whose first step is
//         reloading the extension (the old copy's field cuts a new code short)
// Run: node --test test/renderer-handoff-login-panel.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ── Wording (pure) ───────────────────────────────────────────────────────────

test('timeAgo', async () => {
  const { timeAgo } = await load('src/extension-status.js');
  assert.equal(timeAgo(0), 'just now');
  assert.equal(timeAgo(59_999), 'just now');
  assert.equal(timeAgo(-5000), 'just now', 'a clock skewed into the future');
  assert.equal(timeAgo(NaN), 'just now');
  assert.equal(timeAgo(60_000), '1 min ago');
  assert.equal(timeAgo(59 * 60_000), '59 min ago');
  assert.equal(timeAgo(60 * 60_000), '1 h ago');
  assert.equal(timeAgo(47 * 3600_000), '47 h ago');
  assert.equal(timeAgo(48 * 3600_000), '2 days ago');
});

test('G2.4: receiverStatus says why nothing is listening', async () => {
  const { receiverStatus } = await load('src/extension-status.js');
  assert.deepEqual(receiverStatus({ port: 47101 }), { text: '· receiver active (port 47101)', tone: 'ok' });
  assert.deepEqual(receiverStatus({ port: 0, receiverError: '' }), { text: '· receiver not started', tone: 'muted' });
  assert.deepEqual(receiverStatus(undefined), { text: '· receiver not started', tone: 'muted' });
  const r = receiverStatus({ port: 0, receiverError: 'No port could be opened (47100 EACCES, 47101 EACCES).' });
  assert.equal(r.tone, 'error');
  assert.match(r.text, /^· receiver not running: No port could be opened \(47100 EACCES, 47101 EACCES\)\. /);
  assert.match(r.text, /keeps retrying/);
  assert.ok(receiverStatus({ port: 0, receiverError: 'x'.repeat(5000) }).text.length < 400, 'capped');
  assert.equal(receiverStatus({ port: '47100' }).tone, 'ok');
  assert.equal(receiverStatus({ port: -1 }).tone, 'muted');
});

test('F96: lastSyncNotice', async () => {
  const { lastSyncNotice } = await load('src/extension-status.js');
  const now = 1_780_000_000_000;
  assert.equal(lastSyncNotice(undefined, now), null, 'an app that does not report it yet');
  assert.equal(lastSyncNotice(null, now), null);
  assert.equal(lastSyncNotice({ at: 'soon', ok: true }, now), null);
  assert.equal(lastSyncNotice({ at: 0, ok: true }, now), null);
  assert.deepEqual(lastSyncNotice({ at: now - 5 * 60_000, platform: 'youtube', ok: true }, now),
    { text: 'Extension last synced YouTube 5 min ago.', warn: false });
  const bad = lastSyncNotice({ at: now - 3 * 3600_000, platform: 'twitch', ok: false, error: 'Invalid pairing code' }, now);
  assert.equal(bad.warn, true);
  assert.equal(bad.text, "The extension's last automatic sync of Twitch failed 3 h ago: Invalid pairing code. If the pairing code changed, paste the current one into the extension.");
  // A platform off the allowlist is never echoed.
  assert.match(lastSyncNotice({ at: now, platform: '<b>x</b>', ok: true }, now).text, /synced an account just now/);
  assert.match(lastSyncNotice({ at: now, platform: 'constructor', ok: true }, now).text, /an account/);
  assert.match(lastSyncNotice({ at: now, platform: 'kick', ok: false }, now).text, /Kick failed just now\. If/);
  // main's own messages end in a full stop; no second one is added.
  assert.match(lastSyncNotice({ at: now, platform: 'kick', ok: false, error: 'Invalid pairing code. Copy the code shown in Stream Lurker into the extension.' }, now).text,
    /into the extension\. If the pairing/);
});

test('F82: folderOpenFailure', async () => {
  const { folderOpenFailure } = await load('src/extension-status.js');
  assert.equal(folderOpenFailure({ success: true, path: 'C:\\x' }), null);
  assert.equal(folderOpenFailure(undefined), null, 'an older main answered nothing');
  assert.equal(folderOpenFailure({ success: false, error: 'The extension folder is missing. Reinstall Stream Lurker to restore it.', path: 'C:\\Program Files\\Stream Lurker\\resources\\extension' }),
    'Could not open the extension folder (The extension folder is missing. Reinstall Stream Lurker to restore it.). Folder: C:\\Program Files\\Stream Lurker\\resources\\extension');
  assert.equal(folderOpenFailure({ success: false }), 'Could not open the extension folder (unknown error).');
});

// ── Wired into the page ──────────────────────────────────────────────────────

const doc = createDocument();
doc.add('div', 'console-logs');
const code = doc.add('code', 'ext-pairing-code');
const conn = doc.add('span', 'ext-conn-status');
const folderBtn = doc.add('button', 'ext-open-folder');
const copyBtn = doc.add('button', 'ext-copy-code');
const newBtn = doc.add('button', 'ext-new-code');
const note = doc.add('p', 'ext-panel-note', 'ext-note hidden');
const sync = doc.add('p', 'ext-sync-status', 'ext-sync hidden');
const loginsNav = doc.add('button', null, 'nav-btn');
loginsNav.setAttribute('data-tab', 'logins');
globalThis.document = doc;

let info;
let confirmAnswer = true;
const calls = [];
const api = {
  onLoginSuccess() {},
  onSessionExpired() {},
  getExtensionInfo: () => { calls.push('getExtensionInfo'); return typeof info === 'function' ? info() : Promise.resolve(info); },
};
const clipboard = [];
globalThis.window = { api, confirm: (msg) => { calls.push(['confirm', msg]); return confirmAnswer; } };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({ clipboard: { writeText: async (t) => { clipboard.push(t); } } }),
});

const CODE = '0123456789ABCDEF0123456789ABCDEF';
test.before(async () => {
  const { state } = await load('src/state.js');
  state.currentConfig = { accounts: {} };
  info = { pairingCode: CODE, port: 0, receiverError: 'No port could be opened (47100 EACCES).', extensionPath: 'C:\\ext' };
  const login = await load('src/login.js');
  login.setupLoginPortalListeners();
  await flush();
});

test('G2.4: the panel shows the code and why the receiver is down', () => {
  assert.equal(code.textContent, CODE);
  assert.equal(code.dataset.code, CODE);
  assert.match(conn.textContent, /receiver not running: No port could be opened \(47100 EACCES\)\./);
  assert.equal(conn.style.color, '#ef4444');
  assert.ok(sync.classList.contains('hidden'), 'no sync line until main reports one');
});

test('F96: opening Platform Logins re-reads the info; a failed last sync is a warning', async () => {
  const now = Date.now();
  info = { pairingCode: CODE, port: 47100, receiverError: '', lastAutoSync: { at: now - 10 * 60_000, platform: 'youtube', ok: false, error: 'Invalid pairing code' } };
  await loginsNav.dispatch('click');
  await flush();
  assert.equal(conn.textContent, '· receiver active (port 47100)');
  assert.ok(!sync.classList.contains('hidden'));
  assert.ok(sync.classList.contains('warn'));
  assert.match(sync.textContent, /last automatic sync of YouTube failed 10 min ago: Invalid pairing code/);

  info = { ...info, lastAutoSync: { at: now, platform: 'kick', ok: true } };
  await loginsNav.dispatch('click');
  await flush();
  assert.ok(!sync.classList.contains('warn'));
  assert.equal(sync.textContent, 'Extension last synced Kick just now.');

  // A failed read leaves what is shown alone.
  info = () => Promise.reject(new Error('IPC gone'));
  await loginsNav.dispatch('click');
  await flush();
  assert.equal(code.textContent, CODE);
  assert.equal(sync.textContent, 'Extension last synced Kick just now.');
});

test('F96: the panel reads autoSync and codeRejectedAt, not only lastAutoSync', async () => {
  const now = Date.now();
  // One pass: YouTube failed, then Kick succeeded and became lastAutoSync.
  info = {
    pairingCode: CODE,
    port: 47100,
    lastAutoSync: { at: now - 5_000, platform: 'kick', ok: true, error: '' },
    autoSync: {
      youtube: { at: now - 10_000, ok: false, error: 'No YouTube login cookies were found in the browser.' },
      kick: { at: now - 5_000, ok: true, error: '' },
    },
    codeRejectedAt: 0,
  };
  await loginsNav.dispatch('click');
  await flush();
  assert.ok(sync.classList.contains('warn'));
  assert.match(sync.textContent, /last automatic sync of YouTube failed just now: No YouTube login cookies/);

  // Every platform fine, then an import refused for its code.
  info = { ...info, autoSync: { ...info.autoSync, youtube: { at: now - 10_000, ok: true, error: '' } }, codeRejectedAt: now - 2_000 };
  await loginsNav.dispatch('click');
  await flush();
  assert.ok(sync.classList.contains('warn'));
  assert.match(sync.textContent, /^An import with a wrong pairing code was refused just now\./);

  info = { ...info, codeRejectedAt: 0 };
  await loginsNav.dispatch('click');
  await flush();
  assert.ok(!sync.classList.contains('warn'));
  assert.equal(sync.textContent, 'Extension last synced Kick just now.');
});

test('F17: Copy puts the code on the clipboard', async () => {
  clipboard.length = 0;
  await copyBtn.dispatch('click');
  assert.deepEqual(clipboard, [CODE]);
  assert.equal(note.textContent, 'Pairing code copied. Paste it into the extension.');
  assert.ok(!note.classList.contains('hidden'));
});

test('F17: New code asks first, and a "no" changes nothing', async () => {
  calls.length = 0;
  confirmAnswer = false;
  api.rotatePairingCode = () => { calls.push('rotate'); return Promise.resolve({ pairingCode: 'NEVER' }); };
  await newBtn.dispatch('click');
  assert.equal(calls.filter(c => c === 'rotate').length, 0);
  assert.match(calls[0][1], /stops syncing your logins until you paste the new code/);
  assert.equal(code.textContent, CODE);
});

test('F17: New code shows the new code at once, and a slow older read cannot bring the old one back', async () => {
  confirmAnswer = true;
  const NEW = 'FEDCBA9876543210FEDCBA9876543210';
  // A tab-open read is still in flight when the code is replaced.
  let answerOld;
  info = () => new Promise(r => { answerOld = () => r({ pairingCode: CODE, port: 47100 }); });
  await loginsNav.dispatch('click');
  api.rotatePairingCode = () => Promise.resolve({ pairingCode: NEW });
  await newBtn.dispatch('click');
  assert.equal(code.textContent, NEW);
  assert.equal(code.dataset.code, NEW);
  assert.match(note.textContent, /New pairing code created\. Paste it into the extension/);
  assert.ok(note.classList.contains('warn'));
  assert.equal(newBtn.disabled, false);
  answerOld();
  await flush();
  assert.equal(code.textContent, NEW, 'the stale read did not win');

  clipboard.length = 0;
  await copyBtn.dispatch('click');
  assert.deepEqual(clipboard, [NEW]);
});

test('F17: a failed rotation says so and keeps the button usable', async () => {
  const before = code.textContent;
  api.rotatePairingCode = () => Promise.reject(new Error('disk full'));
  await newBtn.dispatch('click');
  assert.equal(note.textContent, 'Could not create a new pairing code (disk full).');
  assert.ok(note.classList.contains('error'));
  assert.equal(code.textContent, before);
  assert.equal(newBtn.disabled, false);
  api.rotatePairingCode = () => Promise.resolve({});
  await newBtn.dispatch('click');
  assert.equal(note.textContent, 'Could not create a new pairing code (the app returned no code).');
});

test('F82: Open Extension Folder shows main\'s failure and the path', async () => {
  api.openExtensionFolder = () => Promise.resolve({ success: false, error: 'The extension folder is missing. Reinstall Stream Lurker to restore it.', path: 'C:\\SL\\resources\\extension' });
  await folderBtn.dispatch('click');
  assert.equal(note.textContent, 'Could not open the extension folder (The extension folder is missing. Reinstall Stream Lurker to restore it.). Folder: C:\\SL\\resources\\extension');
  assert.ok(note.classList.contains('error'));
  assert.equal(folderBtn.disabled, false);

  api.openExtensionFolder = () => Promise.resolve({ success: true, path: 'C:\\SL\\resources\\extension' });
  await folderBtn.dispatch('click');
  assert.ok(note.classList.contains('hidden'), 'a success clears the old error');

  api.openExtensionFolder = () => Promise.reject(new Error('IPC gone'));
  await folderBtn.dispatch('click');
  assert.equal(note.textContent, 'Could not open the extension folder (IPC gone).');
  assert.equal(folderBtn.disabled, false);
});

test('F17: with no code to show, Copy copies nothing', async () => {
  info = { pairingCode: '', port: 47100 };
  await loginsNav.dispatch('click');
  await flush();
  assert.equal(code.textContent, '—');
  clipboard.length = 0;
  await copyBtn.dispatch('click');
  assert.deepEqual(clipboard, []);
});

// ── C1: codes from before 32 characters ──────────────────────────────────────
// Connector 1.3 refuses a code under 32 characters. The copy of the extension
// a browser still runs after the app updated is 1.2 until it is reloaded, and
// 1.2's code field keeps 16 characters: a new code pasted there is cut short
// and refused ("Invalid pairing code"), so the advice must start with the reload.

function clearNote() {
  note.textContent = '';
  note.className = 'ext-note hidden';
}
async function openLogins(pairingCode) {
  info = { pairingCode, port: 47100 };
  await loginsNav.dispatch('click');
  await flush();
}

test('C1: an 8-character code shows a note that starts with reloading the extension', async () => {
  clearNote();
  await openLogins('ABCD1234');
  assert.equal(code.textContent, 'ABCD1234');
  assert.ok(!note.classList.contains('hidden'));
  assert.ok(note.classList.contains('warn'));
  const text = note.textContent;
  assert.match(text, /from an older version/);
  assert.match(text, /reload Stream Lurker Connector on your browser's Extensions page/);
  assert.match(text, /version 1\.3 or later/);
  assert.ok(text.indexOf('reload') < text.indexOf('New code'), `reload comes before New code: ${text}`);

  // Any code short of 32 characters is one connector 1.3 refuses.
  clearNote();
  await openLogins('A'.repeat(31));
  assert.match(note.textContent, /reload Stream Lurker Connector/);
});

test('C1: a 32-character code shows no note', async () => {
  clearNote();
  await openLogins(CODE);
  assert.equal(code.textContent, CODE);
  assert.equal(note.textContent, '');
  assert.ok(note.classList.contains('hidden'));
  await openLogins('F'.repeat(64));
  assert.equal(note.textContent, '');
});

test('C1: the short-code note never replaces a message already shown', async () => {
  clearNote();
  api.openExtensionFolder = () => Promise.resolve({ success: false, error: 'The extension folder is missing.', path: 'C:\\SL\\resources\\extension' });
  await folderBtn.dispatch('click');
  const shown = note.textContent;
  assert.match(shown, /^Could not open the extension folder/);
  await openLogins('ABCD1234');
  assert.equal(note.textContent, shown);
  assert.ok(note.classList.contains('error'), 'tone kept too');
});

test('C1: the New code confirm says to reload an extension that predates the update first', async () => {
  calls.length = 0;
  confirmAnswer = false;
  api.rotatePairingCode = () => { calls.push('rotate'); return Promise.resolve({ pairingCode: 'NEVER' }); };
  await newBtn.dispatch('click');
  const msg = calls.find(c => Array.isArray(c) && c[0] === 'confirm')[1];
  assert.match(msg, /stops syncing your logins until you paste the new code/);
  assert.match(msg, /reload Stream Lurker Connector on your browser's Extensions page first/);
  assert.match(msg, /cannot hold the new, longer code/);
  assert.equal(calls.filter(c => c === 'rotate').length, 0);
});
