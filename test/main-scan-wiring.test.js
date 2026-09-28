// Static guards for how main.js wires the scan modules. The decisions are
// tested directly in the other main-* tests; these make sure main.js keeps
// routing through them, since main.js itself cannot load outside Electron.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8');

// Source of a top-level function or handler: from its opening line to the
// next line that is exactly "}" or "});".
function block(startMarker) {
  const start = mainJs.indexOf(startMarker);
  assert.ok(start >= 0, `found ${startMarker}`);
  const end = mainJs.slice(start).search(/\n\}\)?;?\n/);
  assert.ok(end > 0, `end of ${startMarker}`);
  return mainJs.slice(start, start + end + 3);
}

test('F26: every scan request goes through the deadline helper', () => {
  const start = mainJs.indexOf('async function getTwitchToken(');
  const end = mainJs.indexOf('async function checkStreamersParallel(');
  assert.ok(start > 0 && end > start);
  const checkers = mainJs.slice(start, end);
  assert.doesNotMatch(checkers, /net\.fetch\(/, 'a bare net.fetch call has no timeout');
  for (const fn of ['getTwitchToken', 'checkTwitchStreamers', 'checkTwitchStreamersGQL', 'checkKickStreamer', 'checkYoutubeStreamer', 'checkRumbleStreamer']) {
    assert.match(block(`async function ${fn}(`), /fetchTextWithDeadline\(net\.fetch/, fn);
  }
});

test('F12: no checker uses the scan time as a stream start', () => {
  assert.doesNotMatch(mainJs, /liveSince:\s*[^,\n]*new Date\(\)\.toISOString\(\)/);
  assert.match(block('async function checkYoutubeStreamer('), /sessionId:\s*page\.sessionId/);
});

test('G2.2: username derefs in the per-channel checkers are inside their try', () => {
  for (const fn of ['checkKickStreamer', 'checkYoutubeStreamer']) {
    const body = block(`async function ${fn}(`);
    assert.ok(body.indexOf('try {') < body.indexOf('String(username)'), fn);
  }
});

test('F25/F67: scans run single-flight; only the interval tick moves the countdown', () => {
  assert.match(mainJs, /const scanRunner = createSingleFlight\(doScan,/);
  assert.doesNotMatch(mainJs, /setInterval\(\s*performScan/);
  const doScan = block('async function doScan(');
  assert.doesNotMatch(doScan, /updateNextScanTime\(/, 'a scan finishing must not restart the countdown');
  assert.match(doScan, /applyScanResults\(results,/);
  const poller = block('function resetPoller(');
  assert.match(poller, /setInterval\(\(\) => \{\s*updateNextScanTime\(\);/);
  assert.match(poller, /scanIntervalMs\(config\)/);
  // User-initiated scans queue a fresh one; nothing calls doScan directly.
  assert.match(block("ipcMain.handle('force-scan'"), /await requestScan\(\)/);
  assert.match(mainJs, /label: 'Force Scan Now',\s*click: \(\) => \{\s*requestScan\(\);/);
  assert.match(block("ipcMain.handle('add-streamer'"), /setTimeout\(requestScan, 500\)/);
  assert.equal((mainJs.match(/\bdoScan\(/g) || []).length, 1, 'doScan is only declared, never called directly');
});

test('F66/G2.2: every config entry point is sanitized before it is used or saved', () => {
  const load = block('function loadConfig(');
  assert.ok(load.indexOf('config = { ...config, ...loaded };') < load.indexOf("sanitizeIncomingConfig(config, 'config.json')"));
  const save = block("ipcMain.handle('save-config'");
  // The dashboard's settings are merged over main's config as `next` (F18/F22).
  assert.ok(save.indexOf('sanitizeIncomingConfig(next') >= 0 && save.indexOf('sanitizeIncomingConfig(next') < save.indexOf('saveConfig(next)'));
  const imp = block("ipcMain.handle('import-config'");
  // The last save is the one that writes the imported config; an earlier one
  // flushes pending watch time into the pre-import snapshot (F11).
  const importSave = imp.indexOf('saveConfig();', imp.indexOf('config = imported.config;'));
  assert.ok(imp.indexOf('sanitizeIncomingConfig(config') >= 0 && imp.indexOf('sanitizeIncomingConfig(config') < importSave);
  assert.match(block('function sanitizeIncomingConfig('), /dropped-streamers-/);
});

test('r4-3: dropped streamer entries reach the activity log through the capped helper only', () => {
  const sanitize = block('function sanitizeIncomingConfig(');
  assert.match(sanitize, /for \(const line of droppedStreamerLines\(dropped, salvageFile\)\) addLog\(line\);/);
  assert.doesNotMatch(sanitize, /for \(const d of dropped\)/, 'no line per entry');
  assert.equal((sanitize.match(/addLog\(/g) || []).length, 4, 'the clamp lines, the salvage line or its failure, and the capped list');
  // The salvage file is only named once it was written.
  assert.ok(sanitize.indexOf("fs.writeFileSync(salvagePath") < sanitize.indexOf('salvageFile = path.basename(salvagePath);'));
});

test('G4.6: watch time is credited only when liveness allows, and sessions end at the last confirmation', () => {
  const ticker = block('function startWatchTimeTracking(');
  const gate = ticker.indexOf('streamLiveness.credit(key');
  assert.ok(gate > 0 && gate < ticker.indexOf('config.watchTime.streamers[streamerKey] ='));
  assert.ok(ticker.indexOf('if (!verdict.credit) continue;') < ticker.indexOf('updated = true'));
  assert.match(block('function finalizeSession('), /streamLiveness\.sessionEnd\(key/);
  assert.match(block('function spawnStreamContainer('), /streamLiveness\.start\(key/);
  const tabs = block("ipcMain.handle('update-active-tabs'");
  assert.match(tabs, /streamLiveness\.forget\(key\)/);
  assert.match(tabs, /if \(!activeWindows\.has\(t\)\) streamLiveness\.start\(t/);
});

test('issue-2: a scan that throws counts as a finished scan that confirmed nothing', () => {
  // Staleness is measured against finished scans; one that throws before
  // applyScanResults would otherwise leave every open cell credited forever.
  const failed = block('const scanRunner = createSingleFlight(doScan,');
  assert.match(failed, /\(err\) => \{[\s\S]*streamLiveness\.scanFailed\(Date\.now\(\)\);/);
});

test('F65: the Helix token is keyed to the credentials and built with URLSearchParams', () => {
  const token = block('async function getTwitchToken(');
  assert.match(token, /twitchCredentialKey\(config\.twitchClientId, config\.twitchClientSecret\)/);
  assert.match(token, /new URLSearchParams\(/);
  assert.doesNotMatch(mainJs, /twitchTokenCache/);
});

test('G4.8: the last scan is kept and served to the dashboard', () => {
  const doScan = block('async function doScan(');
  assert.ok(doScan.indexOf('lastScanResults = results;') < doScan.indexOf("send('status-update', results)"));
  assert.match(block("ipcMain.handle('get-statuses'"), /return lastScanResults;/);
  assert.match(mainJs, /let lastScanResults = \[\];/);
  assert.match(preloadJs, /getStatuses:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-statuses'\)/);
});
