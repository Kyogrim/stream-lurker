// Gate tests for main/ua-spoof.js (F56): the spoofed Chrome version follows
// the engine and never goes below it, and the UA string, Sec-CH-UA headers
// and the preload's navigator.userAgentData all report the same version.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MIN_CHROME_MAJOR, spoofedChromeVersion, normalizeUserAgent, applyClientHints } = require('../main/ua-spoof');

const ELECTRON_44_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) stream-lurker/0.14.0-beta Chrome/152.0.7632.45 Electron/44.4.5 Safari/537.36';

test('regression F56: never lower than the real engine', () => {
  assert.deepEqual(spoofedChromeVersion('152.0.7632.45'), { major: '152', full: '152.0.0.0' });
  assert.deepEqual(spoofedChromeVersion('200.1.2.3'), { major: '200', full: '200.0.0.0' });
});

test('an engine below the floor is raised to it; garbage falls back to the floor', () => {
  assert.equal(MIN_CHROME_MAJOR, 137);
  assert.deepEqual(spoofedChromeVersion('124.0.6367.243'), { major: '137', full: '137.0.0.0' });
  assert.deepEqual(spoofedChromeVersion(undefined), { major: '137', full: '137.0.0.0' });
  assert.deepEqual(spoofedChromeVersion('x'), { major: '137', full: '137.0.0.0' });
});

test('the version this process would spoof is at least its own engine', () => {
  // Under plain Node there is no process.versions.chrome: the floor applies.
  const { major } = spoofedChromeVersion(process.versions.chrome);
  assert.ok(Number(major) >= (parseInt(process.versions.chrome, 10) || MIN_CHROME_MAJOR));
});

test('UA: Electron and app tokens stripped, reduced MAJOR.0.0.0 version', () => {
  const { full } = spoofedChromeVersion('152.0.7632.45');
  assert.equal(normalizeUserAgent(ELECTRON_44_UA, full),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
});

test('client hints: low-entropy always set (case-insensitively replacing Chromium\'s own)', () => {
  const h = applyClientHints({ 'Sec-CH-UA': '"Chromium";v="152", "Not(A:Brand";v="24"', 'User-Agent': 'x' }, { major: '152', full: '152.0.0.0', platform: 'win32' });
  assert.deepEqual(h, {
    'User-Agent': 'x',
    'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  });
});

test('client hints: high-entropy versions rewritten only when the site asked for them', () => {
  const asked = applyClientHints({
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="152.0.7632.45", "Not(A:Brand";v="24.0.0.0"',
    'sec-ch-ua-full-version': '"152.0.7632.45"',
  }, { major: '152', full: '152.0.0.0', platform: 'darwin' });
  assert.equal(asked['sec-ch-ua-full-version-list'], '"Chromium";v="152.0.0.0", "Google Chrome";v="152.0.0.0", "Not-A.Brand";v="99.0.0.0"');
  assert.equal(asked['sec-ch-ua-full-version'], '"152.0.0.0"');
  assert.equal(asked['sec-ch-ua-platform'], '"macOS"');
  assert.equal(Object.keys(asked).filter(k => /full-version-list/i.test(k)).length, 1);
  const notAsked = applyClientHints({}, { major: '152', full: '152.0.0.0', platform: 'linux' });
  assert.equal('sec-ch-ua-full-version-list' in notAsked, false);
  assert.equal(notAsked['sec-ch-ua-platform'], '"Linux"');
});

test('the preload derives the same brands and full version from the spoofed UA', () => {
  // src/twitch-preload.js reads navigator.userAgent with these regexes and
  // reports fullVersionList with the Chrome/<full> version: the headers above
  // must say the same.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'twitch-preload.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(preload, /Chrome\\\\\/\(\\\\d\+\)\\\\\./, 'major from the UA string');
  assert.match(preload, /brand: 'Google Chrome', version: chromeVersion/);
  const { major, full } = spoofedChromeVersion('152.0.7632.45');
  const ua = normalizeUserAgent(ELECTRON_44_UA, full);
  assert.equal(ua.match(/Chrome\/(\d+)\./)[1], major);
  assert.equal(ua.match(/Chrome\/([\d.]+)/)[1], full);
});
