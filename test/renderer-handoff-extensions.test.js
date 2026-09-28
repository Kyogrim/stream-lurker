// The Extensions tab, run as the real src/extensions.js on the fake DOM:
//   G4.10 a configured folder main could not reach is labelled
//         "Unavailable (drive not found)" instead of "Active", and stays
//         removable; main never drops it
//   F69   catalog Install/Remove buttons always come back, uninstall's
//         "files left behind" warning is shown, and the copy says what now
//         happens (unloaded at once) instead of "takes effect on restart"
// Run: node --test test/renderer-handoff-extensions.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createDocument } = require('./renderer-fake-dom.js');

const ROOT = path.join(__dirname, '..');
const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const doc = createDocument();
const consoleEl = doc.add('div', 'console-logs');
const list = doc.add('div', 'extensions-list');
const catalog = doc.add('div', 'ext-catalog-grid');
globalThis.document = doc;

const api = { calls: [] };
globalThis.window = { api };
const logs = () => consoleEl.children.map(c => c.textContent);

let state, ext;
test.before(async () => {
  ({ state } = await load('src/state.js'));
  ext = await load('src/extensions.js');
});

const NETWORK = 'Z:\\shared\\extensions\\ublock';
const LOCAL = 'C:\\Users\\me\\exts\\7tv';
const badge = path => list.querySelectorAll('.ext-item').find(r => r.dataset.extPath === path)?.querySelector('.ext-item-ver');

function reset(extensions = [LOCAL, NETWORK], status = { unavailable: [NETWORK] }) {
  api.calls.length = 0;
  consoleEl.children = [];
  state.currentConfig = { extensions: [...extensions] };
  api.getExtensionStatus = () => { api.calls.push(['getExtensionStatus']); return typeof status === 'function' ? status() : Promise.resolve(status); };
  api.saveConfig = (cfg) => { api.calls.push(['saveConfig', [...cfg.extensions]]); return Promise.resolve(true); };
}

test('G4.10: an unreachable folder is shown as unavailable, the rest as active', async () => {
  reset();
  ext.renderExtensionsList();
  // Drawn at once (the startup test relies on it), labelled when main answers.
  assert.equal(list.querySelectorAll('.ext-item').length, 2);
  await flush();
  assert.equal(badge(LOCAL).textContent, 'Active');
  assert.equal(badge(NETWORK).textContent, 'Unavailable (drive not found)');
  assert.ok(badge(NETWORK).classList.contains('unavailable'));
  assert.match(badge(NETWORK).title, /could not be reached/);
  assert.ok(!badge(LOCAL).classList.contains('unavailable'));
  assert.deepEqual(state.currentConfig.extensions, [LOCAL, NETWORK], 'nothing is dropped from the list');
});

test('G4.10: the unavailable entry is removed only by its Remove button', async () => {
  reset();
  ext.renderExtensionsList();
  await flush();
  const row = list.querySelectorAll('.ext-item').find(r => r.dataset.extPath === NETWORK);
  await row.querySelector('.remove-ext-btn').dispatch('click');
  await flush();
  assert.deepEqual(api.calls.filter(c => c[0] === 'saveConfig'), [['saveConfig', [LOCAL]]]);
  assert.deepEqual(list.querySelectorAll('.ext-item').map(r => r.dataset.extPath), [LOCAL]);
  // F69: the copy says what happens now, not "on restart".
  assert.deepEqual(logs(), ['[Extensions] Removed ublock; it is no longer loaded.']);
});

test('G4.10: an older main, a failing call or odd answers leave every row Active', async () => {
  // (undefined as a function: a bare undefined would pick reset's default.)
  for (const status of [() => Promise.resolve(undefined), null, {}, { unavailable: 'Z:\\x' }, { unavailable: [5, null] }, () => Promise.reject(new Error('no handler'))]) {
    reset([NETWORK], status);
    ext.renderExtensionsList();
    await flush();
    assert.equal(badge(NETWORK).textContent, 'Active', String(status));
  }
  reset([NETWORK]);
  delete api.getExtensionStatus;
  ext.renderExtensionsList();
  await flush();
  assert.equal(badge(NETWORK).textContent, 'Active', 'bridge missing entirely');
});

test('G4.10: a hostile path is text, and matching is by exact path', async () => {
  const evil = 'C:\\x\\<img src=x onerror=alert(1)>';
  reset([evil, `${evil}-sibling`], { unavailable: [evil] });
  ext.renderExtensionsList();
  await flush();
  assert.equal(badge(evil).textContent, 'Unavailable (drive not found)');
  assert.equal(badge(`${evil}-sibling`).textContent, 'Active');
  assert.equal(doc.created.filter(el => el.tagName === 'IMG').length, 0);
});

// ── F69: the catalog card buttons ────────────────────────────────────────────

const card = id => catalog.querySelectorAll('.ext-catalog-item')
  .find(c => c.querySelector('.catalog-install-btn')?.dataset.id === id);

async function renderCatalog(items) {
  api.listCatalogExtensions = () => Promise.resolve(items);
  api.getConfig = () => Promise.resolve({ extensions: [] });
  await ext.renderExtensionCatalog();
}

test('F69: a rejected install or uninstall gives both buttons back', async () => {
  reset([]);
  await renderCatalog([{ id: '7tv', name: '7TV', description: 'emotes', installed: { version: '3.0' } }]);
  const c = card('7tv');
  const install = c.querySelector('.catalog-install-btn');
  const remove = c.querySelector('.catalog-uninstall-btn');

  api.installCatalogExtension = () => Promise.reject(new Error('IPC gone'));
  await install.dispatch('click');
  assert.equal(install.disabled, false);
  assert.equal(remove.disabled, false);
  assert.equal(c.querySelector('.catalog-status').textContent, 'Failed: IPC gone');

  api.uninstallCatalogExtension = () => Promise.reject(new Error('EBUSY'));
  await remove.dispatch('click');
  assert.equal(install.disabled, false);
  assert.equal(remove.disabled, false);
  assert.equal(c.querySelector('.catalog-status').textContent, 'Failed: EBUSY');

  api.installCatalogExtension = () => Promise.resolve({ ok: false, error: 'rate limited' });
  await install.dispatch('click');
  assert.equal(install.disabled, false);
  assert.equal(c.querySelector('.catalog-status').textContent, 'Failed: rate limited');

  api.installCatalogExtension = () => Promise.resolve(undefined);
  await install.dispatch('click');
  assert.equal(install.disabled, false);
  assert.equal(c.querySelector('.catalog-status').textContent, 'Failed: unknown error');
});

test('F69: an uninstall that left files behind says so on the card', async () => {
  reset([]);
  await renderCatalog([
    { id: '7tv', name: '7TV', description: 'emotes', installed: { version: '3.0' } },
    { id: 'other', name: 'Other', description: 'x', installed: { version: '1.0' } },
  ]);
  api.uninstallCatalogExtension = () => Promise.resolve({ ok: true, warning: 'Removed, but some files could not be deleted: EBUSY' });
  await card('7tv').querySelector('.catalog-uninstall-btn').dispatch('click');
  await flush();
  // The catalog was re-rendered; the warning is on the new card for 7TV only.
  assert.equal(card('7tv').querySelector('.catalog-status').textContent, 'Removed, but some files could not be deleted: EBUSY');
  assert.equal(card('other').querySelector('.catalog-status').textContent, '');
  assert.deepEqual(logs(), ['[Catalog] 7TV removed and unloaded.']);
});

test('F69: a clean uninstall and an install report what happened, no restart claim', async () => {
  reset([]);
  await renderCatalog([{ id: '7tv', name: '7TV', description: 'emotes', installed: { version: '3.0' } }]);
  api.uninstallCatalogExtension = () => Promise.resolve({ ok: true });
  await card('7tv').querySelector('.catalog-uninstall-btn').dispatch('click');
  await flush();
  assert.equal(card('7tv').querySelector('.catalog-status').textContent, '');

  api.installCatalogExtension = () => Promise.resolve({ ok: true, version: '3.1' });
  await card('7tv').querySelector('.catalog-install-btn').dispatch('click');
  await flush();
  assert.equal(card('7tv').querySelector('.catalog-status').textContent, 'Installed v3.1.', 'still visible after the re-render');
  assert.deepEqual(logs(), ['[Catalog] 7TV removed and unloaded.', '[Catalog] 7TV v3.1 installed.']);
  assert.ok(!logs().some(l => /restart/i.test(l)));
});
