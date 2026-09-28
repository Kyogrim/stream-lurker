// Guards the CRLF fix. Wiring tests read sources as text and match them with
// LF regexes; Git for Windows checks sources out as CRLF by default, which
// once failed 46 tests on a fresh clone. Two layers, each checked here:
// .gitattributes pins LF, and every test read of a repo source normalizes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

test('.gitattributes checks sources out with LF (and batch files with CRLF)', () => {
  const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(attrs, /^\* text=auto eol=lf$/m);
  assert.match(attrs, /^\*\.bat text eol=crlf$/m);
});

test('every test that reads a repo source as text normalizes its line endings', () => {
  const SOURCE_ROOT = /\b(REPO|ROOT|root|EXT)\b|__dirname/;
  const offenders = [];
  for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
    for (const m of src.matchAll(/readFileSync\(/g)) {
      let depth = 1, j = m.index + m[0].length;
      while (depth && j < src.length) { depth += { '(': 1, ')': -1 }[src[j]] || 0; j++; }
      const args = src.slice(m.index + m[0].length, j - 1);
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', j));
      if (!SOURCE_ROOT.test(args) || !/'utf-?8'\s*$/.test(args)) continue; // not a repo source read as text
      if (/css\.text\(\)/.test(line)) continue; // compares bytes with what the app serves: must stay raw
      if (src.startsWith(".replace(/\\r\\n/g, '\\n')", j)) continue;
      offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(offenders, [], 'normalize with .replace(/\\r\\n/g, \'\\n\')');
});
