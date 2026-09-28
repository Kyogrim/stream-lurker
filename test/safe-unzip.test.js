// Gate tests for safe-unzip.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
const { extractZipBuffer, safeEntryPath } = require('../main/safe-unzip');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sl-unzip-test-'));
}

// Overwrites the uncompressed size that a zip's first central-directory record
// declares. That field is what the filter sees as `originalSize`, and it is
// attacker-controlled: a bomb can claim any size it likes.
function declareSize(zip, bytes) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  view.setUint32(view.getUint32(eocd + 16, true) + 24, bytes, true);
  return zip;
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

// --- Limits: the defaults, and where exactly the line is -------------------

// main.js calls extractZipBuffer(zip, staging) with no limits, so the defaults
// ARE the zip-bomb protection in production. Pins 20000 files / 512 MiB, and
// that overriding one limit keeps the other's default.
test('default limits apply with no options, and survive overriding the other limit', () => {
  const dest = path.join(tmp(), 'out');
  const many = {};
  for (let i = 0; i <= 20000; i++) many[`f${i}`] = new Uint8Array(0);
  const tooMany = zipSync(many, { level: 0 }); // stored: builds in ms, not seconds
  assert.throws(() => extractZipBuffer(tooMany, dest), /more than 20000 files/);
  assert.throws(() => extractZipBuffer(tooMany, dest, { maxTotalBytes: 1 << 20 }), /more than 20000 files/);

  // Refused on the header's claim alone: nothing is inflated to find out.
  const claimsTooMuch = declareSize(zipSync({ 'a.txt': strToU8('tiny') }), 512 * 1024 * 1024 + 1);
  assert.throws(() => extractZipBuffer(claimsTooMuch, dest), /expands past 536870912 bytes/);
  assert.throws(() => extractZipBuffer(claimsTooMuch, dest, { maxEntries: 5 }), /expands past 536870912 bytes/);
  assert.equal(fs.existsSync(dest), false);
});

// A limit is a maximum, not an exclusive bound: an archive that uses exactly
// its budget extracts, one more file or byte does not. Directory entries and
// refused names are not extracted, so they do not spend the budget either.
test('limits are inclusive, and only extracted files count against them', () => {
  const entries = {
    'a.txt': strToU8('aaaa'),
    'b.txt': strToU8('bbbb'),
    'c.txt': strToU8('cccc'), // 3 files, 12 bytes
    'sub/': new Uint8Array(0),
    '../evil.txt': strToU8('refused, and not counted'),
  };
  const dest = path.join(tmp(), 'out');
  const r = extractZipBuffer(zipSync(entries), dest, { maxEntries: 3, maxTotalBytes: 12 });
  assert.equal(r.written, 3);
  assert.deepEqual(r.refused, ['../evil.txt']);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['a.txt', 'b.txt', 'c.txt']);

  assert.throws(() => extractZipBuffer(zipSync(entries), path.join(tmp(), 'out'), { maxEntries: 2 }), /more than 2 files/);
  assert.throws(() => extractZipBuffer(zipSync(entries), path.join(tmp(), 'out'), { maxTotalBytes: 11 }), /expands past 11 bytes/);
});

// --- Destination directory ----------------------------------------------------

// The staging dir main.js extracts into may already exist, or sit under a
// managed-extensions folder that does not exist yet on a first install.
test('extracts into a destination that already exists, or whose parents do not', () => {
  const zip = zipSync({ 'manifest.json': strToU8('{}') });
  const existing = tmp();
  assert.equal(extractZipBuffer(zip, existing).written, 1);
  assert.equal(fs.readFileSync(path.join(existing, 'manifest.json'), 'utf8'), '{}');

  const deep = path.join(tmp(), 'managed', 'ext', 'ublock.staging');
  assert.equal(extractZipBuffer(zip, deep).written, 1);
  assert.equal(fs.readFileSync(path.join(deep, 'manifest.json'), 'utf8'), '{}');
});

// --- Names only the name check catches ---------------------------------------

// extractZipBuffer also checks the resolved target is inside destDir, which
// hides gaps in safeEntryPath. These names get past that second check (or never
// reach it), so safeEntryPath's own answer is what stands.
test('safeEntryPath refuses names with no real segment and drive-qualified names', () => {
  for (const dotsOnly of ['.', './', './.', '.\\', '././']) {
    assert.equal(safeEntryPath(dotsOnly), null, JSON.stringify(dotsOnly));
  }
  for (const drive of ['C:foo', 'c:/x.txt', 'Z:\\x.txt', 'd:', 'C:/']) {
    assert.equal(safeEntryPath(drive), null, JSON.stringify(drive));
  }
});

// On Windows path.resolve('C:\\...\\out', 'C:evil.txt') lands INSIDE out: a
// drive-relative name on the same drive passes the containment check, so the
// drive-letter rule in safeEntryPath is the only thing that refuses it.
test('a drive-relative name on the destination drive is refused, not written', () => {
  const drive = (/^[a-zA-Z]:/.exec(os.tmpdir()) || ['C:'])[0];
  const name = `${drive}evil.txt`;
  const dest = path.join(tmp(), 'out');
  const r = extractZipBuffer(zipSync({ [name]: strToU8('pwned'), 'ok.txt': strToU8('ok') }), dest);
  assert.deepEqual(r.refused, [name]);
  assert.equal(r.written, 1);
  assert.deepEqual(fs.readdirSync(dest), ['ok.txt']);
});

// ── Found by mutation testing: sizes and names the archive lies about ──────

test('a stored entry that declares 0 bytes still counts its real size against the cap', () => {
  // Stored (level 0) entries are read by their compressed size, whatever the
  // central directory declares, so the declared size alone let a bomb through.
  const blob = new Uint8Array(64 * 1024).fill(7);
  const zip = declareSize(zipSync({ 'blob.bin': blob }, { level: 0 }), 0);
  const dest = path.join(tmp(), 'out');
  assert.throws(() => extractZipBuffer(zip, dest, { maxTotalBytes: 1024 }), /expands past 1024/);
  assert.equal(fs.existsSync(dest), false, 'nothing written');
});

test('a deflated entry that under-declares its size never writes past the cap', () => {
  const blob = new Uint8Array(256 * 1024).fill(1); // compresses to almost nothing
  const zip = declareSize(zipSync({ 'blob.bin': blob }), 16);
  const dest = path.join(tmp(), 'out');
  let threw = false;
  try { extractZipBuffer(zip, dest, { maxTotalBytes: 4096 }); } catch (e) { threw = true; }
  const written = fs.existsSync(dest)
    ? fs.readdirSync(dest).reduce((n, f) => n + fs.statSync(path.join(dest, f)).size, 0) : 0;
  assert.ok(threw || written <= 4096, `wrote ${written} bytes past a 4096-byte cap`);
});

// fflate's zipSync cannot build an entry named __proto__ (it walks a plain
// object), so a same-length placeholder is renamed in the raw bytes: in the
// local header and in the central directory alike.
function renameEntry(zip, from, to) {
  assert.equal(from.length, to.length);
  const a = strToU8(from), b = strToU8(to);
  for (let i = 0; i + a.length <= zip.length; i++) {
    if (a.every((c, j) => zip[i + j] === c)) zip.set(b, i);
  }
  return zip;
}

test('names with a colon are refused (NTFS alternate data streams), and so is a root __proto__', () => {
  const dest = path.join(tmp(), 'out');
  const r = extractZipBuffer(renameEntry(zipSync({
    'docs/Re: notes.txt': strToU8('hidden'),
    'manifest.json:hidden': strToU8('stream'),
    xxxxxxxxx: strToU8('x'), // renamed to __proto__ below
    'ok.txt': strToU8('y'),
  }), 'xxxxxxxxx', '__proto__'), dest);
  assert.equal(r.written, 1);
  assert.deepEqual([...r.refused].sort(), ['__proto__', 'docs/Re: notes.txt', 'manifest.json:hidden']);
  assert.deepEqual(fs.readdirSync(dest), ['ok.txt']);
});
