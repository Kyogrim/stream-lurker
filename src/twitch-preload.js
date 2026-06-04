// Preload script for Twitch background GQL helper window
try {
  const { ipcRenderer, webFrame } = require('electron');
  const uniqueIdVal = ipcRenderer.sendSync('get-twitch-unique-id-sync') || '';

  const code = `
    (() => {
      const PRELOAD_UNIQUE_ID = ${JSON.stringify(uniqueIdVal)};
      // -------------------------------------------------------------
      // Stealth: Native-looking NavigatorUAData & toString() bypass
      // -------------------------------------------------------------
      try {
        const nativeFakeMap = new WeakMap();
        const originalToString = Function.prototype.toString;
        
        Function.prototype.toString = function toString() {
          if (nativeFakeMap.has(this)) {
            return nativeFakeMap.get(this);
          }
          return originalToString.call(this);
        };
        // Remove prototype from Function.prototype.toString
        try {
          delete Function.prototype.toString.prototype;
        } catch (e) {}
        nativeFakeMap.set(Function.prototype.toString, 'function toString() { [native code] }');

        const patchNative = (fn, name) => {
          try {
            Object.defineProperty(fn, 'name', { value: name, configurable: true });
          } catch (e) {}
          try {
            delete fn.prototype;
          } catch (e) {}
          
          let toStringName = name;
          if (name.startsWith('get ')) {
            toStringName = name.slice(4);
          } else if (name.startsWith('set ')) {
            toStringName = name.slice(4);
          }
          nativeFakeMap.set(fn, \`function \${toStringName}() { [native code] }\`);
        };

        const defineNativeGetter = (proto, prop, typeName, fn) => {
          const getter = function () {
            if (!(this instanceof proto.constructor)) {
              throw new TypeError(\`Failed to execute '\${prop}' on '\${typeName}': Illegal invocation\`);
            }
            return fn.call(this);
          };
          patchNative(getter, \`get \${prop}\`);
          Object.defineProperty(proto, prop, {
            get: getter,
            configurable: true,
            enumerable: true
          });
        };

        const defineNativeMethod = (proto, prop, typeName, fn) => {
          const method = function (...args) {
            if (!(this instanceof proto.constructor)) {
              throw new TypeError(\`Failed to execute '\${prop}' on '\${typeName}': Illegal invocation\`);
            }
            return fn.apply(this, args);
          };
          patchNative(method, prop);
          Object.defineProperty(proto, prop, {
            value: method,
            writable: true,
            configurable: true,
            enumerable: true
          });
        };

        const ua = navigator.userAgent;
        const chromeMatch = ua.match(/Chrome\\/(\\d+)\\./);
        const chromeVersion = chromeMatch ? chromeMatch[1] : '124';
        const chromeFullVersion = ua.match(/Chrome\\/([\\d.]+)/) ? ua.match(/Chrome\\/([\\d.]+)/)[1] : '124.0.0.0';

        const brands = [
          { brand: 'Chromium', version: chromeVersion },
          { brand: 'Google Chrome', version: chromeVersion },
          { brand: 'Not-A.Brand', version: '99' }
        ];

        const NavigatorUAData = function NavigatorUAData() {
          throw new TypeError('Illegal constructor');
        };
        patchNative(NavigatorUAData, 'NavigatorUAData');
        Object.defineProperty(window, 'NavigatorUAData', {
          value: NavigatorUAData,
          writable: true,
          enumerable: false,
          configurable: true
        });

        const uaData = Object.create(NavigatorUAData.prototype);
        
        defineNativeGetter(Navigator.prototype, 'userAgentData', 'Navigator', () => uaData);

        const osPlatform = navigator.platform.includes('Mac') ? 'macOS' : navigator.platform.includes('Linux') ? 'Linux' : 'Windows';
        
        defineNativeGetter(NavigatorUAData.prototype, 'brands', 'NavigatorUAData', () => {
          const arr = brands.map(b => Object.freeze({ ...b }));
          return Object.freeze(arr);
        });
        defineNativeGetter(NavigatorUAData.prototype, 'mobile', 'NavigatorUAData', () => false);
        defineNativeGetter(NavigatorUAData.prototype, 'platform', 'NavigatorUAData', () => osPlatform);

        const getHighEntropyValues = function getHighEntropyValues(hints) {
          const res = {
            brands: brands.map(b => Object.freeze({ ...b })),
            mobile: false,
            platform: osPlatform
          };
          if (Array.isArray(hints)) {
            hints.forEach(h => {
              if (h === 'architecture') res.architecture = 'x86';
              else if (h === 'bitness') res.bitness = '64';
              else if (h === 'model') res.model = '';
              else if (h === 'platformVersion') res.platformVersion = '10.0.0';
              else if (h === 'uaFullVersion') res.uaFullVersion = chromeFullVersion;
              else if (h === 'fullVersionList') {
                res.fullVersionList = brands.map(b => Object.freeze({
                  brand: b.brand,
                  version: b.brand === 'Not-A.Brand' ? '99.0.0.0' : chromeFullVersion
                }));
              }
            });
          }
          return Promise.resolve(res);
        };
        defineNativeMethod(NavigatorUAData.prototype, 'getHighEntropyValues', 'NavigatorUAData', getHighEntropyValues);

        const toJSON = function toJSON() {
          return {
            brands: brands.map(b => Object.freeze({ ...b })),
            mobile: false,
            platform: osPlatform
          };
        };
        defineNativeMethod(NavigatorUAData.prototype, 'toJSON', 'NavigatorUAData', toJSON);

        Object.defineProperty(NavigatorUAData.prototype, Symbol.toStringTag, {
          value: 'NavigatorUAData',
          configurable: true
        });

        // webdriver spoof
        defineNativeGetter(Navigator.prototype, 'webdriver', 'Navigator', () => false);

        // languages spoof
        defineNativeGetter(Navigator.prototype, 'languages', 'Navigator', () => Object.freeze(['en-US', 'en']));

        // language spoof
        defineNativeGetter(Navigator.prototype, 'language', 'Navigator', () => 'en-US');

        // -------------------------------------------------------------
        // Stealth: Document Visibility and Focus Overrides
        // -------------------------------------------------------------
        defineNativeGetter(Document.prototype, 'visibilityState', 'Document', () => 'visible');
        defineNativeGetter(Document.prototype, 'hidden', 'Document', () => false);
        defineNativeMethod(Document.prototype, 'hasFocus', 'Document', () => true);

        // -------------------------------------------------------------
        // Stealth: window.chrome Mock
        // -------------------------------------------------------------
        try {
          if (!window.chrome) {
            const chromeApp = {
              InstallState: {
                DISABLED: 'disabled',
                INSTALLED: 'installed',
                NOT_INSTALLED: 'not_installed'
              },
              RunningState: {
                CAN_RUN: 'can_run',
                CANNOT_RUN: 'cannot_run',
                RUNNING: 'running'
              },
              getDetails: function getDetails() { return null; },
              getIsInstalled: function getIsInstalled() { return false; },
              installState: function installState() { return 'not_installed'; },
              isInstalled: false,
              runningState: function runningState() { return 'cannot_run'; }
            };
            patchNative(chromeApp.getDetails, 'getDetails');
            patchNative(chromeApp.getIsInstalled, 'getIsInstalled');
            patchNative(chromeApp.installState, 'installState');
            patchNative(chromeApp.runningState, 'runningState');

            const csi = function csi() {
              return {
                startE: Date.now() - 1000,
                onloadT: Date.now(),
                pageT: 1000,
                tran: 15
              };
            };
            patchNative(csi, 'csi');

            const loadTimes = function loadTimes() {
              return {
                requestTime: (Date.now() - 1000) / 1000,
                startLoadTime: (Date.now() - 1000) / 1000,
                commitLoadTime: (Date.now() - 900) / 1000,
                finishDocumentLoadTime: (Date.now() - 500) / 1000,
                finishLoadTime: (Date.now() - 400) / 1000,
                firstPaintTime: (Date.now() - 800) / 1000,
                firstPaintAfterLoadTime: 0,
                navigationType: 'Other',
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: false,
                npnNegotiatedProtocol: '',
                wasAlternativeServiceUsed: false,
                connectionInfo: 'http/1.1'
              };
            };
            patchNative(loadTimes, 'loadTimes');

            const chromeObj = {
              app: chromeApp,
              csi: csi,
              loadTimes: loadTimes
            };

            Object.defineProperty(window, 'chrome', {
              value: chromeObj,
              writable: true,
              configurable: true,
              enumerable: true
            });
          }
        } catch (chromeErr) {
          console.error('[Stealth] Failed to mock window.chrome:', chromeErr);
        }

        // -------------------------------------------------------------
        // Stealth: navigator.plugins Mock
        // -------------------------------------------------------------
        try {
          const Plugin = window.Plugin;
          const PluginArray = window.PluginArray;
          const MimeType = window.MimeType;
          const MimeTypeArray = window.MimeTypeArray;

          if (Plugin && PluginArray && MimeType && MimeTypeArray) {
            const pluginData = new WeakMap();
            const mimeTypeData = new WeakMap();
            const pluginArrayData = new WeakMap();
            const mimeTypeArrayData = new WeakMap();

            defineNativeGetter(Plugin.prototype, 'name', 'Plugin', function () {
              return pluginData.get(this)?.name || '';
            });
            defineNativeGetter(Plugin.prototype, 'filename', 'Plugin', function () {
              return pluginData.get(this)?.filename || '';
            });
            defineNativeGetter(Plugin.prototype, 'description', 'Plugin', function () {
              return pluginData.get(this)?.description || '';
            });
            defineNativeGetter(Plugin.prototype, 'length', 'Plugin', function () {
              return pluginData.get(this)?.length || 0;
            });

            defineNativeGetter(MimeType.prototype, 'type', 'MimeType', function () {
              return mimeTypeData.get(this)?.type || '';
            });
            defineNativeGetter(MimeType.prototype, 'description', 'MimeType', function () {
              return mimeTypeData.get(this)?.description || '';
            });
            defineNativeGetter(MimeType.prototype, 'suffixes', 'MimeType', function () {
              return mimeTypeData.get(this)?.suffixes || '';
            });
            defineNativeGetter(MimeType.prototype, 'enabledPlugin', 'MimeType', function () {
              return mimeTypeData.get(this)?.enabledPlugin || null;
            });

            const pluginItem = function (index) {
              if (!(this instanceof Plugin)) {
                throw new TypeError("Failed to execute 'item' on 'Plugin': Illegal invocation");
              }
              index = Number(index) || 0;
              if (index < 0 || index >= this.length) return null;
              return this[index] || null;
            };
            patchNative(pluginItem, 'item');
            Object.defineProperty(Plugin.prototype, 'item', { value: pluginItem, writable: true, enumerable: true, configurable: true });

            const pluginNamedItem = function (name) {
              if (!(this instanceof Plugin)) {
                throw new TypeError("Failed to execute 'namedItem' on 'Plugin': Illegal invocation");
              }
              return this[name] || null;
            };
            patchNative(pluginNamedItem, 'namedItem');
            Object.defineProperty(Plugin.prototype, 'namedItem', { value: pluginNamedItem, writable: true, enumerable: true, configurable: true });

            const createPluginInstance = (name, filename, description) => {
              const p = Object.create(Plugin.prototype);
              pluginData.set(p, { name, filename, description, length: 0 });
              return p;
            };

            const createMimeTypeInstance = (type, description, suffixes, enabledPlugin) => {
              const m = Object.create(MimeType.prototype);
              mimeTypeData.set(m, { type, description, suffixes, enabledPlugin });
              return m;
            };

            const p1 = createPluginInstance('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format');
            const p2 = createPluginInstance('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format');
            const p3 = createPluginInstance('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format');
            const p4 = createPluginInstance('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format');
            const p5 = createPluginInstance('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format');

            const m1 = createMimeTypeInstance('application/pdf', 'Portable Document Format', 'pdf', p1);
            const m2 = createMimeTypeInstance('text/pdf', 'Portable Document Format', 'pdf', p1);

            const setupPluginMimeTypes = (p, mimes) => {
              mimes.forEach((m, idx) => {
                Object.defineProperty(p, idx, { value: m, enumerable: true, configurable: true });
                Object.defineProperty(p, m.type, { value: m, enumerable: false, configurable: true });
              });
              const data = pluginData.get(p);
              if (data) data.length = mimes.length;
            };

            setupPluginMimeTypes(p1, [m1, m2]);
            setupPluginMimeTypes(p2, [m1, m2]);
            setupPluginMimeTypes(p3, [m1, m2]);
            setupPluginMimeTypes(p4, [m1, m2]);
            setupPluginMimeTypes(p5, [m1, m2]);

            const allPlugins = [p1, p2, p3, p4, p5];
            const allMimes = [m1, m2];

            const plugins = Object.create(PluginArray.prototype);
            allPlugins.forEach((p, idx) => {
              Object.defineProperty(plugins, idx, { value: p, enumerable: true, configurable: true });
              Object.defineProperty(plugins, p.name, { value: p, enumerable: false, configurable: true });
            });
            pluginArrayData.set(plugins, { length: allPlugins.length });

            const mimeTypes = Object.create(MimeTypeArray.prototype);
            allMimes.forEach((m, idx) => {
              Object.defineProperty(mimeTypes, idx, { value: m, enumerable: true, configurable: true });
              Object.defineProperty(mimeTypes, m.type, { value: m, enumerable: false, configurable: true });
            });
            mimeTypeArrayData.set(mimeTypes, { length: allMimes.length });

            defineNativeGetter(PluginArray.prototype, 'length', 'PluginArray', function () {
              return pluginArrayData.get(this)?.length || 0;
            });

            defineNativeGetter(MimeTypeArray.prototype, 'length', 'MimeTypeArray', function () {
              return mimeTypeArrayData.get(this)?.length || 0;
            });

            const defineProtoMethods = (proto, typeName, nameProp) => {
              const item = function (index) {
                if (!(this instanceof proto.constructor)) {
                  throw new TypeError(\`Failed to execute 'item' on '\${typeName}': Illegal invocation\`);
                }
                index = Number(index) || 0;
                if (index < 0 || index >= this.length) return null;
                return this[index];
              };
              patchNative(item, 'item');
              Object.defineProperty(proto, 'item', { value: item, writable: true, enumerable: true, configurable: true });

              const namedItem = function (name) {
                if (!(this instanceof proto.constructor)) {
                  throw new TypeError(\`Failed to execute 'namedItem' on '\${typeName}': Illegal invocation\`);
                }
                for (let i = 0; i < this.length; i++) {
                  const el = this[i];
                  if (el && el[nameProp] === name) return el;
                }
                return null;
              };
              patchNative(namedItem, 'namedItem');
              Object.defineProperty(proto, 'namedItem', { value: namedItem, writable: true, enumerable: true, configurable: true });

              const iterator = function () {
                if (!(this instanceof proto.constructor)) {
                  throw new TypeError(\`Failed to execute 'values' on '\${typeName}': Illegal invocation\`);
                }
                let idx = 0;
                const self = this;
                return {
                  next: () => {
                    if (idx < self.length) {
                      return { value: self[idx++], done: false };
                    }
                    return { value: undefined, done: true };
                  },
                  [Symbol.iterator]() { return this; }
                };
              };
              patchNative(iterator, 'values');
              Object.defineProperty(proto, Symbol.iterator, { value: iterator, writable: true, enumerable: false, configurable: true });
            };

            defineProtoMethods(PluginArray.prototype, 'PluginArray', 'name');
            defineProtoMethods(MimeTypeArray.prototype, 'MimeTypeArray', 'type');

            defineNativeGetter(Navigator.prototype, 'plugins', 'Navigator', () => plugins);
            defineNativeGetter(Navigator.prototype, 'mimeTypes', 'Navigator', () => mimeTypes);
          }
        } catch (pluginsErr) {
          console.error('[Stealth] Failed to mock plugins:', pluginsErr);
        }

        // -------------------------------------------------------------
        // Stealth: outerWidth & outerHeight Mock (if 0)
        // -------------------------------------------------------------
        try {
          defineNativeGetter(Window.prototype, 'outerWidth', 'Window', () => window.innerWidth || 1280);
          defineNativeGetter(Window.prototype, 'outerHeight', 'Window', () => window.innerHeight || 720);
        } catch (sizeErr) {
          console.error('[Stealth] Failed to mock outer size:', sizeErr);
        }

        // -------------------------------------------------------------
        // Stealth: navigator.keyboard.getLayoutMap Mock
        // -------------------------------------------------------------
        try {
          if (navigator.keyboard && navigator.keyboard.constructor) {
            const Keyboard = navigator.keyboard.constructor;
            const KeyboardLayoutMap = window.KeyboardLayoutMap;
            const standardLayout = [
              ['Backquote', "\`"], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'],
              ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'],
              ['Digit0', '0'], ['Minus', '-'], ['Equal', '='],
              ['KeyQ', 'q'], ['KeyW', 'w'], ['KeyE', 'e'], ['KeyR', 'r'], ['KeyT', 't'],
              ['KeyY', 'y'], ['KeyU', 'u'], ['KeyI', 'i'], ['KeyO', 'o'], ['KeyP', 'p'],
              ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\\\'],
              ['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd'], ['KeyF', 'f'], ['KeyG', 'g'],
              ['KeyH', 'h'], ['KeyJ', 'j'], ['KeyK', 'k'], ['KeyL', 'l'], ['Semicolon', ';'],
              ['Quote', "'"],
              ['KeyZ', 'z'], ['KeyX', 'x'], ['KeyC', 'c'], ['KeyV', 'v'], ['KeyB', 'b'],
              ['KeyN', 'n'], ['KeyM', 'm'], ['Comma', ','], ['Period', '.'], ['Slash', '/']
            ];

            defineNativeMethod(Keyboard.prototype, 'getLayoutMap', 'Keyboard', function () {
              const map = new Map(standardLayout);
              if (KeyboardLayoutMap) {
                Object.setPrototypeOf(map, KeyboardLayoutMap.prototype);
              }
              return Promise.resolve(map);
            });
          }
        } catch (keyboardErr) {
          console.error('[Stealth] Failed to mock keyboard layout:', keyboardErr);
        }

        // Lock localStorage device IDs to the unique_id cookie
        try {
          const originalGetItem = Storage.prototype.getItem;
          defineNativeMethod(Storage.prototype, 'getItem', 'Storage', function (key) {
            if (key === 'local_storage_device_id' || key === 'k-device-id' || key === 'local_copy_unique_id') {
              const uid = PRELOAD_UNIQUE_ID;
              if (uid) return JSON.stringify(uid);
            }
            return originalGetItem.call(this, key);
          });

          const originalSetItem = Storage.prototype.setItem;
          defineNativeMethod(Storage.prototype, 'setItem', 'Storage', function (key, value) {
            if (key === 'local_storage_device_id' || key === 'k-device-id' || key === 'local_copy_unique_id') {
              const uid = PRELOAD_UNIQUE_ID;
              if (uid) {
                return originalSetItem.call(this, key, JSON.stringify(uid));
              }
            }
            return originalSetItem.call(this, key, value);
          });
          
          console.warn('[Stealth] Locked localStorage device IDs to unique_id cookie successfully. ID: "' + PRELOAD_UNIQUE_ID + '"');
        } catch (storageErr) {
          console.error('[Stealth] Failed to lock localStorage device IDs:', storageErr);
        }

        // -------------------------------------------------------------
        // Stealth: Iframe contentWindow / contentDocument Context Patching
        // -------------------------------------------------------------
        try {
          const patchedWindows = new WeakSet();
          const patchWindowContext = (win) => {
            try {
              if (!win || patchedWindows.has(win)) return;
              patchedWindows.add(win);
              const originalToString = win.Function.prototype.toString;
              win.Function.prototype.toString = function toString() {
                if (nativeFakeMap.has(this)) {
                  return nativeFakeMap.get(this);
                }
                return originalToString.call(this);
              };
              try {
                delete win.Function.prototype.toString.prototype;
              } catch (e) {}
              nativeFakeMap.set(win.Function.prototype.toString, 'function toString() { [native code] }');
            } catch (e) {}
          };

          // Hook HTMLIFrameElement.prototype
          const originalContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
          defineNativeGetter(HTMLIFrameElement.prototype, 'contentWindow', 'HTMLIFrameElement', function () {
            const win = originalContentWindow.call(this);
            if (win) {
              try {
                patchWindowContext(win);
              } catch (e) {}
            }
            return win;
          });

          const originalContentDocument = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument').get;
          defineNativeGetter(HTMLIFrameElement.prototype, 'contentDocument', 'HTMLIFrameElement', function () {
            const doc = originalContentDocument.call(this);
            if (doc && doc.defaultView) {
              try {
                patchWindowContext(doc.defaultView);
              } catch (e) {}
            }
            return doc;
          });

          // Hook HTMLObjectElement.prototype
          const originalObjectContentWindow = Object.getOwnPropertyDescriptor(HTMLObjectElement.prototype, 'contentWindow')?.get;
          if (originalObjectContentWindow) {
            defineNativeGetter(HTMLObjectElement.prototype, 'contentWindow', 'HTMLObjectElement', function () {
              const win = originalObjectContentWindow.call(this);
              if (win) {
                try {
                  patchWindowContext(win);
                } catch (e) {}
              }
              return win;
            });
          }

          const originalObjectContentDocument = Object.getOwnPropertyDescriptor(HTMLObjectElement.prototype, 'contentDocument')?.get;
          if (originalObjectContentDocument) {
            defineNativeGetter(HTMLObjectElement.prototype, 'contentDocument', 'HTMLObjectElement', function () {
              const doc = originalObjectContentDocument.call(this);
              if (doc && doc.defaultView) {
                try {
                  patchWindowContext(doc.defaultView);
                } catch (e) {}
              }
              return doc;
            });
          }

          // Hook window.open
          const originalOpen = Window.prototype.open || window.open;
          defineNativeMethod(Window.prototype, 'open', 'Window', function (...args) {
            const win = originalOpen.apply(this, args);
            if (win) {
              try {
                patchWindowContext(win);
              } catch (e) {}
            }
            return win;
          });

        } catch (iframeHookErr) {
          console.error('[Stealth] Failed to hook iframe contexts:', iframeHookErr);
        }

      } catch (stealthErr) {
        console.error('[Stealth] Failed to spoof userAgentData:', stealthErr);
      }

      // Disable and auto-pause video and audio elements robustly (prototype-safe)
      try {
        const pauseAndMute = (el) => {
          if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
            try {
              if (el.autoplay) el.autoplay = false;
              el.muted = true;
              el.volume = 0;
              if (!el.paused) el.pause();
            } catch(e){}
          }
        };

        // Capture phase listeners to intercept play events on all media elements
        document.addEventListener('play', (e) => {
          pauseAndMute(e.target);
        }, true);

        document.addEventListener('playing', (e) => {
          pauseAndMute(e.target);
        }, true);

        // MutationObserver to catch media elements as they are created
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === 1) {
                pauseAndMute(node);
                node.querySelectorAll('video, audio').forEach(pauseAndMute);
              }
            }
          }
        });
        
        observer.observe(document.documentElement || document, {
          childList: true,
          subtree: true
        });

        // Periodic check to capture any remaining media elements
        setInterval(() => {
          document.querySelectorAll('video, audio').forEach(pauseAndMute);
        }, 300);

      } catch (e) {
        console.error('[Stealth] Failed to setup video auto-pause:', e);
      }
    })();
  `;

  webFrame.executeJavaScript(code);
} catch (e) {
  console.error('[Preload] Failed to inject stealth script:', e);
}
