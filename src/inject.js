// Scripts injected via webview.executeJavaScript inside the platform pages.
// They run in the guest context, not the renderer — keep them as plain strings
// or string-producing functions.

// ---------------------------------------------------------------------------
// Page-side helpers. Each is serialized into the page script with toString(),
// so the guest runs exactly the code test/page-*.test.js exercises. Keep them
// self-contained: no imports, no module-level names, nothing captured.
// ---------------------------------------------------------------------------

// "1080p60 (Source)" -> { height: 1080, fps: 60 }. Anchored at the start so
// YouTube's "Auto (720p)" and a parent row like "Quality 1080p" never parse.
export function parseRendition(label) {
  const m = /^(\d{3,4})p(\d{2,3})?/i.exec(String(label == null ? '' : label).trim());
  return m ? { height: parseInt(m[1], 10), fps: m[2] ? parseInt(m[2], 10) : 0 } : null;
}

// Index of the menu row to click for a quality setting, or -1.
// 'source' takes a row that names itself Source/Original, else the highest
// rendition (labels are localized, "(Quelle)", "(Fuente)", so the ranking is
// what makes it work everywhere). A 'NNNp' cap takes the best rendition at or
// under it, else the lowest offered, so a source-only channel still resolves.
// Auto rows never parse. Premium rows are skipped: for accounts without
// Premium they open an upsell instead of switching quality.
export function pickRendition(labels, quality) {
  const want = String(quality == null ? '' : quality).trim().toLowerCase();
  let named = -1;
  const rows = [];
  for (let i = 0; i < labels.length; i++) {
    const text = String(labels[i] == null ? '' : labels[i]).trim();
    if (!text || /premium/i.test(text)) continue;
    if (named < 0 && /\b(source|original)\b/i.test(text) && !/^auto/i.test(text)) named = i;
    const r = parseRendition(text);
    if (r) rows.push({ i: i, h: r.height, f: r.fps });
  }
  if (want === 'source') {
    if (named >= 0) return named;
    let top = null;
    for (const r of rows) if (!top || r.h > top.h || (r.h === top.h && r.f > top.f)) top = r;
    return top ? top.i : -1;
  }
  const cap = parseInt(want, 10);
  if (!(cap > 0)) return -1;
  let under = null;
  let lowest = null;
  for (const r of rows) {
    if (r.h <= cap && (!under || r.h > under.h || (r.h === under.h && r.f > under.f))) under = r;
    if (!lowest || r.h < lowest.h || (r.h === lowest.h && r.f < lowest.f)) lowest = r;
  }
  return under ? under.i : (lowest ? lowest.i : -1);
}

// The "Quality" row of a player settings menu, in the UI languages the
// platforms ship. Words for "quality" only: resolutions or "Auto" would also
// match the rendition rows.
export function isQualityLabel(text) {
  return /quality|calidad|qualité|qualità|qualität|qualidade|kvalit|kwaliteit|kalite|jakość|laatu|minőség|calitate|качество|якість|ποιότητα|品質|画質|画质|畫質|质量|품질|화질|คุณภาพ|chất lượng|kualitas|الجودة/i
    .test(String(text == null ? '' : text));
}

// Per-channel attempt budget for the menu-driven quality pickers (Twitch,
// Kick). st is the previous state or null; obs is { key, quality, now,
// videoHeight }. Keyed on the pathname, not the document: raids and in-page
// channel switches keep the document, and a document-wide latch would skip
// the next channel. Once a channel resolves or gives up, videoHeight is
// ignored: ads and stream restarts report other heights and must not restart
// the menu loop. Returns { st, action: idle|attempt|resolved|gaveup, log }.
export function qualityStep(st, obs) {
  // Wait before attempt 2, 3, ...: four quick tries, then minutes apart so a
  // long pre-roll ad cannot use up the whole budget, then give up (~18 min).
  const RETRY_MS = [15000, 15000, 15000, 120000, 300000, 600000];
  const MAX_ATTEMPTS = RETRY_MS.length + 1;
  const VERIFY_MS = 20000;
  if (!st || st.key !== obs.key || st.quality !== obs.quality) {
    st = { key: obs.key, quality: obs.quality, attempts: 0, lastAt: 0, pending: null,
      resolved: false, gaveUp: false, failLogged: false, lastFail: '' };
  } else {
    st = Object.assign({}, st);
  }
  if (st.resolved || st.gaveUp) return { st: st, action: 'idle', log: '' };
  // Nothing decoded yet (offline page, mature-content gate): the menu has no
  // real renditions to pick from, so an attempt now would only burn budget.
  if (!(obs.videoHeight > 0)) return { st: st, action: 'idle', log: '' };
  let log = '';
  if (st.pending) {
    const p = st.pending;
    if (p.height == null || obs.videoHeight <= p.height * 1.25) {
      st.pending = null;
      st.resolved = true;
      return { st: st, action: 'resolved', log: 'Quality set to ' + p.label + ' on ' + st.key + '.' };
    }
    if (obs.now - p.at < VERIFY_MS) return { st: st, action: 'idle', log: '' };
    st.pending = null;
    st.lastFail = 'the player stayed at ' + obs.videoHeight + 'p after picking ' + p.label;
    if (!st.failLogged) {
      st.failLogged = true;
      log = 'Could not confirm ' + st.quality + ' on ' + st.key + ' (' + st.lastFail + '); will retry a few times.';
    }
  }
  if (st.attempts >= MAX_ATTEMPTS) {
    st.gaveUp = true;
    return { st: st, action: 'gaveup',
      log: 'Giving up on ' + st.quality + ' for ' + st.key + ' after ' + st.attempts + ' attempts (' + (st.lastFail || 'no reason recorded') + ').' };
  }
  if (st.attempts > 0 && obs.now - st.lastAt < RETRY_MS[st.attempts - 1]) return { st: st, action: 'idle', log: log };
  st.attempts += 1;
  st.lastAt = obs.now;
  return { st: st, action: 'attempt', log: log };
}

// Folds one menu walk into the state from qualityStep. outcome is
// { picked: { label, height, checked } } or { fail: 'reason' }.
export function qualityRecord(st, outcome, now) {
  st = Object.assign({}, st);
  const picked = outcome && outcome.picked;
  if (picked) {
    // Already the selected row: nothing to switch and nothing to wait for.
    if (picked.checked) {
      st.pending = null;
      st.resolved = true;
      return { st: st, log: 'Quality set to ' + picked.label + ' on ' + st.key + '.' };
    }
    st.pending = { label: picked.label, height: picked.height == null ? null : picked.height, at: now };
    return { st: st, log: '' };
  }
  st.lastFail = (outcome && outcome.fail) || 'unknown error';
  if (st.failLogged) return { st: st, log: '' };
  st.failLogged = true;
  return { st: st, log: 'Could not set ' + st.quality + ' on ' + st.key + ' (' + st.lastFail + '); will retry a few times.' };
}

// The theater button (Kick, and Twitch's button path). Click only while
// theater is off (Kick's selector also matches "Exit theater mode"), latch
// once a later tick shows the click changed something (label, icon, player
// width), and stop after a few clicks, so a renamed label or an unrecognised
// locale cannot keep the page toggling every tick. obs is { found, on, sig }.
export function theaterStep(st, obs) {
  const MAX_CLICKS = 5;
  st = st ? Object.assign({}, st) : { clicks: 0, sig: null, done: false };
  if (st.done || !obs.found) return { st: st, action: 'idle' };
  if (obs.on || (st.sig !== null && obs.sig !== st.sig)) {
    st.done = true;
    return { st: st, action: 'latched' };
  }
  if (st.clicks >= MAX_CLICKS) {
    st.done = true;
    return { st: st, action: 'gaveup' };
  }
  st.clicks += 1;
  st.sig = obs.sig;
  return { st: st, action: 'click' };
}

// A synthetic click that behaves like one real click: pointer and mouse
// down/up at the element's centre, then exactly one click. The old version
// also called el.click() afterwards, so every toggle (theater, the settings
// cog) fired twice and cancelled itself out. Retarget only to a real control:
// class-name guesses like [class*="pointer"] hit Tailwind's cursor-pointer and
// pointer-events-none and moved clicks off an option onto its list wrapper.
// Events bubble, so a handler on a plain ancestor still sees the click.
export function directClick(el) {
  if (!el) return;
  if (el.closest) {
    const control = el.closest('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], a[href]');
    if (control) el = control;
  }
  let clicked = false;
  try {
    const r = el.getBoundingClientRect();
    const at = { view: window, bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    const ptr = Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, at);
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ buttons: 1 }, ptr)));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, at)));
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
    clicked = true;
  } catch (e) {
    if (!clicked) { try { el.click(); } catch (err) {} }
  }
}

export function qualityAndTheaterScript(quality) {
  return `
    (function() {
      const quality = ${JSON.stringify(quality)};

      const parseRendition = ${parseRendition.toString()};
      const pickRendition = ${pickRendition.toString()};
      const isQualityLabel = ${isQualityLabel.toString()};
      const qualityStep = ${qualityStep.toString()};
      const qualityRecord = ${qualityRecord.toString()};
      const theaterStep = ${theaterStep.toString()};
      const directClick = ${directClick.toString()};

      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Poll instead of a flat delay: on a slow frame a fixed 100ms read the
      // menu before it rendered and counted that as a failed attempt.
      const waitFor = async (fn, timeoutMs) => {
        const until = Date.now() + timeoutMs;
        for (;;) {
          const v = fn();
          if (v) return v;
          if (Date.now() >= until) return null;
          await sleep(100);
        }
      };

      const isShown = (node) => {
        if (!node || !node.isConnected) return false;
        if (node.getAttribute && node.getAttribute('data-state') === 'closed') return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // Close a settings menu this script opened, and only while it is still
      // open: a blind toggle on the cog reopens a menu the page already shut.
      // node is a concrete element seen inside the menu, never a re-run of a
      // loose text heuristic, which can match ordinary text near the cog.
      // With neither node nor aria-expanded there is no way to tell, so only
      // Escape is sent: it can close the menu but never reopen it.
      const closeMenu = async (cog, node, click) => {
        const exp = cog && cog.getAttribute ? cog.getAttribute('aria-expanded') : null;
        const known = exp === 'true' || exp === 'false' || !!node;
        const open = () => {
          const e = cog && cog.getAttribute ? cog.getAttribute('aria-expanded') : null;
          if (e === 'true') return true;
          if (e === 'false') return false;
          return isShown(node);
        };
        if (known) {
          if (!open()) return;
          click(cog);
          await sleep(300);
          if (!open()) return;
        }
        const target = (node && node.isConnected) ? node : document;
        ['keydown', 'keyup'].forEach(type => target.dispatchEvent(new KeyboardEvent(type, {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        })));
      };

      // One attempt budget per channel for Twitch and Kick: resolve once, or
      // give up after a few failed rounds, instead of reopening the settings
      // menu every 15s for the life of the cell. Logs only on state changes.
      const runQuality = async (tag, walk) => {
        if (window.__autoQualityDisabled) {
          // Re-enabling auto quality later should cap again from scratch.
          window.__qualityState = null;
          return;
        }
        if (window.__qualityBusy) return;
        const video = document.querySelector('video');
        const step = qualityStep(window.__qualityState, {
          key: window.location.pathname, quality: quality, now: Date.now(),
          videoHeight: video ? video.videoHeight : 0
        });
        window.__qualityState = step.st;
        if (step.log) console.log('[' + tag + '] ' + step.log);
        if (step.action === 'resolved') window.__qualitySet = quality;
        if (step.action !== 'attempt') return;
        window.__qualityBusy = true;
        let outcome;
        try {
          outcome = await walk(step.st, video);
        } catch (e) {
          console.error('[' + tag + '] Error in quality setting loop: ' + e.message);
          outcome = { fail: 'error: ' + e.message };
        } finally {
          window.__qualityBusy = false;
        }
        // Auto quality was switched off mid-walk and the state reset: drop it.
        if (window.__qualityState !== step.st) return;
        const rec = qualityRecord(window.__qualityState, outcome, Date.now());
        window.__qualityState = rec.st;
        if (rec.log) console.log('[' + tag + '] ' + rec.log);
        if (rec.st.resolved) window.__qualitySet = quality;
      };

      const isChatElement = (el) => {
        let ancestor = el;
        while (ancestor && ancestor !== document.body) {
          const cls = ancestor.className || '';
          const id = ancestor.id || '';
          const clsStr = typeof cls === 'string' ? cls : (cls.baseVal || '');
          const idStr = typeof id === 'string' ? id : '';

          const isLayout = clsStr.toLowerCase().includes('layout') ||
                           clsStr.toLowerCase().includes('page') ||
                           clsStr.toLowerCase().includes('enabled') ||
                           clsStr.toLowerCase().includes('active') ||
                           clsStr.toLowerCase().includes('wrapper') ||
                           clsStr.toLowerCase().includes('screen');

          if (!isLayout && (
            clsStr.toLowerCase().includes('chat-room') ||
            clsStr.toLowerCase().includes('chat-container') ||
            clsStr.toLowerCase().includes('chat-messages') ||
            clsStr.toLowerCase().includes('chat-input') ||
            clsStr.toLowerCase().includes('chat-list') ||
            clsStr.toLowerCase().includes('chat-line') ||
            clsStr.toLowerCase().includes('message') ||
            idStr.toLowerCase().includes('chat-room') ||
            idStr.toLowerCase().includes('chat-container') ||
            idStr.toLowerCase().includes('chat-messages') ||
            idStr.toLowerCase().includes('message') ||
            (clsStr.toLowerCase() === 'chat' || idStr.toLowerCase() === 'chat')
          )) {
            return true;
          }
          ancestor = ancestor.parentElement;
        }
        return false;
      };

      if (window.location.host.includes('twitch.tv')) {
        // The data-a-target hook is locale-independent; the text match is only
        // a fallback. Filtering on English/French text made every other UI
        // language flash the menu forever without ever capping quality.
        const findTwitchQualityRow = () =>
          document.querySelector('[data-a-target="player-settings-menu-item-quality"]') ||
          Array.from(document.querySelectorAll('.player-menu__item, [role="menuitem"]'))
            .find(el => isQualityLabel(el.textContent)) || null;

        const readTwitchOptions = () => {
          let rows = Array.from(document.querySelectorAll('[data-a-target="player-settings-submenu-quality-option"]'));
          if (!rows.length) rows = Array.from(document.querySelectorAll('.tw-radio__label, .player-menu__item, [data-a-target="player-settings-menu-item"]'));
          return rows.map(el => {
            const input = el.control || el.querySelector('input[type="radio"]');
            return {
              el: el,
              label: (el.textContent || '').trim(),
              target: el.tagName === 'LABEL' ? el : (el.querySelector('label') || input || el),
              checked: !!(input && input.checked) || el.getAttribute('aria-checked') === 'true'
            };
          });
        };

        const twitchMenuNode = (cog) => {
          const menu = document.querySelector('[data-a-target="player-settings-menu"]');
          if (menu) return menu;
          const root = cog.closest('[data-a-target="video-player"], .video-player');
          return root ? root.querySelector('[role="menu"]') : null;
        };

        const twitchQualityWalk = async () => {
          const cog = document.querySelector('[data-a-target="player-settings-button"]');
          if (!cog) return { fail: 'settings button not found' };
          cog.click();
          let seen = null;
          try {
            const row = await waitFor(findTwitchQualityRow, 3000);
            if (!row) return { fail: 'Quality row not found in the settings menu' };
            seen = row;
            row.click();
            // Wait for real rendition rows: until the submenu renders, the
            // fallback selectors still see the parent menu's items.
            const opts = await waitFor(() => {
              const o = readTwitchOptions();
              return o.some(x => parseRendition(x.label)) ? o : null;
            }, 3000);
            if (!opts) return { fail: 'the quality submenu listed no renditions' };
            seen = opts[0].el;
            const idx = pickRendition(opts.map(o => o.label), quality);
            if (idx < 0) return { fail: 'no rendition fits ' + quality };
            const o = opts[idx];
            if (!o.checked) o.target.click();
            const r = parseRendition(o.label);
            return { picked: { label: o.label, height: quality === 'source' || !r ? null : r.height, checked: o.checked } };
          } finally {
            await sleep(150);
            const menuNode = twitchMenuNode(cog);
            await closeMenu(cog, [seen, menuNode].find(isShown) || menuNode || seen, el => el.click());
          }
        };

        setInterval(() => {
          try {
            // Auto-theater runs only until we observe theater mode active once.
            // After that the user can exit theater freely without us forcing
            // it back on, so they can scroll down to the streamer's page.
            if (!window.__twitchTheaterLatched) {
              const playerContainer = document.querySelector('.video-player__container, [data-a-target="video-player"]');
              const btn = document.querySelector('[data-a-target="player-theatre-mode-button"]') ||
                          document.querySelector('button[aria-label*="Theatre Mode"]') ||
                          document.querySelector('button[aria-label*="Theater Mode"]');

              const isTheater = !!(
                // Locale-independent hooks on the current Twitch layout (the
                // older ones below no longer match anything).
                document.querySelector('.persistent-player--theatre') ||
                document.querySelector('.channel-page__video-player--theatre-mode') ||
                document.querySelector('.video-player--theatre') ||
                document.querySelector('.tw-html--theatre') ||
                document.querySelector('[data-a-target="player-theatre-mode-button"][aria-checked="true"]') ||
                document.querySelector('.video-player--theatre-mode') ||
                document.querySelector('html.tw-html--theatre') ||
                (btn && (
                  (btn.getAttribute('aria-label') || '').toLowerCase().includes('normal') ||
                  (btn.getAttribute('aria-label') || '').toLowerCase().includes('exit') ||
                  (btn.getAttribute('aria-label') || '').toLowerCase().includes('quitter') ||
                  (btn.getAttribute('aria-label') || '').toLowerCase().includes('çık') ||
                  (btn.getAttribute('aria-label') || '').toLowerCase().includes('beenden')
                ))
              );

              if (isTheater) {
                window.__twitchTheaterLatched = true;
              } else if (btn) {
                // directClick now really toggles (it used to click twice), so
                // confirm the click took and cap the tries: in a locale whose
                // "exit" label is not listed above, isTheater stays false and
                // an unchecked click would flip theatre every 3s for days.
                const pc = playerContainer ? playerContainer.getBoundingClientRect() : null;
                const tstep = theaterStep(window.__twitchTheaterState, {
                  found: true,
                  on: false,
                  sig: [btn.getAttribute('aria-label'), btn.getAttribute('aria-checked'), pc ? Math.round(pc.width / 10) : 0].join('|')
                });
                window.__twitchTheaterState = tstep.st;
                if (tstep.action === 'click') directClick(btn);
                else if (tstep.action !== 'idle') window.__twitchTheaterLatched = true;
              } else {
                if (playerContainer) {
                  playerContainer.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                  playerContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                  playerContainer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                }

                const kbEv = new KeyboardEvent('keydown', {
                  key: 't', code: 'KeyT', keyCode: 84, which: 84,
                  altKey: true, bubbles: true, cancelable: true
                });
                const target = document.querySelector('video') || playerContainer || document;
                target.dispatchEvent(kbEv);
                document.dispatchEvent(kbEv);
                window.dispatchEvent(kbEv);

                if (document.querySelector('video')) {
                  console.log("[Twitch Theater] Need Alt+T");
                }
              }
            }

            runQuality('Twitch Quality', twitchQualityWalk);
          } catch(e){}
        }, 3000);
      } else if (window.location.host.includes('kick.com')) {
        setInterval(() => {
          try {
            const tstate = window.__kickTheaterState;
            if (!tstate || !tstate.done) {
              const tbtn = document.querySelector('button[aria-label*="theater" i], button[title*="theater" i], button[aria-label*="theatre" i], button[title*="theatre" i]');
              const tlabel = tbtn ? ((tbtn.getAttribute('aria-label') || '') + ' ' + (tbtn.getAttribute('title') || '')).toLowerCase() : '';
              const ticon = tbtn ? tbtn.querySelector('path') : null;
              const tvideo = document.querySelector('video');
              const tstep = theaterStep(tstate, {
                found: !!tbtn,
                on: !!tbtn && (tbtn.getAttribute('aria-pressed') === 'true' || /exit|leave|normal|default|close|quit|disable/.test(tlabel)),
                // Whatever a real toggle changes: label, pressed state, icon, player width.
                sig: tbtn ? [tlabel, tbtn.getAttribute('aria-pressed'), ticon ? ticon.getAttribute('d') : '',
                  tvideo ? Math.round(tvideo.getBoundingClientRect().width / 10) : 0].join('|') : ''
              });
              window.__kickTheaterState = tstep.st;
              if (tstep.action === 'click') directClick(tbtn);
              else if (tstep.action === 'gaveup') console.log('[Kick Theater] Theater button did not respond after ' + tstep.st.clicks + ' clicks; leaving the layout alone.');
            }
          } catch(e){}

          runQuality('Kick Quality', async (st, player) => {
            const targetQuality = quality;

            const playerContainer = player.parentElement.closest('[id*="player"], [class*="player"], [class*="Player"]') || player.parentElement;

            if (playerContainer) {
              const rect = playerContainer.getBoundingClientRect();
              const centerX = Math.round(rect.left + rect.width / 2) || 100;
              const centerY = Math.round(rect.top + rect.height / 2) || 100;
              ['mouseenter', 'mouseover', 'mousemove'].forEach(type => {
                const ev = new MouseEvent(type, { view: window, bubbles: true, cancelable: true, clientX: centerX, clientY: centerY });
                playerContainer.dispatchEvent(ev);
                player.dispatchEvent(ev);
              });
            }

            await new Promise(r => setTimeout(r, 100));

            const findSettingsCog = () => {
              if (!playerContainer) return null;

              const selectors = [
                'button[aria-label="Settings"]', 'button[title="Settings"]',
                'button[aria-label="Ayarlar"]', 'button[title="Ayarlar"]',
                '[aria-label*="Settings"]', '[aria-label*="settings"]',
                '[class*="settings-button"]', '[id*="settings"]',
                'button.vjs-settings-control', 'button.vjs-menu-button'
              ];
              for (const sel of selectors) {
                const el = playerContainer.querySelector(sel);
                if (el && !isChatElement(el)) return el;
              }

              const svgs = Array.from(playerContainer.querySelectorAll('svg'));
              for (const svg of svgs) {
                if (isChatElement(svg)) continue;
                const html = svg.outerHTML.toLowerCase();
                if (html.includes('settings') || html.includes('gear') || html.includes('cog') || html.includes('setup') ||
                    html.includes('m25.7') || html.includes('m12 ') || html.includes('m19.4') ||
                    svg.className.toString().toLowerCase().includes('settings') ||
                    svg.className.toString().toLowerCase().includes('gear')) {
                  let ancestor = svg.parentElement;
                  while (ancestor && ancestor !== playerContainer) {
                    const tag = ancestor.tagName.toLowerCase();
                    const role = ancestor.getAttribute('role');
                    if (tag === 'button' || role === 'button' || ancestor.onclick ||
                        ancestor.className.toString().includes('button') ||
                        ancestor.className.toString().includes('btn') ||
                        ancestor.className.toString().includes('settings') ||
                        ancestor.className.toString().includes('control') ||
                        ancestor.className.toString().includes('clickable')) {
                      return ancestor;
                    }
                    ancestor = ancestor.parentElement;
                  }
                  return svg;
                }
              }

              const allButtons = Array.from(playerContainer.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], [class*="settings"], [class*="Settings"]'));
              for (const b of allButtons) {
                if (isChatElement(b)) continue;
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                const title = (b.getAttribute('title') || '').toLowerCase();
                const cls = typeof b.className === 'string' ? b.className.toLowerCase() : '';
                if (label.includes('settings') || title.includes('settings') || cls.includes('settings') ||
                    label.includes('ayarlar') || title.includes('ayarlar') || cls.includes('ayarlar')) {
                  return b;
                }
              }

              const playerRect = player.getBoundingClientRect();
              if (playerRect.width > 0 && playerRect.height > 0) {
                const playerRight = playerRect.right;
                const playerBottom = playerRect.bottom;

                const candidates = Array.from(playerContainer.querySelectorAll('button, [role="button"], svg, [class*="button"], [class*="icon"], [class*="control"]'));
                let bestCand = null;
                let minDistance = Infinity;

                candidates.forEach(cand => {
                  if (isChatElement(cand)) return;
                  const rect = cand.getBoundingClientRect();
                  if (rect.width === 0 || rect.height === 0 || rect.width > 120 || rect.height > 120) return;

                  const dx = playerRight - (rect.left + rect.width / 2);
                  const dy = playerBottom - (rect.top + rect.height / 2);

                  if (dx >= -20 && dy >= -20 && dx < playerRect.width * 0.35 && dy < playerRect.height * 0.25) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < minDistance) { minDistance = dist; bestCand = cand; }
                  }
                });

                if (bestCand) {
                  let btnElement = bestCand;
                  while (btnElement && btnElement !== playerContainer) {
                    const tag = btnElement.tagName.toLowerCase();
                    const role = btnElement.getAttribute('role');
                    if (tag === 'button' || role === 'button' ||
                        btnElement.className.toString().includes('button') ||
                        btnElement.className.toString().includes('btn') ||
                        btnElement.className.toString().includes('clickable')) {
                      return btnElement;
                    }
                    btnElement = btnElement.parentElement;
                  }
                  return bestCand;
                }
              }

              return null;
            };

            let cog = findSettingsCog();
            // Clicking the player can pause it or fire player shortcuts, so only
            // the first attempt on a channel uses it to reveal the controls.
            if (!cog && st.attempts === 1) {
              const wasPaused = player.paused;
              if (playerContainer) directClick(playerContainer);
              directClick(player);
              if (!wasPaused && player.paused) {
                try { player.play(); } catch(e) {}
              }
              await new Promise(r => setTimeout(r, 400));
              cog = findSettingsCog();
            }

            if (!cog) return { fail: 'settings button not found' };

            // Returns the visible rows and the menu element they came from, so
            // closing can check that exact element instead of re-running this
            // loose match, whose last fallback hits ordinary text near the cog.
            const findActiveMenu = (clickTarget) => {
              const playerRect = player.getBoundingClientRect();
              const viewportHeight = window.innerHeight;
              const viewportWidth = window.innerWidth;

              const containers = Array.from(document.querySelectorAll('div, [role="dialog"], [role="menu"], [class*="drawer"], [class*="sheet"], [class*="bottom"]'));
              for (const container of containers) {
                if (isChatElement(container)) continue;
                const rect = container.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                if (rect.width > viewportWidth * 0.95 && rect.height > viewportHeight * 0.95) continue;

                const isAtBottom = (rect.bottom >= viewportHeight - 50) && (rect.top > viewportHeight * 0.4);
                const hasDrawerClass = /(drawer|sheet|bottom|dialog|popup|modal)/i.test(container.className || '');
                const hasMenuRole = container.getAttribute('role') === 'menu' || container.getAttribute('role') === 'dialog';

                if (isAtBottom && (hasDrawerClass || hasMenuRole || container.querySelectorAll('button, [role="button"], [role="menuitem"]').length > 0)) {
                  const text = (container.textContent || '').toLowerCase();
                  if (/quality|calidad|qualité|qualität|qualidade|qualità|качество|质量|品質|720|1080|160|360|480|auto|source/i.test(text)) {
                    const items = Array.from(container.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [role="button"], a, li, div, span'));
                    return { node: container, items: items.filter(el => {
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0 && el.textContent.trim().length > 0;
                    }) };
                  }
                }
              }

              if (clickTarget) {
                const targetRect = clickTarget.getBoundingClientRect();
                let bestContainer = null;
                let minDistance = Infinity;

                const menuContainers = Array.from(document.querySelectorAll('[role="menu"], [class*="menu"], [class*="Menu"], [class*="popover"], [class*="Popover"], [class*="dropdown"], [class*="Dropdown"]'));
                menuContainers.forEach(container => {
                  if (isChatElement(container)) return;
                  const rect = container.getBoundingClientRect();
                  if (rect.width === 0 || rect.height === 0 || rect.width > playerRect.width * 0.8 || rect.height > playerRect.height * 0.8) return;
                  if (container === clickTarget || clickTarget.contains(container)) return;

                  const dx = (rect.left + rect.width / 2) - (targetRect.left + targetRect.width / 2);
                  const dy = (rect.top + rect.height / 2) - (targetRect.top + targetRect.height / 2);
                  const dist = Math.sqrt(dx * dx + dy * dy);

                  if (dist < minDistance && dist < Math.max(playerRect.width, playerRect.height) * 0.6) {
                    minDistance = dist;
                    bestContainer = container;
                  }
                });

                if (bestContainer) {
                  const items = Array.from(bestContainer.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [role="button"], a, li, div, span'));
                  return { node: bestContainer, items: items.filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && el.textContent.trim().length > 0;
                  }) };
                }
              }

              const allVisible = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], div, span'));
              return { node: null, items: allVisible.filter(el => {
                if (isChatElement(el)) return false;
                if (clickTarget && (el === clickTarget || clickTarget.contains(el))) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;

                if (clickTarget) {
                  const targetRect = clickTarget.getBoundingClientRect();
                  const dx = (rect.left + rect.width / 2) - (targetRect.left + targetRect.width / 2);
                  const dy = (rect.top + rect.height / 2) - (targetRect.top + targetRect.height / 2);
                  if (Math.sqrt(dx * dx + dy * dy) > 400) return false;
                }

                const txt = el.textContent.toLowerCase().trim();
                return /quality|calidad|qualité|qualität|qualidade|qualità|качество|质量|品質|720p|1080p|480p|360p|160p/i.test(txt);
              }) };
            };

            const isContainerElement = (el) => !!el.querySelector('button, [role="button"], [role="menuitem"], [role="menuitemradio"]');

            const isChecked = (el) => {
              const on = (n) => !!n && (n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true' || n.getAttribute('data-state') === 'checked');
              if (on(el) || on(el.closest('[role="menuitemradio"], [role="option"]'))) return true;
              const input = el.querySelector('input[type="radio"]');
              return !!(input && input.checked);
            };

            // Ranks what the menu actually offers (see pickRendition): the old
            // text match took the first row containing "auto" for Source, and
            // had nothing to pick on a channel without the target rendition.
            const pickFrom = (items) => {
              const rows = items.filter(el => !isContainerElement(el));
              const labels = rows.map(el => {
                const txt = el.textContent.trim();
                return txt.length < 12 ? txt : '';
              });
              const idx = pickRendition(labels, targetQuality);
              if (idx < 0) return null;
              const row = rows[idx];
              const r = parseRendition(labels[idx]);
              const checked = isChecked(row);
              if (!checked) directClick(row);
              return { label: labels[idx], height: targetQuality === 'source' || !r ? null : r.height, checked: checked };
            };

            // Whatever the loose match finds while the menu is still shut is
            // page furniture (a control bar with "Auto" in it), visible either
            // way, so it can never prove the menu is open.
            const furniture = findActiveMenu(cog).node;
            directClick(cog);
            await new Promise(r => setTimeout(r, 400));

            const opened = [];
            let picked = null;
            try {
              const menu = findActiveMenu(cog);
              opened.push(menu.node);
              const menuItems = menu.items;

              const hasResolutionsDirectly = menuItems.some(el => {
                if (isContainerElement(el)) return false;
                const txt = el.textContent.toLowerCase().trim();
                if (txt.length >= 12) return false;
                return /^(auto|source|\\d{3,4}p(\\d{2})?)$/i.test(txt) || (/\\d{3,4}/.test(txt) && (txt.includes('p') || txt.includes('auto') || txt.includes('source')));
              });

              if (hasResolutionsDirectly) {
                picked = pickFrom(menuItems);
              } else {
                const qualityMenuItem = menuItems.find(el => {
                  if (isContainerElement(el)) return false;
                  const txt = el.textContent.toLowerCase().trim();
                  if (txt.length >= 12) return false;
                  return /quality|calidad|qualité|qualität|qualidade|qualità|качество|质量|品質/i.test(txt) && txt.length < 30;
                });
                if (qualityMenuItem) {
                  directClick(qualityMenuItem);
                  await new Promise(r => setTimeout(r, 400));
                  const sub = findActiveMenu(qualityMenuItem);
                  opened.push(sub.node);
                  picked = pickFrom(sub.items);
                } else {
                  picked = pickFrom(menuItems);
                }
              }
            } finally {
              await new Promise(r => setTimeout(r, 250));
              const real = opened.filter(n => n && n !== furniture);
              await closeMenu(cog, real.slice().reverse().find(isShown) || real[real.length - 1] || null, directClick);
            }
            return picked ? { picked: picked } : { fail: 'no quality option fits ' + targetQuality };
          });
        }, 3000);
      } else if (window.location.host.includes('youtube.com')) {
        setInterval(() => {
          try {
            if (!window.__youtubeTheaterSet) {
              const tbtn = document.querySelector('.ytp-size-button');
              if (tbtn) {
                if (tbtn.title && tbtn.title.toLowerCase().includes('theater')) tbtn.click();
                window.__youtubeTheaterSet = true;
              }
            }

            if (window.__autoQualityDisabled) return;

            try {
              const ytQuality = quality === '160p' ? 'tiny' : (quality === '360p' ? 'small' : (quality === '480p' ? 'large' : (quality === 'source' ? 'highres' : 'hd1080')));
              localStorage.setItem('yt-player-quality', JSON.stringify({
                creation: Date.now(),
                data: ytQuality,
                expiration: Date.now() + 31536000000
              }));
            } catch(e){}

            const cog = document.querySelector('.ytp-settings-button');
            if (!cog) return;
            if (window.__qualitySet === quality) return;

            // One attempt at a time. Without this the 3s tick could reopen the
            // settings menu while a previous attempt was still walking it.
            const nowTs = Date.now();
            if (window.__ytQualityBusy) return;
            if (window.__ytQualityAttemptAt && nowTs - window.__ytQualityAttemptAt < 8000) return;
            window.__ytQualityAttemptAt = nowTs;
            window.__ytQualityBusy = true;

            const settingsOpen = function() {
              const m = document.querySelector('.ytp-settings-menu, .ytp-popup.ytp-settings-menu');
              return !!m && m.style.display !== 'none';
            };
            const finish = function(closeIt) {
              window.__ytQualityBusy = false;
              // Never strand the menu open — that was the visible symptom when
              // the option lookup failed partway through.
              if (closeIt && settingsOpen()) cog.click();
            };
            // A real quality row starts with the resolution ("144p", "1080p60",
            // "Auto (720p)"). The parent menu's row reads "Quality1080p", so
            // anchoring at the start keeps us out of the wrong menu.
            const isQualityOption = function(el) {
              return /^(\\d{3,4}p|auto)/i.test((el.textContent || '').trim());
            };

            cog.click();

            // Poll for the settings panel, then for the quality submenu. The old
            // code used a flat 150ms timeout, so on a slow frame it read the
            // parent menu, matched nothing, and clicked the LAST item — opening
            // an unrelated submenu and leaving it open, while still marking the
            // quality as set so it never retried.
            let menuTries = 0;
            const openQuality = setInterval(() => {
              if (++menuTries > 20) { clearInterval(openQuality); finish(true); return; }
              const items = Array.from(document.querySelectorAll('.ytp-menuitem'));
              if (!items.length) return;
              const qualityItem = items.find(el => {
                const txt = (el.textContent || '').toLowerCase();
                return /quality|calidad|qualité|qualität|qualidade|qualità|качество|质量|品質|품질/i.test(txt);
              });
              if (!qualityItem) return;
              clearInterval(openQuality);
              qualityItem.click();

              let optTries = 0;
              const pickOption = setInterval(() => {
                if (++optTries > 20) { clearInterval(pickOption); finish(true); return; }
                const options = Array.from(document.querySelectorAll('.ytp-menuitem')).filter(isQualityOption);
                if (!options.length) return;
                clearInterval(pickOption);

                // Rank the rows the stream actually offers (see pickRendition).
                // Source used to map to Auto, which in a scaled-down webview
                // adapts below the best rendition; 160p lands on 144p, and a
                // missing target falls back to the best rendition under it.
                const idx = pickRendition(options.map(el => (el.textContent || '').trim()), quality);
                let target = idx >= 0 ? options[idx] : null;
                // Auto only when no row carries a resolution at all.
                if (!target && quality === 'source') {
                  target = options.find(el => /auto|自动|自動/i.test(el.textContent || '')) || null;
                }
                if (!target) { finish(true); return; }

                // Long menus scroll, and 144p sits below the fold — make sure
                // the row is realised and in view before clicking it.
                try { target.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                target.click();
                window.__qualitySet = quality;
                console.log('[YT Quality] Selected ' + (target.textContent || '').trim());
                setTimeout(() => finish(true), 300);
              }, 150);
            }, 150);
          } catch(e){}
        }, 3000);
      }
    })();
  `;
}

export const ghostSuspendScript = `
  (function() {
    const v = document.querySelector('video');
    if (v) {
      v.style.visibility = 'hidden';
      v.style.pointerEvents = 'none';
      v.muted = true;
      console.log('[Ghost Mode] Video decoding suspended to save CPU.');
    }
  })();
`;

export const ghostResumeScript = `
  (function() {
    const v = document.querySelector('video');
    if (v) {
      v.style.visibility = 'visible';
      v.style.pointerEvents = 'auto';
      v.muted = false;
      console.log('[Ghost Mode] Video decoding resumed.');
    }
  })();
`;

// Clicks the channel-points chest if one is waiting and evaluates to true when
// it did, so the poller can log the claim itself (the guest console never
// reached the activity log). Only ever the chest's own button: a selector list
// returns the first match in document order, and the generic secondary-button
// class it used to include clicked whatever button came first on the page.
// The class hook is locale-independent; the aria-label fallback is English
// only, so it is restricted to buttons.
export function autoClaimPointsScript() {
  return `
    (function() {
      try {
        const scope = document.querySelector('.community-points-summary, [data-test-selector="community-points-summary"]') || document;
        const icon = scope.querySelector('.claimable-bonus__icon');
        const btn = (icon && icon.closest('button')) || scope.querySelector('button[aria-label="Claim Bonus"]');
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
      } catch(e) {}
      return false;
    })();
  `;
}

export const kickLiveFollowsScript = `
  (async () => {
    try {
      const response = await fetch('/api/v2/channels/followed?limit=100');
      if (response.ok) {
        const data = await response.json();
        const liveFollows = data.filter(item => item.livestream !== null).map(item => item.slug || item.username);
        if (liveFollows.length > 0) return liveFollows;
      }
    } catch(e) {}

    try {
      const usernamesSet = new Set();
      const ignoreList = ['categories', 'search', 'auth', 'dashboard', 'about', 'help', 'terms', 'privacy', 'contact', 'jobs'];
      const sidebars = Array.from(document.querySelectorAll('nav, aside, #sidebar, .sidebar-inner, [data-v-sidebar]'));
      for (const sidebar of sidebars) {
        const links = Array.from(sidebar.querySelectorAll('a[href]'));
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href || !href.startsWith('/') || href.length <= 2) continue;
          const innerText = link.innerText || '';
          const innerHtml = link.innerHTML || '';
          const isLive = innerText.includes('LIVE') || innerHtml.includes('bg-red-500') || innerHtml.includes('live-badge');
          if (!isLive) continue;
          const parts = href.split('/');
          if (parts.length === 2) {
            const possibleName = parts[1];
            if (!ignoreList.includes(possibleName.toLowerCase())) usernamesSet.add(possibleName);
          }
        }
      }
      return Array.from(usernamesSet);
    } catch(e) {
      return [];
    }
  })()
`;
