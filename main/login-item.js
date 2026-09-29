// Mirrors config.launchOnStartup into the OS login items. Tested with a fake
// `app` in test/main-login-item.test.js.
//
// Why: on Windows, getLoginItemSettings() only reports openAtLogin when it is
// asked with the SAME args the entry was written with (Electron compares the
// whole "exe" + args command line). Asked with none, it always said false, so
// turning the setting off returned early and the app kept starting at every
// sign-in.

// Started this way the app comes up in the tray instead of stealing focus.
const STARTUP_ARGS = ['--hidden'];

// Returns 'enabled', 'disabled' or 'unchanged', for the log.
function syncLoginItem(app, want) {
  const current = app.getLoginItemSettings({ args: STARTUP_ARGS }) || {};

  if (want) {
    // Never rewrite an entry that is already there: every write with the
    // default enabled:true re-approves it, silently undoing a user who turned
    // it off in Task Manager's Startup apps.
    if (current.openAtLogin) return 'unchanged';
    app.setLoginItemSettings({ openAtLogin: true, args: STARTUP_ARGS });
    return 'enabled';
  }

  // Off: remove our entry and any other per-user entry that launches this exe
  // (written by an older build, under another name or with other args), so a
  // mismatch in the command line can never leave the app stuck at login.
  const names = new Set();
  if (current.openAtLogin) names.add('');
  for (const item of Array.isArray(current.launchItems) ? current.launchItems : []) {
    if (item && item.scope === 'user' && typeof item.name === 'string') names.add(item.name);
  }
  if (!names.size) return 'unchanged';
  for (const name of names) {
    app.setLoginItemSettings(name ? { openAtLogin: false, name } : { openAtLogin: false });
  }
  return 'disabled';
}

module.exports = { STARTUP_ARGS, syncLoginItem };
