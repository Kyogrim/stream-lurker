// Gate tests for the seams between the companion extension and the app that
// neither side's own tests can see: the port list, the C1 YouTube cookie scope
// and the hostOnly flag. Each side is loaded as shipped. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SL = require('../extension/connector.js');
const cookieImport = require('../main/cookie-import.js');
const { makeCookieJar, YT_COOKIES } = require('./extension-fakes.js');

const ROOT = path.join(__dirname, '..');

// RECEIVER_PORTS is a literal in main.js today; also look under main/ so the
// guard keeps working if it moves into a module.
function appReceiverPorts() {
  const files = ['main.js', ...fs.readdirSync(path.join(ROOT, 'main')).filter(f => f.endsWith('.js')).map(f => path.join('main', f))];
  for (const f of files) {
    const m = /\bRECEIVER_PORTS\s*=\s*\[([^\]]*)\]/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'));
    if (m) return m[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
  }
  return null;
}

test('every port the app may bind is one the extension probes, and 47100-47104 come first on both (G2.4)', () => {
  const app = appReceiverPorts();
  assert.ok(app && app.length, 'RECEIVER_PORTS literal not found: update this guard to wherever the app keeps its port list');
  assert.ok(app.every(Number.isInteger), `unparsable RECEIVER_PORTS: ${app}`);
  assert.deepEqual(app.slice(0, 5), [47100, 47101, 47102, 47103, 47104], 'extensions already installed only try these');
  const missing = app.filter(p => !SL.PORTS.includes(p));
  assert.deepEqual(missing, [], 'an app bound to one of these would be invisible to the extension');
  // Same relative order, so both walk the fallbacks alike.
  assert.deepEqual(app, SL.PORTS.filter(p => app.includes(p)));
});

test('every pairing code the app makes is long enough for the extension to verify against, and both normalize it alike (F50)', () => {
  const crypto = require('node:crypto');
  const boundary = require('../main/config-boundary.js');
  for (let i = 0; i < 50; i++) {
    const code = boundary.newPairingCode(crypto.randomBytes);
    assert.ok(code.length >= SL.MIN_CODE_LENGTH, `the extension refuses the app's own ${code.length}-character code`);
    const pasted = ` ${code.toLowerCase()} `;
    assert.equal(SL.normalizeCode(pasted), boundary.normalizePairingCode(pasted));
  }
});

test('C1 YouTube cookie scope: the extension and the app accept exactly the same domains', () => {
  const domains = [
    'youtube.com', '.youtube.com', 'www.youtube.com', '.m.youtube.com', 'music.youtube.com', '.YouTube.com',
    'google.com', '.google.com', 'accounts.google.com', '.accounts.google.com', ' .google.com ',
    'mail.google.com', '.mail.google.com', 'docs.google.com', 'myaccount.google.com', 'www.google.com',
    'foo.accounts.google.com', 'evilyoutube.com', 'youtube.com.evil.com', 'notgoogle.com', 'google.co.uk',
    'youtube-nocookie.com', 'ytimg.com', '.gstatic.com', 'googleapis.com', '', '.', null, undefined,
  ];
  for (const d of domains) {
    assert.equal(SL.isAllowedCookieDomain('youtube', d), cookieImport.isYouTubeCookieDomain(d), `sides disagree on ${JSON.stringify(d)}`);
  }
});

test('hostOnly from the extension becomes a Domain-less write in the app; domain cookies keep their Domain (F39)', async () => {
  const jar = makeCookieJar([
    ...YT_COOKIES,
    // A dotted domain the browser flags host-only: only the forwarded flag
    // keeps the app from widening it to every subdomain.
    { name: 'DOTTED', domain: '.www.youtube.com', hostOnly: true },
  ]);
  const sent = JSON.parse(JSON.stringify(await SL.collectCookies('youtube', jar))); // what crosses the wire
  const { writes } = cookieImport.planCookieWrites(sent, { nowS: 1_700_000_000 });
  const write = (name, host) => writes.find(w => w.name === name && new URL(w.url).hostname === host);

  for (const [name, host] of [['__Host-GAPS', 'accounts.google.com'], ['LSID', 'accounts.google.com'], ['VISITOR_INFO1_LIVE', 'm.youtube.com'], ['DOTTED', 'www.youtube.com']]) {
    const w = write(name, host);
    assert.ok(w, `${name} is written for ${host}`);
    assert.ok(!('domain' in w), `${name} stays host-only`);
  }
  assert.equal(write('__Host-GAPS', 'accounts.google.com').path, '/');
  assert.equal(write('__Host-GAPS', 'accounts.google.com').secure, true);
  assert.equal(write('__Secure-1PSID', 'google.com').domain, '.google.com');
  assert.equal(write('ACCOUNT_CHOOSER', 'accounts.google.com').domain, '.accounts.google.com');
  assert.equal(write('PREF', 'youtube.com').domain, '.youtube.com');
});
