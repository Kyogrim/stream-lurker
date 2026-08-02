// First-run setup guide. Shown once on a fresh install (and on demand from
// System Settings), walking through the three things the app can't do for you:
// signing in, choosing channels, and deciding how you want to be told.

import { state, appendLogMessage } from './state.js';
import { switchTab } from './tabs.js';

const STEPS = [
  {
    title: 'Welcome to Stream Lurker',
    body: `Stream Lurker keeps an eye on your favourite Twitch, Kick and YouTube channels and
           can open them the moment they go live — so you never miss the start of a stream, and
           your watch time counts even when you're doing something else.
           <br><br>This takes about a minute.`,
    icon: '<path d="M12 2a9 9 0 0 0-9 9v9c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-9a9 9 0 0 0-9-9z"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/>',
  },
  {
    title: 'Sign in to your platforms',
    body: `Signing in lets Stream Lurker watch as <em>you</em>, so your view counts and channel
           points get claimed.
           <br><br>The quickest way is the <strong>1-Click Login</strong> browser extension — load it
           once, enter the pairing code, and it hands over the sessions you're already signed
           into. Pasting cookies manually works too.`,
    action: { label: 'Open Platform Logins', tab: 'logins' },
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  },
  {
    title: 'Add the channels you watch',
    body: `Add any Twitch, Kick or YouTube channel you want to keep tabs on.
           <br><br>Their order is the <strong>watch priority</strong> — when you hit the per-platform
           stream limit, the ones nearer the top win. Drag to reorder any time.`,
    action: { label: 'Open Manage Streamers', tab: 'streamers' },
    icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
  },
  {
    title: 'Decide how you get told',
    body: `Every channel can be set to <strong>⚡ auto-open</strong>, <strong>🔔 notify only</strong>, or
           <strong>🔕 ignore</strong> — use the button beside it in Manage Streamers.
           <br><br>In System Settings you can cap how many streams open at once, set the default
           quality, and have Stream Lurker start with Windows so it's always watching.
           <br><br>That's it — leave it running and your stats will build up under <strong>Lurk Stats</strong>.`,
    action: { label: 'Open System Settings', tab: 'settings' },
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1z"/>',
  },
];

let stepIndex = 0;

function overlayEl() { return document.getElementById('onboarding-overlay'); }

async function markComplete() {
  if (!state.currentConfig) return;
  state.currentConfig.onboardingComplete = true;
  try { await window.api.saveConfig(state.currentConfig); } catch (e) { /* non-fatal */ }
}

function render() {
  const overlay = overlayEl();
  if (!overlay) return;

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;
  const dots = STEPS.map((_, i) => `<span class="ob-dot${i === stepIndex ? ' active' : ''}"></span>`).join('');

  overlay.querySelector('.ob-modal').innerHTML = `
    <div class="ob-icon">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${step.icon}</svg>
    </div>
    <h2 class="ob-title">${step.title}</h2>
    <p class="ob-body">${step.body}</p>
    ${step.action ? `<button class="ob-action" data-tab="${step.action.tab}">${step.action.label}</button>` : ''}
    <div class="ob-foot">
      <div class="ob-dots">${dots}</div>
      <div class="ob-buttons">
        ${stepIndex > 0 ? '<button class="ob-back">Back</button>' : '<button class="ob-skip">Skip setup</button>'}
        <button class="ob-next">${isLast ? 'Finish' : 'Next'}</button>
      </div>
    </div>
  `;
}

export function closeOnboarding() {
  const overlay = overlayEl();
  if (overlay) overlay.classList.remove('open');
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  if (e.key === 'Escape') { markComplete(); closeOnboarding(); }
}

export function openOnboarding() {
  let overlay = overlayEl();
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'onboarding-overlay';
    overlay.className = 'ob-overlay';
    overlay.innerHTML = '<div class="ob-modal" role="dialog" aria-modal="true" aria-label="Setup guide"></div>';
    document.body.appendChild(overlay);

    // Delegated — the modal body is rebuilt on every step.
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('.ob-next')) {
        if (stepIndex < STEPS.length - 1) { stepIndex++; render(); }
        else { markComplete(); closeOnboarding(); appendLogMessage('[Setup] Setup guide complete. Happy lurking!'); }
        return;
      }
      if (e.target.closest('.ob-back')) { stepIndex--; render(); return; }
      if (e.target.closest('.ob-skip')) {
        markComplete();
        closeOnboarding();
        appendLogMessage('[Setup] Setup guide skipped — reopen it any time from System Settings.');
        return;
      }
      const action = e.target.closest('.ob-action');
      if (action) {
        // Jump to the tab being described and get out of the way; the guide is
        // marked done so it won't reappear on the next launch.
        markComplete();
        closeOnboarding();
        switchTab(action.dataset.tab);
      }
    });
  }

  stepIndex = 0;
  render();
  overlay.classList.add('open');
  document.addEventListener('keydown', onKeydown);
}

// Runs after config load. Only fires for a genuinely fresh setup — main marks
// existing installs as complete so upgraders never see it.
export function maybeShowOnboarding() {
  if (!state.currentConfig) return;
  if (state.currentConfig.onboardingComplete) return;
  openOnboarding();
}

export function setupOnboarding() {
  document.getElementById('rerun-onboarding-btn')?.addEventListener('click', () => openOnboarding());
}
