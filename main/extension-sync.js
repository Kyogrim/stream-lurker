// Keeping the extensions loaded into the stream session equal to
// config.extensions, and checking a catalog download before it is installed.
// Pure, tested in test/main-extension-sync.test.js.
//
// Chromium keeps an extension loaded until it is explicitly removed. The app
// never removed one, so an extension the user removed or uninstalled kept
// injecting into every stream until restart, an update kept running the old
// version, and every settings change re-loaded every configured extension.

const crypto = require('crypto');
const nodePath = require('path');

// Windows paths from the folder dialog and from Chromium can differ in case,
// and path.resolve does not fold it.
function extensionPathKey(p, { platform = process.platform, pathApi } = {}) {
  const api = pathApi || (platform === 'win32' ? nodePath.win32 : nodePath.posix);
  const resolved = api.resolve(String(p || ''));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// What to do so the loaded set matches the configured list:
//   unload  ids of loaded extensions whose folder is no longer configured
//   load    configured paths not loaded yet (in config order)
//   loaded  configured paths already loaded, left running as they are
// `loaded` is session.extensions.getAllExtensions(): [{ id, path }].
function planExtensionSync(loaded, configured, opts = {}) {
  const want = new Map();
  for (const p of Array.isArray(configured) ? configured : []) {
    if (typeof p !== 'string' || !p) continue;
    const key = extensionPathKey(p, opts);
    if (!want.has(key)) want.set(key, p);
  }
  const have = new Set();
  const unload = [];
  for (const ext of Array.isArray(loaded) ? loaded : []) {
    if (!ext || !ext.path) continue;
    const key = extensionPathKey(ext.path, opts);
    if (want.has(key)) have.add(key);
    else if (ext.id) unload.push(ext.id);
  }
  const load = [];
  const already = [];
  for (const [key, p] of want) (have.has(key) ? already : load).push(p);
  return { unload, load, loaded: already };
}

// True when `p` is `dir` or inside it. A plain startsWith(dir) also matched
// siblings sharing the prefix: managed-extensions/7tv matched 7tv.staging.
function isInsideDir(p, dir, { platform = process.platform } = {}) {
  if (typeof p !== 'string' || !p) return false;
  const api = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const a = extensionPathKey(p, { platform });
  const d = extensionPathKey(dir, { platform });
  return a === d || a.startsWith(d.endsWith(api.sep) ? d : d + api.sep);
}

// Checks a downloaded release asset against what the GitHub API said about
// it: the byte size, and the sha256 digest GitHub publishes for assets
// ("sha256:<hex>"). A digest in any other form cannot be checked and is
// reported as unverified rather than refused, so a format change on GitHub's
// side does not break every install. Returns { ok, verified, reason }.
function checkReleaseAsset(buffer, asset) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, verified: false, reason: 'no download' };
  const size = asset && asset.size;
  if (Number.isFinite(size) && size >= 0 && buffer.length !== size) {
    return { ok: false, verified: false, reason: `downloaded ${buffer.length} bytes, the release lists ${size}` };
  }
  const digest = asset && typeof asset.digest === 'string' ? asset.digest.trim() : '';
  if (!digest) return { ok: true, verified: false, reason: 'the release lists no digest' };
  const m = digest.match(/^sha256:([0-9a-f]{64})$/i);
  if (!m) return { ok: true, verified: false, reason: `unrecognised digest format (${digest.slice(0, 20)})` };
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== m[1].toLowerCase()) {
    return { ok: false, verified: false, reason: `sha256 mismatch: expected ${m[1].toLowerCase().slice(0, 16)}…, got ${actual.slice(0, 16)}…` };
  }
  return { ok: true, verified: true, reason: 'sha256 matches' };
}

module.exports = { extensionPathKey, planExtensionSync, isInsideDir, checkReleaseAsset };
