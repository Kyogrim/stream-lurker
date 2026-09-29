// Keeping the extensions loaded into the stream session equal to
// config.extensions, and checking and swapping in a catalog download. No
// Electron: tested in test/main-extension-sync.test.js, the folder swap
// against a temp directory.
//
// Chromium keeps an extension loaded until it is explicitly removed. The app
// never removed one, so an extension the user removed or uninstalled kept
// injecting into every stream until restart, an update kept running the old
// version, and every settings change re-loaded every configured extension.

const crypto = require('crypto');
const fs = require('fs');
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

// Walk the extracted directory to find the dir that contains manifest.json.
// Some zips put files at root; uBlock puts them under uBlock0.chromium/.
function findManifestRoot(dir, { fsImpl = fs } = {}) {
  if (fsImpl.existsSync(nodePath.join(dir, 'manifest.json'))) return dir;
  const entries = fsImpl.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const e of entries) {
    const sub = nodePath.join(dir, e.name);
    if (fsImpl.existsSync(nodePath.join(sub, 'manifest.json'))) return sub;
  }
  // One more level for safety
  for (const e of entries) {
    const found = findManifestRoot(nodePath.join(dir, e.name), { fsImpl });
    if (found) return found;
  }
  return null;
}

// The staged copy's manifest, read and checked before it replaces the
// installed one. It used to be parsed only after the swap, so a manifest Node
// could not parse (a UTF-8 BOM, which Chromium accepts) threw once the old
// version was already deleted and config.extensions pointed at the new one.
// The BOM is stripped as Chromium does. Throws with the reason; returns the
// parsed manifest.
function readStagedManifest(manifestRoot, { fsImpl = fs } = {}) {
  let text;
  try {
    text = fsImpl.readFileSync(nodePath.join(manifestRoot, 'manifest.json'), 'utf8');
  } catch (e) {
    throw new Error(`its manifest.json could not be read (${e.message})`);
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`its manifest.json is not valid JSON (${e.message})`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('its manifest.json is not a JSON object');
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('its manifest.json has no version');
  return manifest;
}

// Replaces `live` with `staging` so that no failure leaves neither. Renaming
// the live dir first is what fails on Windows while its files are locked, and
// that failure happens before anything was changed. If the second rename
// fails the old copy is renamed back; if even that fails, the error says where
// the old copy is (err.oldCopyAt) rather than claiming it is still installed.
function swapDirectory(staging, live, { fsImpl = fs } = {}) {
  const old = `${live}.old`;
  const rmrf = (p) => { if (fsImpl.existsSync(p)) fsImpl.rmSync(p, { recursive: true, force: true }); };
  rmrf(old);
  const hadLive = fsImpl.existsSync(live);
  if (hadLive) fsImpl.renameSync(live, old);
  try {
    fsImpl.renameSync(staging, live);
  } catch (e) {
    if (hadLive) {
      try {
        fsImpl.renameSync(old, live);
      } catch (restoreErr) {
        const err = new Error(`${e.message}; putting the previous version back also failed (${restoreErr.message}), it is at ${old}`);
        err.oldCopyAt = old;
        throw err;
      }
    }
    throw e;
  }
  try { rmrf(old); } catch (e) { /* cleared by the next install */ }
}

// Where the manifest ends up once `staging` has been renamed to `live`: the
// same place relative to the root. Walking the live folder again could pick a
// different manifest than the one that was checked.
function liveManifestRoot(staging, stagedManifestRoot, live) {
  return nodePath.join(live, nodePath.relative(staging, stagedManifestRoot));
}

// Checks the unpacked copy in `staging` and swaps it in for `live`. Nothing
// at `live` changes unless a manifest is found, parses and has a version,
// before and after `patch` (the 7TV Kick patch) edits it. beforeSwap runs
// right before the swap (main unloads the running copy there, so a failure
// before that point never touches the session either). Returns the manifest
// as installed and where it is now.
function promoteStaged(staging, live, { patch = null, beforeSwap = () => {}, fsImpl = fs } = {}) {
  const stagedManifest = findManifestRoot(staging, { fsImpl });
  if (!stagedManifest) throw new Error('the archive did not contain a manifest.json');
  let manifest = readStagedManifest(stagedManifest, { fsImpl });
  if (patch) {
    patch(stagedManifest);
    manifest = readStagedManifest(stagedManifest, { fsImpl });
  }
  beforeSwap();
  swapDirectory(staging, live, { fsImpl });
  return { manifest, manifestRoot: liveManifestRoot(staging, stagedManifest, live) };
}

// One install or uninstall per catalog id at a time. run() resolves
// { refused: true } while another holds the id, otherwise fn's result, and
// always frees the id, even when fn throws.
function createInstallLocks() {
  const held = new Set();
  return {
    has: (id) => held.has(id),
    async run(id, fn) {
      if (held.has(id)) return { refused: true };
      held.add(id);
      try {
        return await fn();
      } finally {
        held.delete(id);
      }
    },
  };
}

module.exports = {
  extensionPathKey, planExtensionSync, isInsideDir, checkReleaseAsset,
  findManifestRoot, readStagedManifest, swapDirectory, liveManifestRoot, promoteStaged, createInstallLocks,
};
