import { state, appendLogMessage } from './state.js';

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Public client ID

// Elements
let clipsGrid;
let savedClipsList;
let refreshBtn;
let filterSelect;

let savedClips = [];

export function initClipsManager() {
  clipsGrid = document.getElementById('trending-clips-grid');
  savedClipsList = document.getElementById('saved-clips-list');
  refreshBtn = document.getElementById('refresh-clips-btn');
  filterSelect = document.getElementById('clips-filter-select');

  // Load saved clips from localStorage
  try {
    const stored = localStorage.getItem('stream_lurker_saved_clips');
    if (stored) {
      savedClips = JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load saved clips:', e);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', fetchTrendingClips);
  }
  
  if (filterSelect) {
    filterSelect.addEventListener('change', fetchTrendingClips);
  }

  renderSavedClips();

  // Try fetching on init
  setTimeout(fetchTrendingClips, 1000);
}

function getMonitoredTwitchStreamers() {
  const cfg = state.currentConfig;
  if (!cfg || !cfg.streamers) return [];
  return cfg.streamers.filter(s => s.platform.toLowerCase() === 'twitch').map(s => s.username);
}

async function fetchTrendingClips() {
  if (!clipsGrid) return;
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
      <p>Fetching ${filter} clips...</p>
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
        }])
      });

      const data = await res.json();
      const userNode = data[0]?.data?.user;
      if (userNode && userNode.clips && userNode.clips.edges) {
        for (const edge of userNode.clips.edges) {
          allClips.push(edge.node);
        }
      }
    } catch (e) {
      appendLogMessage(`[Clips] Failed to fetch clips for ${login}: ${e.message}`);
    }
  }

  // Sort logic based on filter
  if (filter === 'latest') {
    allClips.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else {
    allClips.sort((a, b) => b.viewCount - a.viewCount);
  }

  if (allClips.length === 0) {
    clipsGrid.innerHTML = `
      <div class="no-clips-message" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p>No ${filter} clips found for your monitored streamers.</p>
      </div>`;
    return;
  }

  clipsGrid.innerHTML = '';
  allClips.slice(0, 30).forEach(clip => {
    clipsGrid.appendChild(createClipCard(clip));
  });
  
  appendLogMessage(`[Clips] Loaded ${Math.min(allClips.length, 30)} ${filter} clips.`);
}

function createClipCard(clip) {
  const isSaved = savedClips.some(c => c.id === clip.id);
  
  const el = document.createElement('div');
  el.className = 'glass-panel';
  el.style.cssText = 'overflow: hidden; border-radius: var(--radius-md); display: flex; flex-direction: column; background: rgba(30,30,40,0.5);';
  
  const thumbUrl = clip.thumbnailURL || '';
  const title = clip.title || 'Untitled Clip';
  const views = clip.viewCount ? clip.viewCount.toLocaleString() : '0';
  const duration = clip.durationSeconds ? `${clip.durationSeconds}s` : '';
  const author = clip.broadcaster ? clip.broadcaster.displayName : 'Unknown';

  el.innerHTML = `
    <div style="position: relative; width: 100%; padding-top: 56.25%; background: #000;">
      <img src="${thumbUrl}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;" alt="Thumbnail">
      <div style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">${duration}</div>
    </div>
    <div style="padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1;">
      <h4 style="margin: 0; font-size: 0.95rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${title}">${title}</h4>
      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted);">
        <span>${author}</span>
        <span>${views} views</span>
      </div>
      <div style="margin-top: auto; display: flex; gap: 8px; justify-content: space-between; padding-top: 8px;">
        <button class="btn btn-sm btn-cyan play-btn" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          Watch
        </button>
        <button class="btn btn-sm download-btn" style="background: var(--panel-glass); border: 1px solid var(--panel-border); color: var(--text-primary); padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s;" title="Download">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button class="btn btn-sm save-btn" data-clip-id="${clip.id}" style="background: ${isSaved ? 'rgba(239, 68, 68, 0.2)' : 'var(--panel-glass)'}; border: 1px solid ${isSaved ? '#ef4444' : 'var(--panel-border)'}; color: ${isSaved ? '#ef4444' : 'var(--text-primary)'}; padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; transition: all 0.2s;" title="${isSaved ? 'Unsave' : 'Save'}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
        </button>
      </div>
    </div>
  `;

  // Attach events
  const playBtn = el.querySelector('.play-btn');
  const downloadBtn = el.querySelector('.download-btn');
  const saveBtn = el.querySelector('.save-btn');

  playBtn.addEventListener('click', () => {
    if (window.api && window.api.openClipWindow) {
      window.api.openClipWindow(clip.url);
    } else {
      window.open(clip.url, '_blank');
    }
  });

  downloadBtn.addEventListener('click', async () => {
    let mp4Url = '';
    
    // First, try to sign the download if it's a modern AWS cloudfront MP4
    if (clip.videoQualities && clip.videoQualities.length > 0) {
      const sourceUrl = clip.videoQualities[0].sourceURL;
      
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
        const tokenData = data[0]?.data?.clip?.playbackAccessToken;
        
        if (tokenData && tokenData.signature && tokenData.value) {
          const sig = tokenData.signature;
          const token = encodeURIComponent(tokenData.value);
          mp4Url = `${sourceUrl}?sig=${sig}&token=${token}`;
        } else {
          mp4Url = sourceUrl; // Fallback
        }
      } catch (err) {
        console.error('Failed to sign clip URL:', err);
        mp4Url = sourceUrl;
      } finally {
        downloadBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
      }
    } else if (thumbUrl) {
      // Fallback for older saved clips without videoQualities
      mp4Url = thumbUrl.replace(/-preview-.*\.jpg$/, '.mp4').replace(/-[0-9x]+\.jpg$/, '.mp4');
    }
    
    if (mp4Url && window.api && window.api.downloadClip) {
      window.api.downloadClip(mp4Url, `${clip.slug}.mp4`);
    } else if (mp4Url) {
      window.open(mp4Url, '_blank');
    } else {
      appendLogMessage(`[Clips] Could not resolve download URL for ${title}`);
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
    
    const newIsSaved = idx < 0;
    saveBtn.style.background = newIsSaved ? 'rgba(239, 68, 68, 0.2)' : 'var(--panel-glass)';
    saveBtn.style.borderColor = newIsSaved ? '#ef4444' : 'var(--panel-border)';
    saveBtn.style.color = newIsSaved ? '#ef4444' : 'var(--text-primary)';
    saveBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="${newIsSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
    
    renderSavedClips();
  });

  return el;
}

function saveClipsToStorage() {
  try {
    localStorage.setItem('stream_lurker_saved_clips', JSON.stringify(savedClips));
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
    
    const thumbUrl = clip.thumbnailURL || '';
    const title = clip.title || 'Untitled';
    const author = clip.broadcaster ? clip.broadcaster.displayName : 'Unknown';
    
    el.innerHTML = `
      <img src="${thumbUrl}" style="width: 80px; height: 45px; object-fit: cover; border-radius: 4px;" alt="Thumb">
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px;" title="${title}">${title}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${author}</div>
      </div>
      <button class="btn btn-sm btn-cyan play-btn" style="padding: 4px; height: 26px; width: 26px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="Watch">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      </button>
      <button class="btn btn-sm remove-btn" style="padding: 4px; height: 26px; width: 26px; display: flex; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; color: #ef4444; flex-shrink: 0;" title="Remove">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;
    
    el.querySelector('.play-btn').addEventListener('click', () => {
      if (window.api && window.api.openClipWindow) {
        window.api.openClipWindow(clip.url);
      } else {
        window.open(clip.url, '_blank');
      }
    });
    
    el.querySelector('.remove-btn').addEventListener('click', () => {
      savedClips = savedClips.filter(c => c.id !== clip.id);
      saveClipsToStorage();
      renderSavedClips();
      
      // Update heart icon in main grid if present
      const btn = clipsGrid.querySelector(`button.save-btn[data-clip-id="${clip.id}"]`);
      if (btn) {
        btn.style.background = 'var(--panel-glass)';
        btn.style.borderColor = 'var(--panel-border)';
        btn.style.color = 'var(--text-primary)';
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
      }
    });
    
    savedClipsList.appendChild(el);
  });
}
