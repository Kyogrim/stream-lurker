// Custom Chrome extensions loaded into webview containers.

import { state, appendLogMessage, escapeHtml, safeHttpsUrl } from './state.js';

function listEl() { return document.getElementById('extensions-list'); }
function catalogEl() { return document.getElementById('ext-catalog-grid'); }

export async function renderExtensionCatalog() {
  const host = catalogEl();
  if (!host) return;
  host.innerHTML = `<div class="catalog-loading" style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 16px;">Loading catalog…</div>`;

  let items = [];
  try {
    items = await window.api.listCatalogExtensions();
  } catch (err) {
    host.innerHTML = `<div style="grid-column: 1 / -1; color: var(--text-muted); font-size: 0.85rem;">Failed to load catalog: ${escapeHtml(err?.message)}</div>`;
    return;
  }

  host.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'ext-catalog-item';
    card.style.cssText = `
      background-color: hsla(240, 5.9%, 15%, 0.25);
      border: 1px solid var(--panel-border);
      border-radius: var(--radius-md);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    // The installed version is read from a third-party release zip's manifest,
    // so it is escaped like everything else here. The repo link is only shown
    // for an https GitHub URL.
    const installedBadge = item.installed
      ? `<span style="font-size: 0.7rem; color: var(--text-secondary); background: var(--panel-border); padding: 2px 8px; border-radius: 10px;">Installed v${escapeHtml(item.installed.version)}</span>`
      : '';
    const repoUrl = safeHttpsUrl(item.repoUrl, ['github.com']);
    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <strong style="font-size: 0.95rem;">${escapeHtml(item.name)}</strong>
        ${installedBadge}
      </div>
      <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; flex-grow: 1;">${escapeHtml(item.description)}</p>
      ${repoUrl ? `<a href="#" data-repo-url="${escapeHtml(repoUrl)}" style="font-size: 0.7rem; color: var(--cyan-color); text-decoration: none;">${escapeHtml(item.repo)} ↗</a>` : ''}
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn btn-sm btn-cyan catalog-install-btn" data-id="${escapeHtml(item.id)}" style="flex-grow: 1;">
          ${item.installed ? 'Update' : 'Install'}
        </button>
        ${item.installed ? `<button class="btn btn-sm catalog-uninstall-btn" data-id="${escapeHtml(item.id)}" style="background: transparent; border: 1px solid var(--panel-border); color: var(--text-secondary);">Remove</button>` : ''}
      </div>
      <div class="catalog-status" style="font-size: 0.72rem; color: var(--text-muted); min-height: 14px;"></div>
    `;

    card.querySelector('[data-repo-url]')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(e.currentTarget.dataset.repoUrl);
    });

    const statusEl = card.querySelector('.catalog-status');
    const installBtn = card.querySelector('.catalog-install-btn');
    const uninstallBtn = card.querySelector('.catalog-uninstall-btn');

    // Both handlers give the buttons back whatever happens: a rejected IPC
    // call used to leave them disabled until the tab was re-rendered. On
    // success the card is re-rendered and these buttons are discarded anyway.
    const setBusy = (busy) => {
      installBtn.disabled = busy;
      if (uninstallBtn) uninstallBtn.disabled = busy;
    };

    installBtn.addEventListener('click', async () => {
      setBusy(true);
      statusEl.textContent = 'Downloading & extracting…';
      try {
        const res = await window.api.installCatalogExtension(item.id);
        if (res?.ok) {
          // Main loads it into the live session and reloads open streams; its
          // own log line says so, or that it will load on the next start.
          statusEl.textContent = `Installed v${res.version}.`;
          statusEl.style.color = 'var(--cyan-color)';
          appendLogMessage(`[Catalog] ${item.name} v${res.version} installed.`);
          state.currentConfig = await window.api.getConfig();
          renderExtensionsList();
          await renderExtensionCatalog();
          showCatalogStatus(item.id, `Installed v${res.version}.`);
        } else {
          statusEl.textContent = `Failed: ${res?.error || 'unknown error'}`;
          statusEl.style.color = 'var(--text-muted)';
        }
      } catch (err) {
        statusEl.textContent = `Failed: ${err?.message || err}`;
        statusEl.style.color = 'var(--text-muted)';
      } finally {
        setBusy(false);
      }
    });

    uninstallBtn?.addEventListener('click', async () => {
      setBusy(true);
      try {
        const res = await window.api.uninstallCatalogExtension(item.id);
        if (res?.ok) {
          // Main unloads it at once and reloads open streams, so nothing it
          // injected survives. A warning means some files were left on disk;
          // it stays on the re-rendered card, where the user clicked.
          appendLogMessage(`[Catalog] ${item.name} removed and unloaded.`);
          state.currentConfig = await window.api.getConfig();
          renderExtensionsList();
          await renderExtensionCatalog();
          if (res.warning) showCatalogStatus(item.id, res.warning);
        } else {
          statusEl.textContent = `Failed: ${res?.error || 'unknown error'}`;
        }
      } catch (err) {
        statusEl.textContent = `Failed: ${err?.message || err}`;
      } finally {
        setBusy(false);
      }
    });

    host.appendChild(card);
  });
}

// A note on one catalog card, found by id after a re-render replaced them all.
function showCatalogStatus(id, text) {
  const btn = [...(catalogEl()?.querySelectorAll('.catalog-install-btn') || [])]
    .find(b => b.dataset.id === id);
  const status = btn?.closest('.ext-catalog-item')?.querySelector('.catalog-status');
  if (status) status.textContent = text;
}

export function renderExtensionsList() {
  const host = listEl();
  if (!host) return;
  host.innerHTML = '';

  const cfg = state.currentConfig;
  // An imported config can carry null or a non-list here (F93); show it as
  // empty rather than throwing out of startup.
  const exts = Array.isArray(cfg?.extensions) ? cfg.extensions : [];
  if (exts.length === 0) {
    host.innerHTML = `
      <div class="no-extensions-message">
        <p>No custom extensions added yet. Add an unpacked folder above to load extensions inside the browser containers.</p>
      </div>
    `;
    return;
  }

  exts.forEach((extPath, index) => {
    if (typeof extPath !== 'string') return;
    const extName = extPath.split(/[\\/]/).pop() || 'Chrome Extension';

    const row = document.createElement('div');
    row.className = 'ext-item';
    row.dataset.extPath = extPath;
    row.innerHTML = `
      <div class="ext-item-header">
        <span class="ext-item-title">${escapeHtml(extName)}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="ext-item-ver">Active</span>
          <button class="delete-btn remove-ext-btn" title="Remove Extension">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="ext-item-path">${escapeHtml(extPath)}</div>
    `;

    row.querySelector('.remove-ext-btn').addEventListener('click', async () => {
      state.currentConfig.extensions.splice(index, 1);
      await window.api.saveConfig(state.currentConfig);
      renderExtensionsList();
      // Main unloads it on this save, and reloads open streams if it was
      // running so what it injected goes too.
      appendLogMessage(`[Extensions] Removed ${extName}; it is no longer loaded.`);
    });

    host.appendChild(row);
  });

  markUnavailableExtensions(host);
}

// Rows are drawn at once as "Active", then the folders main could not reach
// at its last load (a drive not mounted yet) are relabelled. The entries stay
// in the list, removable as usual; main never drops them on its own.
async function markUnavailableExtensions(host) {
  let unavailable;
  try {
    unavailable = (await window.api.getExtensionStatus())?.unavailable;
  } catch (err) {
    return;
  }
  if (!Array.isArray(unavailable) || unavailable.length === 0) return;
  const missing = new Set(unavailable.filter(p => typeof p === 'string'));
  host.querySelectorAll('.ext-item').forEach(row => {
    if (!missing.has(row.dataset.extPath)) return;
    const badge = row.querySelector('.ext-item-ver');
    if (!badge) return;
    badge.textContent = 'Unavailable (drive not found)';
    badge.classList.add('unavailable');
    badge.title = 'This folder could not be reached when extensions were loaded, so it is not running. It loads by itself once the folder is back (checked again shortly after start and at every launch). Remove it if the folder is gone for good.';
  });
}
