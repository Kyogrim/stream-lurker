// Gate tests for main/clip-download.js (F75): download-clip and
// open-clip-window accept only https Twitch URLs, the same hosts the dashboard
// builds its clip links on, and the Save dialog gets a bare legal file name.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { clipDownloadUrl, clipPageUrl, clipFileName, CLIP_MEDIA_HOSTS, CLIP_PAGE_HOSTS } = require('../main/clip-download');

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
