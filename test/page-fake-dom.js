// A small fake DOM plus a fake clock, for running the scripts that
// src/inject.js and src/twitch-preload.js inject into third-party pages under
// node:test. Not a browser: just the tree, selector matching, bubbling events,
// click activation for labels/radios, and hand-set layout boxes those scripts
// read. A selector it cannot parse throws, so a typo in a page script fails the
// test instead of silently matching nothing. Helper module, not a test file.
'use strict';
const vm = require('node:vm');

// ---------------------------------------------------------------- selectors

function splitOutside(sel, isSep) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0 && isSep(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function parseCompound(src) {
  const c = { tag: null, ids: [], classes: [], attrs: [] };
  let i = 0;
  const ident = () => {
    const m = /^[\w-]+/.exec(src.slice(i));
    if (!m) throw new Error(`fake-dom: bad selector "${src}"`);
    i += m[0].length;
    return m[0];
  };
  if (src[0] === '*') i = 1;
  else if (/[a-zA-Z]/.test(src[0])) c.tag = ident().toUpperCase();
  while (i < src.length) {
    const ch = src[i++];
    if (ch === '.') c.classes.push(ident());
    else if (ch === '#') c.ids.push(ident());
    else if (ch === '[') {
      const end = src.indexOf(']', i);
      const body = src.slice(i, end);
      i = end + 1;
      const m = /^\s*([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*([iIsS])?)?\s*$/.exec(body);
      if (!m) throw new Error(`fake-dom: bad attribute selector "[${body}]"`);
      c.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? '', ci: /i/i.test(m[6] || '') });
    } else {
      throw new Error(`fake-dom: unsupported selector syntax "${ch}" in "${src}"`);
    }
  }
  return c;
}

function parseSelector(sel) {
  return splitOutside(sel, ch => ch === ',').map(complex => {
    if (/[>+~]/.test(complex.replace(/\[[^\]]*\]/g, ''))) throw new Error(`fake-dom: unsupported combinator in "${complex}"`);
    return splitOutside(complex, ch => /\s/.test(ch)).map(parseCompound);
  });
}

function attrMatches(el, a) {
  const v = el.getAttribute(a.name);
  if (v === null) return false;
  if (!a.op) return true;
  const have = a.ci ? v.toLowerCase() : v;
  const want = a.ci ? a.value.toLowerCase() : a.value;
  switch (a.op) {
    case '=': return have === want;
    case '*=': return want !== '' && have.includes(want);
    case '^=': return want !== '' && have.startsWith(want);
    case '$=': return want !== '' && have.endsWith(want);
    case '~=': return have.split(/\s+/).includes(want);
    case '|=': return have === want || have.startsWith(want + '-');
    default: return false;
  }
}

function compoundMatches(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.ids.some(id => el.id !== id)) return false;
  const cls = el.className.split(/\s+/);
  if (c.classes.some(k => !cls.includes(k))) return false;
  return c.attrs.every(a => attrMatches(el, a));
}

function complexMatches(el, parts) {
  if (!compoundMatches(el, parts[parts.length - 1])) return false;
  let node = el.parentElement;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (node && !compoundMatches(node, parts[p])) node = node.parentElement;
    if (!node) return false;
    node = node.parentElement;
  }
  return true;
}

// ------------------------------------------------------------------- events

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stopped = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
}
class FakeMouseEvent extends FakeEvent {}
class FakePointerEvent extends FakeMouseEvent {}
class FakeKeyboardEvent extends FakeEvent {}

class EventTargetish {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (l) this._listeners.set(type, l.filter(f => f !== fn));
  }
  listenerCount(type) { return (this._listeners.get(type) || []).length; }
  _fire(ev) {
    ev.currentTarget = this;
    for (const fn of (this._listeners.get(ev.type) || []).slice()) fn.call(this, ev);
  }
}

// ----------------------------------------------------------------- elements

class FakeElement extends EventTargetish {
  constructor(doc, tag, attrs = {}, text = '') {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.rect = null;
    this.style = {};
    this.checked = false;
    this.disabled = false;
    this.onclick = null;
    this.counts = {};
  }
  get className() { return this.getAttribute('class') || ''; }
  get id() { return this.getAttribute('id') || ''; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children.forEach(c => { c.parentElement = null; }); this.children = []; this.ownText = String(v); }
  get outerHTML() {
    const a = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.tagName.toLowerCase()}${a}>${this.textContent}</${this.tagName.toLowerCase()}>`;
  }
  get control() {
    if (this.tagName !== 'LABEL') return undefined;
    const f = this.getAttribute('for');
    return f ? this.ownerDocument.getElementById(f) : this.querySelector('input');
  }
  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    this.ownerDocument._mutated(this, child);
    return child;
  }
  remove() {
    const p = this.parentElement;
    if (!p) return;
    p.children = p.children.filter(c => c !== this);
    this.parentElement = null;
  }
  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n === this.ownerDocument.documentElement;
  }
  contains(other) {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  matches(sel) { return parseSelector(sel).some(parts => complexMatches(this, parts)); }
  closest(sel) {
    const parsed = parseSelector(sel);
    for (let n = this; n; n = n.parentElement) if (parsed.some(parts => complexMatches(n, parts))) return n;
    return null;
  }
  _descendants(out = []) {
    for (const c of this.children) { out.push(c); c._descendants(out); }
    return out;
  }
  querySelectorAll(sel) {
    const parsed = parseSelector(sel);
    return this._descendants().filter(el => parsed.some(parts => complexMatches(el, parts)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  _hidden() {
    for (let n = this; n; n = n.parentElement) if (n.style.display === 'none') return true;
    return false;
  }
  getBoundingClientRect() {
    const r = (this.isConnected && !this._hidden() && this.rect) || { left: 0, top: 0, width: 0, height: 0 };
    return { left: r.left, top: r.top, width: r.width, height: r.height, x: r.left, y: r.top,
      right: r.left + r.width, bottom: r.top + r.height };
  }
  getClientRects() { const r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; }
  scrollIntoView() {}
  dispatchEvent(ev) {
    ev.target = this;
    this.counts[ev.type] = (this.counts[ev.type] || 0) + 1;
    const isToggle = ev.type === 'click' && this.tagName === 'INPUT' && /^(radio|checkbox)$/.test(this.getAttribute('type') || '');
    if (isToggle) this._activate();
    const path = [];
    for (let n = this; n; n = ev.bubbles ? n.parentElement : null) path.push(n);
    if (ev.bubbles && this.isConnected) path.push(this.ownerDocument);
    for (const n of path) { n._fire(ev); if (ev._stopped) break; }
    if (isToggle) { this._fire(new FakeEvent('input', { bubbles: true })); this._fire(new FakeEvent('change', { bubbles: true })); }
    // A label forwards clicks, synthetic ones included, to its control.
    if (ev.type === 'click' && this.tagName === 'LABEL' && !ev.defaultPrevented && this.control) this.control.click();
    return !ev.defaultPrevented;
  }
  _activate() {
    if (this.getAttribute('type') === 'radio') {
      const name = this.getAttribute('name');
      if (name) this.ownerDocument.documentElement.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = false; });
      this.checked = true;
    } else {
      this.checked = !this.checked;
    }
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeMouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  }
}

class FakeDocument extends EventTargetish {
  constructor() {
    super();
    this.readyState = 'loading';
    this.observers = [];
    this.documentElement = null;
    this.head = null;
    this.body = null;
  }
  // Builds <html><head/><body/></html>; the preload tests start without it.
  mountRoot() {
    this.documentElement = new FakeElement(this, 'html');
    this.head = this.documentElement.appendChild(new FakeElement(this, 'head'));
    this.body = this.documentElement.appendChild(new FakeElement(this, 'body'));
    this._mutated(this, this.documentElement);
    return this;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return { nodeType: 3, textContent: String(text), text: String(text) }; }
  el(tag, attrs = {}, text = '', rect = null) {
    const e = new FakeElement(this, tag, attrs, text);
    e.rect = rect;
    return e;
  }
  getElementById(id) { return this.querySelector(`#${id}`); }
  querySelectorAll(sel) {
    if (!this.documentElement) return [];
    const parsed = parseSelector(sel);
    return [this.documentElement, ...this.documentElement._descendants()].filter(el => parsed.some(parts => complexMatches(el, parts)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  dispatchEvent(ev) { ev.target = ev.target || this; this._fire(ev); return !ev.defaultPrevented; }
  _mutated(target, node) { for (const o of this.observers) o._notify(target, node); }
}

// Delivers records in a microtask, like the real one: a synchronous callback
// would re-enter whatever DOM write triggered it. disconnect() drops pending
// records, as the spec does.
class FakeMutationObserver {
  constructor(doc, cb) { this.doc = doc; this.cb = cb; this.active = false; this.records = []; this.scheduled = false; }
  observe() { if (!this.active) { this.active = true; this.doc.observers.push(this); } }
  disconnect() {
    this.active = false;
    this.records = [];
    this.doc.observers = this.doc.observers.filter(o => o !== this);
  }
  _notify(target, node) {
    if (!this.active) return;
    this.records.push({ type: 'childList', target, addedNodes: [node] });
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const recs = this.records;
      this.records = [];
      if (this.active && recs.length) this.cb(recs, this);
    });
  }
}

// ---------------------------------------------------------------- the clock

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, at: now + delay, every: repeat ? Math.max(1, delay) : 0 });
    return id;
  };
  const flush = () => new Promise(r => setImmediate(r));
  return {
    get now() { return now; },
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear: (id) => { timers.delete(id); },
    pending: () => timers.size,
    // Runs every timer due within ms, in time order, letting promise chains
    // settle between them the way the event loop would.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
        }
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      await flush();
      now = end;
    },
  };
}

// A page context: the fake document as `document`, the context itself as
// `window`, fake timers and Date, and a console that records what the page logs.
function makePage({ host, pathname = '/', width = 1280, height = 720 } = {}) {
  const clock = makeClock();
  const doc = new FakeDocument().mountRoot();
  const logs = [];
  const store = new Map();
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const windowEvents = new EventTargetish();
  const ctx = {
    document: doc,
    location: { host, pathname, href: `https://${host}${pathname}` },
    innerWidth: width,
    innerHeight: height,
    console: {
      log: (...a) => logs.push({ level: 'log', text: a.join(' ') }),
      warn: (...a) => logs.push({ level: 'warn', text: a.join(' ') }),
      error: (...a) => logs.push({ level: 'error', text: a.join(' ') }),
      debug: () => {},
    },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clear,
    clearInterval: clock.clear,
    Date: FakeDate,
    Event: FakeEvent,
    MouseEvent: FakeMouseEvent,
    PointerEvent: FakePointerEvent,
    KeyboardEvent: FakeKeyboardEvent,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    addEventListener: (...a) => windowEvents.addEventListener(...a),
    removeEventListener: (...a) => windowEvents.removeEventListener(...a),
    dispatchEvent: (ev) => { windowEvents._fire(ev); return true; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return {
    ctx, doc, clock, logs, store,
    run: (code) => vm.runInContext(code, ctx),
    logText: (needle) => logs.filter(l => l.text.includes(needle)).map(l => l.text),
  };
}

module.exports = {
  FakeDocument, FakeElement, FakeEvent, FakeMouseEvent, FakePointerEvent, FakeKeyboardEvent,
  FakeMutationObserver, makeClock, makePage, parseSelector,
};
