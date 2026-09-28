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
// Names listed in `refused`; refusedCount has them all.
const MAX_REFUSED_LISTED = 100;

// Returns the safe relative path for an entry, or null if it must be refused.
function safeEntryPath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return null;
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null; // absolute or drive-qualified
  // Anywhere else, ':' names an NTFS alternate data stream on Windows:
  // 'manifest.json:x' writes a hidden stream onto manifest.json. No extension
  // ships such a name, so it is refused rather than written somewhere odd.
  if (norm.includes(':')) return null;
  const parts = norm.split('/').filter(p => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some(p => p === '..')) return null;
  return parts.join(path.sep);
}

function extractZipBuffer(buf, destDir, limits = {}) {
  const { maxEntries, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const root = path.resolve(destDir);
  const input = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const refused = [];
  let refusedCount = 0;
  let records = 0;
  let total = 0;
  let compressed = 0;
  const declared = new Map();

  const files = unzipSync(input, {
    filter(file) {
      // Every record counts, directories and refused ones too: a zip64
      // directory can claim billions of phantom records past the end of the
      // buffer, and fflate walks each one.
      records += 1;
      if (records > maxEntries) throw new Error(`archive has more than ${maxEntries} files`);
      // In a real archive no two records share data, so their compressed sizes
      // add up to less than the archive itself. More means records point at
      // the same stream, which fflate would inflate once per record.
      compressed += file.size;
      if (compressed > input.length) throw new Error('archive entries overlap');
      if (file.name.endsWith('/')) return false; // directory entry; created on demand
      const rel = safeEntryPath(file.name);
      const target = rel && path.resolve(root, rel);
      // fflate collects results in a plain object, where '__proto__' would set
      // the prototype and the entry would vanish unreported.
      if (!target || !target.startsWith(root + path.sep) || file.name === '__proto__') {
        refusedCount += 1;
        if (refused.length < MAX_REFUSED_LISTED) refused.push(file.name);
        return false;
      }
      // originalSize is only what the archive declares, and a stored entry is
      // read by its compressed size, so count the larger of the two.
      total += Math.max(file.size, file.originalSize);
      if (total > maxTotalBytes) throw new Error(`archive expands past ${maxTotalBytes} bytes`);
      declared.set(file.name, file.originalSize);
      return true;
    },
  });

  // After fflate: every entry must be the size it declared, and the real total
  // within the cap. With fflate 0.8 a stored entry is at most its compressed
  // size and a deflated one is cut to its declared size, so the filter already
  // bounds the total; this catches a lying stored entry and guards an upgrade.
  let actual = 0;
  for (const [name, data] of Object.entries(files)) {
    if (data.length !== declared.get(name)) throw new Error(`${name} is not the size it declares`);
    actual += data.length;
  }
  if (actual > maxTotalBytes) throw new Error(`archive holds more than ${maxTotalBytes} bytes`);

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
  return { written, refused, refusedCount };
}

module.exports = { extractZipBuffer, safeEntryPath };
