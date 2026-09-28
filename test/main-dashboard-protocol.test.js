// Gate tests for main/dashboard-protocol.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DASHBOARD_URL,
  DASHBOARD_SCHEME,
  DASHBOARD_SCHEME_PRIVILEGES,
  IMPORT_MARKER,
  isDashboardOrigin,
  isDashboardUrl,
  resolveDashboardAsset,
  createDashboardHandler,
  mergeLegacyStorage,
  migrateFileOriginStorage,
} = require('../main/dashboard-protocol');

const REPO = path.resolve(__dirname, '..');

test('the scheme is registered the way ES modules and localStorage need', () => {
  assert.equal(DASHBOARD_URL, 'app://bundle/index.html');
  assert.equal(DASHBOARD_SCHEME, 'app');
  assert.equal(DASHBOARD_SCHEME_PRIVILEGES.standard, true, 'a real origin: relative imports and localStorage');
  assert.equal(DASHBOARD_SCHEME_PRIVILEGES.secure, true);
  assert.equal(DASHBOARD_SCHEME_PRIVILEGES.bypassCSP, undefined, 'index.html CSP must keep applying');
  assert.equal(DASHBOARD_SCHEME_PRIVILEGES.allowServiceWorkers, undefined);
});

test('isDashboardOrigin: scheme and host, not Node\'s "null" origin for custom schemes', () => {
  assert.equal(new URL('app://bundle/index.html').origin, 'null', 'why origin is not compared directly');
  assert.equal(isDashboardOrigin('app://bundle'), true);
  assert.equal(isDashboardOrigin('app://bundle/any/path'), true);
  assert.equal(isDashboardOrigin('app://bundle.evil/index.html'), false);
  assert.equal(isDashboardOrigin('app://other/'), false);
  assert.equal(isDashboardOrigin('https://bundle/'), false);
  assert.equal(isDashboardOrigin('null'), false);
});

test('isDashboardUrl matches only the dashboard page', () => {
  assert.equal(isDashboardUrl('app://bundle/index.html'), true);
  assert.equal(isDashboardUrl('app://bundle/index.html?x=1#tab'), true);
  assert.equal(isDashboardUrl('app://other/index.html'), false);
  assert.equal(isDashboardUrl('app://bundle/renderer.js'), false);
  assert.equal(isDashboardUrl('file:///C:/app/index.html'), false);
  assert.equal(isDashboardUrl('https://bundle/index.html'), false);
  assert.equal(isDashboardUrl(''), false);
  assert.equal(isDashboardUrl(undefined), false);
});

test('every file index.html loads resolves, with an explicit content type', () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  // Local (relative) src/href references in the page itself.
  const refs = [...html.matchAll(/\s(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
  assert.ok(refs.includes('style.css') && refs.includes('renderer.js'), `found ${refs.join(', ')}`);
  for (const ref of refs) {
    const r = resolveDashboardAsset(new URL(ref, DASHBOARD_URL).href, REPO);
    assert.equal(r.status, 200, ref);
    assert.ok(fs.existsSync(r.filePath), `${ref} -> ${r.filePath}`);
  }
  // Every ES module the renderer imports, followed transitively.
  const seen = new Set();
  const queue = ['renderer.js'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const url = new URL(rel, DASHBOARD_URL).href;
    const r = resolveDashboardAsset(url, REPO);
    assert.equal(r.status, 200, url);
    assert.equal(r.contentType, 'text/javascript; charset=utf-8', url);
    const src = fs.readFileSync(r.filePath, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      queue.push(new URL(spec, url).pathname.slice(1));
    }
  }
  assert.ok(seen.size > 5, `followed ${seen.size} modules`);

  assert.equal(resolveDashboardAsset('app://bundle/index.html', REPO).contentType, 'text/html; charset=utf-8');
  assert.equal(resolveDashboardAsset('app://bundle/style.css', REPO).contentType, 'text/css; charset=utf-8');
  assert.equal(resolveDashboardAsset('app://bundle/', REPO).filePath, path.join(REPO, 'index.html'));
});

test('traversal in every spelling is refused and never leaves the app directory', () => {
  const root = path.join(os.tmpdir(), 'sl-proto-root');
  for (const url of [
    'app://bundle/%2e%2e/secret.js',
    'app://bundle/src/%2e%2e/%2e%2e/secret.js',
    'app://bundle/src/..%2f..%2fsecret.js',
    'app://bundle/src/..%5c..%5csecret.js',
    'app://bundle/src/%5c..%5csecret.js',
    'app://bundle/src/C:%5cWindows%5cwin.ini',
    'app://bundle/C:/Windows/win.ini',
    'app://bundle/src/x.js%00.css',
    'app://bundle//etc/passwd.js',
    'app://bundle/src//x.js',
  ]) {
    const r = resolveDashboardAsset(url, root);
    assert.notEqual(r.status, 200, url);
  }
  // Literal dot segments are collapsed by the URL parser (Chromium does the
  // same before the request reaches us), so they can only land inside.
  assert.equal(resolveDashboardAsset('app://bundle/src/./x.js', root).filePath, path.join(root, 'src', 'x.js'));
  assert.equal(resolveDashboardAsset('app://bundle/src/../../../x.js', root).status, 404, 'collapses to /x.js, not an allowed top-level file');
  assert.equal(resolveDashboardAsset('app://bundle/../../src/x.js', root).filePath, path.join(root, 'src', 'x.js'));
  assert.equal(resolveDashboardAsset('app://bundle/src/%E0%A4%A.js', root).status, 400, 'malformed escape');
});

test('only the dashboard files are served; the main process and dependencies are not', () => {
  for (const url of [
    'app://bundle/main.js', 'app://bundle/preload.js', 'app://bundle/package.json', 'app://bundle/main/web-security.js',
    'app://bundle/node_modules/electron/index.js', 'app://bundle/extension/manifest.json', 'app://bundle/test/x.test.js',
    'app://bundle/src/data.json', 'app://bundle/src/', 'app://bundle/INDEX.HTML',
    'app://evil/index.html', 'https://bundle/index.html', 'not a url',
  ]) {
    assert.notEqual(resolveDashboardAsset(url, REPO).status, 200, url);
  }
  assert.equal(resolveDashboardAsset('app://bundle/src/multi-lurk.js', REPO).status, 200);
  assert.equal(resolveDashboardAsset('app://bundle/icon.ico', REPO).contentType, 'image/x-icon');
});

test('the handler serves bytes with its own content type, and 404s the rest', async () => {
  const reads = [];
  const handler = createDashboardHandler(REPO, async (p) => { reads.push(p); return Buffer.from(`body of ${path.basename(p)}`); });

  const ok = await handler({ url: 'app://bundle/renderer.js' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await ok.text(), 'body of renderer.js');

  const denied = await handler({ url: 'app://bundle/main.js' });
  assert.equal(denied.status, 404);
  assert.deepEqual(reads, [path.join(REPO, 'renderer.js')], 'a refused path is never read');

  const missing = createDashboardHandler(REPO, async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
  assert.equal((await missing({ url: 'app://bundle/src/gone.js' })).status, 404);

  const real = createDashboardHandler(REPO);
  const css = await real({ url: 'app://bundle/style.css' });
  assert.equal(css.status, 200);
  assert.equal(await css.text(), fs.readFileSync(path.join(REPO, 'style.css'), 'utf8'));
});

const clip = (id) => ({ id, title: `clip ${id}`, url: `https://clips.twitch.tv/${id}` });

test('storage merge: first import copies everything the old origin had', () => {
  const source = { stream_lurker_saved_clips: JSON.stringify([clip('a'), clip('b')]), other_key: 'v' };
  const plan = mergeLegacyStorage(source, {});
  assert.equal(plan.alreadyImported, false);
  assert.deepEqual(plan.entries, source);
  assert.deepEqual(plan.keys.sort(), ['other_key', 'stream_lurker_saved_clips']);
});

test('storage merge: never runs twice, so removed clips do not come back', () => {
  const source = { stream_lurker_saved_clips: JSON.stringify([clip('a'), clip('b')]) };
  const dest = { stream_lurker_saved_clips: JSON.stringify([clip('a')]), [IMPORT_MARKER]: '2026-09-27T00:00:00Z' };
  const plan = mergeLegacyStorage(source, dest);
  assert.equal(plan.alreadyImported, true);
  assert.deepEqual(plan.entries, {});
});

test('storage merge: clips saved on the new origin before a retry are kept, old ones added', () => {
  const source = { stream_lurker_saved_clips: JSON.stringify([clip('a'), clip('b')]) };
  const dest = { stream_lurker_saved_clips: JSON.stringify([clip('c'), clip('a')]) };
  const plan = mergeLegacyStorage(source, dest);
  assert.deepEqual(JSON.parse(plan.entries.stream_lurker_saved_clips).map(c => c.id), ['c', 'a', 'b']);
});

test('storage merge: a key both sides have that is not an id list keeps the new value', () => {
  const plan = mergeLegacyStorage(
    { setting: 'old', broken: '{not json', ids: JSON.stringify([clip('a')]) },
    { setting: 'new', broken: '[]', ids: JSON.stringify([clip('a')]) },
  );
  assert.deepEqual(plan.entries, {}, 'nothing to add');
  assert.deepEqual(mergeLegacyStorage({ [IMPORT_MARKER]: 'x', n: 5 }, {}).entries, {}, 'the marker and non-strings are never copied');
  assert.deepEqual(mergeLegacyStorage(null, null).entries, {});
});

// A stand-in for BrowserWindow that records what the import does. `stores`
// maps an origin to its localStorage contents, like Chromium's per-origin store.
function fakeElectron({ stores, failOn = null, hangOn = null }) {
  const log = { windows: [], loads: [], destroyed: 0 };
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.origin = null;
      this.destroyedFlag = false;
      log.windows.push(this);
      const self = this;
      this.webContents = {
        async executeJavaScript(code) {
          if (self.destroyedFlag) throw new Error('Object has been destroyed');
          const store = stores[self.origin] || (stores[self.origin] = {});
          if (code.includes('localStorage.setItem')) {
            const json = code.slice(code.lastIndexOf('})(') + 3, code.lastIndexOf(')'));
            Object.assign(store, JSON.parse(json));
            return Object.keys(JSON.parse(json)).length;
          }
          return { ...store };
        },
      };
    }
    async loadFile(p) { return this.go(`file://${p}`, 'file://'); }
    async loadURL(u) { return this.go(u, new URL(u).origin === 'null' ? `${new URL(u).protocol}//${new URL(u).host}` : new URL(u).origin); }
    async go(u, origin) {
      log.loads.push(u);
      if (failOn && u.includes(failOn)) throw new Error('ERR_FAILED (-2) loading ' + u);
      if (hangOn && u.includes(hangOn)) return new Promise(() => {});
      this.origin = origin;
    }
    isDestroyed() { return this.destroyedFlag; }
    destroy() { this.destroyedFlag = true; log.destroyed++; }
  }
  return { BrowserWindow: FakeWindow, log };
}

// A blank page the caller writes under userData (see loadDashboard in main.js).
const READER = path.join(os.tmpdir(), 'stream-lurker', 'legacy-storage-reader.html');

test('migration: copies the file:// store into app://bundle once, then reports already', async () => {
  const stores = { 'file://': { stream_lurker_saved_clips: JSON.stringify([clip('a')]) } };
  const { BrowserWindow, log } = fakeElectron({ stores });
  let flushed = 0;
  const r = await migrateFileOriginStorage({ BrowserWindow, sourceFile: READER, flushStorage: () => { flushed++; }, settleMs: 0 });
  assert.equal(r.status, 'imported');
  assert.deepEqual(r.keys, ['stream_lurker_saved_clips']);
  assert.equal(flushed, 1, 'made durable before the caller records it as done');
  assert.equal(stores['app://bundle'].stream_lurker_saved_clips, stores['file://'].stream_lurker_saved_clips);
  assert.ok(stores['app://bundle'][IMPORT_MARKER]);
  assert.equal(stores['file://'][IMPORT_MARKER], undefined, 'the old store is left untouched for a downgrade');
  assert.deepEqual(log.loads, [`file://${READER}`, 'app://bundle/style.css'], 'no dashboard script is ever loaded');
  const prefs = log.windows[0].opts.webPreferences;
  assert.equal(log.windows[0].opts.show, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.partition, undefined, 'the default session, the one the dashboard uses');
  assert.equal(log.destroyed, 1);

  const again = await migrateFileOriginStorage({ BrowserWindow, sourceFile: READER, settleMs: 0 });
  assert.equal(again.status, 'already');
});

test('migration: a fresh install with nothing to carry still records the import', async () => {
  const stores = {};
  const { BrowserWindow } = fakeElectron({ stores });
  const r = await migrateFileOriginStorage({ BrowserWindow, sourceFile: READER, settleMs: 0 });
  assert.equal(r.status, 'imported');
  assert.deepEqual(r.keys, []);
  assert.ok(stores['app://bundle'][IMPORT_MARKER]);
});

test('migration: a load failure reports failed, writes nothing, and always destroys the window', async () => {
  const stores = { 'file://': { stream_lurker_saved_clips: '[]' } };
  const { BrowserWindow, log } = fakeElectron({ stores, failOn: 'app://bundle' });
  const r = await migrateFileOriginStorage({ BrowserWindow, sourceFile: READER, settleMs: 0 });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /ERR_FAILED/);
  assert.equal(stores['app://bundle'], undefined);
  assert.equal(log.destroyed, 1);
});

test('migration: a hung page times out instead of holding the dashboard back', async () => {
  const { BrowserWindow, log } = fakeElectron({ stores: {}, hangOn: 'legacy-storage-reader' });
  const started = Date.now();
  const r = await migrateFileOriginStorage({ BrowserWindow, sourceFile: READER, timeoutMs: 50, settleMs: 0 });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(log.destroyed, 1);
});

test('migration: a BrowserWindow that cannot even be created is a failure, not a crash', async () => {
  class Broken { constructor() { throw new Error('no display'); } }
  const r = await migrateFileOriginStorage({ BrowserWindow: Broken, sourceFile: READER, settleMs: 0 });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /no display/);
});

test('migration: the old store is never read through a page inside app.asar', async () => {
  // Packaged, with grantFileProtocolExtraPrivileges off, a file:// page inside
  // the archive cannot load, so reading through one failed on every launch.
  for (const bad of [
    'C:\\Program Files\\Stream Lurker\\resources\\app.asar\\style.css',
    '/opt/stream-lurker/resources/app.asar/style.css',
    'C:\\x\\resources\\app.asar',
    '',
    undefined,
  ]) {
    const { BrowserWindow, log } = fakeElectron({ stores: { 'file://': { k: 'v' } } });
    const r = await migrateFileOriginStorage({ BrowserWindow, sourceFile: bad, settleMs: 0 });
    assert.equal(r.status, 'failed', String(bad));
    assert.deepEqual(log.loads, [], 'nothing is loaded');
  }
  // app.asar.unpacked is a real directory on disk, and a name merely
  // containing "app.asar" is not the archive.
  for (const ok of ['C:\\x\\resources\\app.asar.unpacked\\r.html', 'C:\\data\\my-app.asar-notes\\r.html']) {
    const { BrowserWindow } = fakeElectron({ stores: {} });
    assert.equal((await migrateFileOriginStorage({ BrowserWindow, sourceFile: ok, settleMs: 0 })).status, 'imported', ok);
  }
});
