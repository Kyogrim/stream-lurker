// Gate tests for main/extension-sync.js: the loaded extensions follow
// config.extensions (F69), the catalog's managed folders are matched exactly
// (F37), and a catalog download is checked against the release's size and
// sha256 digest before it is unpacked (F37). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extensionPathKey, planExtensionSync, isInsideDir, checkReleaseAsset,
  findManifestRoot, readStagedManifest, swapDirectory, liveManifestRoot, promoteStaged, createInstallLocks,
} = require('../main/extension-sync');

const win = { platform: 'win32' };

test('F69 regression: a removed or uninstalled extension is unloaded, not left injecting', () => {
  const loaded = [
    { id: 'ublock', path: 'C:\\Users\\me\\AppData\\Roaming\\stream-lurker\\managed-extensions\\ublock-origin\\uBlock0.chromium' },
    { id: 'mine', path: 'D:\\exts\\mine' },
  ];
  const plan = planExtensionSync(loaded, ['D:\\exts\\mine'], win);
  assert.deepEqual(plan.unload, ['ublock']);
  assert.deepEqual(plan.load, []);
  assert.deepEqual(plan.loaded, ['D:\\exts\\mine']);
});

test('F69 regression: a settings change loads only the new folder, never re-loads running ones', () => {
  const loaded = [{ id: 'a', path: 'C:\\exts\\a' }, { id: 'b', path: 'C:\\exts\\b' }];
  // Windows paths from the dialog and from Chromium can differ in case.
  const plan = planExtensionSync(loaded, ['c:\\EXTS\\A', 'C:\\exts\\b', 'C:\\exts\\new', 'C:\\exts\\new\\'], win);
  assert.deepEqual(plan.unload, []);
  assert.deepEqual(plan.load, ['C:\\exts\\new'], 'the trailing-separator spelling is the same folder');
  assert.deepEqual(plan.loaded, ['c:\\EXTS\\A', 'C:\\exts\\b']);
});

test('F69: startup (nothing loaded) loads every configured folder once; junk is skipped', () => {
  const plan = planExtensionSync([], ['C:\\a', null, '', 7, 'C:\\a', 'C:\\b'], win);
  assert.deepEqual(plan, { unload: [], load: ['C:\\a', 'C:\\b'], loaded: [] });
  assert.deepEqual(planExtensionSync(null, null, win), { unload: [], load: [], loaded: [] });
  // A loaded entry without a path or id is left alone rather than crashing.
  assert.deepEqual(planExtensionSync([{}, { id: 'x' }, { path: 'C:\\z' }], [], win).unload, []);
});

test('F69: on POSIX, case is significant', () => {
  const plan = planExtensionSync([{ id: 'a', path: '/home/me/Ext' }], ['/home/me/ext'], { platform: 'linux' });
  assert.deepEqual(plan.unload, ['a']);
  assert.deepEqual(plan.load, ['/home/me/ext']);
  assert.equal(extensionPathKey('/a/b/../c', { platform: 'linux' }), '/a/c');
});

test('F37: a catalog folder matches itself and its insides, never a sibling sharing its prefix', () => {
  const root = 'C:\\data\\managed-extensions\\7tv';
  assert.equal(isInsideDir(root, root, win), true);
  assert.equal(isInsideDir(`${root}\\dist`, root, win), true);
  assert.equal(isInsideDir('c:\\DATA\\managed-extensions\\7TV\\dist', root, win), true);
  assert.equal(isInsideDir(`${root}.staging`, root, win), false);
  assert.equal(isInsideDir(`${root}.old\\dist`, root, win), false);
  assert.equal(isInsideDir('C:\\data\\managed-extensions\\7tv-beta', root, win), false);
  assert.equal(isInsideDir(null, root, win), false);
  assert.equal(isInsideDir('/x/7tv/a', '/x/7tv', { platform: 'linux' }), true);
  assert.equal(isInsideDir('/x/7tvx', '/x/7tv', { platform: 'linux' }), false);
});

function asset(buf, overrides = {}) {
  return { name: 'x.zip', size: buf.length, digest: `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`, ...overrides };
}

test('F37: a download matching the release digest is verified', () => {
  const buf = Buffer.from('PK\u0003\u0004 a real archive');
  assert.deepEqual(checkReleaseAsset(buf, asset(buf)), { ok: true, verified: true, reason: 'sha256 matches' });
  // GitHub's digest in upper case still matches.
  const upper = asset(buf);
  upper.digest = upper.digest.replace(/[0-9a-f]{64}$/, h => h.toUpperCase());
  assert.equal(checkReleaseAsset(buf, upper).verified, true);
});

test('F37 regression: a tampered or truncated download is refused before it is unpacked', () => {
  const buf = Buffer.from('the release bytes');
  const tampered = Buffer.from('the release byteZ');
  const r = checkReleaseAsset(tampered, asset(buf));
  assert.equal(r.ok, false);
  assert.match(r.reason, /sha256 mismatch/);
  const truncated = checkReleaseAsset(buf.subarray(0, 5), asset(buf));
  assert.equal(truncated.ok, false);
  assert.match(truncated.reason, /downloaded 5 bytes, the release lists 17/);
  assert.equal(checkReleaseAsset(null, asset(buf)).ok, false);
});

test('F37: without a digest (older API answers), only the size is checked', () => {
  const buf = Buffer.from('abc');
  assert.deepEqual(checkReleaseAsset(buf, { size: 3 }), { ok: true, verified: false, reason: 'the release lists no digest' });
  assert.equal(checkReleaseAsset(buf, { size: 3, digest: null }).ok, true);
  const other = checkReleaseAsset(buf, { size: 3, digest: 'sha512:abcd' });
  assert.equal(other.ok, true);
  assert.equal(other.verified, false);
  assert.match(other.reason, /unrecognised digest format/);
  assert.equal(checkReleaseAsset(buf, {}).ok, true, 'no size either');
});

// F37: the staged install against real folders in a temp directory.
function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ext-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

// Every file under root, relative path -> contents: "byte-identical" means equal.
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
}

const LIVE_FILES = {
  'uBlock0.chromium/manifest.json': JSON.stringify({ name: 'uBO', version: '1.0.0', manifest_version: 3 }),
  'uBlock0.chromium/js/background.js': 'console.log("v1")',
};

// An fs that fails the one rename named (a locked folder on Windows), and
// passes everything else through; alsoRestore fails putting the old copy back.
function failingRename(match, { alsoRestore = false } = {}) {
  return {
    ...fs,
    renameSync(from, to) {
      if (from === match.from && to === match.to) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      if (alsoRestore && to === match.to && from.endsWith('.old')) throw Object.assign(new Error('EBUSY: resource busy, rename'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  };
}

test('F37 regression: a staged manifest Node cannot use leaves the live folder byte-identical', (t) => {
  const root = tempRoot(t);
  const live = path.join(root, 'ublock-origin');
  writeTree(live, LIVE_FILES);
  const before = snapshotTree(live);
  const cases = {
    'invalid JSON': '{ "name": "uBO", ',
    'no version': JSON.stringify({ name: 'uBO', manifest_version: 3 }),
    'empty version': JSON.stringify({ name: 'uBO', version: '  ' }),
    'not an object': '["1.0"]',
  };
  for (const [what, manifest] of Object.entries(cases)) {
    const staging = `${live}.staging`;
    fs.rmSync(staging, { recursive: true, force: true });
    writeTree(staging, { 'uBlock0.chromium/manifest.json': manifest, 'uBlock0.chromium/js/background.js': 'console.log("v2")' });
    let unloaded = false;
    assert.throws(() => promoteStaged(staging, live, { beforeSwap: () => { unloaded = true; } }), /manifest\.json/, what);
    assert.equal(unloaded, false, `${what}: the running copy was never unloaded`);
    assert.deepEqual(snapshotTree(live), before, `${what}: live folder untouched`);
    assert.equal(fs.existsSync(`${live}.old`), false);
  }
  // No manifest at all.
  fs.rmSync(`${live}.staging`, { recursive: true, force: true });
  writeTree(`${live}.staging`, { 'readme.txt': 'x' });
  assert.throws(() => promoteStaged(`${live}.staging`, live), /did not contain a manifest\.json/);
  assert.deepEqual(snapshotTree(live), before);
});

test('F37: a manifest with a UTF-8 BOM (Chromium accepts it) installs, and is read as installed', (t) => {
  const root = tempRoot(t);
  const live = path.join(root, '7tv');
  writeTree(live, { 'manifest.json': JSON.stringify({ name: '7TV', version: '3.0.0' }) });
  const staging = `${live}.staging`;
  writeTree(staging, { 'dist/manifest.json': `﻿${JSON.stringify({ name: '7TV', version: '3.1.0' })}`, 'dist/content.js': 'x' });
  let patchedAt = null;
  const r = promoteStaged(staging, live, {
    // The 7TV Kick patch rewrites the manifest; the result is what is reported.
    patch: (dir) => {
      patchedAt = dir;
      const m = readStagedManifest(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, host_permissions: ['*://*.kick.com/*'] }));
    },
  });
  assert.equal(patchedAt, path.join(staging, 'dist'), 'patched in staging, before the swap');
  assert.equal(r.manifest.version, '3.1.0');
  assert.deepEqual(r.manifest.host_permissions, ['*://*.kick.com/*']);
  assert.equal(r.manifestRoot, path.join(live, 'dist'));
  assert.equal(readStagedManifest(r.manifestRoot).version, '3.1.0');
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(`${live}.old`), false, 'the old copy is removed once the new one is in place');
  assert.equal(fs.existsSync(path.join(live, 'manifest.json')), false, 'nothing of the old version is left');
  assert.equal(findManifestRoot(live), path.join(live, 'dist'));
  assert.equal(liveManifestRoot(path.join(root, 'x.staging'), path.join(root, 'x.staging'), path.join(root, 'x')), path.join(root, 'x'));
});

test('F37 regression: when staging cannot be renamed into place, the old folder is restored as it was', (t) => {
  const root = tempRoot(t);
  const live = path.join(root, 'ublock-origin');
  writeTree(live, LIVE_FILES);
  const before = snapshotTree(live);
  const staging = `${live}.staging`;
  writeTree(staging, { 'uBlock0.chromium/manifest.json': JSON.stringify({ version: '2.0.0' }) });
  const fsImpl = failingRename({ from: staging, to: live });
  assert.throws(() => promoteStaged(staging, live, { fsImpl }), /EPERM/);
  assert.deepEqual(snapshotTree(live), before, 'the old version is back, byte for byte');
  assert.equal(fs.existsSync(`${live}.old`), false);
  assert.ok(fs.existsSync(staging), 'staging is left for the caller to remove');

  // If putting it back fails too, the error says where the old copy is.
  const both = failingRename({ from: staging, to: live }, { alsoRestore: true });
  let err;
  try { swapDirectory(staging, live, { fsImpl: both }); } catch (e) { err = e; }
  assert.ok(err, 'threw');
  assert.equal(err.oldCopyAt, `${live}.old`);
  assert.match(err.message, /EPERM.*putting the previous version back also failed.*EBUSY/);
  assert.deepEqual(snapshotTree(`${live}.old`), before, 'nothing of the old copy was lost');
});

test('F37: a fresh install (nothing live yet) swaps in without an old copy', (t) => {
  const root = tempRoot(t);
  const live = path.join(root, 'new-ext');
  writeTree(`${live}.staging`, { 'manifest.json': JSON.stringify({ version: '1' }) });
  const r = promoteStaged(`${live}.staging`, live);
  assert.equal(r.manifestRoot, live);
  assert.equal(r.manifest.version, '1');
  assert.equal(fs.existsSync(`${live}.old`), false);
});

test('F37 regression: a second concurrent install of the same id is refused; the lock frees on success or failure', async () => {
  const locks = createInstallLocks();
  let release;
  const first = locks.run('7tv', () => new Promise((r) => { release = r; }));
  assert.equal(locks.has('7tv'), true);
  assert.deepEqual(await locks.run('7tv', async () => 'second ran'), { refused: true });
  assert.equal(await locks.run('ublock-origin', async () => 'other id'), 'other id', 'another id is independent');
  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(locks.has('7tv'), false);
  await assert.rejects(locks.run('7tv', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(locks.has('7tv'), false, 'freed after a throw');
  assert.equal(await locks.run('7tv', async () => 'again'), 'again');
});
