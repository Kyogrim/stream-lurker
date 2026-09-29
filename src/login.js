// Account login / re-auth / sign-out cards and the IPC handlers that flip
// connected/disconnected card states.

import { PLATFORMS, state, appendLogMessage, getPlatformSVG } from './state.js';
import { renderFollowsList } from './follows.js';
import { receiverStatus, extensionSyncNotice, folderOpenFailure } from './extension-status.js';

// Each account card's title carries its platform's logo, the same SVG the
// stream cards use (index.html leaves the badge empty for this).
export function fillLoginCardLogos(root = document) {
  for (const badge of root.querySelectorAll('.login-card-logo')) {
    badge.innerHTML = getPlatformSVG(badge.getAttribute('data-logo'));
  }
}

function setConnectionUI(platform, connected, username) {
  const disconnectedCard = document.getElementById(`${platform}-disconnected-state`);
  const connectedCard = document.getElementById(`${platform}-connected-state`);
  const usernameSpan = document.getElementById(`${platform}-username-val`);
  if (!disconnectedCard || !connectedCard) return;

  disconnectedCard.style.display = connected ? 'none' : 'flex';
  connectedCard.style.display = connected ? 'flex' : 'none';
  if (connected && username && usernameSpan) usernameSpan.textContent = username;
}

export function setupLoginPortalListeners() {
  if (!state.currentConfig.accounts) state.currentConfig.accounts = {};
  fillLoginCardLogos();

  PLATFORMS.forEach(platform => {
    const username = state.currentConfig.accounts[platform];
    setConnectionUI(platform, !!username, username);
  });

  setupTwitchImportModal();
  setupYoutubeImportModal();
  setupExtensionPanel();

  document.querySelectorAll('.connect-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      // Twitch/YouTube block embedded login, so use browser-assisted cookie import.
      if (platform === 'twitch') { openTwitchImportModal(); return; }
      if (platform === 'youtube') { openYoutubeImportModal(); return; }
      btn.disabled = true;
      btn.innerHTML = `<span class="pulse-dot"></span> Connecting...`;
      try {
        await window.api.openLoginModal(platform);
        appendLogMessage(`[System] Connection status request resolved for ${platform.toUpperCase()}.`);
      } catch (err) {
        appendLogMessage(`[ERROR] Connection failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          Connect Account
        `;
      }
    });
  });

  document.querySelectorAll('.login-card .reauth-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      if (platform === 'twitch') { openTwitchImportModal(); return; }
      if (platform === 'youtube') { openYoutubeImportModal(); return; }
      btn.disabled = true;
      // Keep the original nodes rather than re-parsing serialized markup.
      const originalNodes = [...btn.childNodes];
      btn.innerHTML = `<span class="pulse-dot"></span> Re-auth...`;
      appendLogMessage(`[System] Opening re-authentication modal for ${platform.toUpperCase()}...`);
      try {
        await window.api.openLoginModal(platform);
        appendLogMessage(`[System] Re-authentication request resolved for ${platform.toUpperCase()}.`);
      } catch (err) {
        appendLogMessage(`[ERROR] Re-authentication failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.replaceChildren(...originalNodes);
      }
    });
  });

  document.querySelectorAll('.login-card .logout-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      btn.disabled = true;
      btn.innerHTML = `<span class="pulse-dot"></span> Purging...`;
      appendLogMessage(`[System] Signing out of ${platform.toUpperCase()}...`);
      try {
        await window.api.logoutPlatform(platform);

        delete state.currentConfig.accounts[platform];
        if (platform === 'twitch' || platform === 'kick') {
          state.followsCache[platform] = [];
          renderFollowsList();
        }
        setConnectionUI(platform, false);

        appendLogMessage(`[System] Successfully disconnected ${platform.toUpperCase()} account.`);
      } catch (err) {
        appendLogMessage(`[ERROR] Sign out failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg class="btn-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          Sign Out
        `;
      }
    });
  });

  window.api.onLoginSuccess(async ({ platform, username }) => {
    appendLogMessage(`[System] Received successful login signal for ${platform.toUpperCase()} (${username}). Updating cards...`);
    if (!state.currentConfig.accounts) state.currentConfig.accounts = {};
    state.currentConfig.accounts[platform] = username;
    setConnectionUI(platform, true, username);

    if (platform === 'twitch' && state.currentConfig.twitchEnabled !== false) {
      try {
        appendLogMessage('[Twitch Sync] Auto-syncing live follows after successful connection...');
        const res = await window.api.getTwitchFollows();
        if (res.success) {
          state.followsCache.twitch = res.follows;
          renderFollowsList();
          if (res.username && state.currentConfig.accounts.twitch !== res.username) {
            state.currentConfig.accounts.twitch = res.username;
            setConnectionUI('twitch', true, res.username);
          }
          appendLogMessage(`[System] Auto-synced ${res.follows.length} live followed Twitch channels.`);
        }
      } catch (e) {
        appendLogMessage(`[Twitch Sync] Auto-sync follows failed: ${e.message}`);
      }
    }
  });

  window.api.onSessionExpired(({ platform }) => {
    appendLogMessage(`[Auth] Session expired for ${platform.toUpperCase()}. Marking as disconnected.`);
    if (state.currentConfig.accounts) delete state.currentConfig.accounts[platform];
    if (platform === 'twitch' || platform === 'kick') {
      state.followsCache[platform] = [];
      renderFollowsList();
    }
    setConnectionUI(platform, false);
  });
}

// ── Browser-assisted Twitch login modal ──────────────────────────────────────
function openTwitchImportModal() {
  const overlay = document.getElementById('twitch-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('ti-token-input');
  const status = document.getElementById('ti-status');
  if (input) input.value = '';
  if (status) { status.textContent = ''; status.className = 'ti-status'; }
  overlay.style.display = 'flex';
  setTimeout(() => input?.focus(), 50);
}

function closeTwitchImportModal() {
  const overlay = document.getElementById('twitch-import-overlay');
  if (overlay) overlay.style.display = 'none';
}

function setupTwitchImportModal() {
  const overlay = document.getElementById('twitch-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('ti-token-input');
  const status = document.getElementById('ti-status');
  const importBtn = document.getElementById('ti-import');

  document.getElementById('ti-open-twitch')?.addEventListener('click', () => {
    window.api.openExternal('https://www.twitch.tv/login');
  });
  document.getElementById('ti-cancel')?.addEventListener('click', closeTwitchImportModal);
  document.getElementById('ti-close')?.addEventListener('click', closeTwitchImportModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTwitchImportModal(); });

  const doImport = async () => {
    const token = (input?.value || '').trim();
    if (!token) {
      if (status) { status.textContent = 'Paste your auth-token first.'; status.className = 'ti-status error'; }
      return;
    }
    if (status) { status.textContent = 'Verifying with Twitch…'; status.className = 'ti-status pending'; }
    if (importBtn) importBtn.disabled = true;
    try {
      const res = await window.api.setTwitchToken(token);
      if (res?.success) {
        if (status) { status.textContent = `Connected as ${res.username}!`; status.className = 'ti-status ok'; }
        appendLogMessage(`[System] Twitch connected as ${res.username} via browser import.`);
        // main also emits 'login-success', which updates the card and syncs follows.
        setTimeout(closeTwitchImportModal, 900);
      } else {
        if (status) { status.textContent = res?.error || 'Import failed.'; status.className = 'ti-status error'; }
      }
    } catch (err) {
      if (status) { status.textContent = err.message; status.className = 'ti-status error'; }
    } finally {
      if (importBtn) importBtn.disabled = false;
    }
  };

  importBtn?.addEventListener('click', doImport);
  // Ctrl/Cmd+Enter submits (plain Enter inserts a newline in the textarea).
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doImport(); });
}

// ── 1-click login extension panel ────────────────────────────────────────────
const RECEIVER_TONE_COLORS = {
  ok: 'var(--lime-color, #84cc16)',
  error: '#ef4444',
  muted: 'var(--text-muted, #a1a1aa)',
};

// A one-line note under the steps (copy, new code, folder errors).
function setExtensionNote(text, tone = 'ok') {
  const el = document.getElementById('ext-panel-note');
  if (!el) return;
  el.textContent = text || '';
  el.className = `ext-note ${tone}`;
  el.classList.toggle('hidden', !text);
}

// Bumped by each new code, so an info read that started before it cannot put
// the old code back on screen.
let pairingCodeGen = 0;

// For a code shorter than connector 1.3 accepts (see refreshExtensionInfo).
const SHORT_CODE_NOTE = "This pairing code is from an older version. First reload Stream Lurker Connector on your browser's Extensions page (it should then show version 1.3 or later), then click New code and paste the new code into it.";
// Part of the New code confirm: a copy loaded before the app updated is
// connector 1.2 until it is reloaded, and cannot hold a 32-character code.
const NEW_CODE_RELOAD_CAUTION = "If Stream Lurker has updated since the extension was last reloaded, reload Stream Lurker Connector on your browser's Extensions page first: the older copy still running there cannot hold the new, longer code.";

function showPairingCode(code) {
  const codeEl = document.getElementById('ext-pairing-code');
  if (!codeEl) return;
  codeEl.textContent = code || '—';
  // What Copy puts on the clipboard; never the placeholder dash.
  codeEl.dataset.code = code || '';
}

// Runs at setup and every time Platform Logins is opened: the receiver can
// come up late (it retries), and the last automatic sync changes over time.
async function refreshExtensionInfo() {
  const connEl = document.getElementById('ext-conn-status');
  const syncEl = document.getElementById('ext-sync-status');
  const gen = pairingCodeGen;
  let info;
  try {
    info = await window.api.getExtensionInfo();
  } catch (e) {
    return;
  }
  if (gen === pairingCodeGen) {
    showPairingCode(info?.pairingCode);
    // Installs from before 32-character codes still hold an 8-character one.
    // Connector 1.3 refuses those (one /ping answer is enough to brute-force a
    // 32-bit code offline), so say how to fix it here rather than leave the
    // extension failing on its own. Never over another message.
    // Reloading comes first: the browser keeps running the old 1.2 copy until
    // it is reloaded or the browser restarts, and 1.2's code field holds 16
    // characters, so a new code pasted into it is cut short and refused.
    const code = info?.pairingCode || '';
    const note = document.getElementById('ext-panel-note');
    if (code && code.length < 32 && note && !note.textContent) {
      setExtensionNote(SHORT_CODE_NOTE, 'warn');
    }
  }
  if (connEl) {
    const r = receiverStatus(info);
    connEl.textContent = r.text;
    connEl.style.color = RECEIVER_TONE_COLORS[r.tone];
  }
  if (syncEl) {
    // Per platform, not just the latest attempt: see extensionSyncNotice.
    const notice = extensionSyncNotice(info);
    syncEl.textContent = notice ? notice.text : '';
    syncEl.classList.toggle('warn', !!notice?.warn);
    syncEl.classList.toggle('hidden', !notice);
  }
}

async function setupExtensionPanel() {
  const codeEl = document.getElementById('ext-pairing-code');
  const folderBtn = document.getElementById('ext-open-folder');
  const copyBtn = document.getElementById('ext-copy-code');
  const newCodeBtn = document.getElementById('ext-new-code');
  if (!codeEl) return;
  codeEl.dataset.code = '';

  // main reports a folder it could not open (missing after a bad update, no
  // file manager association) instead of pretending it opened.
  folderBtn?.addEventListener('click', async () => {
    folderBtn.disabled = true;
    try {
      const res = await window.api.openExtensionFolder();
      const failure = folderOpenFailure(res);
      if (failure) setExtensionNote(failure, 'error');
      else setExtensionNote('');
    } catch (err) {
      setExtensionNote(`Could not open the extension folder (${err?.message || err}).`, 'error');
    } finally {
      folderBtn.disabled = false;
    }
  });

  copyBtn?.addEventListener('click', async () => {
    const code = codeEl.dataset.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setExtensionNote('Pairing code copied. Paste it into the extension.');
    } catch (err) {
      setExtensionNote('Could not copy the code. Select it and copy it by hand.', 'error');
    }
  });

  // A shared or leaked code can be replaced. The paired extension then stops
  // syncing until it is given the new one, so this asks first.
  newCodeBtn?.addEventListener('click', async () => {
    const ok = window.confirm(`Create a new pairing code?\n\nThe browser extension stops syncing your logins until you paste the new code into it.\n\n${NEW_CODE_RELOAD_CAUTION}`);
    if (!ok) return;
    newCodeBtn.disabled = true;
    try {
      const res = await window.api.rotatePairingCode();
      if (!res?.pairingCode) throw new Error('the app returned no code');
      pairingCodeGen++;
      showPairingCode(res.pairingCode);
      setExtensionNote('New pairing code created. Paste it into the extension to reconnect it.', 'warn');
    } catch (err) {
      setExtensionNote(`Could not create a new pairing code (${err?.message || err}).`, 'error');
    } finally {
      newCodeBtn.disabled = false;
    }
  });

  document.querySelector('.nav-btn[data-tab="logins"]')?.addEventListener('click', () => { refreshExtensionInfo(); });

  await refreshExtensionInfo();
  if (!codeEl.dataset.code) showPairingCode('');
}

// ── Browser-assisted YouTube login modal ─────────────────────────────────────
function openYoutubeImportModal() {
  const overlay = document.getElementById('youtube-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('yti-input');
  const status = document.getElementById('yti-status');
  if (input) input.value = '';
  if (status) { status.textContent = ''; status.className = 'ti-status'; }
  overlay.style.display = 'flex';
  setTimeout(() => input?.focus(), 50);
}

function closeYoutubeImportModal() {
  const overlay = document.getElementById('youtube-import-overlay');
  if (overlay) overlay.style.display = 'none';
}

function setupYoutubeImportModal() {
  const overlay = document.getElementById('youtube-import-overlay');
  if (!overlay) return;
  const input = document.getElementById('yti-input');
  const status = document.getElementById('yti-status');
  const importBtn = document.getElementById('yti-import');

  document.getElementById('yti-open-yt')?.addEventListener('click', () => {
    window.api.openExternal('https://www.youtube.com/');
  });
  document.getElementById('yti-cancel')?.addEventListener('click', closeYoutubeImportModal);
  document.getElementById('yti-close')?.addEventListener('click', closeYoutubeImportModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeYoutubeImportModal(); });

  const doImport = async () => {
    // Sent as typed: trimming here dropped a cookies.txt last line whose value
    // is empty (the line ends in its tab). main parses and cleans it.
    const raw = input?.value || '';
    if (!raw.trim()) {
      if (status) { status.textContent = 'Paste your exported cookies first.'; status.className = 'ti-status error'; }
      return;
    }
    if (status) { status.textContent = 'Importing session…'; status.className = 'ti-status pending'; }
    if (importBtn) importBtn.disabled = true;
    try {
      const res = await window.api.setGoogleCookies(raw);
      if (res?.success) {
        const msg = res.verified
          ? `Connected! (${res.cookiesSet} cookies, verified)`
          : `Imported ${res.cookiesSet} cookies — open a YouTube stream to confirm.`;
        if (status) { status.textContent = msg; status.className = 'ti-status ok'; }
        appendLogMessage(`[System] YouTube session imported (${res.cookiesSet} cookies, verified: ${!!res.verified}).`);
        setTimeout(closeYoutubeImportModal, 1100);
      } else {
        if (status) { status.textContent = res?.error || 'Import failed.'; status.className = 'ti-status error'; }
      }
    } catch (err) {
      if (status) { status.textContent = err.message; status.className = 'ti-status error'; }
    } finally {
      if (importBtn) importBtn.disabled = false;
    }
  };

  importBtn?.addEventListener('click', doImport);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doImport(); });
}
