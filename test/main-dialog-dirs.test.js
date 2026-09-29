// Gate tests for main/dialog-dirs.js (F98): the Open dialogs start in a
// folder that exists (Electron 43+ otherwise always opens Downloads), the
// extension picker opens the PARENT of the last extension so a sibling can be
// picked, and never inside the app's own managed-extensions folder.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { existingDir, firstExistingDir, extensionPickerDir } = require('../main/dialog-dirs');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-dialog-dirs-'));
  const exts = path.join(root, 'my-extensions');
  fs.mkdirSync(path.join(exts, 'ublock'), { recursive: true });
  fs.mkdirSync(path.join(exts, 'other'), { recursive: true });
  const docs = path.join(root, 'Documents');
  fs.mkdirSync(docs);
  const managed = path.join(root, 'userData', 'managed-extensions');
  fs.mkdirSync(path.join(managed, '7tv', 'dist'), { recursive: true });
  const file = path.join(root, 'a-file.json');
  fs.writeFileSync(file, '{}');
  return { root, exts, docs, managed, file };
}

test('existingDir: only real directories', () => {
  const t = tree();
  assert.equal(existingDir(t.docs), t.docs);
  assert.equal(existingDir(t.file), undefined, 'a file would be read as folder + file name');
  assert.equal(existingDir(path.join(t.root, 'moved-away')), undefined);
  assert.equal(existingDir(null), undefined);
  assert.equal(existingDir(''), undefined);
  assert.equal(firstExistingDir([undefined, path.join(t.root, 'gone'), t.docs]), t.docs);
});

test('extension picker: parent of the last user extension', () => {
  const t = tree();
  const dir = extensionPickerDir({ extensions: [path.join(t.exts, 'other'), path.join(t.exts, 'ublock')], fallback: t.docs });
  assert.equal(dir, t.exts);
});

test('extension picker: the last pick wins, a stale one falls through', () => {
  const t = tree();
  const picked = path.join(t.root, 'picked-from');
  fs.mkdirSync(picked);
  assert.equal(extensionPickerDir({ remembered: picked, extensions: [path.join(t.exts, 'ublock')], fallback: t.docs }), picked);
  assert.equal(extensionPickerDir({ remembered: path.join(t.root, 'unplugged-usb'), extensions: [path.join(t.exts, 'ublock')], fallback: t.docs }), t.exts);
});

test('extension picker: catalog installs are skipped; fallback when nothing is usable', () => {
  const t = tree();
  const catalog = path.join(t.managed, '7tv', 'dist');
  assert.equal(extensionPickerDir({ extensions: [path.join(t.exts, 'ublock'), catalog], managedRoot: t.managed, fallback: t.docs }), t.exts);
  assert.equal(extensionPickerDir({ extensions: [catalog], managedRoot: t.managed, fallback: t.docs }), t.docs);
  assert.equal(extensionPickerDir({ extensions: null, fallback: t.docs }), t.docs);
  assert.equal(extensionPickerDir({ extensions: [42, null], fallback: path.join(t.root, 'no') }), undefined);
});
