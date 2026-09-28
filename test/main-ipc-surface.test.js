// Static guards for the main-process security wiring that cannot run outside
// Electron: what the dashboard preload may require and expose, which windows
// are sandboxed, and that the session and protocol setup happen before any
// page loads. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const mainJs = read('main.js');
const preloadJs = read('preload.js');

function rendererSources() {
  const files = ['renderer.js', 'index.html', 'preload.js', ...fs.readdirSync(path.join(REPO, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`)];
  return files.map(f => ({ file: f, text: read(f) }));
}

test('C4: the sandboxed dashboard preload only requires electron', () => {
  const requires = [...preloadJs.matchAll(/\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map(m => m[2]);
  assert.deepEqual([...new Set(requires)], ['electron']);
  assert.doesNotMatch(preloadJs, /\bprocess\.(env|versions|platform)|__dirname|__filename/, 'Node globals a sandboxed preload lacks');
});

test('C5: the Twitch auth token is not reachable from any renderer', () => {
  assert.doesNotMatch(mainJs, /ipcMain\.(handle|on)\(\s*['"]get-twitch-auth-token['"]/);
  for (const { file, text } of rendererSources()) {
    assert.doesNotMatch(text, /getTwitchAuthToken|get-twitch-auth-token/, file);
  }
});

test('every channel the preload calls has a handler in main.js', () => {
  const invoked = [...preloadJs.matchAll(/ipcRenderer\.(?:invoke|sendSync|send)\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(invoked.length > 20, `found ${invoked.length}`);
  for (const channel of invoked) {
    const re = new RegExp(`ipcMain\\.(?:handle|on)\\(\\s*['"]${channel.replace(/[-]/g, '\\-')}['"]`);
    assert.match(mainJs, re, channel);
  }
});

test('F08/F21: no window turns the renderer sandbox off, and the dashboard turns it on', () => {
  assert.doesNotMatch(mainJs, /sandbox\s*:\s*false/);
  const dash = mainJs.match(/preload:\s*path\.join\(__dirname,\s*'preload\.js'\)[\s\S]*?\}/);
  assert.ok(dash, 'dashboard webPreferences found');
  assert.match(dash[0], /sandbox:\s*true/);
  assert.match(dash[0], /contextIsolation:\s*true/);
  assert.match(dash[0], /nodeIntegration:\s*false/);
});

test('G3.4: the dashboard is served from app://bundle, never file://', () => {
  assert.doesNotMatch(mainJs, /loadFile\(\s*['"]index\.html['"]\s*\)/);
  const register = mainJs.indexOf('protocol.registerSchemesAsPrivileged(');
  const ready = mainJs.indexOf('app.whenReady()');
  assert.ok(register > 0 && register < ready, 'scheme privileges are registered before ready');
  const handle = mainJs.indexOf('protocol.handle(DASHBOARD_SCHEME');
  const firstWindow = mainJs.indexOf('createMainWindow();', ready);
  assert.ok(handle > ready && handle < firstWindow, 'handler installed before the dashboard window exists');
  // The first statement on ready, before anything that can throw: the
  // startup-failure path opens the window on app:// whatever broke.
  const body = mainJs.slice(mainJs.indexOf('app.whenReady().then(async () => {'));
  const firstStatement = body.split('\n').slice(1).map(l => l.trim()).find(l => l && !l.startsWith('//'));
  assert.equal(firstStatement, 'protocol.handle(DASHBOARD_SCHEME, createDashboardHandler(__dirname));');
  assert.ok(body.indexOf('protocol.handle(DASHBOARD_SCHEME') < body.indexOf('loadConfig();'), 'before loadConfig');
  const failure = body.slice(body.indexOf('}).catch((err) => {'), body.indexOf('\n});'));
  assert.match(failure, /if \(!protocol\.isProtocolHandled\(DASHBOARD_SCHEME\)\) protocol\.handle\(DASHBOARD_SCHEME, createDashboardHandler\(__dirname\)\);/);
  assert.ok(failure.indexOf('isProtocolHandled') < failure.indexOf('startRuntime();'), 'registered before the runtime opens the window');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.electronFuses.grantFileProtocolExtraPrivileges, false);
  assert.equal(pkg.build.electronFuses.enableCookieEncryption, undefined, 'one-way; must be a deliberate separate change');
});

test('G1.1-G1.3: both sessions are locked down before extensions or any window load', () => {
  const ready = mainJs.indexOf('app.whenReady()');
  const extensions = mainJs.indexOf('await loadExtensions();', ready);
  for (const call of ['lockDownSession(session.defaultSession);', "lockDownSession(session.fromPartition('persist:default'));"]) {
    const at = mainJs.indexOf(call, ready);
    assert.ok(at > ready && at < extensions, call);
  }
  const lock = mainJs.slice(mainJs.indexOf('function lockDownSession('), mainJs.indexOf('function handleWillDownload('));
  for (const api of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setDevicePermissionHandler', "on('will-download'"]) {
    assert.ok(lock.includes(api), api);
  }
  assert.match(mainJs, /app\.on\('session-created',\s*lockDownSession\)/);
});

test('F10/F19/G1.4: the web-contents-created choke point installs every guard', () => {
  const start = mainJs.indexOf("app.on('web-contents-created'");
  const body = mainJs.slice(start, mainJs.indexOf('\n});', start));
  for (const hook of ['setWindowOpenHandler', "'will-attach-webview'", "'will-navigate'", "'will-redirect'", "'will-frame-navigate'", "'did-start-navigation'", "'input-event'", "'before-mouse-event'", "'before-input-event'", "'select-bluetooth-device'"]) {
    assert.ok(body.includes(hook), hook);
  }
  // The webview-only early return must come after the guards, or they would
  // never be installed on windows (will-attach-webview fires on the embedder).
  const early = body.indexOf("contents.getType() !== 'webview'");
  assert.ok(early > body.indexOf("'will-frame-navigate'"));
  assert.ok(early > body.indexOf("'did-start-navigation'"), 'pop-outs are stream surfaces too');
  // Issue 6: a load the embedder starts after attach is stopped when it
  // leaves the platforms (the rule is isBlockedStreamLoad, in web-security).
  const start2 = body.slice(body.indexOf("contents.on('did-start-navigation'"));
  assert.match(start2, /if \(!isBlockedStreamLoad\(contentsRole\(contents\), \{/);
  assert.match(start2, /contents\.stop\(\)/);
  assert.match(start2, /logSecurityOnce\(/);
  // Issue 1: the attach verdict comes from sanitizeWebviewAttach, which pins
  // the guest's partition, and nothing but the dashboard may embed.
  assert.match(body, /const verdict = sanitizeWebviewAttach\(webPreferences, params\);\s*if \(contentsRole\(contents\) !== 'dashboard'\)/);
  // Popups a page opens inherit its role, so they keep its allowlist.
  assert.match(body, /contents\.on\('did-create-window', \(child\) => \{\s*setContentsRole\(child\.webContents, contentsRole\(contents\)\);/);
});

test('issue-1/G3.4: the stream partition refuses every file: load before anything can load on it', () => {
  // Deterministic, unlike the deferred stop(): a file: load commits too fast
  // to be recalled, and a compromised dashboard could then read local text
  // files back out of a cell. The default session keeps file: (the one-time
  // storage import window loads style.css from it).
  const fn = mainJs.slice(mainJs.indexOf('function refuseFileLoadsOnStreamPartition('), mainJs.indexOf('\n}\n', mainJs.indexOf('function refuseFileLoadsOnStreamPartition(')));
  assert.match(fn, /const ses = session\.fromPartition\('persist:default'\);/);
  assert.match(fn, /if \(ses\.protocol\.isProtocolHandled\('file'\)\) return;\s*ses\.protocol\.handle\('file', \(\) => new Response\('', \{ status: 403 \}\)\);/);
  assert.doesNotMatch(mainJs, /defaultSession\.protocol\.handle\('file'|(?<![.\w])protocol\.handle\('file'/, 'never on the default session');
  // On ready: after the lockdown, before extensions and before the runtime
  // opens the dashboard window (which embeds the cells).
  const body = mainJs.slice(mainJs.indexOf('app.whenReady().then(async () => {'));
  const ready = body.slice(0, body.indexOf('}).catch((err) => {'));
  const call = ready.indexOf('refuseFileLoadsOnStreamPartition();');
  assert.ok(call > ready.indexOf("lockDownSession(session.fromPartition('persist:default'));"), 'after the lockdown');
  assert.ok(call < ready.indexOf('await loadExtensions();'), 'before any extension loads on the partition');
  assert.ok(call < ready.indexOf('startRuntime();'), 'before the dashboard window exists');
  // The startup-failure path opens the window too, so it repeats the call.
  const failure = body.slice(body.indexOf('}).catch((err) => {'), body.indexOf('\n});'));
  assert.match(failure, /try \{ refuseFileLoadsOnStreamPartition\(\); \} catch \(e\) \{ reportFatal\(/);
  assert.ok(failure.indexOf('refuseFileLoadsOnStreamPartition();') < failure.indexOf('startRuntime();'));
  // createMainWindow is only ever reached through startRuntime (and the
  // macOS activate handler, long after ready).
  const calls = [...mainJs.matchAll(/\bcreateMainWindow\(\);/g)].map(m => m.index);
  const runtime = mainJs.indexOf('function startRuntime(');
  const activate = mainJs.indexOf("app.on('activate'");
  for (const at of calls) assert.ok(at > runtime || at > activate, `createMainWindow() at ${at}`);
});

test('issue-1: an off-platform document that commits in a stream surface anyway is torn down', () => {
  const body = webContentsCreatedBody();
  const nav = body.slice(body.indexOf("contents.on('did-navigate'"));
  assert.match(nav, /^contents\.on\('did-navigate', \(e, url\) => \{\s*if \(!isBlockedStreamLoad\(contentsRole\(contents\), \{ url, isMainFrame: true, isSameDocument: false \}\)\) return;\s*try \{ if \(!contents\.isDestroyed\(\)\) contents\.forcefullyCrashRenderer\(\); \}/);
  // Installed before the webview-only early return: pop-outs are stream
  // surfaces too.
  assert.ok(body.indexOf("contents.on('did-navigate'") < body.indexOf("contents.getType() !== 'webview'"));
});

function webContentsCreatedBody() {
  const start = mainJs.indexOf("app.on('web-contents-created'");
  assert.ok(start > 0, 'web-contents-created handler found');
  return mainJs.slice(start, mainJs.indexOf('\n});', start));
}

test('r2-21: only activation input opens the external-link gate (not the app\'s own Alt+T)', () => {
  const body = webContentsCreatedBody();
  const note = body.slice(body.indexOf('const noteGesture = '), body.indexOf("contents.on('input-event', noteGesture);"));
  assert.match(note, /if \(isUserGestureInput\(input\)\) externalOpenGate\.noteGesture\(contents\);/);
  // The old type-only set counted every key press, the synthesized Alt+T included.
  assert.doesNotMatch(mainJs, /USER_GESTURE_INPUTS/);
  for (const hook of ["contents.on('input-event', noteGesture);", "contents.on('before-mouse-event', noteGesture);", "contents.on('before-input-event', noteGesture);"]) {
    assert.ok(body.includes(hook), hook);
  }
});

test('r2-22: security log lines are capped per minute, with one summary line for the rest', () => {
  const setup = mainJs.slice(mainJs.indexOf('const securityLogThrottle = createLogThrottle('), mainJs.indexOf('function logSecurityOnce('));
  assert.match(setup, /maxPerMinute: 20,/);
  assert.match(setup, /onSuppressed: \(n\) => addLog\(`\[Security\] \$\{n\} more blocked event/);
  // Every security line goes through that one throttle.
  assert.match(mainJs, /function logSecurityOnce\(key, text\) \{\s*if \(securityLogThrottle\.shouldLog\(key\)\) addLog\(`\[Security\] \$\{text\}`\);/);
});

test('r2-23: every surface answers a Web Bluetooth chooser with no device', () => {
  const body = webContentsCreatedBody();
  const at = body.indexOf("contents.on('select-bluetooth-device'");
  assert.ok(at > 0, 'listener installed at the choke point');
  assert.ok(at < body.indexOf("contents.getType() !== 'webview'"), 'before the webview-only early return, so windows get it too');
  const handler = body.slice(at, body.indexOf('});', at));
  // A listener that does not preventDefault gets the first device found.
  assert.match(handler, /e\.preventDefault\(\);/);
  assert.match(handler, /callback\(''\)/);
  assert.ok(handler.indexOf('e.preventDefault();') < handler.indexOf("callback('')"));
});

test('r2-24: a login window may open sign-in and platform popups in-app, sandboxed; everything else is denied', () => {
  const open = mainJs.slice(mainJs.indexOf('function handleWindowOpen('), mainJs.indexOf('function guardTopLevelNavigation('));
  assert.match(open, /if \(contentsRole\(contents\) === 'login' && isLoginPopupUrl\(url\)\) \{/);
  assert.match(open, /webPreferences: \{ sandbox: true, contextIsolation: true, nodeIntegration: false \}/);
  assert.match(open, /parent: BrowserWindow\.fromWebContents\(contents\)/);
  assert.match(open, /openExternallyIfClicked\(contents, url, 'a popup'\);\s*return \{ action: 'deny' \};/);
});

// The source of a top-level ipcMain.handle(...) registration, to its "});".
function handlerSource(channel) {
  const start = mainJs.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start > 0, `handler ${channel} found`);
  return mainJs.slice(start, mainJs.indexOf('\n});', start) + 4);
}

test('G1.4: a pop-out is a stream surface, keeps its label, and loads only a platform page', () => {
  const pop = handlerSource('popout-stream');
  const tag = pop.indexOf("setContentsRole(win.webContents, 'stream');");
  const load = pop.indexOf('win.loadURL(');
  assert.ok(tag > 0, 'tagged as a stream surface (the navigation guards key on the role)');
  assert.ok(load > tag, 'tagged before its first load, so that load is already guarded');
  // No address bar: the "name · PLATFORM" title is the only cue to what it shows.
  assert.match(pop, /win\.on\('page-title-updated', \(e\) => e\.preventDefault\(\)\);/);
  // `url` comes from the renderer.
  assert.match(pop, /win\.loadURL\(isPlatformUrl\(url\) \? url : streamWatchUrl\(platform, username\)\);/);
  assert.equal((pop.match(/\.loadURL\(/g) || []).length, 1, 'no other load in the handler');
});

test('r2-20: every window main.js creates carries its web-content role before it loads anything', () => {
  // The whole web-content policy keys on these tags: an untagged window is
  // 'other' and unrestricted, and without 'dashboard' every <webview> attach
  // is refused. A new window must be added here with its role on purpose.
  const EXPECTED = {
    'function createMainWindow(': 'dashboard',
    'async function runInHiddenPage(': 'hidden',
    "ipcMain.handle('open-login-modal'": 'login',
    "ipcMain.handle('popout-stream'": 'stream',
    "ipcMain.handle('open-clip-window'": 'clip',
  };
  const lines = mainJs.split('\n');
  const offsets = [];
  let pos = 0;
  for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
  const seen = [];
  for (const m of mainJs.matchAll(/\b(\w+) = new BrowserWindow\(/g)) {
    const v = m[1];
    // The top-level declaration this window is created in: the last
    // column-0 function or handler line above it, ending at the next
    // column-0 closing brace.
    let header = null;
    for (let i = offsets.length - 1; i >= 0; i--) {
      if (offsets[i] > m.index) continue;
      const line = lines[i];
      const key = Object.keys(EXPECTED).find(k => line.startsWith(k));
      if (key) { header = key; break; }
      if (/^(?:async )?function |^ipcMain\.handle\(|^app\.on\(/.test(line)) { header = line; break; }
    }
    const end = mainJs.indexOf('\n}', m.index);
    const block = mainJs.slice(m.index, end);
    seen.push(header);
    assert.ok(header in EXPECTED, `a BrowserWindow in "${header}" has no expected role; add it to this test with the role it needs`);
    const role = EXPECTED[header];
    const tag = block.indexOf(`setContentsRole(${v}.webContents, '${role}');`);
    assert.ok(tag > 0, `${header}: ${v} is tagged '${role}'`);
    // loadDashboard() is the dashboard's load (app://bundle/index.html).
    const firstLoad = block.search(new RegExp(`\\b${v}\\.(?:webContents\\.)?load(?:URL|File)\\(|runPageScript\\(${v}\\b|\\bloadDashboard\\(\\)`));
    assert.ok(firstLoad > 0, `${header}: ${v}'s first load found`);
    assert.ok(firstLoad > tag, `${header}: tagged before ${v} loads anything`);
    const other = [...block.matchAll(/setContentsRole\(\w+\.webContents, '(\w+)'\)/g)].map(x => x[1]).filter(r => r !== role);
    assert.deepEqual(other, [], `${header}: no second, conflicting tag`);
  }
  assert.deepEqual(seen.sort(), Object.keys(EXPECTED).sort(), 'exactly these windows, each once');
  // The one intended exception: the migration window of dashboard-protocol.js
  // loads two stylesheets and is destroyed; no other main-process module
  // creates windows.
  for (const f of fs.readdirSync(path.join(REPO, 'main')).filter(n => n.endsWith('.js'))) {
    const text = read(`main/${f}`);
    if (f === 'dashboard-protocol.js') continue;
    assert.doesNotMatch(text, /new BrowserWindow\(/, `main/${f} creates a window main.js cannot tag`);
  }
});

test('F19 regression: every privileged IPC handler goes through the dashboard sender check', () => {
  // The wrapper replaces ipcMain.handle itself, so it must exist before the
  // first registration: one registered above it would skip the check.
  const wrapper = mainJs.indexOf('ipcMain.handle = (channel, listener) =>');
  assert.ok(wrapper > 0, 'wrapper present');
  const firstHandle = mainJs.indexOf("ipcMain.handle('");
  assert.ok(firstHandle > 0, 'handlers registered');
  assert.ok(wrapper < firstHandle, 'wrapper installed before the first ipcMain.handle(\'...\')');
  const wrapped = mainJs.slice(wrapper, mainJs.indexOf('\n});', wrapper));
  assert.match(wrapped, /registerIpcHandler\(channel, \(event, \.\.\.args\) => \{/);
  assert.match(wrapped, /if \(!isTrustedDashboardSender\(event, dashboard\)\) \{[\s\S]*?throw new Error\(/);
  assert.match(wrapped, /return listener\(event, \.\.\.args\);/);
  assert.match(mainJs, /const registerIpcHandler = ipcMain\.handle\.bind\(ipcMain\);/);
  // Every channel is registered through that one function.
  const registrations = mainJs.match(/ipcMain\.handle\(\s*['"`]/g) || [];
  assert.ok(registrations.length > 20, `found ${registrations.length}`);
  // No route around it, in main.js or any main-process module.
  const bypass = /\bipcMain\.(on|once|addListener|prependListener|prependOnceListener|handleOnce)\s*\(|\.ipc\.(handle|handleOnce|on|once|addListener)\s*\(|\bipcMain\s*\[|=\s*ipcMain\.handle\b(?!\.bind\(ipcMain\))|\{[^}]*\bhandle\b[^}]*\}\s*=\s*ipcMain\b/;
  const sources = [{ file: 'main.js', text: mainJs }, ...fs.readdirSync(path.join(REPO, 'main')).filter(f => f.endsWith('.js')).map(f => ({ file: `main/${f}`, text: read(`main/${f}`) }))];
  for (const { file, text } of sources) {
    assert.doesNotMatch(text, bypass, `${file} registers IPC around the sender check`);
  }
});
