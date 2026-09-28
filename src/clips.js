import {
  appendLogMessage, escapeHtml, safeHttpsUrl, TWITCH_PAGE_HOSTS, TWITCH_MEDIA_HOSTS, monitoredStreamers,
} from './state.js';

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Public client ID
const SAVED_CLIPS_KEY = 'stream_lurker_saved_clips';

// Elements
let clipsGrid;
let savedClipsList;
let refreshBtn;
let filterSelect;

let savedClips = [];

// Each fetch run supersedes the one before it (Refresh, a filter change, the
// startup fetch). The runs await one request per streamer, so an older, slower
// run could finish last and paint its clips under the newer filter. A run only
// touches the grid while it is still the latest, and a new run aborts the
// previous one's requests.
let clipsFetchGen = 0;
let clipsAbort = null;
const CLIPS_REQUEST_TIMEOUT_MS = 15000;

// One hung request must not hold a run (and the grid's "Fetching..." state)
// forever.
function clipsRequestSignal(signal) {
  return typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.any([signal, AbortSignal.timeout(CLIPS_REQUEST_TIMEOUT_MS)])
    : signal;
}

// ── Clip data ────────────────────────────────────────────────────────────────
// Clip titles are written by whoever clipped the stream, not the streamer, and
// saved clips come back out of localStorage (where older builds may already
// have stored a hostile one). None of it is trusted: the cards below take text
// from clipView() through textContent only, and URLs from the helpers here,
// which return '' for anything that is not https on a Twitch host.

// Whatever localStorage holds, as a list of clip objects that at least have an
// id to key on. Entries are otherwise kept as stored.
export function parseSavedClips(raw) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(c => c && typeof c === 'object'
    && (typeof c.id === 'string' || typeof c.id === 'number'));
}

function textOr(value, fallback) {
  return value == null || value === '' ? fallback : String(value);
}

// The plain-text fields a clip card shows.
export function clipView(clip, untitled = 'Untitled Clip') {
  const c = clip && typeof clip === 'object' ? clip : {};
  const views = Number(c.viewCount);
  const secs = Number(c.durationSeconds);
  const slug = typeof c.slug === 'string' ? c.slug : '';
  return {
    id: c.id == null ? '' : String(c.id),
    title: textOr(c.title, untitled),
    author: textOr(c.broadcaster?.displayName, 'Unknown'),
    views: views ? views.toLocaleString() : '0',
    duration: secs ? `${secs}s` : '',
    // Handed to the save dialog as a default path, so no separators.
    fileName: `${slug.replace(/[^\w-]/g, '') || 'clip'}.mp4`,
  };
}

export function clipThumbUrl(clip) {
  return safeHttpsUrl(clip?.thumbnailURL, TWITCH_MEDIA_HOSTS);
}

export function clipPageUrl(clip) {
  return safeHttpsUrl(clip?.url, TWITCH_PAGE_HOSTS);
}

export function clipSourceUrl(clip) {
  const qualities = Array.isArray(clip?.videoQualities) ? clip.videoQualities : [];
  return safeHttpsUrl(qualities[0]?.sourceURL, TWITCH_MEDIA_HOSTS);
}

// The source MP4 with the playback token Twitch's CDN wants. Falls back to the
// unsigned URL when there is no token.
export function signedClipUrl(rawUrl, tokenData) {
  const base = safeHttpsUrl(rawUrl, TWITCH_MEDIA_HOSTS);
  if (!base || !tokenData?.signature || !tokenData?.value) return base;
  return safeHttpsUrl(
    `${base}?sig=${encodeURIComponent(tokenData.signature)}&token=${encodeURIComponent(tokenData.value)}`,
    TWITCH_MEDIA_HOSTS,
  );
}

// Older saved clips have no videoQualities; their MP4 sits next to the
// thumbnail on the same CDN.
export function legacyClipMp4Url(clip) {
  const thumb = clipThumbUrl(clip);
  if (!thumb) return '';
  return safeHttpsUrl(
    thumb.replace(/-preview-.*\.jpg$/, '.mp4').replace(/-[0-9x]+\.jpg$/, '.mp4'),
    TWITCH_MEDIA_HOSTS,
  );
}

export function initClipsManager() {
  clipsGrid = document.getElementById('trending-clips-grid');
  savedClipsList = document.getElementById('saved-clips-list');
  refreshBtn = document.getElementById('refresh-clips-btn');
  filterSelect = document.getElementById('clips-filter-select');

  // Load saved clips from localStorage
  try {
    savedClips = parseSavedClips(localStorage.getItem(SAVED_CLIPS_KEY));
  } catch (e) {
    console.error('Failed to load saved clips:', e);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchTrendingClips());
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', () => fetchTrendingClips());
  }

  renderSavedClips();

  // Try fetching on init
  setTimeout(fetchTrendingClips, 1000);
}

function getMonitoredTwitchStreamers() {
  return monitoredStreamers().filter(s => s.platform.toLowerCase() === 'twitch').map(s => s.username);
}

async function fetchTrendingClips() {
  if (!clipsGrid) return;
  // Before the no-streamers early return, so a slower older run can't paint
  // over that message either.
  const gen = ++clipsFetchGen;
  clipsAbort?.abort();
  const controller = new AbortController();
  clipsAbort = controller;
  const stale = () => gen !== clipsFetchGen;

  const streamers = getMonitoredTwitchStreamers();

  if (streamers.length === 0) {
    clipsGrid.innerHTML = `
      <div class="no-clips-message" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p>No Twitch streamers monitored. Add some in the Manage Streamers tab to see trending clips.</p>
      </div>`;
    return;
  }

  const filter = filterSelect ? filterSelect.value : 'trending';
  let period = 'LAST_WEEK';
  if (filter === 'latest') period = 'LAST_DAY';
  if (filter === 'popular') period = 'ALL_TIME';

  clipsGrid.innerHTML = `
    <div class="no-clips-message" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
      <p>Fetching ${escapeHtml(filter)} clips...</p>
    </div>`;

  const allClips = [];

  for (const login of streamers) {
    try {
      const query = `
        query GetClips($login: String!) {
          user(login: $login) {
            id
            clips(first: 20, criteria: { period: ${period} }) {
              edges {
                node {
                  id
                  slug
                  url
                  title
                  viewCount
                  durationSeconds
                  createdAt
                  thumbnailURL
                  broadcaster { id login displayName }
                  videoQualities { sourceURL quality }
                }
              }
            }
          }
        }
      `;

      const res = await fetch(TWITCH_GQL_URL, {
        method: 'POST',
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([{
          operationName: 'GetClips',
          variables: { login },
          query
        }]),
        signal: clipsRequestSignal(controller.signal),
      });

      const data = await res.json();
      if (stale()) return;
      const userNode = data[0]?.data?.user;
      if (userNode && userNode.clips && userNode.clips.edges) {
        for (const edge of userNode.clips.edges) {
          if (edge?.node && typeof edge.node === 'object') allClips.push(edge.node);
        }
      }
    } catch (e) {
      // A superseded run was aborted on purpose; logging it would add a line
      // per streamer to the console on every filter switch.
      if (stale()) return;
      appendLogMessage(`[Clips] Failed to fetch clips for ${login}: ${e.message}`);
    }
  }
  if (stale()) return;

  // Sort logic based on filter
  if (filter === 'latest') {
    allClips.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else {
    allClips.sort((a, b) => b.viewCount - a.viewCount);
  }

  if (allClips.length === 0) {
    clipsGrid.innerHTML = `
      <div class="no-clips-message" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p>No ${escapeHtml(filter)} clips found for your monitored streamers.</p>
      </div>`;
    return;
  }

  clipsGrid.innerHTML = '';
  allClips.slice(0, 30).forEach(clip => {
    clipsGrid.appendChild(createClipCard(clip));
  });
  
  appendLogMessage(`[Clips] Loaded ${Math.min(allClips.length, 30)} ${filter} clips.`);
}

// ── Cards ────────────────────────────────────────────────────────────────────
// The markup is fixed; clip data is filled in afterwards through textContent,
// DOM properties and dataset, so no clip string is ever parsed as HTML.

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
// paintSaveButton() flips the fill between 'none' and 'currentColor'.
const HEART_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';

const CLIP_CARD_HTML = `
    <div style="position: relative; width: 100%; padding-top: 56.25%; background: #000;">
      <img class="clip-thumb" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;" alt="Thumbnail">
      <div class="clip-duration" style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 600;"></div>
    </div>
    <div style="padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1;">
      <h4 class="clip-title" style="margin: 0; font-size: 0.95rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></h4>
      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted);">
        <span class="clip-author"></span>
        <span class="clip-views"></span>
      </div>
      <div style="margin-top: auto; display: flex; gap: 8px; justify-content: space-between; padding-top: 8px;">
        <button class="btn btn-sm btn-cyan play-btn" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Watch
        </button>
        <button class="btn btn-sm download-btn" style="background: var(--panel-glass); border: 1px solid var(--panel-border); color: var(--text-primary); padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s;" title="Download">
          ${DOWNLOAD_ICON}
        </button>
        <button class="btn btn-sm save-btn" style="border: 1px solid var(--panel-border); padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s;">
          ${HEART_ICON}
        </button>
      </div>
    </div>
  `;

const SAVED_CLIP_HTML = `
      <img class="clip-thumb" style="width: 80px; height: 45px; object-fit: cover; border-radius: 4px;" alt="Thumb">
      <div style="flex: 1; min-width: 0;">
        <div class="clip-title" style="font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px;"></div>
        <div class="clip-author" style="font-size: 0.75rem; color: var(--text-muted);"></div>
      </div>
      <button class="btn btn-sm btn-cyan play-btn" style="padding: 4px; height: 26px; width: 26px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="Watch">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      </button>
      <button class="btn btn-sm remove-btn" style="padding: 4px; height: 26px; width: 26px; display: flex; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; color: #ef4444; flex-shrink: 0;" title="Remove">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;

function paintSaveButton(btn, saved) {
  btn.style.background = saved ? 'rgba(239, 68, 68, 0.2)' : 'var(--panel-glass)';
  btn.style.borderColor = saved ? '#ef4444' : 'var(--panel-border)';
  btn.style.color = saved ? '#ef4444' : 'var(--text-primary)';
  btn.title = saved ? 'Unsave' : 'Save';
  btn.querySelector('svg')?.setAttribute('fill', saved ? 'currentColor' : 'none');
}

// Shared by both card kinds: thumbnail, title (text and tooltip), author.
function fillClipIdentity(el, clip, view) {
  const thumbUrl = clipThumbUrl(clip);
  if (thumbUrl) el.querySelector('.clip-thumb').src = thumbUrl;
  const titleEl = el.querySelector('.clip-title');
  titleEl.textContent = view.title;
  titleEl.title = view.title;
  el.querySelector('.clip-author').textContent = view.author;
}

// Clips open and download through main only. A window.open fallback went to
// main's popup handler instead, which opens a link in the system browser only
// right after a click and denies it otherwise, so whether it worked depended
// on timing. The bridge is always there (preload.js).
async function openClip(clip) {
  const pageUrl = clipPageUrl(clip);
  if (!pageUrl) {
    appendLogMessage('[Clips] Not opening a clip whose link is not a twitch.tv https URL.');
    return;
  }
  try {
    const res = await window.api.openClipWindow(pageUrl);
    if (res && res.success === false) appendLogMessage(`[Clips] Could not open the clip: ${res.error || 'unknown error'}`);
  } catch (err) {
    appendLogMessage(`[Clips] Could not open the clip: ${err?.message || err}`);
  }
}

async function downloadClipFile(mp4Url, fileName, title) {
  try {
    const res = await window.api.downloadClip(mp4Url, fileName);
    if (res && res.success === false) appendLogMessage(`[Clips] Could not download ${title}: ${res.error || 'unknown error'}`);
  } catch (err) {
    appendLogMessage(`[Clips] Could not download ${title}: ${err?.message || err}`);
  }
}

function createClipCard(clip) {
  const isSaved = savedClips.some(c => c.id === clip.id);
  const view = clipView(clip);

  const el = document.createElement('div');
  el.className = 'glass-panel';
  el.style.cssText = 'overflow: hidden; border-radius: var(--radius-md); display: flex; flex-direction: column; background: rgba(30,30,40,0.5);';
  el.innerHTML = CLIP_CARD_HTML;

  fillClipIdentity(el, clip, view);
  el.querySelector('.clip-duration').textContent = view.duration;
  el.querySelector('.clip-views').textContent = `${view.views} views`;

  // Attach events
  const playBtn = el.querySelector('.play-btn');
  const downloadBtn = el.querySelector('.download-btn');
  const saveBtn = el.querySelector('.save-btn');
  saveBtn.dataset.clipId = view.id;
  paintSaveButton(saveBtn, isSaved);

  playBtn.addEventListener('click', () => openClip(clip));

  downloadBtn.addEventListener('click', async () => {
    let mp4Url = '';
    const sourceUrl = clipSourceUrl(clip);
    
    // First, try to sign the download if it's a modern AWS cloudfront MP4
    if (sourceUrl) {
      try {
        downloadBtn.innerHTML = '<span style="font-size: 0.75rem;">...</span>';
        
        const query = `
          query GetClipAccessToken($slug: ID!) {
            clip(slug: $slug) {
              playbackAccessToken(params: {
                platform: "web",
                playerBackend: "mediaplayer",
                playerType: "site"
              }) {
                signature
                value
              }
            }
          }
        `;
        
        const res = await fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: {
            'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([{
            operationName: 'GetClipAccessToken',
            variables: { slug: clip.slug },
            query
          }])
        });
        
        const data = await res.json();
        mp4Url = signedClipUrl(sourceUrl, data[0]?.data?.clip?.playbackAccessToken);
      } catch (err) {
        console.error('Failed to sign clip URL:', err);
        mp4Url = sourceUrl;
      } finally {
        downloadBtn.innerHTML = DOWNLOAD_ICON;
      }
    } else {
      // Fallback for older saved clips without videoQualities
      mp4Url = legacyClipMp4Url(clip);
    }
    
    if (mp4Url) {
      await downloadClipFile(mp4Url, view.fileName, view.title);
    } else {
      appendLogMessage(`[Clips] Could not resolve download URL for ${view.title}`);
    }
  });

  saveBtn.addEventListener('click', () => {
    const idx = savedClips.findIndex(c => c.id === clip.id);
    if (idx >= 0) {
      savedClips.splice(idx, 1);
    } else {
      savedClips.push(clip);
    }
    saveClipsToStorage();
    paintSaveButton(saveBtn, idx < 0);
    renderSavedClips();
  });

  return el;
}

function saveClipsToStorage() {
  try {
    localStorage.setItem(SAVED_CLIPS_KEY, JSON.stringify(savedClips));
  } catch (e) {
    console.error('Failed to save clips to localStorage', e);
  }
}

function renderSavedClips() {
  if (!savedClipsList) return;
  savedClipsList.innerHTML = '';
  
  if (savedClips.length === 0) {
    savedClipsList.innerHTML = `
      <div class="no-clips-message" style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 20px;">
        <p>No saved clips yet. Find a clip and click the heart to save it!</p>
      </div>`;
    return;
  }
  
  savedClips.forEach(clip => {
    const el = document.createElement('div');
    el.className = 'glass-panel';
    el.style.cssText = 'padding: 8px; display: flex; gap: 10px; align-items: center; border-radius: var(--radius-sm); background: rgba(30,30,40,0.5);';
    el.innerHTML = SAVED_CLIP_HTML;
    fillClipIdentity(el, clip, clipView(clip, 'Untitled'));

    el.querySelector('.play-btn').addEventListener('click', () => openClip(clip));
    
    el.querySelector('.remove-btn').addEventListener('click', () => {
      savedClips = savedClips.filter(c => c.id !== clip.id);
      saveClipsToStorage();
      renderSavedClips();
      
      // Update heart icon in main grid if present. Matched through dataset
      // rather than a selector, so no stored id is ever parsed as CSS.
      const id = String(clip.id);
      const btn = [...(clipsGrid?.querySelectorAll('button.save-btn') || [])]
        .find(b => b.dataset.clipId === id);
      if (btn) paintSaveButton(btn, false);
    });
    
    savedClipsList.appendChild(el);
  });
}
