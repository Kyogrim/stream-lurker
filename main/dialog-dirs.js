// Where the app's Open dialogs start. Tested in test/main-dialog-dirs.test.js.
//
// Why: since Electron 43 an open dialog without defaultPath always starts in
// Downloads, and Windows stops remembering the last folder. Users with
// unpacked extensions or backups elsewhere had to navigate there every time.

const fs = require('fs');
const path = require('path');

// The candidate if it is an existing directory. On Windows a defaultPath that
// is not a directory is read as folder + file name, so a stale or moved path
// would pre-fill a bogus name instead of falling back.
function existingDir(p, fsImpl = fs) {
  if (typeof p !== 'string' || !p) return undefined;
  try {
    return fsImpl.statSync(p).isDirectory() ? p : undefined;
  } catch (e) {
    return undefined;
  }
}

function firstExistingDir(candidates, fsImpl = fs) {
  for (const c of candidates) {
    const dir = existingDir(c, fsImpl);
    if (dir) return dir;
  }
  return undefined;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// "Add Unpacked Extension Folder": the folder the last pick came from, else
// the PARENT of the most recently added extension. The parent, because an
// openDirectory dialog opened inside a folder cannot select its sibling.
// Catalog installs (under managedRoot) are the app's own and never a place
// the user picked from.
function extensionPickerDir({ remembered, extensions, managedRoot, fallback }, fsImpl = fs) {
  const list = (Array.isArray(extensions) ? extensions : [])
    .filter(p => typeof p === 'string' && p && !(managedRoot && isInside(p, managedRoot)));
  const last = list.length ? path.dirname(list[list.length - 1]) : undefined;
  return firstExistingDir([remembered, last, fallback], fsImpl);
}

module.exports = { existingDir, firstExistingDir, extensionPickerDir };
