// Gate tests for main/web-security.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STREAM_PARTITION,
  isWebUrl,
  isPlatformUrl,
  isOAuthPopupUrl,
  isLoginPopupUrl,
  isUserGestureInput,
  isAllowedTopLevelUrl,
  isAllowedFrameUrl,
  mayOpenExternally,
  sanitizeWebviewAttach,
  isBlockedStreamLoad,
  isPermissionAllowed,
  isTrustedDashboardSender,
  createExternalOpenGate,
  createLogThrottle,
  createDownloadAllowlist,
} = require('../main/web-security');
const { createClock } = require('./main-auth-fakes');

test('platform URLs: https on the platform hosts and their subdomains only', () => {
  for (const ok of [
    'https://www.twitch.tv/somebody', 'https://twitch.tv/x', 'https://player.twitch.tv/?channel=x', 'https://clips.twitch.tv/abc',
    'https://kick.com/x', 'https://www.kick.com/x', 'https://www.youtube.com/@x/live', 'https://consent.youtube.com/m',
    'https://m.youtube.com/watch?v=1', 'https://www.youtube-nocookie.com/embed/1', 'https://rumble.com/c/x',
    'https://WWW.TWITCH.TV/Upper',
  ]) assert.equal(isPlatformUrl(ok), true, ok);

  for (const bad of [
    'http://www.twitch.tv/x',                 // not https
    'https://twitch.tv.evil.net/x',           // platform name as a subdomain
    'https://eviltwitch.tv/x',                // platform name as a suffix without a dot
    'https://evil.net/?u=twitch.tv',          // platform name in the query (the old substring guard passed this)
    'https://twitch.tv@evil.net/x',           // userinfo trick
    'https://www.twitch.tv.',                 // trailing-dot host
    'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'app://bundle/index.html', '', null, undefined, 'not a url',
  ]) assert.equal(isPlatformUrl(bad), false, String(bad));
});

// Pins the exported isWebUrl: http and https, any host, and a real boolean
// (never null/undefined) for everything else.
test('web URLs: http and https on any host, a plain false for anything else', () => {
  for (const ok of ['https://example.com/', 'http://example.com/x?y=1', 'HTTPS://WWW.TWITCH.TV/Upper', 'http://127.0.0.1:8080/']) {
    assert.equal(isWebUrl(ok), true, ok);
  }
  for (const bad of [
    'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'app://bundle/index.html', 'ms-settings:privacy', 'ftp://x.example/',
    'about:blank', 'data:text/html,hi', 'not a url', '', null, undefined,
  ]) assert.equal(isWebUrl(bad), false, String(bad));
});

// Pins both anchors of every Google/Apple host pattern. A lost `$` lets a
// lookalike domain that merely starts with the real host through; a lost `^`
// widens an exact-host allowlist to every host that ends with it.
test('Google and Apple host patterns match whole hostnames, never a prefix or suffix', () => {
  for (const role of ['stream', 'hidden']) {
    for (const bad of [
      'https://accounts.google.com.evil.net/ServiceLogin', 'https://consent.google.com.evil.net/ml', // real host as a prefix
      'https://xaccounts.google.com/', 'https://evil.consent.google.com/ml',                        // real host as a suffix
    ]) assert.equal(isAllowedTopLevelUrl(role, bad), false, `${role} ${bad}`);
  }

  // Sign in with Apple: apple.com itself and its subdomains, not a lookalike.
  assert.equal(isAllowedTopLevelUrl('login', 'https://apple.com/legal/privacy/'), true, 'bare apple.com');
  for (const bad of ['https://appleid.apple.com.evil.net/auth/authorize', 'https://apple.com.evil.net/']) {
    assert.equal(isAllowedTopLevelUrl('login', bad), false, bad);
  }

  // The per-country cookie hop is accounts.google.<cc> exactly, even on the right path.
  for (const bad of ['https://evil.accounts.google.de/accounts/SetSID', 'https://xaccounts.google.co.uk/accounts/SetSID']) {
    assert.equal(isAllowedTopLevelUrl('login', bad), false, bad);
  }

  // In-app OAuth popups: exactly the two sign-in hosts.
  for (const bad of ['https://xaccounts.google.com/o/oauth2', 'https://evil.appleid.apple.com/auth/authorize']) {
    assert.equal(isOAuthPopupUrl(bad), false, bad);
    assert.equal(isLoginPopupUrl(bad), false, bad);
  }
});

test('stream cells and pop-outs stay on the platforms, plus Google consent/auth', () => {
  assert.equal(isAllowedTopLevelUrl('stream', 'https://www.twitch.tv/raidtarget'), true);
  assert.equal(isAllowedTopLevelUrl('stream', 'https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isAllowedTopLevelUrl('stream', 'https://consent.google.com/ml?continue=x'), true);
  assert.equal(isAllowedTopLevelUrl('stream', 'https://accounts.google.com/ServiceLogin'), true);
  // A same-tab link or redirect off the platforms is refused.
  assert.equal(isAllowedTopLevelUrl('stream', 'https://twitch-login.example.com/'), false);
  assert.equal(isAllowedTopLevelUrl('stream', 'https://www.google.com/search?q=x'), false);
  assert.equal(isAllowedTopLevelUrl('stream', 'https://twitch.tv.example.net/'), false);
  assert.equal(isAllowedTopLevelUrl('stream', 'http://kick.com/x'), false);
});

test('hidden probe windows accept the YouTube consent and re-auth hops', () => {
  assert.equal(isAllowedTopLevelUrl('hidden', 'https://consent.youtube.com/m?continue=https://www.youtube.com/'), true);
  assert.equal(isAllowedTopLevelUrl('hidden', 'https://accounts.google.com/ServiceLogin?service=youtube'), true);
  assert.equal(isAllowedTopLevelUrl('hidden', 'https://kick.com/'), true);
  assert.equal(isAllowedTopLevelUrl('hidden', 'https://ads.example.com/landing'), false);
});

test('login windows reach Google\'s sign-in hosts, Apple and the platforms, and nothing else', () => {
  for (const ok of [
    'https://kick.com/login', 'https://passport.twitch.tv/x', 'https://id.twitch.tv/oauth2',
    'https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/v3/signin/identifier?x=1',
    'https://www.google.com/accounts/x', 'https://myaccount.google.com/', 'https://consent.google.com/ml',
    'https://gds.google.com/web/chip?x=1', 'https://accounts.youtube.com/accounts/SetSID',
    // Google's per-country cookie hop, on the accounts host and that path only.
    'https://accounts.google.co.uk/accounts/SetSID?ssdc=1', 'https://accounts.google.de/accounts/SetSID',
    'https://accounts.google.com.br/accounts/SetSID', 'https://ACCOUNTS.GOOGLE.FR/accounts/setsid',
    'https://appleid.apple.com/auth/authorize', 'https://idmsa.apple.com/x',
  ]) assert.equal(isAllowedTopLevelUrl('login', ok), true, ok);
  for (const bad of [
    'https://google.com.evil.net/', 'https://evil-google.com/', 'https://notapple.com/', 'https://phish.example/login',
    'http://accounts.google.com/', 'file:///C:/x',
    // Any google.<two letters> used to pass, subdomains included.
    'https://google.tk/', 'https://evil.google.ly/phish', 'https://www.google.com.br/accounts/x',
    'https://accounts.google.tk/signin', 'https://accounts.google.co.uk/ServiceLogin', 'https://accounts.google.de/accounts/SetSID/../phish',
    // google.com hosts that serve pages anyone can write.
    'https://sites.google.com/view/phish', 'https://docs.google.com/forms/d/x', 'https://translate.google.com/',
    'https://accounts.google.co.uk.evil.net/accounts/SetSID',
  ]) assert.equal(isAllowedTopLevelUrl('login', bad), false, bad);
});

test('the dashboard may only ever be itself', () => {
  assert.equal(isAllowedTopLevelUrl('dashboard', 'app://bundle/index.html'), true);
  assert.equal(isAllowedTopLevelUrl('dashboard', 'app://bundle/index.html#settings'), true);
  assert.equal(isAllowedTopLevelUrl('dashboard', 'https://www.twitch.tv/'), false);
  assert.equal(isAllowedTopLevelUrl('dashboard', 'file:///C:/app/index.html'), false);
  assert.equal(isAllowedTopLevelUrl('dashboard', 'app://bundle/src/state.js'), false);
});

test('clip windows stay on the platforms; unknown contents are not restricted here', () => {
  assert.equal(isAllowedTopLevelUrl('clip', 'https://clips.twitch.tv/abc'), true);
  assert.equal(isAllowedTopLevelUrl('clip', 'https://example.com/'), false);
  assert.equal(isAllowedTopLevelUrl('other', 'devtools://devtools/bundled/inspector.html'), true);
  assert.equal(isAllowedTopLevelUrl(undefined, 'https://example.com/'), true);
});

test('frames in third-party pages may only use web schemes', () => {
  for (const role of ['stream', 'hidden', 'login', 'clip']) {
    for (const ok of ['https://ads.example/x', 'http://x.test/', 'about:blank', 'about:srcdoc', 'blob:https://www.twitch.tv/1', 'data:text/html,hi', 'chrome-extension://abcdefghijklmnop/frame.html']) {
      assert.equal(isAllowedFrameUrl(role, ok), true, `${role} ${ok}`);
    }
    for (const bad of ['file:///C:/Users/x/AppData/Roaming/stream-lurker/Partitions/default/Network/Cookies', 'app://bundle/index.html', 'ms-settings:privacy', 'search-ms:query=x', 'mailto:a@b.c', 'steam://run/1', 'chrome://settings', 'view-source:https://x', 'not a url']) {
      assert.equal(isAllowedFrameUrl(role, bad), false, `${role} ${bad}`);
    }
  }
  // The dashboard is app:// itself and DevTools is devtools://; neither is filtered.
  assert.equal(isAllowedFrameUrl('dashboard', 'app://bundle/index.html'), true);
  assert.equal(isAllowedFrameUrl('other', 'devtools://devtools/x'), true);
});

test('hidden windows never hand links to the browser', () => {
  assert.equal(mayOpenExternally('hidden'), false);
  for (const role of ['stream', 'login', 'clip', 'dashboard', 'other']) assert.equal(mayOpenExternally(role), true, role);
});

test('OAuth popups: exactly Google and Apple sign-in hosts over https', () => {
  assert.equal(isOAuthPopupUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1'), true);
  assert.equal(isOAuthPopupUrl('https://appleid.apple.com/auth/authorize'), true);
  assert.equal(isOAuthPopupUrl('http://accounts.google.com/'), false);
  assert.equal(isOAuthPopupUrl('https://accounts.google.com.evil.net/'), false);
  assert.equal(isOAuthPopupUrl('https://www.google.com/'), false);
  assert.equal(isOAuthPopupUrl('https://ads.example/'), false);
});

test("login popups (r2-24): the sign-in hosts and the platforms' own redirect routes, nothing else", () => {
  for (const ok of [
    'https://accounts.google.com/o/oauth2/v2/auth?x=1', 'https://appleid.apple.com/auth/authorize',
    // Kick's "Continue with Google" may open on its own route first, then 302 to Google.
    'https://kick.com/redirect/google', 'https://www.kick.com/social/apple', 'https://id.twitch.tv/oauth2/authorize',
  ]) assert.equal(isLoginPopupUrl(ok), true, ok);
  for (const bad of [
    'http://kick.com/redirect/google', 'https://kick.com.evil.net/', 'https://www.google.com/', 'https://sites.google.com/view/phish',
    'https://ads.example/', 'javascript:alert(1)', 'file:///C:/x', '', null,
  ]) assert.equal(isLoginPopupUrl(bad), false, String(bad));
});

test('webview attach: hostile markup is stripped and forced safe', () => {
  const prefs = {
    preload: 'file:///C:/Windows/win.ini', preloadURL: 'file:///x.js', nodeIntegration: true, nodeIntegrationInSubFrames: true,
    nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true,
    webviewTag: true, experimentalFeatures: true, enableBlinkFeatures: 'Foo', backgroundThrottling: false,
  };
  const verdict = sanitizeWebviewAttach(prefs, { partition: STREAM_PARTITION, src: 'https://www.twitch.tv/x', allowpopups: 'true' });
  assert.deepEqual(verdict, { allow: true, reason: '' });
  assert.equal('preload' in prefs, false);
  assert.equal('preloadURL' in prefs, false);
  assert.equal('enableBlinkFeatures' in prefs, false);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.experimentalFeatures, false);
  assert.equal(prefs.backgroundThrottling, false, 'unrelated preferences are left alone');
});

test('webview attach: wrong partition or a non-platform src is refused', () => {
  const src = 'https://www.youtube.com/@x/live';
  assert.equal(sanitizeWebviewAttach({}, { partition: '', src }).allow, false);
  assert.equal(sanitizeWebviewAttach({}, { partition: 'persist:other', src }).allow, false);
  assert.equal(sanitizeWebviewAttach({}, { src }).allow, false);
  for (const bad of ['file:///C:/Users/x/AppData/Roaming/stream-lurker/config.json', 'https://evil.example/', 'http://www.twitch.tv/x', '', 'app://bundle/index.html']) {
    const v = sanitizeWebviewAttach({}, { partition: STREAM_PARTITION, src: bad });
    assert.equal(v.allow, false, bad);
    assert.ok(v.reason.length > 0);
  }
  assert.equal(sanitizeWebviewAttach(undefined, undefined).allow, false, 'missing arguments do not throw');
});

// Pins the refusal reason main.js writes to the activity log ("Refused to
// attach a <webview>: <reason>"): it names the partition or src that failed,
// says (none) / (empty) when there was none, and keeps a hostile src to 120
// characters so injected markup cannot flood the log line.
test('webview attach: the refusal reason names what failed, bounded for the activity log', () => {
  const src = 'https://www.twitch.tv/x';
  assert.match(sanitizeWebviewAttach({}, { partition: 'persist:other', src }).reason, /partition "persist:other"/);
  assert.match(sanitizeWebviewAttach({}, { src }).reason, /partition "\(none\)"/);
  assert.match(sanitizeWebviewAttach({}, { partition: '', src }).reason, /partition "\(none\)"/);

  const bad = 'https://evil.example/landing';
  assert.ok(sanitizeWebviewAttach({}, { partition: STREAM_PARTITION, src: bad }).reason.includes(`src ${bad} `));
  assert.match(sanitizeWebviewAttach({}, { partition: STREAM_PARTITION }).reason, /src \(empty\) /);
  assert.match(sanitizeWebviewAttach({}, { partition: STREAM_PARTITION, src: '' }).reason, /src \(empty\) /);

  const long = `https://evil.example/${'a'.repeat(5000)}`;
  const reason = sanitizeWebviewAttach({}, { partition: STREAM_PARTITION, src: long }).reason;
  assert.ok(reason.includes(`src ${long.slice(0, 120)} `), 'the first 120 characters are kept');
  assert.ok(!reason.includes(long.slice(0, 121)), 'nothing past them');
});

test('webview attach: accepts exactly what a stream cell may navigate to (reordering a cell re-attaches it)', () => {
  for (const ok of ['https://consent.google.com/ml?continue=x', 'https://accounts.google.com/ServiceLogin', 'https://kick.com/x']) {
    assert.equal(sanitizeWebviewAttach({}, { partition: STREAM_PARTITION, src: ok }).allow, true, ok);
    assert.equal(isAllowedTopLevelUrl('stream', ok), true, ok);
  }
  for (const bad of ['https://www.google.com/search?q=x', 'http://accounts.google.com/', 'https://mail.google.com/']) {
    assert.equal(sanitizeWebviewAttach({}, { partition: STREAM_PARTITION, src: bad }).allow, false, bad);
    assert.equal(isAllowedTopLevelUrl('stream', bad), false, bad);
  }
});

test('webview attach: the guest\'s own partition preference is pinned to the stream partition', () => {
  // Electron builds webPreferences from params, then spreads the markup's
  // `webpreferences` attribute over it; the guest is created from the result.
  // <webview partition="persist:default" webpreferences="partition=..."> used
  // to pass the params check and attach on another session.
  const src = 'https://www.twitch.tv/x';
  for (const spoofed of ['', 'persist:other', 'other', undefined]) {
    const prefs = spoofed === undefined ? {} : { partition: spoofed };
    const verdict = sanitizeWebviewAttach(prefs, { partition: STREAM_PARTITION, src });
    assert.equal(verdict.allow, true);
    assert.equal(prefs.partition, STREAM_PARTITION, JSON.stringify(spoofed));
  }
});

test('a load started after attach (webview.src / loadURL) keeps a stream cell on the platforms', () => {
  const main = (url) => ({ url, isMainFrame: true, isSameDocument: false });
  for (const bad of ['https://evil.example/', 'https://www.google.com/search?q=x', 'data:text/html,<h1>x', 'file:///C:/x', 'http://www.twitch.tv/x', 'about:blank']) {
    assert.equal(isBlockedStreamLoad('stream', main(bad)), true, bad);
  }
  for (const ok of ['https://www.twitch.tv/raid', 'https://kick.com/x', 'https://consent.youtube.com/m', 'https://accounts.google.com/ServiceLogin']) {
    assert.equal(isBlockedStreamLoad('stream', main(ok)), false, ok);
  }
  // Subframes, in-page changes and every other surface are someone else's rule.
  assert.equal(isBlockedStreamLoad('stream', { url: 'https://evil.example/', isMainFrame: false, isSameDocument: false }), false);
  assert.equal(isBlockedStreamLoad('stream', { url: 'https://evil.example/', isMainFrame: true, isSameDocument: true }), false);
  for (const role of ['login', 'hidden', 'clip', 'dashboard', 'other']) {
    assert.equal(isBlockedStreamLoad(role, main('https://evil.example/')), false, role);
  }
  assert.equal(isBlockedStreamLoad('stream'), false, 'no details: nothing to stop');
});

test('permissions: fullscreen anywhere, sanitized clipboard writes for trusted origins, everything else denied', () => {
  assert.equal(isPermissionAllowed('fullscreen', 'https://player.twitch.tv/'), true);
  assert.equal(isPermissionAllowed('fullscreen', 'https://clip-cdn.example/'), true);
  assert.equal(isPermissionAllowed('fullscreen', ''), true);

  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'https://www.twitch.tv/x'), true);
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'https://www.youtube.com'), true); // check handler passes an origin
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'chrome-extension://ammjkodgmmoknidbanneddgankgfejfh/'), true);
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'app://bundle'), true);
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', 'https://ads.doubleclick.net/'), false, 'an ad iframe on twitch.tv asks as itself');
  assert.equal(isPermissionAllowed('clipboard-sanitized-write', ''), false);

  const denied = [
    'media', 'clipboard-read', 'deprecated-sync-clipboard-read', 'notifications', 'geolocation', 'midi', 'midiSysex',
    'openExternal', 'pointerLock', 'keyboardLock', 'idle-detection', 'window-management', 'storage-access',
    'top-level-storage-access', 'display-capture', 'hid', 'serial', 'usb', 'local-fonts', 'local-network-access',
    'local-network', 'loopback-network', 'mediaKeySystem', 'screen-wake-lock', 'fileSystem', 'automatic-fullscreen', 'unknown',
  ];
  for (const perm of denied) {
    for (const from of ['https://www.twitch.tv/x', 'https://www.youtube.com', 'app://bundle', 'chrome-extension://abc/']) {
      assert.equal(isPermissionAllowed(perm, from), false, `${perm} from ${from}`);
    }
  }
});

test('IPC: only the dashboard top frame on app://bundle is trusted', () => {
  const dashboard = { id: 1 };
  const other = { id: 2 };
  const top = (url) => ({ parent: null, url });
  const ok = { sender: dashboard, senderFrame: top('app://bundle/index.html') };
  assert.equal(isTrustedDashboardSender(ok, dashboard), true);
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: top('app://bundle/index.html#clips') }, dashboard), true);
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: top('app://bundle/settings') }, dashboard), true, 'a pushState path stays trusted: same origin');
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: top('app://other/index.html') }, dashboard), false);

  assert.equal(isTrustedDashboardSender({ sender: other, senderFrame: top('app://bundle/index.html') }, dashboard), false, 'another webContents');
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: { parent: {}, url: 'app://bundle/index.html' } }, dashboard), false, 'a subframe');
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: top('https://evil.example/') }, dashboard), false, 'navigated away');
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: top('file:///C:/app/index.html') }, dashboard), false, 'old file:// origin');
  assert.equal(isTrustedDashboardSender({ sender: dashboard, senderFrame: null }, dashboard), false, 'frame already gone');
  assert.equal(isTrustedDashboardSender(ok, null), false, 'no dashboard window');
  assert.equal(isTrustedDashboardSender(null, dashboard), false);
  const disposed = { sender: dashboard, senderFrame: { get parent() { throw new Error('Render frame was disposed'); }, url: 'app://bundle/index.html' } };
  assert.equal(isTrustedDashboardSender(disposed, dashboard), false, 'a disposed frame throws; treated as untrusted');
});

function clock(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("r2-21: only clicks, taps, Enter and Space count as a gesture; the app's own Alt+T does not", () => {
  // The exact event src/multi-lurk.js sends every Twitch cell (sendInputEvent shape).
  assert.equal(isUserGestureInput({ type: 'keyDown', keyCode: 't', modifiers: ['alt'] }), false);
  assert.equal(isUserGestureInput({ type: 'keyUp', keyCode: 't', modifiers: ['alt'] }), false);
  // The same key as before-input-event / input-event report it.
  assert.equal(isUserGestureInput({ type: 'keyDown', key: 't', code: 'KeyT', alt: true, meta: false, modifiers: ['alt'] }), false);
  assert.equal(isUserGestureInput({ type: 'rawKeyDown', key: 't', code: 'KeyT', alt: false, modifiers: [] }), false, 'any other key: typing in chat is not asking to open a link');
  assert.equal(isUserGestureInput({ type: 'char', key: 'Enter' }), false, 'char follows the keyDown that already counted');

  for (const ok of [
    { type: 'mouseDown', button: 'left', x: 1, y: 1 }, { type: 'mouseUp', button: 'left' }, { type: 'gestureTap' }, { type: 'touchEnd' },
    { type: 'keyDown', key: 'Enter', code: 'Enter', alt: false, meta: false, modifiers: [] },
    { type: 'rawKeyDown', key: 'Enter', code: 'NumpadEnter', modifiers: [] },
    { type: 'keyDown', key: ' ', code: 'Space', modifiers: [] },
    { type: 'keyDown', key: 'Enter', control: true, modifiers: ['control'] }, // Ctrl+Enter opens a link in a new tab
    { type: 'keyDown', keyCode: 'Return' }, { type: 'keyDown', keyCode: 'Space' },
  ]) assert.equal(isUserGestureInput(ok), true, JSON.stringify(ok));

  for (const bad of [
    { type: 'keyDown', key: 'Enter', alt: true, modifiers: ['alt'] },
    { type: 'keyDown', key: 'Enter', meta: true, modifiers: ['meta'] },
    { type: 'keyDown', keyCode: 'Return', modifiers: ['command'] },
    { type: 'keyUp', key: 'Enter' },
    { type: 'mouseMove' }, { type: 'mouseWheel' }, { type: 'mouseEnter' }, { type: 'contextMenu' }, { type: 'gestureScrollBegin' },
    { type: 'undefined' }, {}, null, undefined, 'mouseDown',
  ]) assert.equal(isUserGestureInput(bad), false, JSON.stringify(bad));
});

// Pins each modifier veto on its own, in each of the two shapes Electron
// uses: the { alt, meta } booleans with no modifiers array, and a modifiers
// array with no booleans. Also pins the key pattern's anchors: Backspace ends
// in "space" but is typing, not activating a link.
test('gesture input: Alt, Meta, Command or Cmd held vetoes Enter/Space in either event shape', () => {
  for (const bad of [
    { type: 'keyDown', key: 'Enter', code: 'Enter', alt: true, meta: false },  // booleans only
    { type: 'keyDown', key: 'Enter', code: 'Enter', alt: false, meta: true },
    { type: 'rawKeyDown', key: ' ', code: 'Space', alt: true },
    { type: 'keyDown', keyCode: 'Return', modifiers: ['alt'] },                 // modifiers only
    { type: 'keyDown', keyCode: 'Return', modifiers: ['Alt'] },
    { type: 'keyDown', keyCode: 'Return', modifiers: ['meta'] },
    { type: 'keyDown', keyCode: 'Return', modifiers: ['cmd'] },
    { type: 'keyDown', keyCode: 'Space', modifiers: ['shift', 'alt'] },
  ]) assert.equal(isUserGestureInput(bad), false, JSON.stringify(bad));

  for (const typing of [
    { type: 'keyDown', key: 'Backspace', code: 'Backspace', modifiers: [] },
    { type: 'rawKeyDown', keyCode: 'Backspace' },
  ]) assert.equal(isUserGestureInput(typing), false, JSON.stringify(typing));

  // Control and Shift are not vetoes: Ctrl+Enter / Shift+Enter still activate.
  assert.equal(isUserGestureInput({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] }), true);
  assert.equal(isUserGestureInput({ type: 'keyDown', key: 'Enter', shift: true, alt: false, meta: false }), true);
});

test("r2-21 regression: a page cannot ride the synthesized Alt+T to the user's browser", () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  const note = (input) => { if (isUserGestureInput(input)) gate.noteGesture(cell); };
  note({ type: 'keyDown', keyCode: 't', modifiers: ['alt'] });
  note({ type: 'keyUp', keyCode: 't', modifiers: ['alt'] });
  c.advance(1000);
  assert.equal(gate.decide(cell, 'https://ads.example/landing', { focused: true }).open, false);
  note({ type: 'mouseDown', button: 'left' });
  assert.equal(gate.decide(cell, 'https://example.com/chat-link', { focused: true }).open, true, 'a real click still works');
});

// Every verdict is compared whole: the reason is the log text and part of the
// log-throttle key, and a refusal must never carry open: true.
const refused = (reason) => ({ open: false, reason });

test('external opens need a recent gesture and a focused window', () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  const url = 'https://example.com/chat-link';

  assert.deepEqual(gate.decide(cell, url, { focused: true }), refused('no click or key press just before it'), 'no gesture yet: a script calling window.open on its own');
  gate.noteGesture(cell);
  assert.deepEqual(gate.decide(cell, url, { focused: false }), refused('its window was not focused'));
  assert.deepEqual(gate.decide(cell, url, {}), refused('its window was not focused'), 'focus unknown counts as unfocused');
  assert.deepEqual(gate.decide(cell, url, { focused: true }), { open: true, reason: '', href: url });

  // The same click opens nothing more, even once the rate limit has passed:
  // the gesture is spent.
  c.advance(3000);
  assert.deepEqual(gate.decide(cell, 'https://example.com/second', { focused: true }), refused('no click or key press just before it'));

  // Gesture too old.
  gate.noteGesture(cell);
  c.advance(6000);
  assert.deepEqual(gate.decide(cell, 'https://example.com/late', { focused: true }), refused('no click or key press just before it'));
});

test('external opens: a plain http link opens too, and the verdict carries the normalized href', () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  gate.noteGesture(cell);
  assert.deepEqual(gate.decide(cell, 'http://example.com/plain-http', { focused: true }), { open: true, reason: '', href: 'http://example.com/plain-http' });
  c.advance(2000);
  gate.noteGesture(cell);
  assert.deepEqual(gate.decide(cell, 'HTTPS://Example.COM', { focused: true }), { open: true, reason: '', href: 'https://example.com/' });
});

test('external opens are rate limited and deduplicated per opener', () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, 'https://a.example/', { focused: true }).open, true);
  c.advance(500);
  gate.noteGesture(cell);
  assert.deepEqual(gate.decide(cell, 'https://b.example/', { focused: true }), refused('rate limited'));
  c.advance(2000);
  gate.noteGesture(cell);
  assert.deepEqual(gate.decide(cell, 'https://a.example/', { focused: true }), refused('same link again'));
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, 'https://b.example/', { focused: true }).open, true);

  // Another opener has its own budget.
  const other = {};
  gate.noteGesture(other);
  assert.equal(gate.decide(other, 'https://c.example/', { focused: true }).open, true);
});

// Pins the three windows at their exact edges (defaults: gesture 5000 ms,
// rate limit 2000 ms, dedupe 10000 ms): each boundary value is still on the
// permissive side, one millisecond further is not.
test('external opens: exact edges of the gesture window, the rate limit and the dedupe window', () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  const open = (url) => gate.decide(cell, url, { focused: true });

  gate.noteGesture(cell);
  c.advance(5000);
  assert.equal(open('https://a.example/').open, true, 'a gesture exactly 5000 ms old still counts');

  c.advance(1999);
  gate.noteGesture(cell);
  assert.deepEqual(open('https://b.example/'), refused('rate limited'), '1999 ms after an open');
  c.advance(1);
  assert.equal(open('https://b.example/').open, true, 'exactly 2000 ms after an open');

  c.advance(9999);
  gate.noteGesture(cell);
  assert.deepEqual(open('https://b.example/'), refused('same link again'), '9999 ms after opening the same link');
  c.advance(1);
  assert.equal(open('https://b.example/').open, true, 'exactly 10000 ms later the same link may open again');

  gate.noteGesture(cell);
  c.advance(5001);
  assert.deepEqual(open('https://c.example/'), refused('no click or key press just before it'), 'a gesture 5001 ms old');
});

test('external opens refuse every non-web scheme, even right after a click', () => {
  const gate = createExternalOpenGate();
  const cell = {};
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:', 'search-ms:query=x', 'javascript:alert(1)', 'mailto:x@y.z', 'app://bundle/index.html', 'ftp://x.example/', 'not a url', '']) {
    gate.noteGesture(cell);
    assert.deepEqual(gate.decide(cell, bad, { focused: true }), refused('not an http(s) link'), bad);
  }
});

// Pins the opener guard on both methods: the gate keys a WeakMap by the
// opener, so a missing or primitive key must be refused (decide) or ignored
// (noteGesture), never reach the WeakMap and throw.
test('external opens: an opener that is not an object arms nothing and never throws', () => {
  const gate = createExternalOpenGate();
  for (const key of [null, undefined, '', 'cell-1', 42, true]) {
    assert.doesNotThrow(() => gate.noteGesture(key), String(key));
    assert.deepEqual(gate.decide(key, 'https://x.example/', { focused: true }), refused('no opener'), String(key));
  }
});

test('log throttle: once per key per interval, again at exactly intervalMs', () => {
  const c = clock();
  const t = createLogThrottle({ intervalMs: 1000, now: c.now });
  assert.equal(t.shouldLog('a'), true);
  assert.equal(t.shouldLog('a'), false);
  assert.equal(t.shouldLog('b'), true);
  c.advance(999);
  assert.equal(t.shouldLog('a'), false, '999 ms later');
  c.advance(1);
  assert.equal(t.shouldLog('a'), true, 'exactly intervalMs later');
  assert.equal(t.shouldLog('a'), false, 'and the interval restarts from there');
});

// Pins the default interval: main.js's security log passes no intervalMs.
test('log throttle: the default interval is one hour', () => {
  const c = clock();
  const t = createLogThrottle({ now: c.now });
  assert.equal(t.shouldLog('k'), true);
  c.advance(60 * 60 * 1000 - 1);
  assert.equal(t.shouldLog('k'), false, 'a millisecond short of an hour');
  c.advance(1);
  assert.equal(t.shouldLog('k'), true);
});

// Pins the memory bound: at most maxKeys keys are remembered, and the key that
// would exceed it clears the map first. Every key here is well inside its
// (default, one hour) interval, so a key logs again only if it was forgotten.
test('log throttle: remembers at most maxKeys keys; the next new key resets the map', () => {
  const c = clock();
  const t = createLogThrottle({ maxKeys: 3, now: c.now });
  for (const k of ['a', 'b', 'c']) assert.equal(t.shouldLog(k), true, k);
  assert.equal(t.shouldLog('a'), false, 'three keys fit: a is still remembered');
  assert.equal(t.shouldLog('d'), true);
  assert.equal(t.shouldLog('a'), true, 'the fourth key cleared the map: a logs again inside its hour');
  assert.equal(t.shouldLog('d'), false, 'what came after the reset is remembered');
});

test('r2-22: a burst of distinct origins logs at most maxPerMinute lines, then one summary when the minute ends', async () => {
  const c = createClock();
  const summaries = [];
  const t = createLogThrottle({ maxPerMinute: 20, onSuppressed: (n) => summaries.push(n), now: () => c.now, timers: c });
  let logged = 0;
  // A page cycling window.open through random subdomains: every key is new.
  for (let i = 0; i < 100; i++) if (t.shouldLog(`a popup|stream|https://r${i}.ads.example`)) logged++;
  assert.equal(logged, 20);
  assert.deepEqual(summaries, [], 'nothing until the minute is over');
  assert.equal(c.pending(), 1, 'one summary timer, however many were refused');
  // A repeat of a refused key is not counted twice.
  t.shouldLog('a popup|stream|https://r50.ads.example');
  await c.advance(60 * 1000);
  assert.deepEqual(summaries, [80]);
  assert.equal(c.pending(), 0);
  // The next minute logs again.
  assert.equal(t.shouldLog('a popup|stream|https://fresh.example'), true);
  await c.advance(60 * 1000);
  assert.deepEqual(summaries, [80], 'no summary for a minute that refused nothing');
});

test('log throttle: without maxPerMinute there is no cap and no timer (the auto-sync throttle)', () => {
  const c = createClock();
  const t = createLogThrottle({ maxKeys: 1000, now: () => c.now, timers: c });
  for (let i = 0; i < 200; i++) assert.equal(t.shouldLog(`k${i}`), true);
  assert.equal(c.pending(), 0);
});

// Pins the cap's minute: 60 s long, opened by the first line logged in it, with
// the summary landing exactly when that minute ends, not when the cap is first
// hit and not a full minute after that.
test('log throttle: the per-minute cap spans a full minute from its first line, and the summary lands as it ends', async () => {
  const c = createClock();
  const summaries = [];
  const t = createLogThrottle({ maxPerMinute: 1, onSuppressed: (n) => summaries.push(n), now: () => c.now, timers: c });
  await c.advance(1000);
  assert.equal(t.shouldLog('k1'), true, 'opens a minute at t=1000');
  await c.advance(30 * 1000);
  assert.equal(t.shouldLog('k2'), false, '30 s in: same minute, cap reached');
  assert.equal(t.shouldLog('k3'), false);
  await c.advance(29999);
  assert.deepEqual(summaries, [], 'the minute is not over');
  await c.advance(1);
  assert.deepEqual(summaries, [2], 'at t=61000, exactly when it ends');
  assert.equal(t.shouldLog('k4'), true, 'a new minute');
});

// Pins onSuppressed as optional: with no callback the overflow is dropped
// quietly, and the summary timer must not call null from inside a timer.
test('log throttle: a cap without onSuppressed drops the overflow without throwing', async () => {
  const c = createClock();
  const t = createLogThrottle({ maxPerMinute: 1, now: () => c.now, timers: c });
  assert.equal(t.shouldLog('a'), true);
  assert.equal(t.shouldLog('b'), false);
  assert.equal(c.pending(), 1);
  await c.advance(60 * 1000);
  assert.equal(c.pending(), 0);
  assert.equal(t.shouldLog('c'), true);
});

// Pins the default timers: main.js's security throttle passes none, so the
// summary has to go through the real setTimeout. The cap is hit in the last
// millisecond of the minute so that real timer fires at once.
test('log throttle: with the default timers the summary still arrives (the security log passes none)', async () => {
  let now = 0;
  const summaries = [];
  const t = createLogThrottle({ maxPerMinute: 1, onSuppressed: (n) => summaries.push(n), now: () => now });
  assert.equal(t.shouldLog('a'), true);
  now = 60 * 1000 - 1;
  assert.equal(t.shouldLog('b'), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(summaries, [1]);
});

test('download allowlist: only what the dashboard asked for, once, before it expires', () => {
  const c = clock();
  const d = createDownloadAllowlist({ ttlMs: 60000, now: c.now });
  const url = 'https://production.assets.clips.twitchcdn.net/v2/media/abc/video.mp4?sig=1&token=%7B%22a%22%7D';

  assert.equal(d.take([url]), null, 'nothing expected yet: a page-initiated download');
  assert.equal(d.expect(url, 'my clip.mp4'), true);
  // Matched by origin + path, so the signed query may be spelled differently,
  // and via any hop of the redirect chain.
  assert.equal(d.take(['https://production.assets.clips.twitchcdn.net/v2/media/abc/video.mp4?sig=1&token={"a"}', 'https://cdn2.example/x']), 'my clip.mp4');
  assert.equal(d.take([url]), null, 'used up');

  d.expect(url, 'late.mp4');
  c.advance(60001);
  assert.equal(d.take([url]), null, 'expired');

  d.expect('https://a.example/1.mp4', 'one.mp4');
  d.expect('https://a.example/2.mp4', 'two.mp4');
  assert.equal(d.take(['https://a.example/2.mp4']), 'two.mp4', 'two clips close together each keep their own name');
  assert.equal(d.take(['https://a.example/1.mp4']), 'one.mp4');

  assert.equal(d.expect('not a url', 'x'), false);
  assert.equal(d.take('https://evil.example/malware.exe'), null);
});

// Pins the defaults main.js uses (createDownloadAllowlist() with no options):
// a request stays good for one minute, its last millisecond included.
test('download allowlist: by default a request is good for exactly one minute', () => {
  const c = clock();
  const d = createDownloadAllowlist({ now: c.now });
  d.expect('https://a.example/1.mp4', 'one.mp4');
  c.advance(60 * 1000);
  assert.equal(d.take(['https://a.example/1.mp4']), 'one.mp4', 'exactly 60000 ms old');
  d.expect('https://a.example/2.mp4', 'two.mp4');
  c.advance(60 * 1000 + 1);
  assert.equal(d.take(['https://a.example/2.mp4']), null, '60001 ms old');
});

// Pins the cap: never more than maxEntries pending, oldest dropped first.
test('download allowlist: holds at most maxEntries requests and drops the oldest first', () => {
  const c = clock();
  const d = createDownloadAllowlist({ maxEntries: 2, now: c.now });
  d.expect('https://a.example/1.mp4', 'one.mp4');
  d.expect('https://a.example/2.mp4', 'two.mp4');
  assert.equal(d.take(['https://a.example/1.mp4']), 'one.mp4', 'exactly maxEntries: both kept');
  d.expect('https://a.example/1.mp4', 'one again.mp4');
  d.expect('https://a.example/3.mp4', 'three.mp4');
  assert.equal(d.take(['https://a.example/2.mp4']), null, 'a third request dropped the oldest');
  assert.equal(d.take(['https://a.example/3.mp4']), 'three.mp4');
  assert.equal(d.take(['https://a.example/1.mp4']), 'one again.mp4');
});

// Pins take()'s input forms: a bare URL is a one-hop chain, and a hop that
// does not parse is skipped rather than ending the search.
test('download allowlist: take() accepts a bare URL and skips unparsable hops', () => {
  const d = createDownloadAllowlist();
  d.expect('https://a.example/clip.mp4', 'clip.mp4');
  assert.equal(d.take('https://a.example/clip.mp4?sig=2'), 'clip.mp4');
  d.expect('https://a.example/clip.mp4', 'again.mp4');
  assert.equal(d.take(['not a url', '', 'https://a.example/clip.mp4']), 'again.mp4');
  assert.equal(d.take(['not a url', null]), null);
});

// Found by mutation testing: 0 doubled as "never", so a clock that starts
// near 0 refused the first open and ignored a gesture noted at 0.
test('external-open gate: a clock starting at 0 behaves like any other', () => {
  let t = 0;
  const gate = createExternalOpenGate({ now: () => t });
  const key = {};
  gate.noteGesture(key);
  t = 100;
  assert.equal(gate.decide(key, 'https://example.com/a', { focused: true }).open, true);
  t = 200;
  gate.noteGesture(key);
  assert.equal(gate.decide(key, 'https://example.com/b', { focused: true }).reason, 'rate limited', 'still rate limited after a real open');
});
