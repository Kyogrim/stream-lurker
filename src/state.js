// Shared mutable renderer state + small platform helpers.
// Importing modules read/write these via the exported `state` object so
// every module sees the same data without circular-import pitfalls.

export const PLATFORMS = ['twitch', 'kick', 'youtube', 'rumble'];

export const state = {
  currentConfig: null,
  currentStatuses: [],
  activeContainers: [],
  followsCache: { twitch: [], kick: [] },
  activeFollowsTab: 'twitch',
  platformSchedules: [],
  draggedItem: null,
};

export function isPlatformEnabled(platform) {
  const cfg = state.currentConfig;
  if (!cfg) return true;
  return cfg[`${platform.toLowerCase()}Enabled`] !== false;
}

export function platformColorVar(platform) {
  return `var(--${platform.toLowerCase()}-color)`;
}

export function formatViewerCount(count) {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
  return count;
}

// Reusable platform badge SVGs.
const PLATFORM_SVG = {
  twitch: `<svg class="badge-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>`,
  kick: `<svg class="badge-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 0h-5v5h-5v5H4v14h10v-5h5V0zM12 12H9v-2h3v2zm5-5h-3v5h-2V7H9V5h3v2h2v5h3V7z"/></svg>`,
  youtube: `<svg class="badge-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.108C19.516 3.5 12 3.5 12 3.5s-7.516 0-9.388.555A3.002 3.002 0 0 0 .502 6.163C0 8.07 0 12 0 12s0 3.93.502 5.837a3.003 3.003 0 0 0 2.11 2.108C4.484 20.5 12 20.5 12 20.5s7.516 0 9.388-.555a3.003 3.003 0 0 0 2.11-2.108C24 15.93 24 12 24 12s0-3.93-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
  rumble: `<svg class="badge-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12 0a12 12 0 1 0 12 12A12.013 12.013 0 0 0 12 0zm5.176 13.916a2.766 2.766 0 0 1-2.316.643c-.482-.093-2.025-.561-3.69-.974l-2.023 3.947a.384.384 0 0 1-.68 0L7.02 14.77a.384.384 0 0 1 0-.34l2.128-4.156a6.837 6.837 0 0 1-1.391-2.327.384.384 0 0 1 .494-.482l8.473 2.782a2.766 2.766 0 0 1 1.776 2.502 2.76 2.76 0 0 1-1.324 1.171z"/></svg>`,
};

export function getPlatformSVG(platform) {
  return PLATFORM_SVG[platform.toLowerCase()] || '';
}

export function streamUrl(platform, username, status) {
  const u = username.toLowerCase();
  switch (platform.toLowerCase()) {
    case 'twitch': return `https://www.twitch.tv/${u}`;
    case 'kick': return `https://kick.com/${u}`;
    case 'youtube': return `https://www.youtube.com/${u.startsWith('@') ? u : '@' + u}/live`;
    case 'rumble': return status?.resolvedUrl || `https://rumble.com/c/${u}`;
    default: return '';
  }
}

// Activity log writer (used everywhere). Console host element is grabbed lazily
// so this module doesn't require DOM to exist at import time.
let consoleLogs = null;
function getConsoleLogs() {
  if (!consoleLogs) consoleLogs = document.getElementById('console-logs');
  return consoleLogs;
}

export function appendLogMessage(message) {
  const host = getConsoleLogs();
  if (!host) return;

  const line = document.createElement('div');
  line.textContent = message;

  if (message.includes('[Lurk]') || message.includes('online') || message.includes('LIVE')) {
    line.style.color = '#53FC18';
  } else if (message.includes('[ERROR]') || message.includes('failed') || message.includes('Error')) {
    line.style.color = '#ef4444';
  } else if (message.includes('[Extensions]') || message.includes('Loaded')) {
    line.style.color = '#e9d5ff';
  }

  host.appendChild(line);
  host.scrollTop = host.scrollHeight;
}
