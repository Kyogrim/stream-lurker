// Static guard for contract C2: no string from config, localStorage or the
// network reaches the dashboard's HTML parser unescaped, and no URL reaches a
// src/href sink without validation. Run: node --test test/renderer-html-guard.test.js
//
// Rule 1 (HTML). Every ${} inside a template literal that contains markup, and
// every right-hand side of innerHTML / outerHTML / insertAdjacentHTML, must be
// provably safe:
//   - escapeHtml(...), or a call to a SAFE_HTML_CALLS helper (each re-verified
//     below by feeding it hostile input), or a per-file HTML builder whose every
//     return statement passes this same rule;
//   - a string/number literal, or a template whose own ${} are safe;
//   - a ternary whose two branches are safe (the condition is never rendered);
//   - a || b / a ?? b with both sides safe, a && b with b safe;
//   - a + b with both sides safe; numeric results (a * b, Math.x(...),
//     Number(...), x.toFixed(...)) and booleans (comparisons, !x);
//   - arr.join(sep) where every element provably is safe (array literal, .map
//     callback returns, or a const array whose every .push() is safe);
//   - an identifier that is never a parameter / destructured / imported name in
//     that file and whose every assignment in that file is safe;
//   - an exact expression in ALLOWED_EXPRESSIONS (static markup by design).
// Rule 2 (URL). Every .src= / .href= / setAttribute('src'|'href', x) /
// window.open(x) value must be safeHttpsUrl(...), a per-file URL builder whose
// returns are verified, an https:// or relative literal, or an identifier
// whose every assignment is one of those.
// Rule 3. No inline event handler or javascript: URL in any markup string, and
// no other HTML-parsing API (DOMParser, createContextualFragment, ...).
//
// The analysis is name-based and flow-insensitive, which errs toward flagging:
// a false alarm costs an escapeHtml() call, a miss costs an XSS.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

// inject.js and twitch-preload.js run inside third-party pages, not the
// dashboard document, so the dashboard's HTML contract does not apply there.
const PAGE_SCRIPTS = new Set(['inject.js', 'twitch-preload.js']);
const FILES = [
  'renderer.js',
  ...fs.readdirSync(path.join(ROOT, 'src'))
    .filter(f => f.endsWith('.js') && !PAGE_SCRIPTS.has(f))
    .sort()
    .map(f => `src/${f}`),
];

// Calls whose result may be interpolated unescaped. Verified against hostile
// input in the "allowlisted helpers" test below.
const SAFE_HTML_CALLS = {
  escapeHtml: 'the escaper itself',
  getPlatformSVG: 'one of four constant SVG strings, or ""',
  fmtDuration: 'digits from Math.round/floor plus "h"/"m"',
  formatViewerCount: 'Number() coerced; digits, ".", K or M',
  platformColorVar: 'var(--<known platform>-color) or a fixed fallback',
};
const SAFE_URL_CALLS = {
  safeHttpsUrl: 'an https URL on an allowlisted host, or ""',
};
// Local builders: allowed as calls because every `return` in them is checked
// with the same rule (see verifyBuilders), so listing one grants nothing.
const HTML_BUILDERS = {
  'src/leaderboard.js': ['statCard', 'buildHeatmap'],
  'src/multi-lurk.js': ['cellMetaHTML', 'buildCellHTML'],
};
const URL_BUILDERS = {
  'src/clips.js': ['clipThumbUrl', 'clipPageUrl', 'clipSourceUrl', 'signedClipUrl', 'legacyClipMp4Url'],
  'src/stream-webview.js': ['streamWebviewSrc'],
};
// Markup by design, so it cannot be escaped. Each one is a constant in the
// same file; the test fails if the expression disappears (stale entry).
const ALLOWED_EXPRESSIONS = {
  'src/onboarding.js': {
    'step.body': 'static copy from the STEPS constant',
    'step.icon': 'static SVG path from the STEPS constant',
  },
  'src/streamers.js': {
    'MODE_META[mode].icon': 'static SVG from MODE_META; mode is from getStreamMode()',
  },
};

// ── Lexer ────────────────────────────────────────────────────────────────────
// Enough JavaScript to find template literals and their ${} code, skip
// strings / comments / regexes, and split expressions at their top level.
// Anything it cannot follow throws, so the guard fails loudly, never silently.

const PUNCT = /\?\?=|\?\?|\?\.(?!\d)|\.\.\.|===|!==|\*\*=|>>>=|<<=|>>=|=>|==|!=|<=|>=|&&=|\|\|=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\*\*|<<|>>>|>>|[{}()[\];,<>+\-*%&|^!~?:=./@#]/y;
const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
const WORD = /[\w$\u0080-￿]+/y;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

function lineOf(src, pos) {
  return src.slice(0, pos).split('\n').length;
}

function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j + 1;
    if (src[j] === '\n') break;
  }
  throw new Error(`unterminated string at line ${lineOf(src, i)}`);
}

function skipRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') break;
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k++;
      return k;
    }
  }
  throw new Error(`unterminated regex at line ${lineOf(src, i)}`);
}

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === 'word') return REGEX_AFTER_WORD.has(prev.value);
  if (prev.type === 'punct') return ![')', ']', '}', '++', '--'].includes(prev.value);
  return false;
}

// A template literal starting at the backtick at i. exprs hold absolute
// [start, end) ranges of each ${} body.
function readTemplate(src, i) {
  const tpl = { type: 'tpl', start: i, quasis: [], exprs: [] };
  let q = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { q += src.slice(j, j + 2); j += 2; continue; }
    if (c === '`') { tpl.quasis.push(q); tpl.end = j + 1; return tpl; }
    if (c === '$' && src[j + 1] === '{') {
      tpl.quasis.push(q);
      q = '';
      const close = findClosingBrace(src, j + 2);
      tpl.exprs.push({ start: j + 2, end: close });
      j = close + 1;
      continue;
    }
    q += c;
    j++;
  }
  throw new Error(`unterminated template at line ${lineOf(src, i)}`);
}

function findClosingBrace(src, i) {
  let depth = 0;
  for (const t of lex(src, i, src.length)) {
    if (t.type !== 'punct') continue;
    if (OPENERS.has(t.value)) depth++;
    else if (CLOSERS.has(t.value)) {
      if (depth === 0) {
        if (t.value === '}') return t.start;
        throw new Error(`unbalanced ${t.value} at line ${lineOf(src, t.start)}`);
      }
      depth--;
    }
  }
  throw new Error(`unterminated \${ at line ${lineOf(src, i)}`);
}

function* lex(src, i = 0, end = src.length) {
  let prev = null;
  while (i < end) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? end : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new Error(`unterminated comment at line ${lineOf(src, i)}`);
      i = close + 2;
      continue;
    }
    let tok;
    if (c === '"' || c === "'") {
      tok = { type: 'str', start: i, end: skipString(src, i) };
    } else if (c === '`') {
      tok = readTemplate(src, i);
    } else if (c === '/' && regexAllowed(prev)) {
      tok = { type: 'regex', start: i, end: skipRegex(src, i) };
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1]))) {
      NUM.lastIndex = i;
      const m = NUM.exec(src);
      tok = { type: 'num', start: i, end: i + m[0].length };
    } else if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      WORD.lastIndex = i;
      const m = WORD.exec(src);
      tok = { type: 'word', start: i, end: i + m[0].length };
    } else {
      PUNCT.lastIndex = i;
      const m = PUNCT.exec(src);
      if (!m) throw new Error(`unexpected character ${JSON.stringify(c)} at line ${lineOf(src, i)}`);
      tok = { type: 'punct', start: i, end: i + m[0].length };
    }
    tok.value = src.slice(tok.start, tok.end);
    yield tok;
    prev = tok;
    i = tok.end;
  }
}

// Tokens of one code context, each tagged with its bracket depth (an opener
// and its closer share the outer depth).
function tokensWithDepth(src, start = 0, end = src.length) {
  const toks = [...lex(src, start, end)];
  let d = 0;
  for (const t of toks) {
    if (t.type === 'punct' && CLOSERS.has(t.value)) d--;
    t.depth = d;
    if (t.type === 'punct' && OPENERS.has(t.value)) d++;
  }
  return toks;
}

// Every code context in a file: the file itself plus each ${} body, however
// deeply nested. Also every template token, for rule 1.
function contextsOf(src) {
  const contexts = [];
  const templates = [];
  const visit = (start, end) => {
    const toks = tokensWithDepth(src, start, end);
    contexts.push(toks);
    for (const t of toks) {
      if (t.type !== 'tpl') continue;
      templates.push(t);
      for (const e of t.exprs) visit(e.start, e.end);
    }
  };
  visit(0, src.length);
  return { contexts, templates };
}

function matchIndex(toks, i) {
  const open = toks[i].value;
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  for (let j = i + 1; j < toks.length; j++) {
    if (toks[j].depth === toks[i].depth && toks[j].value === close && toks[j].type === 'punct') return j;
  }
  return -1;
}

function matchIndexBack(toks, i) {
  const close = toks[i].value;
  const open = { ')': '(', ']': '[', '}': '{' }[close];
  for (let j = i - 1; j >= 0; j--) {
    if (toks[j].depth === toks[i].depth && toks[j].value === open && toks[j].type === 'punct') return j;
  }
  return -1;
}

// Tokens of one expression starting at index i: up to a ';' or ',' at the
// starting depth, or a closer that leaves it. Returns the end index (exclusive).
function expressionEnd(toks, i) {
  const base = toks[i]?.depth;
  let j = i;
  for (; j < toks.length; j++) {
    const t = toks[j];
    if (t.depth < base) break;
    if (t.depth === base && t.type === 'punct' && (t.value === ';' || t.value === ',')) break;
  }
  return j;
}

function textOf(src, toks, a, b) {
  return b > a ? src.slice(toks[a].start, toks[b - 1].end) : '';
}

function splitTopLevel(src, toks, a, b, sep) {
  const parts = [];
  let from = a;
  const base = toks[a]?.depth;
  for (let j = a; j < b; j++) {
    if (toks[j].depth === base && toks[j].type === 'punct' && toks[j].value === sep) {
      parts.push(textOf(src, toks, from, j));
      from = j + 1;
    }
  }
  const last = textOf(src, toks, from, b);
  if (last.trim()) parts.push(last);
  return parts;
}

// ── Per-file facts ───────────────────────────────────────────────────────────

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'with', 'return', 'typeof', 'new', 'await', 'async']);

function collectFacts(src) {
  const { contexts, templates } = contextsOf(src);
  const tainted = new Set();
  const assignments = new Map(); // name -> [{ rhs, op }]
  const pushes = new Map(); // name -> [argText]
  const mutated = new Set();
  const functions = new Map(); // name -> body text
  const addAssign = (name, rhs, op) => {
    if (!assignments.has(name)) assignments.set(name, []);
    assignments.get(name).push({ rhs, op });
  };
  const taintRange = (toks, a, b) => {
    for (let k = a; k < b; k++) if (toks[k].type === 'word') tainted.add(toks[k].value);
  };

  for (const toks of contexts) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const next = toks[i + 1];
      const prev = toks[i - 1];

      // Parameters of arrow functions.
      if (t.value === '=>' && prev) {
        if (prev.value === ')') {
          const open = matchIndexBack(toks, i - 1);
          if (open < 0) throw new Error('unmatched arrow params');
          taintRange(toks, open + 1, i - 1);
        } else if (prev.type === 'word') {
          tainted.add(prev.value);
        }
      }
      // function declarations/expressions: params tainted, body remembered.
      if (t.type === 'word' && t.value === 'function') {
        let k = i + 1;
        if (toks[k]?.value === '*') k++;
        let name = null;
        if (toks[k]?.type === 'word') name = toks[k++].value;
        if (toks[k]?.value === '(') {
          const close = matchIndex(toks, k);
          taintRange(toks, k + 1, close);
          if (toks[close + 1]?.value === '{') {
            const bodyEnd = matchIndex(toks, close + 1);
            if (name) functions.set(name, src.slice(toks[close + 1].start, toks[bodyEnd].end));
          }
        }
      }
      // Method shorthand: name(params) { ... }
      if (t.type === 'word' && !KEYWORDS.has(t.value) && next?.value === '(' && prev?.value !== '.' && prev?.value !== 'function') {
        const close = matchIndex(toks, i + 1);
        if (close > 0 && toks[close + 1]?.value === '{' && toks[close + 1].depth === t.depth) {
          taintRange(toks, i + 2, close);
        }
      }
      // Destructuring assignment: ({ a } = obj), [a, b] = list.
      if (t.type === 'punct' && (t.value === '{' || t.value === '[')) {
        const close = matchIndex(toks, i);
        if (close > 0 && toks[close + 1]?.type === 'punct' && toks[close + 1].value === '=') taintRange(toks, i + 1, close);
      }
      if (t.value === 'catch' && next?.value === '(') taintRange(toks, i + 2, matchIndex(toks, i + 1));
      if (t.value === 'import') {
        let k = i + 1;
        while (k < toks.length && toks[k].value !== 'from' && toks[k].value !== ';') k++;
        taintRange(toks, i + 1, k);
      }
      if (t.value === 'for' && next?.value === '(') taintRange(toks, i + 2, matchIndex(toks, i + 1));

      // Declarations.
      if (t.type === 'word' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) {
        let k = i + 1;
        for (;;) {
          const d = toks[k];
          if (!d) break;
          if (d.value === '{' || d.value === '[') {
            const close = matchIndex(toks, k);
            taintRange(toks, k + 1, close); // destructuring: provenance unknown
            k = close + 1;
          } else if (d.type === 'word') {
            k++;
            if (toks[k]?.value === '=') {
              const end = expressionEnd(toks, k + 1);
              addAssign(d.value, textOf(src, toks, k + 1, end), '=');
              k = end;
            } else {
              addAssign(d.value, 'undefined', '=');
            }
          } else break;
          if (toks[k]?.value === '=' ) { k = expressionEnd(toks, k + 1); }
          if (toks[k]?.value === ',' && toks[k].depth === t.depth) { k++; continue; }
          break;
        }
      }
      // Plain and compound assignments to a bare name.
      if (t.type === 'word' && next?.type === 'punct' && ['=', '+=', '||=', '??=', '&&='].includes(next.value)
          && prev?.value !== '.' && prev?.value !== '?.'
          && !['const', 'let', 'var'].includes(prev?.value)) {
        const end = expressionEnd(toks, i + 2);
        addAssign(t.value, textOf(src, toks, i + 2, end), next.value);
      }
      // Array growth and in-place mutation.
      if (t.type === 'word' && next?.value === '.' && ['push', 'unshift'].includes(toks[i + 2]?.value) && toks[i + 3]?.value === '(') {
        const close = matchIndex(toks, i + 3);
        const args = splitTopLevel(src, toks, i + 4, close, ',');
        if (!pushes.has(t.value)) pushes.set(t.value, []);
        pushes.get(t.value).push(...args);
      }
      if (t.type === 'word' && next?.value === '.' && ['splice', 'fill', 'copyWithin'].includes(toks[i + 2]?.value)) {
        mutated.add(t.value);
      }
      if (t.type === 'word' && next?.value === '[' && prev?.value !== '.') {
        const close = matchIndex(toks, i + 1);
        if (toks[close + 1]?.value === '=') mutated.add(t.value);
      }
    }
  }
  return { contexts, templates, tainted, assignments, pushes, mutated, functions };
}

// ── Safety judgement ─────────────────────────────────────────────────────────

function makeJudge(file, facts) {
  const allowedExpr = ALLOWED_EXPRESSIONS[file] || {};
  const htmlBuilders = new Set(HTML_BUILDERS[file] || []);
  const urlBuilders = new Set(URL_BUILDERS[file] || []);

  function safe(text, kind, seen = new Set()) {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (!norm) return false;
    if (kind === 'html' && Object.hasOwn(allowedExpr, norm)) return true;
    const toks = tokensWithDepth(text);
    return safeToks(text, toks, 0, toks.length, kind, seen);
  }

  function literalUrlOk(value) {
    // https:// or a relative path; never javascript:, data:, http: ...
    return value === '' || /^https:\/\//i.test(value) || /^[\w./#?=&-]*$/.test(value) && !/^[a-z][\w+.-]*:/i.test(value);
  }

  function safeToks(src, toks, a, b, kind, seen) {
    if (b <= a) return false;
    const base = toks[a].depth;
    // Whole expression wrapped in parens.
    if (toks[a].value === '(' && matchIndex(toks, a) === b - 1) return safeToks(src, toks, a + 1, b - 1, kind, seen);

    const top = [];
    for (let j = a; j < b; j++) if (toks[j].depth === base) top.push(j);
    const topPunct = v => top.filter(j => toks[j].type === 'punct' && toks[j].value === v);

    // Assignments and bare functions inside an interpolation: never.
    if (top.some(j => toks[j].type === 'punct' && /^(=|\+=|-=|\*=|\/=|%=|&&=|\|\|=|\?\?=|=>)$/.test(toks[j].value))) return false;

    // Ternary: only the branches are rendered.
    const q = topPunct('?')[0];
    if (q !== undefined) {
      let nest = 0;
      for (const j of top) {
        if (j <= q || toks[j].type !== 'punct') continue;
        if (toks[j].value === '?') nest++;
        else if (toks[j].value === ':') {
          if (nest === 0) return safeToks(src, toks, q + 1, j, kind, seen) && safeToks(src, toks, j + 1, b, kind, seen);
          nest--;
        }
      }
      return false;
    }

    // Logical operators.
    const logical = top.filter(j => toks[j].type === 'punct' && ['||', '??', '&&'].includes(toks[j].value));
    if (logical.length) {
      const bounds = [a, ...logical.map(j => j), b];
      const operands = [];
      for (let k = 0; k < bounds.length - 1; k++) operands.push([k === 0 ? bounds[k] : bounds[k] + 1, bounds[k + 1]]);
      const onlyAnd = logical.every(j => toks[j].value === '&&');
      // a && b renders a only when a is falsy (false/0/""/null/undefined/NaN).
      if (onlyAnd && kind === 'html') { const [x, y] = operands[operands.length - 1]; return safeToks(src, toks, x, y, kind, seen); }
      return operands.every(([x, y]) => safeToks(src, toks, x, y, kind, seen));
    }

    const isBinary = j => {
      const p = toks[j - 1];
      return j > a && p && (p.type !== 'punct' || [')', ']', '}'].includes(p.value));
    };
    // Comparisons render as true/false.
    if (kind === 'html' && top.some(j => (toks[j].type === 'punct' && ['===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(toks[j].value))
        || (toks[j].type === 'word' && ['instanceof', 'in'].includes(toks[j].value)))) return true;
    // String concatenation: every piece must be safe.
    const plus = top.filter(j => toks[j].type === 'punct' && toks[j].value === '+' && isBinary(j));
    if (plus.length) {
      if (kind !== 'html') return false;
      const bounds = [a - 1, ...plus, b];
      for (let k = 0; k < bounds.length - 1; k++) {
        if (!safeToks(src, toks, bounds[k] + 1, bounds[k + 1], kind, seen)) return false;
      }
      return true;
    }
    // Other binary arithmetic always yields a number.
    if (top.some(j => toks[j].type === 'punct' && ['-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^'].includes(toks[j].value) && isBinary(j))) {
      return kind === 'html';
    }
    // Unary operators.
    if (toks[a].type === 'punct' && ['!', '-', '+', '~'].includes(toks[a].value)) return kind === 'html';
    if (toks[a].type === 'word' && ['typeof', 'void'].includes(toks[a].value)) return kind === 'html';

    // Single tokens.
    if (b - a === 1) {
      const t = toks[a];
      if (t.type === 'str') return kind === 'html' || literalUrlOk(t.value.slice(1, -1).replace(/\\(.)/g, '$1'));
      if (t.type === 'tpl') {
        if (kind === 'url') return t.exprs.length === 0 && literalUrlOk(t.quasis[0]);
        return t.exprs.every(e => safe(src.slice(e.start, e.end), 'html', seen));
      }
      if (t.type === 'num') return kind === 'html';
      if (t.type === 'word') {
        if (['true', 'false', 'null', 'undefined'].includes(t.value)) return kind === 'html';
        return identSafe(t.value, kind, seen);
      }
      return false;
    }

    return chainSafe(src, toks, a, b, kind, seen);
  }

  // A postfix chain: primary followed by .prop / [index] / (args) suffixes.
  function parseChain(src, toks, a, b) {
    const chain = [];
    let i = a;
    const t = toks[i];
    if (t.type === 'word') { chain.push({ k: 'id', name: t.value }); i++; }
    else if (t.value === '[') {
      const close = matchIndex(toks, i);
      if (close < 0 || close >= b) return null;
      chain.push({ k: 'array', elems: splitTopLevel(src, toks, i + 1, close, ',') });
      i = close + 1;
    } else if (t.value === '(') {
      const close = matchIndex(toks, i);
      if (close < 0 || close >= b) return null;
      chain.push({ k: 'group', text: textOf(src, toks, i + 1, close) });
      i = close + 1;
    } else if (t.type === 'str' || t.type === 'tpl' || t.type === 'num') {
      chain.push({ k: 'lit' }); i++;
    } else return null;
    while (i < b) {
      const s = toks[i];
      if ((s.value === '.' || s.value === '?.') && toks[i + 1]?.type === 'word') { chain.push({ k: 'prop', name: toks[i + 1].value }); i += 2; continue; }
      if (s.value === '?.') { i++; continue; }
      if (s.value === '(' || s.value === '[') {
        const close = matchIndex(toks, i);
        if (close < 0 || close >= b) return null;
        const inner = textOf(src, toks, i + 1, close);
        chain.push(s.value === '(' ? { k: 'call', args: splitTopLevel(src, toks, i + 1, close, ','), text: inner } : { k: 'index', text: inner });
        i = close + 1;
        continue;
      }
      return null;
    }
    return chain;
  }

  function chainSafe(src, toks, a, b, kind, seen) {
    const chain = parseChain(src, toks, a, b);
    if (!chain) return false;
    const [head, second] = chain;
    const last = chain[chain.length - 1];
    const beforeLast = chain[chain.length - 2];

    if (head.k === 'id' && chain.length === 2 && second.k === 'call') {
      if (kind === 'html') {
        if (Object.hasOwn(SAFE_HTML_CALLS, head.name) || htmlBuilders.has(head.name)) return true;
        if (['Number', 'parseInt', 'parseFloat', 'Boolean'].includes(head.name)) return true;
      } else if (Object.hasOwn(SAFE_URL_CALLS, head.name) || urlBuilders.has(head.name)) {
        return true;
      }
      return false;
    }
    if (kind !== 'html') return false;
    if (head.k === 'id' && head.name === 'Math' && chain.length === 3 && second.k === 'prop' && last.k === 'call') return true;
    if (last.k === 'call' && beforeLast?.k === 'prop' && beforeLast.name === 'toFixed') return true;
    if (last.k === 'call' && beforeLast?.k === 'prop' && beforeLast.name === 'join') {
      const sepOk = last.args.length === 0 || safe(last.args[0], 'html', seen);
      return sepOk && arraySafe(chain.slice(0, -2), seen);
    }
    if (head.k === 'group' && chain.length === 1) return safe(head.text, kind, seen);
    return false;
  }

  function arraySafe(chain, seen) {
    if (chain.length === 0) return false;
    const last = chain[chain.length - 1];
    const beforeLast = chain[chain.length - 2];
    if (chain.length === 1 && chain[0].k === 'array') {
      return chain[0].elems.every(e => !e.trim().startsWith('...') && safe(e, 'html', seen));
    }
    if (chain.length === 1 && chain[0].k === 'id') return arrayIdentSafe(chain[0].name, seen);
    if (last.k === 'call' && beforeLast?.k === 'prop') {
      if (beforeLast.name === 'map') return last.args.length >= 1 && callbackSafe(last.args[0], 'html', seen);
      if (['filter', 'slice', 'reverse', 'sort'].includes(beforeLast.name)) return arraySafe(chain.slice(0, -2), seen);
    }
    return false;
  }

  function arrayIdentSafe(name, seen) {
    if (facts.tainted.has(name) || facts.mutated.has(name)) return false;
    const key = `array:${name}`;
    if (seen.has(key)) return true;
    const next = new Set(seen).add(key);
    const assigns = facts.assignments.get(name) || [];
    if (!assigns.length) return false;
    for (const { rhs, op } of assigns) {
      if (op !== '=') return false;
      const toks = tokensWithDepth(rhs);
      const chain = toks.length ? parseChain(rhs, toks, 0, toks.length) : null;
      if (!chain || !arraySafe(chain, next)) return false;
    }
    return (facts.pushes.get(name) || []).every(arg => safe(arg, 'html', next));
  }

  // An arrow or function expression whose results are all safe.
  function callbackSafe(text, kind, seen) {
    const toks = tokensWithDepth(text);
    const arrow = toks.findIndex(t => t.value === '=>' && t.depth === 0);
    let body;
    if (arrow >= 0) {
      body = text.slice(toks[arrow + 1].start).trim();
    } else if (toks[0]?.value === 'function' || (toks[0]?.value === 'async' && toks[1]?.value === 'function')) {
      const open = toks.findIndex(t => t.value === '{' && t.depth === 0);
      body = text.slice(toks[open].start).trim();
    } else {
      return false;
    }
    if (body.startsWith('{')) return returnsSafe(body, kind, seen);
    return safe(body, kind, seen);
  }

  // Every `return` in a block (nested functions included, which only errs
  // toward flagging).
  function returnsSafe(body, kind, seen) {
    const toks = tokensWithDepth(body);
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'word' || toks[i].value !== 'return') continue;
      const n = toks[i + 1];
      if (!n || (n.type === 'punct' && (n.value === ';' || n.value === '}'))) continue;
      const end = expressionEnd(toks, i + 1);
      if (!safe(textOf(body, toks, i + 1, end), kind, seen)) return false;
    }
    return true;
  }

  function identSafe(name, kind, seen) {
    if (facts.tainted.has(name)) return false;
    const key = `${kind}:${name}`;
    if (seen.has(key)) return true; // co-inductive: every assignment is checked
    const next = new Set(seen).add(key);
    const assigns = facts.assignments.get(name) || [];
    if (!assigns.length) return false;
    return assigns.every(({ rhs, op }) => (kind === 'url' && op === '+=' ? false : safe(rhs, kind, next)));
  }

  function builderSafe(name, kind) {
    if (facts.functions.has(name)) return returnsSafe(facts.functions.get(name), kind, new Set());
    const assigns = facts.assignments.get(name) || [];
    return assigns.length > 0 && assigns.every(({ rhs }) => callbackSafe(rhs, kind, new Set()));
  }

  return { safe, builderSafe };
}

// ── Scan ─────────────────────────────────────────────────────────────────────

const FORBIDDEN_APIS = ['DOMParser', 'createContextualFragment', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'srcdoc'];
// Attribute names (markup and setAttribute) and DOM properties that load a URL.
const URL_ATTRS = ['src', 'href', 'srcset', 'action', 'formaction', 'poster', 'data'];
const URL_PROPS = ['src', 'href', 'srcset', 'action', 'formAction', 'poster'];
const INLINE_HANDLER = /<[^>]*\son[a-z]+\s*=/i;

function scanSource(file, src) {
  const facts = collectFacts(src);
  const judge = makeJudge(file, facts);
  const violations = [];
  const sinks = { html: 0, url: 0, templates: 0 };
  const report = (pos, msg, text) => violations.push(`${file}:${lineOf(src, pos)}: ${msg}: ${String(text).replace(/\s+/g, ' ').trim().slice(0, 160)}`);

  // Rule 1a: every template with markup.
  for (const tpl of facts.templates) {
    const quasis = tpl.quasis.join('');
    if (!/<\/?[a-zA-Z!]/.test(quasis)) continue;
    sinks.templates++;
    if (INLINE_HANDLER.test(quasis) || /javascript:/i.test(quasis)) report(tpl.start, 'inline handler or javascript: URL in markup', quasis);
    tpl.exprs.forEach((e, idx) => {
      const text = src.slice(e.start, e.end);
      const before = tpl.quasis[idx];
      const urlAttr = new RegExp(`\\s(?:${URL_ATTRS.join('|')})\\s*=\\s*["']?$`, 'i').test(before);
      if (urlAttr && !/^\s*escapeHtml\(\s*safeHttpsUrl\(/.test(text)) report(e.start, 'URL attribute needs escapeHtml(safeHttpsUrl(...))', text);
      else if (!judge.safe(text, 'html')) report(e.start, 'unescaped interpolation in HTML template', text);
    });
  }

  for (const toks of facts.contexts) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const prev = toks[i - 1];
      const next = toks[i + 1];
      // Rule 3: markup in plain strings.
      if (t.type === 'str' && (INLINE_HANDLER.test(t.value) || /javascript:/i.test(t.value))) report(t.start, 'inline handler or javascript: URL in markup', t.value);
      if (t.type === 'word' && FORBIDDEN_APIS.includes(t.value)) {
        report(t.start, `${t.value} is not allowed in renderer code`, t.value);
      }
      if (t.type === 'word' && t.value === 'createElement' && next?.value === '(' && toks[i + 2]?.type === 'str'
          && /^['"](script|iframe|frame|object|embed|base|meta)['"]$/i.test(toks[i + 2].value)) {
        report(t.start, 'creating this element is not allowed in renderer code', toks[i + 2].value);
      }
      if (t.type === 'word' && t.value === 'write' && prev?.value === '.' && toks[i - 2]?.value === 'document') report(t.start, 'document.write is not allowed', 'document.write');
      if (t.type === 'word' && t.value === 'writeln' && prev?.value === '.' && toks[i - 2]?.value === 'document') report(t.start, 'document.writeln is not allowed', 'document.writeln');

      // Rule 1b: innerHTML / outerHTML assignments.
      if (t.type === 'word' && (t.value === 'innerHTML' || t.value === 'outerHTML') && prev?.value === '.' && next && ['=', '+='].includes(next.value)) {
        sinks.html++;
        const end = expressionEnd(toks, i + 2);
        const rhs = textOf(src, toks, i + 2, end);
        if (!judge.safe(rhs, 'html')) report(t.start, `unsafe value assigned to ${t.value}`, rhs);
      }
      // Rule 1c: insertAdjacentHTML(position, html).
      if (t.type === 'word' && t.value === 'insertAdjacentHTML' && next?.value === '(') {
        sinks.html++;
        const close = matchIndex(toks, i + 1);
        const args = splitTopLevel(src, toks, i + 2, close, ',');
        if (args.length < 2 || !judge.safe(args[1], 'html')) report(t.start, 'unsafe value passed to insertAdjacentHTML', args[1] || '');
      }
      // Rule 2: URL sinks.
      if (t.type === 'word' && URL_PROPS.includes(t.value) && prev?.value === '.' && next?.value === '=') {
        sinks.url++;
        const end = expressionEnd(toks, i + 2);
        const rhs = textOf(src, toks, i + 2, end);
        if (!judge.safe(rhs, 'url')) report(t.start, `unvalidated URL assigned to .${t.value}`, rhs);
      }
      if (t.type === 'word' && t.value === 'setAttribute' && next?.value === '(') {
        const close = matchIndex(toks, i + 1);
        const args = splitTopLevel(src, toks, i + 2, close, ',');
        const nameTok = toks[i + 2];
        const attr = nameTok?.type === 'str' ? nameTok.value.slice(1, -1).toLowerCase() : null;
        if (attr === null) report(t.start, 'setAttribute with a computed name', args[0] || '');
        else if (/^on/.test(attr)) report(t.start, 'inline event handler attribute', attr);
        else if (URL_ATTRS.includes(attr) || attr === 'srcdoc') {
          sinks.url++;
          if (attr === 'srcdoc' || !judge.safe(args[1] || '', 'url')) report(t.start, `unvalidated URL in setAttribute('${attr}')`, args[1] || '');
        }
      }
      if (t.type === 'word' && t.value === 'open' && prev?.value === '.' && toks[i - 2]?.value === 'window' && next?.value === '(') {
        sinks.url++;
        const close = matchIndex(toks, i + 1);
        const args = splitTopLevel(src, toks, i + 2, close, ',');
        if (!judge.safe(args[0] || '', 'url')) report(t.start, 'unvalidated URL passed to window.open', args[0] || '');
      }
    }
  }

  // Builders and allowlisted expressions must exist and hold up.
  for (const name of HTML_BUILDERS[file] || []) {
    if (!facts.functions.has(name) && !facts.assignments.has(name)) report(0, 'allowlisted HTML builder not found', name);
    else if (!judge.builderSafe(name, 'html')) report(0, 'HTML builder returns an unsafe value', name);
  }
  for (const name of URL_BUILDERS[file] || []) {
    if (!facts.functions.has(name) && !facts.assignments.has(name)) report(0, 'allowlisted URL builder not found', name);
    else if (!judge.builderSafe(name, 'url')) report(0, 'URL builder returns an unvalidated value', name);
  }
  for (const expr of Object.keys(ALLOWED_EXPRESSIONS[file] || {})) {
    const used = facts.templates.some(tpl => tpl.exprs.some(e => src.slice(e.start, e.end).replace(/\s+/g, ' ').trim() === expr));
    if (!used) report(0, 'stale ALLOWED_EXPRESSIONS entry', expr);
  }
  return { violations, sinks };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('renderer code: every HTML and URL sink is escaped or validated', () => {
  const all = [];
  const totals = { html: 0, url: 0, templates: 0 };
  for (const file of FILES) {
    const { violations, sinks } = scanSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    all.push(...violations);
    for (const k of Object.keys(totals)) totals[k] += sinks[k];
  }
  assert.deepEqual(all, []);
  // Not vacuous: the scan really walked the renderer's sinks.
  assert.ok(totals.html >= 50, `expected >= 50 innerHTML sinks, saw ${totals.html}`);
  assert.ok(totals.templates >= 40, `expected >= 40 markup templates, saw ${totals.templates}`);
  assert.ok(totals.url >= 4, `expected >= 4 URL sinks, saw ${totals.url}`);
});

test('allowlist entries point at files that exist in the scan', () => {
  for (const file of [...Object.keys(HTML_BUILDERS), ...Object.keys(URL_BUILDERS), ...Object.keys(ALLOWED_EXPRESSIONS)]) {
    assert.ok(FILES.includes(file), `${file} is allowlisted but not scanned`);
  }
});

test('allowlisted helpers stay safe under hostile input', async () => {
  const s = await import(pathToFileURL(path.join(ROOT, 'src/state.js')).href);
  const hostile = [
    '<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "' onmouseover='x", '&amp;', '',
    null, undefined, 0, -1, 1e9, NaN, Infinity, {}, [], ['<b>'], { toString: () => '<b>' },
    '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'twitch', 'KICK', 'YouTube', 'rumble',
  ];
  const svgs = new Set(['', ...s.PLATFORMS.map(p => s.getPlatformSVG(p))]);
  for (const svg of svgs) assert.doesNotMatch(svg, /\son[a-z]+=|<script|javascript:/i);
  for (const v of hostile) {
    assert.doesNotMatch(s.escapeHtml(v), /[<>"']/);
    assert.ok(svgs.has(s.getPlatformSVG(v)), `getPlatformSVG(${String(v)})`);
    assert.doesNotMatch(String(s.fmtDuration(v)), /[<>"'&]/);
    assert.match(String(s.formatViewerCount(v)), /^-?[\d.e+]+[KM]?$|^-?Infinity[KM]?$/);
    assert.match(s.platformColorVar(v), /^var\(--[a-z]+-(?:color|muted)\)$/);
  }
});

// The guard must actually catch the bug classes it exists for.
test('guard self-test: flags every known-bad pattern', () => {
  const bad = {
    'raw data in text': 'el.innerHTML = `<b>${clip.title}</b>`;',
    'attribute breakout': 'el.innerHTML = `<div title="${title}">x</div>`; const title = clip.title;',
    'parameter shadows a safe const': "const u = 'x'; function f(u) { el.innerHTML = `<i>${u}</i>`; }",
    'const from data': 'const h = s.category; el.innerHTML = `<p>${h}</p>`;',
    'let reassigned from data': "let h = ''; h = s.category; el.innerHTML = `<p>${h}</p>`;",
    'append from data': "let h = ''; h += s.title; el.innerHTML = h;",
    'map without escaping': "el.innerHTML = list.map(x => `<li>${x}</li>`).join('');",
    'map block without escaping': "const rows = list.map(x => { return `<li>${x.name}</li>`; }).join(''); el.innerHTML = rows;",
    'pushed data': "const parts = []; parts.push(s.title); el.innerHTML = `<p>${parts.join('')}</p>`;",
    'indexed array write': "const parts = []; parts[0] = s.title; el.innerHTML = `<p>${parts.join('')}</p>`;",
    'nested template': "el.innerHTML = `<p>${ok ? `Error: ${err}` : ''}</p>`;",
    'ternary data branch': "el.innerHTML = `<p>${ok ? s.title : 'none'}</p>`;",
    'non-template sink': 'el.innerHTML = stream.title;',
    'plus concatenation': "el.innerHTML = '<p>' + s.title + '</p>';",
    'insertAdjacentHTML': "el.insertAdjacentHTML('beforeend', `<p>${s.title}</p>`);",
    'outerHTML': 'el.outerHTML = `<p>${s.title}</p>`;',
    'inline handler': "el.innerHTML = '<img src=x onerror=\"go()\">';",
    'inline handler in template': 'el.innerHTML = `<button onclick="go()">x</button>`;',
    'javascript: URL': "el.innerHTML = '<a href=\"javascript:go()\">x</a>';",
    'DOMParser': 'const d = new DOMParser();',
    'document.write': 'document.write(x);',
    'img src from data': 'img.src = clip.thumbnailURL;',
    'setAttribute src from data': "wv.setAttribute('src', url);",
    'setAttribute inline handler': "el.setAttribute('onclick', 'x()');",
    'window.open from data': "window.open(clip.url, '_blank');",
    'URL attribute escaped but unvalidated': 'el.innerHTML = `<img src="${escapeHtml(u)}">`;',
    'length is not a number': 'el.innerHTML = `<p>${obj.length}</p>`;',
    'toLocaleString keeps strings': 'el.innerHTML = `<p>${s.title.toLocaleString()}</p>`;',
    'destructured name': 'const { title } = clip; el.innerHTML = `<p>${title}</p>`;',
    'catch binding': 'try { x(); } catch (msg) { el.innerHTML = `<p>${msg}</p>`; }',
    'for-of binding': 'for (const name of names) { el.innerHTML = `<p>${name}</p>`; }',
    'imported name': "import { label } from './x.js'; el.innerHTML = `<p>${label}</p>`;",
    'unknown global': 'el.innerHTML = `<p>${someGlobal}</p>`;',
    'window.name style global': 'el.innerHTML = `<p>${name}</p>`;',
    'destructuring assignment': "let label = ''; ({ label } = clip); el.innerHTML = `<p>${label}</p>`;",
    'array destructuring assignment': "let a = '', b = ''; [a, b] = pair; el.innerHTML = `<p>${a}</p>`;",
    'script element': "const s = document.createElement('script');",
    'function source': 'function label() {} el.innerHTML = `<p>${label}</p>`;',
  };
  for (const [name, src] of Object.entries(bad)) {
    const { violations } = scanSource('fixture.js', src);
    assert.ok(violations.length > 0, `not flagged: ${name}`);
  }
});

test('guard self-test: accepts the safe forms it documents', () => {
  const good = {
    escaped: 'el.innerHTML = `<b>${escapeHtml(clip.title)}</b>`;',
    'escaped attribute': 'el.innerHTML = `<div title="${escapeHtml(t)}">x</div>`;',
    'safe helpers': 'el.innerHTML = `<i>${getPlatformSVG(p)}${fmtDuration(m)}${formatViewerCount(v)}</i>`;',
    'literal ternary': "el.innerHTML = `<p class=\"${open ? 'on' : 'off'}\">x</p>`;",
    'const of literals': "const cls = a ? 'x' : b ? 'y' : 'z'; el.innerHTML = `<p class=\"${cls}\"></p>`;",
    'numeric maths': 'const pct = (a / b) * 100; el.innerHTML = `<p style="width: ${pct}%">${pct.toFixed(0)}</p>`;',
    'map with escaping': "el.innerHTML = list.map(x => `<li>${escapeHtml(x)}</li>`).join('');",
    'safe pushes': "const parts = []; parts.push(`<b>${escapeHtml(a)}</b>`); el.innerHTML = `<p>${parts.join('')}</p>`;",
    'static constant': "const ICON = '<svg></svg>'; el.innerHTML = ICON;",
    'validated src': 'const u = safeHttpsUrl(x, HOSTS); if (u) img.src = u;',
    'validated setAttribute': "wv.setAttribute('src', safeHttpsUrl(x, HOSTS));",
    'relative href': "link.href = 'style.css';",
    'textContent is not a sink': 'el.textContent = clip.title;',
  };
  for (const [name, src] of Object.entries(good)) {
    const { violations } = scanSource('fixture.js', src);
    assert.deepEqual(violations, [], `wrongly flagged: ${name}`);
  }
});

test('guard self-test: builders are verified, not trusted', () => {
  HTML_BUILDERS['fixture.js'] = ['card'];
  URL_BUILDERS['fixture.js'] = ['thumb'];
  try {
    const unsafe = scanSource('fixture.js', 'function card(t) { return `<p>${t}</p>`; } function thumb(c) { return c.url; } el.innerHTML = card(x);');
    assert.ok(unsafe.violations.some(v => v.includes('HTML builder returns an unsafe value')));
    assert.ok(unsafe.violations.some(v => v.includes('URL builder returns an unvalidated value')));
    const safeSrc = scanSource('fixture.js', 'function card(t) { return `<p>${escapeHtml(t)}</p>`; } function thumb(c) { return safeHttpsUrl(c.url, H); } el.innerHTML = card(x); img.src = thumb(c);');
    assert.deepEqual(safeSrc.violations, []);
  } finally {
    delete HTML_BUILDERS['fixture.js'];
    delete URL_BUILDERS['fixture.js'];
  }
});
