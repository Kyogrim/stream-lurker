// Stream Lurker Connector — reads your platform cookies (including httpOnly ones,
// which a page script can't) and posts them to the desktop app's localhost
// receiver so it can log in without you copy-pasting cookies.

const PORTS = [47100, 47101, 47102, 47103, 47104];
const DOMAINS = {
  twitch: ['twitch.tv'],
  youtube: ['youtube.com', 'google.com'],
  kick: ['kick.com']
};

const codeInput = document.getElementById('code');
const dot = document.getElementById('dot');
const conn = document.getElementById('conn');
const result = document.getElementById('result');
const buttons = Array.from(document.querySelectorAll('button[data-platform]'));

let appPort = null;

function setResult(msg, kind) {
  result.textContent = msg || '';
  result.className = 'result' + (kind ? ' ' + kind : '');
}

// Restore + persist the pairing code.
chrome.storage.local.get('pairingCode', (d) => {
  if (d && d.pairingCode) codeInput.value = d.pairingCode;
});
codeInput.addEventListener('input', () => {
  chrome.storage.local.set({ pairingCode: codeInput.value.trim().toUpperCase() });
});

// Find which port the app is listening on.
async function findApp() {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { method: 'GET' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.app === 'stream-lurker') return port;
      }
    } catch (e) { /* not this port */ }
  }
  return null;
}

async function refreshConnection() {
  appPort = await findApp();
  if (appPort) {
    dot.classList.add('ok');
    conn.textContent = `Connected to Stream Lurker (port ${appPort})`;
  } else {
    dot.classList.remove('ok');
    conn.textContent = 'Stream Lurker not found — is the app running?';
  }
  buttons.forEach(b => { b.disabled = !appPort; });
}

async function collectCookies(platform) {
  const domains = DOMAINS[platform] || [];
  const seen = new Set();
  const out = [];
  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const c of cookies) {
      const key = c.name + '|' + c.domain + '|' + c.path;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate
      });
    }
  }
  return out;
}

async function connect(platform) {
  const pairingCode = codeInput.value.trim().toUpperCase();
  if (!pairingCode) { setResult('Enter the pairing code shown in the app first.', 'err'); return; }
  if (!appPort) { appPort = await findApp(); if (!appPort) { setResult('Stream Lurker not found — is the app running?', 'err'); return; } }

  buttons.forEach(b => b.disabled = true);
  setResult(`Reading ${platform} cookies…`, null);
  try {
    const cookies = await collectCookies(platform);
    if (!cookies.length) { setResult(`No ${platform} cookies found — open and log in to that site first.`, 'err'); return; }
    const r = await fetch(`http://127.0.0.1:${appPort}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode, platform, cookies })
    });
    const j = await r.json();
    if (j.success) {
      setResult(`✓ ${platform} connected${j.username ? ' as ' + j.username : ''} (${j.cookiesSet} cookies).`, 'ok');
    } else {
      setResult(j.error || 'Import failed.', 'err');
    }
  } catch (e) {
    setResult('Could not reach Stream Lurker: ' + e.message, 'err');
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
}

buttons.forEach(b => b.addEventListener('click', () => connect(b.dataset.platform)));
refreshConnection();
