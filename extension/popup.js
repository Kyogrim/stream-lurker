// Stream Lurker Connector — reads your platform cookies (including httpOnly ones,
// which a page script can't) and posts them to the desktop app's localhost
// receiver so it can log in without you copy-pasting cookies. The protocol
// (port walk, proof check, import) lives in connector.js, shared with the
// background worker.

const SL = window.SLConnector;
const deps = { fetch: window.fetch.bind(window), crypto: window.crypto };

const codeInput = document.getElementById('code');
const dot = document.getElementById('dot');
const conn = document.getElementById('conn');
const result = document.getElementById('result');
const buttons = Array.from(document.querySelectorAll('button[data-platform]'));
const syncSummary = document.getElementById('sync-summary');
const syncRows = document.getElementById('sync-rows');
const syncNowBtn = document.getElementById('sync-now');

let verified = false;
let busy = false;
let checkSeq = 0;
let checkTimer = null;

function setResult(msg, kind) {
  result.textContent = msg || '';
  result.className = 'result' + (kind ? ' ' + kind : '');
}

function currentCode() {
  return SL.normalizeCode(codeInput.value);
}

function updateButtons() {
  buttons.forEach(b => { b.disabled = busy || !verified; });
}

function applyConnection(app) {
  const view = SL.describeConnection(app);
  verified = app.status === 'verified';
  dot.className = 'dot' + (view.tone === 'ok' ? ' ok' : view.tone === 'idle' ? ' idle' : '');
  conn.textContent = view.text;
  updateButtons();
  return view;
}

// Restore + persist the pairing code. Every edit re-checks the app, because
// the code is what the app's proof is checked against.
chrome.storage.local.get('pairingCode', (d) => {
  if (d && d.pairingCode && !codeInput.value) codeInput.value = d.pairingCode;
  refreshConnection();
});
codeInput.addEventListener('input', () => {
  chrome.storage.local.set({ pairingCode: currentCode() });
  clearTimeout(checkTimer);
  checkTimer = setTimeout(refreshConnection, 350);
});

async function refreshConnection() {
  const seq = ++checkSeq;
  let app;
  try { app = await SL.findApp({ ...deps, code: currentCode() }); } catch (e) { app = { status: 'not-found' }; }
  if (seq !== checkSeq) return; // a newer check (the code changed) owns the status line
  applyConnection(app);
}

async function connect(platform) {
  const name = SL.PLATFORM_NAMES[platform] || platform;
  const pairingCode = currentCode();
  if (!pairingCode) { setResult('Enter the pairing code shown in the app first.', 'err'); return; }

  busy = true;
  updateButtons();
  setResult('Checking Stream Lurker…', null);
  try {
    // Prove the listener again right before sending anything: the port may
    // have changed hands since the popup opened.
    checkSeq++; // supersedes a debounced check still in flight
    const app = await SL.findApp({ ...deps, code: pairingCode });
    const view = applyConnection(app);
    if (app.status !== 'verified') { setResult(view.text, 'err'); return; }

    setResult(`Reading ${name} cookies…`, null);
    const cookies = await SL.collectCookies(platform, chrome.cookies);
    if (!cookies.length) { setResult(`No ${name} cookies found. Open ${name} and log in there first.`, 'err'); return; }
    const r = await SL.postImport({ ...deps, port: app.port, code: pairingCode, platform, cookies });
    if (r.success) {
      setResult(`✓ ${name} connected${r.username ? ' as ' + r.username : ''}${r.cookiesSet != null ? ` (${r.cookiesSet} cookies)` : ''}.`, 'ok');
      // Keep this one refreshed from now on: a one-off snapshot goes stale as
      // the platform rotates its tokens. A manual connect also lifts an in-app
      // sign-out, so the worker may push it again.
      await SL.updatePlatform(chrome.storage.local, platform, {
        connected: true,
        result: { kind: 'ok', cookiesSet: r.cookiesSet, at: Date.now() },
      });
    } else if (r.httpStatus === 403) {
      setResult(r.error || 'The app rejected the pairing code. Paste the current one from Stream Lurker.', 'err');
    } else {
      setResult(r.error || `Import failed (HTTP ${r.httpStatus}).`, 'err');
    }
  } catch (e) {
    setResult('Could not reach Stream Lurker: ' + e.message, 'err');
  } finally {
    busy = false;
    updateButtons();
  }
}

// ── Auto-sync panel ──────────────────────────────────────────────────────────
async function renderSync() {
  const state = await chrome.storage.local.get({
    connectedPlatforms: [], lastResync: null, lastResyncStatus: '', lastResyncResults: {},
  });
  const view = SL.describeSync(state, Date.now());
  if (!syncNowBtn.dataset.running) {
    syncSummary.textContent = view.summary.text;
    syncSummary.className = 'sync-summary ' + view.summary.tone;
  }
  syncNowBtn.hidden = !state.connectedPlatforms.length;

  const rows = view.rows.map((row) => {
    const el = document.createElement('div');
    el.className = 'sync-row';
    const name = document.createElement('span');
    name.className = 'sync-name ' + row.platform;
    name.textContent = row.name;
    const text = document.createElement('span');
    text.className = 'sync-text ' + row.tone;
    text.textContent = row.text;
    el.append(name, text);
    if (row.connected) {
      const stop = document.createElement('button');
      stop.className = 'ghost';
      stop.textContent = 'Stop';
      stop.title = `Stop auto-syncing ${row.name} from this browser. This does not sign you out of the app.`;
      stop.addEventListener('click', () => {
        SL.updatePlatform(chrome.storage.local, row.platform, { connected: false, result: null });
      });
      el.append(stop);
    }
    return el;
  });
  syncRows.replaceChildren(...rows);
}

syncNowBtn.addEventListener('click', async () => {
  syncNowBtn.dataset.running = '1';
  syncNowBtn.disabled = true;
  syncSummary.textContent = 'Syncing…';
  syncSummary.className = 'sync-summary idle';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'resync-now' });
    if (r && r.status === 'error') setResult('Sync failed: ' + r.error, 'err');
  } catch (e) {
    setResult('Could not start a sync: ' + e.message, 'err');
  } finally {
    delete syncNowBtn.dataset.running;
    syncNowBtn.disabled = false;
    renderSync();
  }
});

chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') renderSync(); });
setInterval(renderSync, 30000); // keeps "12 min ago" honest while the popup stays open

buttons.forEach(b => b.addEventListener('click', () => connect(b.dataset.platform)));
updateButtons();
renderSync();
