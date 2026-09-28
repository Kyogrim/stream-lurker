// Static guards for the main-process security wiring that cannot run outside
// Electron: what the dashboard preload may require and expose, which windows
// are sandboxed, and that the session and protocol setup happen before any
// page loads. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
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
  for (const hook of ['setWindowOpenHandler', "'will-attach-webview'", "'will-navigate'", "'will-redirect'", "'will-frame-navigate'", "'input-event'", "'before-mouse-event'", "'before-input-event'"]) {
    assert.ok(body.includes(hook), hook);
  }
  // The webview-only early return must come after the guards, or they would
  // never be installed on windows (will-attach-webview fires on the embedder).
  assert.ok(body.indexOf("contents.getType() !== 'webview'") > body.indexOf("'will-frame-navigate'"));
});
