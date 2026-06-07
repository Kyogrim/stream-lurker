// Custom Chrome extensions loaded into webview containers.

import { state, appendLogMessage } from './state.js';

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
    host.innerHTML = `<div style="grid-column: 1 / -1; color: var(--text-muted); font-size: 0.85rem;">Failed to load catalog: ${err.message}</div>`;
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
    const installedBadge = item.installed
      ? `<span style="font-size: 0.7rem; color: var(--text-secondary); background: var(--panel-border); padding: 2px 8px; border-radius: 10px;">Installed v${item.installed.version}</span>`
      : '';
    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <strong style="font-size: 0.95rem;">${item.name}</strong>
        ${installedBadge}
      </div>
      <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; flex-grow: 1;">${item.description}</p>
      <a href="#" data-repo-url="${item.repoUrl}" style="font-size: 0.7rem; color: var(--cyan-color); text-decoration: none;">${item.repo} ↗</a>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn btn-sm btn-cyan catalog-install-btn" data-id="${item.id}" style="flex-grow: 1;">
          ${item.installed ? 'Update' : 'Install'}
        </button>
        ${item.installed ? `<button class="btn btn-sm catalog-uninstall-btn" data-id="${item.id}" style="background: transparent; border: 1px solid var(--panel-border); color: var(--text-secondary);">Remove</button>` : ''}
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

    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      if (uninstallBtn) uninstallBtn.disabled = true;
      statusEl.textContent = 'Downloading & extracting…';
      const res = await window.api.installCatalogExtension(item.id);
      if (res.ok) {
        statusEl.textContent = `Installed v${res.version}. Restart the app to finish loading it.`;
        statusEl.style.color = 'var(--cyan-color)';
        state.currentConfig = await window.api.getConfig();
        renderExtensionsList();
        renderExtensionCatalog();
        appendLogMessage(`[Catalog] ${item.name} v${res.version} installed. Restart Stream Lurker for it to load fully.`);
      } else {
        statusEl.textContent = `Failed: ${res.error}`;
        statusEl.style.color = 'var(--text-muted)';
        installBtn.disabled = false;
        if (uninstallBtn) uninstallBtn.disabled = false;
      }
    });

    uninstallBtn?.addEventListener('click', async () => {
      uninstallBtn.disabled = true;
      installBtn.disabled = true;
      const res = await window.api.uninstallCatalogExtension(item.id);
      if (res.ok) {
        state.currentConfig = await window.api.getConfig();
        renderExtensionsList();
        renderExtensionCatalog();
        appendLogMessage(`[Catalog] ${item.name} removed.`);
      } else {
        statusEl.textContent = `Failed: ${res.error}`;
        uninstallBtn.disabled = false;
        installBtn.disabled = false;
      }
    });

    host.appendChild(card);
  });
}

export function renderExtensionsList() {
  const host = listEl();
  if (!host) return;
  host.innerHTML = '';

  const cfg = state.currentConfig;
  if (!cfg || cfg.extensions.length === 0) {
    host.innerHTML = `
      <div class="no-extensions-message">
        <p>No custom extensions added yet. Add an unpacked folder above to load extensions inside the browser containers.</p>
      </div>
    `;
    return;
  }

  cfg.extensions.forEach((extPath, index) => {
    const extName = extPath.split(/[\\/]/).pop() || 'Chrome Extension';

    const row = document.createElement('div');
    row.className = 'ext-item';
    row.innerHTML = `
      <div class="ext-item-header">
        <span class="ext-item-title">${extName}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="ext-item-ver">Active</span>
          <button class="delete-btn remove-ext-btn" title="Remove Extension">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="ext-item-path">${extPath}</div>
    `;

    row.querySelector('.remove-ext-btn').addEventListener('click', async () => {
      state.currentConfig.extensions.splice(index, 1);
      await window.api.saveConfig(state.currentConfig);
      renderExtensionsList();
      appendLogMessage('[Extensions] Extension removed from list. It will take effect upon reloading or window restarts.');
    });

    host.appendChild(row);
  });
}
