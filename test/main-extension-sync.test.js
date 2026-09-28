// Gate tests for main/extension-sync.js: the loaded extensions follow
// config.extensions (F69), the catalog's managed folders are matched exactly
// (F37), and a catalog download is checked against the release's size and
// sha256 digest before it is unpacked (F37). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { extensionPathKey, planExtensionSync, isInsideDir, checkReleaseAsset } = require('../main/extension-sync');

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
