// Minimal DOM stand-in for the renderer XSS harness (renderer-xss-harness.test.js).
//
// innerHTML is the only way markup reaches the HTML parser in the renderer, so
// this records every string assigned to it and builds a tree from that markup
// the way a browser would for the parts that matter here: one element per
// start tag with its attributes (entities decoded), nesting, and decoded text.
// Nothing is executed. A harness asserts on what WOULD have been parsed: no
// element carries an on* attribute, no unexpected <img>/<script> exists, and
// hostile text comes back out as literal text.

'use strict';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeClassList {
  constructor(el) { this.el = el; }
  _list() { return this.el.className.split(/\s+/).filter(Boolean); }
  contains(c) { return this._list().includes(c); }
  add(...cs) { this.el.className = [...new Set([...this._list(), ...cs])].join(' '); }
  remove(...cs) { this.el.className = this._list().filter(c => !cs.includes(c)).join(' '); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.title = '';
    this.src = '';
    this.disabled = false;
    this.hidden = false;
    this._text = '';
    this._html = '';
    this.classList = new FakeClassList(this);
  }

  set innerHTML(html) {
    const s = String(html);
    this.ownerDocument.htmlLog.push(s);
    this._html = s;
    this.children = [];
    this._text = '';
    parseInto(this, s);
  }
  get innerHTML() { return this._html; }

  set textContent(v) { this.children = []; this._html = ''; this._text = String(v ?? ''); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }

  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.length; }
  get childNodes() { return [...this.children]; }

  setAttribute(name, value) {
    const n = String(name).toLowerCase();
    const v = String(value);
    this.attributes[n] = v;
    if (n === 'class') this.className = v;
    else if (n === 'id') this.id = v;
    else if (n === 'title') this.title = v;
    else if (n === 'src') this.src = v;
    else if (n.startsWith('data-')) this.dataset[camel(n.slice(5))] = v;
  }
  getAttribute(name) { return this.attributes[String(name).toLowerCase()] ?? null; }
  removeAttribute(name) { delete this.attributes[String(name).toLowerCase()]; }

  appendChild(child) {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    child.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  replaceChildren(...nodes) { this.children = []; this._text = ''; nodes.forEach(n => this.appendChild(n)); }
  removeChild(child) { child.remove(); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches?.(sel)) return n; return null; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  async dispatch(type, event = {}) {
    const e = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners[type] || []) await fn(e);
  }

  descendants() {
    const out = [];
    const walk = el => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  matches(selector) { return String(selector).split(',').some(s => matchChain(this, s.trim().split(/\s+/))); }
  querySelectorAll(selector) { return this.descendants().filter(el => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function matchCompound(el, compound) {
  const re = /([a-z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]/gi;
  let m;
  let consumed = 0;
  while ((m = re.exec(compound))) {
    if (m.index !== consumed) throw new Error(`fake DOM cannot parse selector ${compound}`);
    consumed = re.lastIndex;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !el.classList.contains(m[2])) return false;
    if (m[3] && el.id !== m[3]) return false;
    if (m[4]) {
      const name = m[4].toLowerCase();
      const have = name.startsWith('data-') ? el.dataset[camel(name.slice(5))] : el.attributes[name];
      if (have === undefined) return false;
      if (m[5] !== undefined && have !== m[5].replace(/\\(.)/g, '$1')) return false;
    }
  }
  if (consumed !== compound.length) throw new Error(`fake DOM cannot parse selector ${compound}`);
  return true;
}

function matchChain(el, parts) {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  for (let p = el.parentNode; p; p = p.parentNode) {
    if (p.matches && matchChain(p, parts.slice(0, -1))) return true;
  }
  return false;
}

// Start tags, end tags and text; enough of the HTML tokenizer for the
// renderer's templates (and for a payload that slips through to show up).
function parseInto(root, html) {
  const doc = root.ownerDocument;
  const stack = [root];
  const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const text = s => { if (s) stack[stack.length - 1]._text += decodeEntities(s); };
  while ((m = tagRe.exec(html))) {
    text(html.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = doc.createElement(m[2]);
    const attrRe = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[3] || ''))) el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
    stack[stack.length - 1].appendChild(el);
    if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
  }
  text(html.slice(last));
}

function createDocument() {
  const doc = { htmlLog: [], created: [] };
  doc.createElement = tag => { const el = new FakeElement(tag, doc); doc.created.push(el); return el; };
  doc.documentElement = new FakeElement('html', doc);
  doc.head = doc.documentElement.appendChild(new FakeElement('head', doc));
  doc.body = doc.documentElement.appendChild(new FakeElement('body', doc));
  doc.getElementById = id => doc.documentElement.descendants().find(el => el.id === id) || null;
  doc.querySelector = sel => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = sel => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = () => {};
  // Adds <tag id=...> to <body>, as index.html would provide it.
  doc.add = (tag, id, className = '') => {
    const el = doc.createElement(tag);
    if (id) el.id = id;
    el.className = className;
    return doc.body.appendChild(el);
  };
  return doc;
}

// Every element a document has ever parsed or created, attached or not.
function allElements(doc) {
  return doc.created;
}

// Elements the HTML parser produced from markup carrying something other than
// fixed renderer markup: any on* attribute, or a tag in `forbidden`.
function injectedElements(doc, forbidden = ['script', 'iframe', 'object', 'embed']) {
  return allElements(doc).filter(el => Object.keys(el.attributes).some(n => n.startsWith('on'))
    || forbidden.includes(el.tagName.toLowerCase()));
}

module.exports = { createDocument, allElements, injectedElements, decodeEntities, FakeElement };
