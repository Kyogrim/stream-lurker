// Gate tests for main/login-item.js (F27): "Launch on startup" can be turned
// off again on Windows. The fake app reproduces Electron's win32 behaviour
// (shell/browser/browser_win.cc): the Run value is `"exe" args`, and
// openAtLogin is an exact string compare against the args it was asked with.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { STARTUP_ARGS, syncLoginItem } = require('../main/login-item');

const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\Stream Lurker\\Stream Lurker.exe';
const AUMID = 'com.streamlurker.app';

function fakeWinApp(initial = {}) {
  const run = new Map(Object.entries(initial)); // value name -> command line
  const approvedOff = new Set(); // StartupApproved "disabled" entries
  const calls = [];
  const commandLine = (args = []) => [`"${EXE}"`, ...args].join(' ');
  return {
    run,
    approvedOff,
    calls,
    getLoginItemSettings(options = {}) {
      const launchItems = [];
      for (const [name, cmd] of run) {
        const m = /^"([^"]+)"\s*(.*)$/.exec(cmd);
        if (!m || m[1].toLowerCase() !== EXE.toLowerCase()) continue;
        launchItems.push({ name, path: m[1], args: m[2] ? m[2].split(' ') : [], scope: 'user', enabled: !approvedOff.has(name) });
      }
      return {
        openAtLogin: run.get(AUMID) === commandLine(options.args),
        executableWillLaunchAtLogin: launchItems.some(i => i.enabled),
        launchItems,
      };
    },
    setLoginItemSettings(settings) {
      calls.push(settings);
      const name = settings.name || AUMID;
      if (settings.openAtLogin) {
        run.set(name, commandLine(settings.args));
        if (settings.enabled === false) approvedOff.add(name); else approvedOff.delete(name);
      } else {
        run.delete(name);
        approvedOff.delete(name);
      }
    },
  };
}

test('enable from nothing writes the entry with --hidden', () => {
  const app = fakeWinApp();
  assert.equal(syncLoginItem(app, true), 'enabled');
  assert.equal(app.run.get(AUMID), `"${EXE}" --hidden`);
  assert.deepEqual(STARTUP_ARGS, ['--hidden']);
});

test('enable when already registered does not rewrite (keeps a Task Manager "disabled")', () => {
  const app = fakeWinApp({ [AUMID]: `"${EXE}" --hidden` });
  app.approvedOff.add(AUMID); // user disabled it in Task Manager > Startup apps
  assert.equal(syncLoginItem(app, true), 'unchanged');
  assert.equal(app.calls.length, 0, 'a write with enabled:true would re-approve it');
  assert.ok(app.approvedOff.has(AUMID));
});

test('regression F27: disable removes an entry registered with --hidden', () => {
  const app = fakeWinApp({ [AUMID]: `"${EXE}" --hidden` });
  // The bug: asked without args, Electron reports false, so "off" looked done.
  assert.equal(app.getLoginItemSettings().openAtLogin, false);
  assert.equal(syncLoginItem(app, false), 'disabled');
  assert.equal(app.run.size, 0);
});

test('disable also removes an entry written without args or under another name', () => {
  const app = fakeWinApp({ [AUMID]: `"${EXE}"`, 'electron.app.Stream Lurker': `"${EXE}" --hidden`, OtherApp: '"C:\\other.exe"' });
  assert.equal(syncLoginItem(app, false), 'disabled');
  assert.deepEqual([...app.run.keys()], ['OtherApp'], 'another program\'s entry is left alone');
});

test('disable with nothing registered writes nothing and reports unchanged', () => {
  const app = fakeWinApp({ OtherApp: '"C:\\other.exe"' });
  assert.equal(syncLoginItem(app, false), 'unchanged');
  assert.equal(app.calls.length, 0);
});

test('a machine-wide entry is not touched (it cannot be removed per user)', () => {
  const app = fakeWinApp();
  app.getLoginItemSettings = () => ({ openAtLogin: false, launchItems: [{ name: 'X', path: EXE, args: [], scope: 'machine', enabled: true }] });
  assert.equal(syncLoginItem(app, false), 'unchanged');
});

test('toggling on and off round-trips on the fake registry', () => {
  const app = fakeWinApp();
  assert.equal(syncLoginItem(app, true), 'enabled');
  assert.equal(syncLoginItem(app, true), 'unchanged');
  assert.equal(syncLoginItem(app, false), 'disabled');
  assert.equal(syncLoginItem(app, false), 'unchanged');
  assert.equal(app.run.size, 0);
});

test('macOS-shaped settings (no launchItems) still work', () => {
  let open = true;
  const app = {
    getLoginItemSettings: () => ({ openAtLogin: open }),
    setLoginItemSettings: (s) => { open = !!s.openAtLogin; },
  };
  assert.equal(syncLoginItem(app, false), 'disabled');
  assert.equal(open, false);
});
