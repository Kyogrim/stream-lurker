// Gate tests for safe-unzip.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
const { extractZipBuffer, safeEntryPath } = require('../safe-unzip');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sl-unzip-test-'));
}

test('extracts nested files, including a large deflated entry', () => {
  const big = new Uint8Array(512 * 1024).map((_, i) => i % 251);
  const zip = zipSync({
    'uBlock0.chromium/manifest.json': strToU8('{"manifest_version":2}'),
    'uBlock0.chromium/js/big.bin': big,
    'uBlock0.chromium/empty/': new Uint8Array(0),
  });
  const dest = path.join(tmp(), 'out');
  const r = extractZipBuffer(zip, dest);
  assert.equal(r.written, 2);
  assert.deepEqual(r.refused, []);
  assert.equal(fs.readFileSync(path.join(dest, 'uBlock0.chromium', 'manifest.json'), 'utf8'), '{"manifest_version":2}');
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dest, 'uBlock0.chromium', 'js', 'big.bin'))), big);
});

test('refuses every traversal and absolute-path spelling, and writes nothing outside', () => {
  const parent = tmp();
  const dest = path.join(parent, 'out');
  const hostile = ['../evil.txt', 'a/../../evil2.txt', '..\\evil3.txt', '/abs.txt', 'C:/drive.txt', 'c:\\drive2.txt', 'ok/../../../evil4.txt'];
  const entries = { 'safe.txt': strToU8('fine') };
  for (const h of hostile) entries[h] = strToU8('pwned');
  const r = extractZipBuffer(zipSync(entries), dest);
  assert.equal(r.written, 1);
  assert.deepEqual([...r.refused].sort(), [...hostile].sort());
  assert.deepEqual(fs.readdirSync(parent), ['out'], 'nothing escaped into the parent');
  assert.deepEqual(fs.readdirSync(dest), ['safe.txt']);
});

test('names that stay inside after normalisation are allowed', () => {
  assert.equal(safeEntryPath('a/./b.txt'), path.join('a', 'b.txt'));
  assert.equal(safeEntryPath('a//b.txt'), path.join('a', 'b.txt'));
  assert.equal(safeEntryPath('a\\b.txt'), path.join('a', 'b.txt'));
  for (const bad of ['', '..', '/', 'a/..', 'x\0y', null, undefined, 42]) assert.equal(safeEntryPath(bad), null, String(bad));
});

test('zip-bomb limits stop extraction before anything is written', () => {
  const dest = path.join(tmp(), 'out');
  const many = {};
  for (let i = 0; i < 20; i++) many[`f${i}.txt`] = strToU8('x');
  assert.throws(() => extractZipBuffer(zipSync(many), dest, { maxEntries: 10 }), /more than 10 files/);
  assert.equal(fs.existsSync(dest), false);
  const huge = zipSync({ 'z.bin': new Uint8Array(4096) });
  assert.throws(() => extractZipBuffer(huge, dest, { maxTotalBytes: 1024 }), /expands past 1024/);
  assert.equal(fs.existsSync(dest), false);
});

test('a corrupt archive throws instead of hanging or half-writing', () => {
  const dest = path.join(tmp(), 'out');
  assert.throws(() => extractZipBuffer(Buffer.from('this is not a zip file at all'), dest));
  assert.equal(fs.existsSync(dest), false);
});
