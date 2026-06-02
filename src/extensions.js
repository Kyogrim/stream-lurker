// Custom Chrome extensions loaded into webview containers.

import { state, appendLogMessage } from './state.js';

function listEl() { return document.getElementById('extensions-list'); }

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
