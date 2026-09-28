// Gate tests for main/web-security.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STREAM_PARTITION,
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

test('external opens need a recent gesture and a focused window', () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  const url = 'https://example.com/chat-link';

  assert.equal(gate.decide(cell, url, { focused: true }).open, false, 'no gesture yet: a script calling window.open on its own');
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, url, { focused: false }).open, false, 'window not focused');
  const first = gate.decide(cell, url, { focused: true });
  assert.equal(first.open, true);
  assert.equal(first.href, url);

  // A burst from the same click opens nothing more: the gesture is spent.
  assert.equal(gate.decide(cell, 'https://example.com/second', { focused: true }).open, false);

  // Gesture too old.
  gate.noteGesture(cell);
  c.advance(6000);
  assert.equal(gate.decide(cell, 'https://example.com/late', { focused: true }).open, false);
});

test('external opens are rate limited and deduplicated per opener', () => {
  const c = clock();
  const gate = createExternalOpenGate({ now: c.now });
  const cell = {};
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, 'https://a.example/', { focused: true }).open, true);
  c.advance(500);
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, 'https://b.example/', { focused: true }).reason, 'rate limited');
  c.advance(2000);
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, 'https://a.example/', { focused: true }).reason, 'same link again');
  gate.noteGesture(cell);
  assert.equal(gate.decide(cell, 'https://b.example/', { focused: true }).open, true);

  // Another opener has its own budget.
  const other = {};
  gate.noteGesture(other);
  assert.equal(gate.decide(other, 'https://c.example/', { focused: true }).open, true);
});

test('external opens refuse every non-web scheme, even right after a click', () => {
  const gate = createExternalOpenGate();
  const cell = {};
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:', 'search-ms:query=x', 'javascript:alert(1)', 'mailto:x@y.z', 'app://bundle/index.html', 'not a url', '']) {
    gate.noteGesture(cell);
    const v = gate.decide(cell, bad, { focused: true });
    assert.equal(v.open, false, bad);
  }
  assert.equal(gate.decide(null, 'https://x.example/', { focused: true }).open, false);
});

test('log throttle: once per key per interval, bounded memory', () => {
  const c = clock();
  const t = createLogThrottle({ intervalMs: 1000, maxKeys: 3, now: c.now });
  assert.equal(t.shouldLog('a'), true);
  assert.equal(t.shouldLog('a'), false);
  assert.equal(t.shouldLog('b'), true);
  c.advance(1001);
  assert.equal(t.shouldLog('a'), true);
  // Past maxKeys the map is reset rather than growing.
  t.shouldLog('c'); t.shouldLog('d'); t.shouldLog('e');
  assert.equal(t.shouldLog('b'), true, 'forgotten after the reset');
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
