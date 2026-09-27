// Extracts a zip held in memory into a directory, refusing anything that would
// land outside it.
//
// Replaces extract-zip 2.0.1, which hangs forever on the Node 24 that Electron
// 44 bundles (nodejs/node#63487) and has an unfixed symlink path-traversal bug.
// fflate works on a buffer synchronously, so there is no stream to stall, and it
// never creates symlinks: a symlink entry is just written as a small file.
//
// Every entry is checked by name BEFORE it is decompressed, so a hostile archive
// cannot make us inflate a bomb or write a single byte outside `destDir`.

const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

const DEFAULT_LIMITS = { maxEntries: 20000, maxTotalBytes: 512 * 1024 * 1024 };

// Returns the safe relative path for an entry, or null if it must be refused.
function safeEntryPath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return null;
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null; // absolute or drive-qualified
  const parts = norm.split('/').filter(p => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some(p => p === '..')) return null;
  return parts.join(path.sep);
}

function extractZipBuffer(buf, destDir, limits = {}) {
  const { maxEntries, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const root = path.resolve(destDir);
  const refused = [];
  let entries = 0;
  let total = 0;

  const files = unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf), {
    filter(file) {
      if (file.name.endsWith('/')) return false; // directory entry; created on demand
      const rel = safeEntryPath(file.name);
      const target = rel && path.resolve(root, rel);
      if (!target || !target.startsWith(root + path.sep)) {
        refused.push(file.name);
        return false;
      }
      entries += 1;
      total += file.originalSize;
      if (entries > maxEntries) throw new Error(`archive has more than ${maxEntries} files`);
      if (total > maxTotalBytes) throw new Error(`archive expands past ${maxTotalBytes} bytes`);
      return true;
    },
  });

  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const [name, data] of Object.entries(files)) {
    // Re-derive rather than trust the filter: this is the only line that writes.
    const target = path.resolve(root, safeEntryPath(name));
    if (!target.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${root}: ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written += 1;
  }
  return { written, refused };
}

module.exports = { extractZipBuffer, safeEntryPath };
