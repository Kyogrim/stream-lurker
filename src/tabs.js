// Tab switching for both static nav tabs and dynamic per-stream tabs.

import { appendLogMessage } from './state.js';

export function switchTab(tabName) {
  document.querySelectorAll('.nav-btn, .stream-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const gridContainer = document.getElementById('multi-lurk-grid');

  if (tabName.startsWith('stream-')) {
    const [, platform, username] = tabName.split('-');
    const cellId = `grid-cell-${platform}-${username}`;

    document.getElementById('tab-multi-lurk')?.classList.add('active');

    if (gridContainer) {
      gridContainer.classList.add('single-view');
      gridContainer.querySelectorAll('.stream-grid-cell').forEach(cell => {
        cell.classList.toggle('maximized', cell.id === cellId);
      });
    }
  } else {
    document.getElementById(`tab-${tabName}`)?.classList.add('active');

    if (tabName === 'multi-lurk' && gridContainer) {
      gridContainer.classList.remove('single-view');
      gridContainer.querySelectorAll('.stream-grid-cell').forEach(cell => cell.classList.remove('maximized'));
    }
  }

  if (tabName === 'dashboard') {
    appendLogMessage('[System] Displaying main Monitor Panel.');
  }
}

export function setupTabs() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Multi-Lurk layout switcher (4-up, 6-up, etc.) toolbar
  const switcherButtons = document.querySelectorAll('.layout-switcher-toolbar .switcher-btn:not(#global-ghost-btn)');
  const multiLurkGrid = document.getElementById('multi-lurk-grid');

  if (switcherButtons.length && multiLurkGrid) {
    switcherButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        switcherButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const layout = btn.dataset.layout;
        multiLurkGrid.setAttribute('data-layout', layout);
        appendLogMessage(`[System] Multi-Lurk grid layout set to: ${layout.toUpperCase()}`);
      });
    });
  }
}
