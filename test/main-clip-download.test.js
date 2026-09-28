// Gate tests for main/clip-download.js (F75): download-clip and
// open-clip-window accept only https Twitch URLs, the same hosts the dashboard
// builds its clip links on, and the Save dialog gets a bare legal file name.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { clipDownloadUrl, clipPageUrl, clipFileName, CLIP_MEDIA_HOSTS, CLIP_FILE_HOSTS, CLIP_PAGE_HOSTS } = require('../main/clip-download');

test('F75: clip files download only over https from Twitch\'s clip hosts', () => {
  const ok = [
    'https://production.assets.clips.twitchcdn.net/v2/media/abc/video.mp4?sig=a%2Bb&token=%7B%22x%22%3A1%7D',
    'https://clips-media-assets2.twitch.tv/AT-cm%7C123.mp4',
    'https://static-cdn.jtvnw.net/twitch-clips/x-preview-480x272.mp4',
  ];
  for (const u of ok) assert.equal(clipDownloadUrl(u), new URL(u).href, u);
  const bad = [
    'http://clips-media-assets2.twitch.tv/x.mp4',
    'https://192.168.1.1/admin',
    'http://localhost:8080/x.mp4',
    'https://twitch.tv.evil.example/x.mp4',
    'https://eviltwitch.tv/x.mp4',
    'https://user:pass@clips-media-assets2.twitch.tv/x.mp4',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    '', null, 42, {},
  ];
  for (const u of bad) assert.equal(clipDownloadUrl(u), '', String(u));
});

test('F75: the clip window opens only https twitch.tv pages', () => {
  assert.equal(clipPageUrl('https://clips.twitch.tv/SomeSlug'), 'https://clips.twitch.tv/SomeSlug');
  assert.equal(clipPageUrl('https://www.twitch.tv/x/clip/Slug'), 'https://www.twitch.tv/x/clip/Slug');
  for (const u of ['http://clips.twitch.tv/x', 'https://clips-media-assets2.twitch.tv.evil/x', 'https://static-cdn.jtvnw.net/x', 'http://10.0.0.1/']) {
    assert.equal(clipPageUrl(u), '', u);
  }
});

test('F75: the host lists match the dashboard\'s (src/state.js)', async () => {
  const state = await import('../src/state.js');
  assert.deepEqual([...CLIP_MEDIA_HOSTS].sort(), [...state.TWITCH_MEDIA_HOSTS].sort());
  assert.deepEqual([...CLIP_PAGE_HOSTS].sort(), [...state.TWITCH_PAGE_HOSTS].sort());
  // The dashboard sends clip files from this list; main refusing any of them
  // is what broke every clip download once Twitch moved to CloudFront.
  assert.deepEqual([...CLIP_FILE_HOSTS].sort(), [...state.TWITCH_CLIP_FILE_HOSTS].sort());
});

test('clip files: Twitch\'s CloudFront distribution is accepted, any other CloudFront host is not', () => {
  // The shape GQL returns for videoQualities[].sourceURL today (signed query).
  const real = 'https://d1ndex63qxojbr.cloudfront.net/abc123/AT-cm%7Cabc/index.mp4?sig=deadbeef&token=%7B%7D';
  assert.equal(clipDownloadUrl(real), new URL(real).href);
  for (const bad of [
    'https://cloudfront.net/x.mp4',
    'https://evil.cloudfront.net/x.mp4',
    'https://d1ndex63qxojbr.cloudfront.net.evil.example/x.mp4',
    'http://d1ndex63qxojbr.cloudfront.net/x.mp4',
    'https://user:pw@d1ndex63qxojbr.cloudfront.net/x.mp4',
  ]) assert.equal(clipDownloadUrl(bad), '', bad);
  assert.equal(clipPageUrl(real), '', 'a clip file is never a clip page');
});

test('F75 regression: the Save dialog name is a bare, legal .mp4 name', () => {
  const cases = [
    ['GreatClip.mp4', 'GreatClip.mp4'],
    ['GreatClip', 'GreatClip.mp4'],
    ['C:\\Windows\\System32\\evil.mp4', 'evil.mp4'],
    ['..\\..\\Startup\\run.bat', 'run.bat.mp4'],
    ['/etc/passwd', 'passwd.mp4'],
    ['a<b>c:d"e|f?g*h.mp4', 'abcdefgh.mp4'],
    ['CON', '_CON.mp4'],
    ['nul.mp4', '_nul.mp4'],
    ['name. . .', 'name.mp4'],
    ['', 'clip.mp4'],
    [null, 'clip.mp4'],
    [undefined, 'clip.mp4'],
    ['\u0000\u001f', 'clip.mp4'],
    ['x'.repeat(400), `${'x'.repeat(146)}.mp4`],
    ['caf\u00e9 \u{1F600}', 'caf\u00e9 \u{1F600}.mp4'],
  ];
  for (const [input, expected] of cases) assert.equal(clipFileName(input), expected, JSON.stringify(input));
  for (const [input] of cases) assert.ok(clipFileName(input).length <= 150);
});

// Pins the typeof guard in httpsUrlOn. IPC structured-clones its arguments, so
// a compromised dashboard can send an array, and new URL() would stringify
// ['https://…'] into an allowed URL. Only a real string is ever a URL here.
test('clip URLs: a non-string is refused even when it stringifies to an allowed URL', () => {
  const file = 'https://clips-media-assets2.twitch.tv/x.mp4';
  const page = 'https://clips.twitch.tv/SomeSlug';
  const wrappers = {
    array: v => [v],
    'String object': v => new String(v),
    'object with toString': v => ({ toString: () => v }),
  };
  for (const [kind, wrap] of Object.entries(wrappers)) {
    assert.equal(clipDownloadUrl(wrap(file)), '', `download, ${kind}`);
    assert.equal(clipPageUrl(wrap(page)), '', `page, ${kind}`);
  }
  // The bare strings are accepted, so the refusals above are the type check.
  assert.equal(clipDownloadUrl(file), file);
  assert.equal(clipPageUrl(page), page);
});

// Pins the try/catch around new URL(): a string that does not parse is a
// refusal (''), never an exception out of the IPC handler and never a truthy
// value the handler would treat as an accepted URL.
test('clip URLs: an unparsable string is refused with \'\', not thrown', () => {
  for (const u of ['not a url', 'clips.twitch.tv/x.mp4', '//clips.twitch.tv/x.mp4', 'https://', 'https://exa mple.twitch.tv/x', 'https://[::1']) {
    assert.doesNotThrow(() => clipDownloadUrl(u), u);
    assert.doesNotThrow(() => clipPageUrl(u), u);
    assert.equal(clipDownloadUrl(u), '', u);
    assert.equal(clipPageUrl(u), '', u);
  }
});

// Pins each step of clipFileName that the table above does not reach: the
// outer trim, the anchors on the .mp4 strip, the whole trailing run of dots
// and spaces, and the exact shape of the Windows device-name match.
test('clip file name: surrounding whitespace is trimmed before the extension is handled', () => {
  assert.equal(clipFileName('   GreatClip   '), 'GreatClip.mp4');
  // Untrimmed, the trailing blanks hide the .mp4 and it would come out doubled.
  assert.equal(clipFileName('GreatClip.mp4   '), 'GreatClip.mp4');
  assert.equal(clipFileName(' GreatClip '), 'GreatClip.mp4');
});

test('clip file name: only a trailing .mp4 is removed, one elsewhere in the title stays', () => {
  assert.equal(clipFileName('GreatClip.MP4'), 'GreatClip.mp4');
  assert.equal(clipFileName('best.mp4 moments'), 'best.mp4 moments.mp4');
  assert.equal(clipFileName('.mp4 compilation'), '.mp4 compilation.mp4');
});

test('clip file name: a device name is caught even behind a run of trailing dots and spaces', () => {
  // Stripping only the last character would leave "CON " / "PRN .", which the
  // device check does not match, and the final strip would then expose CON.
  assert.equal(clipFileName('CON .'), '_CON.mp4');
  assert.equal(clipFileName('PRN . .mp4'), '_PRN.mp4');
  assert.equal(clipFileName('aux.. ..'), '_aux.mp4');
});

test('clip file name: every reserved device name is prefixed, with or without an extension', () => {
  const devices = ['CON', 'prn', 'Aux', 'NUL', 'COM0', 'com1', 'COM9', 'LPT0', 'lpt1', 'LPT9'];
  for (const d of devices) {
    assert.equal(clipFileName(d), `_${d}.mp4`, d);
    // Microsoft's naming rules reserve these names followed by an extension
    // too ("NUL.txt"), so an extension is no escape from the prefix.
    assert.equal(clipFileName(`${d}.txt`), `_${d}.txt.mp4`, `${d}.txt`);
    assert.equal(clipFileName(`${d}.tar.gz.mp4`), `_${d}.tar.gz.mp4`, `${d}.tar.gz.mp4`);
  }
});

test('clip file name: ordinary titles that only contain a device name are left alone', () => {
  const plain = [
    'Falcon', 'Faux', 'Minnul', 'bestLPT1',        // device name at the end
    'Contest', 'Nullable', 'auxiliary', 'console.log', // device name at the start
    'COM10', 'LPT12', 'coma', 'COMX', 'lptx',       // com/lpt not followed by exactly one digit
    'CON-clip', 'NUL_1',
  ];
  for (const name of plain) assert.equal(clipFileName(name), `${name}.mp4`, name);
});

// Pins the strip after truncation: cutting to 146 characters can leave a run
// of dots and spaces at the end, and all of it has to go, not just the last one.
test('clip file name: truncation never leaves a trailing dot or space before .mp4', () => {
  const head = 'x'.repeat(144);
  for (const tail of [' . and more text', '.. and more text', '  and more text']) {
    const name = clipFileName(head + tail);
    assert.equal(name, `${head}.mp4`, JSON.stringify(tail));
    assert.ok(name.length <= 150);
  }
});
