// Gate tests for the extensions part of main/config-sanitize.js (G2.3): a
// non-list config.extensions from a hand edit or an old backup becomes a list
// of path strings at every entry point, so loadExtensions cannot throw before
// the window and tray exist. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExtensions, sanitizeConfig } = require('../main/config-sanitize');

test('regression G2.3: null, {}, 5 and a string all become []', () => {
  for (const bad of [null, {}, 5, 'C:\\ext', true]) {
    const cfg = { extensions: bad };
    const { clamped } = sanitizeConfig(cfg);
    assert.deepEqual(cfg.extensions, [], JSON.stringify(bad));
    assert.equal(clamped.filter(c => c.key === 'extensions').length, 1, 'logged');
    // What loadExtensions and save-config do with it must not throw.
    assert.doesNotThrow(() => { for (const p of cfg.extensions) p.startsWith('x'); });
  }
});

test('non-string and empty entries are dropped, order kept', () => {
  const cfg = { extensions: ['C:\\a', null, 7, '', { path: 'x' }, 'D:\\b'] };
  sanitizeConfig(cfg);
  assert.deepEqual(cfg.extensions, ['C:\\a', 'D:\\b']);
});

test('a clean list and a missing key are left exactly as they are', () => {
  const list = ['C:\\a', 'D:\\b'];
  const cfg = { extensions: list };
  const { clamped } = sanitizeConfig(cfg);
  assert.equal(cfg.extensions, list, 'same array, untouched');
  assert.equal(clamped.length, 0);
  const none = {};
  sanitizeConfig(none);
  assert.equal('extensions' in none, false, 'a config without the key keeps the in-code default');
  assert.equal(normalizeExtensions(undefined), null);
  assert.equal(normalizeExtensions([]), null);
});

test('the log line describes the change without dumping the value', () => {
  const r = normalizeExtensions(['C:\\a', 3]);
  assert.deepEqual(r.change, { key: 'extensions', from: '2 entries', to: '1 extension path' });
  assert.deepEqual(normalizeExtensions(null).change, { key: 'extensions', from: null, to: '0 extension paths' });
});
