// Scripts injected via webview.executeJavaScript inside the platform pages.
// They run in the guest context, not the renderer — keep them as plain strings
// or string-producing functions.

export function qualityAndTheaterScript(quality) {
  return `
    (function() {
      const quality = ${JSON.stringify(quality)};

      const directClick = (el) => {
        if (!el) return;
        try {
          if (el.closest) {
            const wrapper = el.closest('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [class*="clickable"], [class*="button"], [class*="btn"], [class*="betterhover"], [class*="pointer"]');
            if (wrapper) el = wrapper;
          }
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
          el.dispatchEvent(new MouseEvent('mousedown', { view: window, bubbles: true, cancelable: true, button: 0 }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
          el.dispatchEvent(new MouseEvent('mouseup', { view: window, bubbles: true, cancelable: true, button: 0 }));
          el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, button: 0 }));
          el.click();
        } catch(e) {
          try { el.click(); } catch(err) {}
        }
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
                directClick(btn);
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

            if (window.__autoQualityDisabled) return;

            const video = document.querySelector('video');
            const currentHeight = video ? video.videoHeight : 0;

            let needChange = false;
            if (currentHeight > 0) {
              if (quality === '160p' && currentHeight > 200) needChange = true;
              else if (quality === '360p' && currentHeight > 400) needChange = true;
              else if (quality === '480p' && currentHeight > 540) needChange = true;
              else if (quality === '720p' && currentHeight > 800) needChange = true;
            } else if (window.__qualitySet !== quality) {
              needChange = true;
            }

            if (needChange) {
              const now = Date.now();
              if (!window.__lastQualityAttemptTime || (now - window.__lastQualityAttemptTime > 15000)) {
                window.__lastQualityAttemptTime = now;

                const cog = document.querySelector('[data-a-target="player-settings-button"]');
                if (cog) {
                  cog.click();
                  setTimeout(() => {
                    const items = Array.from(document.querySelectorAll('[data-a-target="player-settings-menu-item-quality"], .player-menu__item'));
                    const qualityItem = items.find(el => el.textContent.toLowerCase().includes('quality') || el.textContent.toLowerCase().includes('qualité'));
                    if (qualityItem) {
                      qualityItem.click();
                      setTimeout(() => {
                        const options = Array.from(document.querySelectorAll('.tw-radio__label, .player-menu__item, [data-a-target="player-settings-menu-item"]'));
                        const targetOpt = options.find(el => el.textContent.toLowerCase().includes(quality === 'source' ? 'source' : quality));
                        if (targetOpt) {
                          targetOpt.click();
                          window.__qualitySet = quality;
                        } else if (quality !== '160p') {
                          const lowestOpt = options.find(el => el.textContent.toLowerCase().includes('160p') || el.textContent.toLowerCase().includes('140p') || el.textContent.toLowerCase().includes('360p'));
                          if (lowestOpt) {
                            lowestOpt.click();
                            window.__qualitySet = quality;
                          }
                        }
                        cog.click();
                      }, 100);
                    } else {
                      cog.click();
                    }
                  }, 100);
                }
              }
            }
          } catch(e){}
        }, 3000);
      } else if (window.location.host.includes('kick.com')) {
        setInterval(async () => {
          try {
            if (!window.__kickTheaterSet) {
              const tbtn = document.querySelector('button[aria-label*="Theater"], button[title*="Theater"], button[aria-label*="theater"], button[title*="theater"]');
              if (tbtn) {
                directClick(tbtn);
                window.__kickTheaterSet = true;
              }
            }

            if (window.__autoQualityDisabled) return;
            const targetQuality = quality;

            const player = document.querySelector('video');
            if (!player) {
              console.log("[Kick Quality] Video element not found yet.");
              return;
            }

            const currentHeight = player.videoHeight;
            let needChange = false;
            if (currentHeight > 0) {
              if (targetQuality === '160p' && currentHeight > 200) needChange = true;
              else if (targetQuality === '360p' && currentHeight > 400) needChange = true;
              else if (targetQuality === '480p' && currentHeight > 540) needChange = true;
              else if (targetQuality === '720p' && currentHeight > 800) needChange = true;
            } else if (window.__qualitySet !== targetQuality) {
              needChange = true;
            }

            if (!needChange) return;

            const now = Date.now();
            if (window.__lastQualityAttemptTime && (now - window.__lastQualityAttemptTime <= 15000)) return;
            window.__lastQualityAttemptTime = now;
            console.log("[Kick Quality] Starting quality check loop. Current Height: " + currentHeight + ", Target: " + targetQuality);

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
            if (!cog) {
              console.log("[Kick Quality] Settings cog not found directly. Clicking player container & player to mount controls overlay...");
              const wasPaused = player.paused;
              if (playerContainer) directClick(playerContainer);
              directClick(player);
              if (!wasPaused && player.paused) {
                try { player.play(); } catch(e) {}
              }
              await new Promise(r => setTimeout(r, 400));
              cog = findSettingsCog();
            }

            if (!cog) {
              console.log("[Kick Quality] Settings cog button still not found in DOM after click fallback.");
              return;
            }

            console.log("[Kick Quality] Found settings cog. Clicking to open menu...");
            directClick(cog);
            await new Promise(r => setTimeout(r, 400));

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
                    return items.filter(el => {
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0 && el.textContent.trim().length > 0;
                    });
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
                  return items.filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && el.textContent.trim().length > 0;
                  });
                }
              }

              const allVisible = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], div, span'));
              return allVisible.filter(el => {
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
              });
            };

            const findMenuItems = () => findActiveMenu(cog);

            const menuItems = findMenuItems();

            const isContainerElement = (el) => !!el.querySelector('button, [role="button"], [role="menuitem"], [role="menuitemradio"]');

            const matchesTarget = (txt, pref) => {
              if (txt.length >= 12) return false;
              if (pref === 'source') {
                return txt.includes('source') || txt.includes('auto') || txt.includes('original') || txt.includes('1080');
              }
              return txt === pref || txt === pref + '60' || txt.includes(pref) || txt.includes(pref.replace('p', ''));
            };
            const matchesFallback = (txt) => {
              if (txt.length >= 12) return false;
              return txt.includes('160') || txt.includes('360') || txt.includes('480') || txt.includes('720');
            };

            const pref = targetQuality.toLowerCase().trim();
            const pickFrom = (items) => {
              const targetOpt = items.find(el => !isContainerElement(el) && matchesTarget(el.textContent.toLowerCase().trim(), pref));
              if (targetOpt) {
                directClick(targetOpt);
                window.__qualitySet = targetQuality;
                return true;
              }
              const fallbackOpt = items.find(el => !isContainerElement(el) && matchesFallback(el.textContent.toLowerCase().trim()));
              if (fallbackOpt) {
                directClick(fallbackOpt);
                window.__qualitySet = targetQuality;
                return true;
              }
              return false;
            };

            const hasResolutionsDirectly = menuItems.some(el => {
              if (isContainerElement(el)) return false;
              const txt = el.textContent.toLowerCase().trim();
              if (txt.length >= 12) return false;
              return /^(auto|source|\\d{3,4}p(\\d{2})?)$/i.test(txt) || (/\\d{3,4}/.test(txt) && (txt.includes('p') || txt.includes('auto') || txt.includes('source')));
            });

            if (hasResolutionsDirectly) {
              pickFrom(menuItems);
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
                pickFrom(findActiveMenu(qualityMenuItem));
              } else {
                pickFrom(menuItems);
              }
            }

            await new Promise(r => setTimeout(r, 250));
            if (findMenuItems().length > 0) directClick(cog);
          } catch(e){
            console.error("[Kick Quality] Error in quality setting loop: " + e.message);
          }
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
              const ytQuality = quality === '160p' ? 'tiny' : (quality === '360p' ? 'small' : (quality === '480p' ? 'large' : 'hd1080'));
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

                const want = quality === '160p' ? '144' : (quality === 'source' ? 'auto' : quality.replace('p', ''));
                let target = options.find(el => {
                  const txt = (el.textContent || '').toLowerCase();
                  return want === 'auto' ? /auto|自动|自動/i.test(txt) : txt.indexOf(want) !== -1;
                });
                if (!target && want !== 'auto') {
                  // Fall back to the lowest resolution this stream actually
                  // offers, rather than whatever sits last in the menu.
                  const ranked = options
                    .map(el => ({ el: el, h: parseInt(((el.textContent || '').match(/(\\d{3,4})p/) || [])[1], 10) }))
                    .filter(o => !isNaN(o.h))
                    .sort((a, b) => a.h - b.h);
                  target = ranked.length ? ranked[0].el : null;
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

export function autoClaimPointsScript(username) {
  return `
    (function() {
      try {
        const bonusBtn = document.querySelector('.claimable-bonus__icon, [aria-label="Claim Bonus"], .tw-button-restyle--secondary');
        if (bonusBtn) {
          bonusBtn.click();
          console.log('[Rewards - ${username}] Claimed channel points chest!');
        }
      } catch(e) {}
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
