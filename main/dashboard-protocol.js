// Serves the dashboard from app://bundle instead of file://.
//
// A file:// page in a build with the GrantFileProtocolExtraPrivileges fuse on
// can fetch any local file, so one script injection in the dashboard could read
// the plaintext cookie database. On app://bundle the dashboard is an ordinary
// origin: it can load its own files and nothing else on disk. The fuse is
// turned off in package.json (build.electronFuses), which only works once
// nothing loads the dashboard from file:// any more.
//
// Moving origins also moves localStorage, where the Clips tab keeps saved
// clips. migrateFileOriginStorage carries that data across once, reading the
// old file:// store in a hidden window. The old store is left untouched, so a
// downgrade still finds it.

const fs = require('fs');
const path = require('path');

const DASHBOARD_SCHEME = 'app';
const DASHBOARD_HOST = 'bundle';
const DASHBOARD_ORIGIN = `${DASHBOARD_SCHEME}://${DASHBOARD_HOST}`;
const DASHBOARD_URL = `${DASHBOARD_ORIGIN}/index.html`;

// standard: a real origin, so relative paths, ES module imports and
// localStorage behave as they do on https. secure: a secure context like the
// file:// page was. supportFetchAPI + corsEnabled: module scripts are fetched
// in CORS mode. No bypassCSP: index.html's CSP still applies.
const DASHBOARD_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// What the dashboard is made of (build.files): these top-level files and src/.
// main.js, preload.js, main/, package.json and, in development, node_modules
// are never served.
const TOP_LEVEL_FILES = new Set(['index.html', 'style.css', 'renderer.js', 'icon.ico', 'icon.png']);

// Any page on app://bundle is one of our own files. Node's URL reports "null"
// as the origin of a non-special scheme, so compare scheme and host instead.
function isDashboardOrigin(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === `${DASHBOARD_SCHEME}:` && u.host === DASHBOARD_HOST;
  } catch (e) {
    return false;
  }
}

// The dashboard page itself: the only place its window may navigate to.
function isDashboardUrl(value) {
  return isDashboardOrigin(value) && new URL(String(value)).pathname === '/index.html';
}

// Maps an app://bundle URL to a file under appRoot. Returns { status: 200,
// filePath, contentType } or { status } for anything outside the allowlist.
// The path is decoded before it is checked, so %2e%2e, %2f and %5c spellings of
// a traversal are caught along with the literal ones.
function resolveDashboardAsset(requestUrl, appRoot) {
  let u;
  try { u = new URL(String(requestUrl)); } catch (e) { return { status: 400 }; }
  if (u.protocol !== `${DASHBOARD_SCHEME}:` || u.hostname !== DASHBOARD_HOST) return { status: 404 };

  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch (e) { return { status: 400 }; }
  rel = rel.replace(/^\/+/, '') || 'index.html';
  if (/[\0\\:]/.test(rel)) return { status: 404 }; // NUL, Windows separators, drive letters, ADS

  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) return { status: 404 };
  const allowed = parts.length === 1 ? TOP_LEVEL_FILES.has(parts[0]) : parts[0] === 'src';
  if (!allowed) return { status: 404 };

  const contentType = CONTENT_TYPES[path.extname(rel).toLowerCase()];
  if (!contentType) return { status: 404 };

  const root = path.resolve(appRoot);
  const filePath = path.resolve(root, ...parts);
  const back = path.relative(root, filePath);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return { status: 404 };
  return { status: 200, filePath, contentType };
}

// The protocol.handle callback. fs.promises.readFile reads inside app.asar in
// Electron, and the content type is set here rather than sniffed, so a module
// script is always served as JavaScript.
function createDashboardHandler(appRoot, readFile = fs.promises.readFile) {
  return async (request) => {
    const r = resolveDashboardAsset(request.url, appRoot);
    if (r.status !== 200) {
      return new Response('Not found', { status: r.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    try {
      const body = await readFile(r.filePath);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': r.contentType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' },
      });
    } catch (e) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  };
}

// Written into the app://bundle store when the import is done, so it can never
// run twice against the same data (a second run would bring back clips the
// user has since removed).
const IMPORT_MARKER = '__streamLurkerFileOriginImported';

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { return undefined; }
}

function isIdList(value) {
  return Array.isArray(value) && value.every(x => x && typeof x === 'object' && (typeof x.id === 'string' || typeof x.id === 'number'));
}

// Both stores hold a list of { id, ... } (saved clips): keep everything in the
// new store and add what only the old one has. Returns the merged JSON, or
// null when there is nothing to add or the values are not such lists.
function unionById(destText, sourceText) {
  const dest = parseJson(destText);
  const source = parseJson(sourceText);
  if (!isIdList(dest) || !isIdList(source)) return null;
  const have = new Set(dest.map(x => String(x.id)));
  const extra = source.filter(x => !have.has(String(x.id)));
  if (extra.length === 0) return null;
  return JSON.stringify([...dest, ...extra]);
}

// Decides what to write into the app://bundle store given both stores' entries.
// Keys only the old store has are copied. A key both have is merged when it is
// an id list (the dashboard already saved something before an earlier import
// attempt failed) and otherwise left as the new store has it.
function mergeLegacyStorage(source, dest) {
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  if (has(dest, IMPORT_MARKER)) return { entries: {}, keys: [], alreadyImported: true };
  const entries = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (key === IMPORT_MARKER || typeof value !== 'string') continue;
    if (!has(dest, key)) {
      entries[key] = value;
      continue;
    }
    const merged = unionById(dest[key], value);
    if (merged !== null) entries[key] = merged;
  }
  return { entries, keys: Object.keys(entries), alreadyImported: false };
}

const READ_STORAGE_SCRIPT = `(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
})()`;

function writeStorageScript(entries) {
  return `((entries) => {
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  return Object.keys(entries).length;
})(${JSON.stringify(entries)})`;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Copies the dashboard's file:// localStorage into app://bundle, in a hidden,
// sandboxed window on the default session (the one the dashboard uses). Every
// file:// page shares one localStorage, so the old store is read through
// `sourceFile`: a blank page the caller writes on the real filesystem. It must
// not be a file inside app.asar: a packaged build turns the
// grantFileProtocolExtraPrivileges fuse off, and then nothing in the archive
// opens as a file:// page, so the import would fail on every launch and the
// saved clips would never arrive. The app:// side loads style.css, so no
// dashboard script runs. Resolves to
// { status: 'imported' | 'already' | 'failed', keys, error }; never rejects.
//
// The caller must already have another window open: destroying the last
// window would fire window-all-closed and quit the app.
async function migrateFileOriginStorage({ BrowserWindow, sourceFile, flushStorage = () => {}, timeoutMs = 10000, settleMs = 300 }) {
  let win = null;
  try {
    if (typeof sourceFile !== 'string' || !sourceFile || /[\\/]app\.asar([\\/]|$)/i.test(sourceFile)) {
      throw new Error(`the legacy store must be read through a page outside app.asar (got ${sourceFile})`);
    }
    win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const run = async () => {
      await win.loadFile(sourceFile);
      const source = await win.webContents.executeJavaScript(READ_STORAGE_SCRIPT);
      await win.loadURL(`${DASHBOARD_ORIGIN}/style.css`);
      const dest = await win.webContents.executeJavaScript(READ_STORAGE_SCRIPT);
      const plan = mergeLegacyStorage(source, dest);
      if (plan.alreadyImported) return { status: 'already', keys: [] };
      await win.webContents.executeJavaScript(writeStorageScript({ ...plan.entries, [IMPORT_MARKER]: new Date().toISOString() }));
      // Let the writes reach the browser-side store before the renderer goes,
      // then make them durable before the caller records the import as done.
      await new Promise(r => setTimeout(r, settleMs));
      flushStorage();
      return { status: 'imported', keys: plan.keys };
    };
    return await withTimeout(run(), timeoutMs, 'Dashboard storage import');
  } catch (e) {
    return { status: 'failed', keys: [], error: e && e.message ? e.message : String(e) };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* already gone */ }
  }
}

module.exports = {
  DASHBOARD_SCHEME,
  DASHBOARD_HOST,
  DASHBOARD_ORIGIN,
  DASHBOARD_URL,
  DASHBOARD_SCHEME_PRIVILEGES,
  IMPORT_MARKER,
  isDashboardOrigin,
  isDashboardUrl,
  resolveDashboardAsset,
  createDashboardHandler,
  mergeLegacyStorage,
  migrateFileOriginStorage,
};
