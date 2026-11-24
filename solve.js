// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Written from the makefun-site README + reference behaviour: same answers,
// byte for byte, on every input. No dependencies, no I/O, no randomness.
//
// Speed notes (all per run() call; nothing is kept from one case to the next):
// - escapeHtml: one regex test for the common no-specials case, else native
//   bulk replaces instead of a per-character callback.
// - slugify: ASCII fast path (no normalize/regex) + a per-case cache, since
//   the same titles/tags are slugified several times per build.
// - Markdown: blocks render straight to a string array (no token objects),
//   and inline rendering accumulates literal runs and escapes them in bulk
//   instead of escaping one character at a time.
// - Templates: rendering pushes into one array (joined once), loop frames are
//   allocated once per loop execution and mutated per iteration, and every
//   page render shares one root scope instead of spreading a fresh object.

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/g;

/**
 * `text` with & < > " and ' escaped. One native scan; a text with no special
 * is returned as it is. (Never called re-entrantly, so the shared regex is safe.)
 */
export function escapeHtml(text) {
  HAS_SPECIAL.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  let found = false;
  while ((m = HAS_SPECIAL.exec(text)) !== null) {
    found = true;
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (!found) return text;
  return out + text.slice(last);
}

const NON_ASCII = /[^\x00-\x7F]/;
const SLUG_MAX = 64;

/** Slug core for a string with no non-ASCII code unit (NFKD is the identity there). */
function slugifyAscii(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    let keep = -1;
    if (ch >= 65 && ch <= 90) keep = ch + 32;
    else if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)) keep = ch;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** Slug core for a string with non-ASCII: NFKD, combining marks dropped, as the reference. */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const HAS_INLINE_SPECIAL = /[\\`*[]/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankSpaces(line);
  if (c0 === 96) return line.startsWith('```') && FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** A line of only spaces and tabs (BLANK, for a non-empty line). */
function isBlankSpaces(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text (`- ` / `* `), or null. */
function bulletItem(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item ({ num, text }), or null: 1-9 digits, `. `, then text. */
function orderedItem(line) {
  let j = 0;
  while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

const trimLine = (line) => {
  if (line === '') return line;
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(line.length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
};

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A match at j is escaped exactly when the run of `\` immediately before j (from `from`) is odd:
 * the scan pairs backslashes left to right, so an odd run leaves its last `\` paired with what[0]
 * (an escapable character at both call sites), and an even run leaves j visited. */
function findUnescaped(s, what, from) {
  let start = from;
  for (;;) {
    const j = s.indexOf(what, start);
    if (j === -1) return -1;
    let run = 0;
    for (let k = j - 1; k >= start && s.charCodeAt(k) === 92; k--) run++;
    if ((run & 1) === 0) return j;
    start = j + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let start = from;
  for (;;) {
    const j = s.indexOf('*', start);
    if (j === -1) return -1;
    let run = 0;
    for (let k = j - 1; k >= start && s.charCodeAt(k) === 92; k--) run++;
    if ((run & 1) === 1) {
      start = j + 1;
      continue;
    }
    if (s[j + 1] === '*') {
      start = j + 2;
      continue;
    }
    return j;
  }
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Literal runs are
 * accumulated and escaped in bulk; only markup boundaries flush them.
 */
function inline(s, env) {
  if (!HAS_INLINE_SPECIAL.test(s)) return escapeHtml(s);
  let out = '';
  let lit = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > lit) out += escapeHtml(s.slice(lit, i));
      // `>` is the one escapable character that HTML-escapes; the rest are as written.
      out += s[i + 1] === '>' ? '&gt;' : s[i + 1];
      i += 2;
      lit = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > lit) out += escapeHtml(s.slice(lit, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > lit) out += escapeHtml(s.slice(lit, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          lit = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > lit) out += escapeHtml(s.slice(lit, i));
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > lit) out += escapeHtml(s.slice(lit, i));
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        lit = i;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  if (n > lit) out += escapeHtml(s.slice(lit, n));
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (level 2/3 headings) and its
 * excerpt (the first paragraph's inline HTML, or ""). `slugify` is the build's
 * cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const len = lines.length;
  while (i < len) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankSpaces(line)) {
        i++;
        continue;
      }
      // A line opening on a space/tab is a paragraph line: no block opens there.
    } else if (c0 === 96) {
      // '`': only a fence can open here.
      if (line.startsWith('```')) {
        const fence = FENCE_OPEN.exec(line);
        if (fence !== null) {
          const body = [];
          i++;
          while (i < len) {
            const l = lines[i];
            if (l.charCodeAt(0) === 96 && FENCE_CLOSE.test(l)) break;
            body.push(l);
            i++;
          }
          i++;
          const cls = fence[1] === '' ? '' : ` class="language-${fence[1]}"`;
          const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
          blocks.push(`<pre><code${cls}>${code}</code></pre>`);
          continue;
        }
      }
    } else if (c0 === 35) {
      // '#': only a heading can open here.
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      // '-' / '*': a thematic break or a bullet list can open here.
      if (HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const item = bulletItem(line);
      if (item !== null) {
        const items = [trimLine(item)];
        i++;
        while (i < len) {
          const l = lines[i];
          const m = bulletItem(l);
          if (m !== null) {
            items.push(trimLine(m));
            i++;
          } else if (l.charCodeAt(0) === 32 && CONTINUED.test(l)) {
            items[items.length - 1] += `\n${trimLine(l)}`;
            i++;
          } else break;
        }
        let listHtml = '<ul>\n';
        for (let k = 0; k < items.length; k++) listHtml += `<li>${inline(items[k], env)}</li>\n`;
        listHtml += '</ul>';
        blocks.push(listHtml);
        continue;
      }
    } else if (c0 === 62) {
      // '>': a blockquote.
      const inner = [];
      while (i < len && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const stripped = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(stripped);
        if (t !== '') inner.push(t);
      }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      // A digit: only an ordered list can open here.
      const o = orderedItem(line);
      if (o !== null) {
        const start = o.num;
        const items = [trimLine(o.text)];
        i++;
        while (i < len) {
          const l = lines[i];
          const m = orderedItem(l);
          if (m !== null) {
            items.push(trimLine(m.text));
            i++;
          } else if (l.charCodeAt(0) === 32 && CONTINUED.test(l)) {
            items[items.length - 1] += `\n${trimLine(l)}`;
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let listHtml = `${open}\n`;
        for (let k = 0; k < items.length; k++) listHtml += `<li>${inline(items[k], env)}</li>\n`;
        listHtml += '</ol>';
        blocks.push(listHtml);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < len && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `tctx` holds the parsed
 * templates, their external names, the render cache and its kinds; `depth` is the
 * include depth. Loop frames are allocated once per loop execution and mutated per iteration.
 */
function renderNodes(nodes, scope, tctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, tctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const fvars = {};
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        fvars[n.name] = xs[0];
        fvars.loop = loop;
        const frame = { vars: fvars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          if (k !== 0) {
            fvars[n.name] = xs[k];
            loop.index = k + 1;
            loop.first = false;
            loop.last = k === xs.length - 1;
          }
          renderNodes(n.body, frame, tctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = tctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const ck = tctx.kinds.get(n.name);
        if (ck === undefined) {
          renderNodes(t, scope, tctx, depth + 1, out);
          break;
        }
        // A cached render is valid only when no frame above the root binds a
        // root name this template reads (a loop var named `site` would win).
        const extSet = tctx.ext.get(n.name);
        let shadowed = false;
        for (let s2 = scope; s2 !== null && s2.parent !== null; s2 = s2.parent) {
          for (const rn of ROOT_NAMES) {
            if (extSet.has(rn) && Object.hasOwn(s2.vars, rn)) {
              shadowed = true;
              break;
            }
          }
          if (shadowed) break;
        }
        if (shadowed) {
          renderNodes(t, scope, tctx, depth + 1, out);
          break;
        }
        const nextDepth = depth + 1;
        if (ck.kind === 'const') {
          let byDepth = tctx.constCache.get(n.name);
          if (byDepth === undefined) {
            byDepth = new Map();
            tctx.constCache.set(n.name, byDepth);
          }
          let html = byDepth.get(nextDepth);
          if (html === undefined) {
            const tmp = [];
            renderNodes(t, scope, tctx, nextDepth, tmp);
            html = tmp.join('');
            byDepth.set(nextDepth, html);
          }
          out.push(html);
        } else {
          const keyVal = lookup(scope, [ck.name]);
          let byKey = tctx.keyedCache.get(n.name);
          if (byKey === undefined) {
            byKey = new Map();
            tctx.keyedCache.set(n.name, byKey);
          }
          let byDepth = byKey.get(keyVal);
          if (byDepth === undefined) {
            byDepth = new Map();
            byKey.set(keyVal, byDepth);
          }
          let html = byDepth.get(nextDepth);
          if (html === undefined) {
            const tmp = [];
            renderNodes(t, scope, tctx, nextDepth, tmp);
            html = tmp.join('');
            byDepth.set(nextDepth, html);
          }
          out.push(html);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template render cache

/** The names bound once per case at the root scope. */
const ROOT_NAMES = new Set(['site', 'tags', 'recent']);

/**
 * Each template's external first-names: names its nodes (and, transitively, its
 * includes') read that no enclosing `for` of the same template binds. Computed
 * to a fixpoint over the include graph (cycles included).
 */
function computeExternals(templates) {
  const info = new Map();
  for (const [name, nodes] of templates) {
    const own = new Set();
    const incs = [];
    const walk = (ns, bound) => {
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        if (n.kind === 'text') continue;
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) own.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) own.add(n.path[0]);
          if (n.then) walk(n.then, bound);
          if (n.else) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) own.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          incs.push({ name: n.name, bound: new Set(bound) });
        }
      }
    };
    walk(nodes, new Set());
    info.set(name, { own, incs });
  }
  const ext = new Map();
  for (const name of templates.keys()) ext.set(name, new Set(info.get(name).own));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, { incs }] of info) {
      const s = ext.get(name);
      for (let i = 0; i < incs.length; i++) {
        const e = ext.get(incs[i].name);
        if (e === undefined) continue;
        for (const x of e) {
          if (!incs[i].bound.has(x) && !s.has(x)) {
            s.add(x);
            changed = true;
          }
        }
      }
    }
  }
  return ext;
}

/**
 * How a template's render may be cached: `const` when it reads only root names,
 * `keyed` when it reads root names plus exactly one other name (never `loop`),
 * else null. The cached value is keyed by that one name's resolved value.
 */
function cacheKindOf(extSet) {
  let keyed = null;
  for (const x of extSet) {
    if (ROOT_NAMES.has(x)) continue;
    if (x === 'loop') return null;
    if (keyed === null) keyed = x;
    else if (keyed !== x) return null;
  }
  return keyed === null ? { kind: 'const' } : { kind: 'keyed', name: keyed };
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. All caches live in this call only. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = NON_ASCII.test(text) ? slugifyUnicode(text) : slugifyAscii(text);
      slugCache.set(text, v);
    }
    return v;
  };

  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const ext = computeExternals(templates);
  const kinds = new Map();
  for (const [name, set] of ext) {
    const k = cacheKindOf(set);
    if (k !== null) kinds.set(name, k);
  }
  // Per-case render cache for includes (nothing is kept from one case to the next).
  const tctx = { templates, ext, kinds, constCache: new Map(), keyedCache: new Map() };

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, in code-unit order of their paths; a non-.md file is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < b.statics.length; i++) staticPaths.add(b.statics[i].path);
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (target.startsWith('/') || target.startsWith('#')) return target;
        const colon = target.indexOf(':');
        if (colon > 0) {
          const first = target.charCodeAt(0);
          const isLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
          if (isLetter) {
            let ok = true;
            for (let k = 1; k < colon; k++) {
              const c = target.charCodeAt(k);
              if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) {
                ok = false;
                break;
              }
            }
            if (ok) return target;
          }
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; each post's neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, named as first met walking the posts in order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const tags = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let i = 0; i < b.posts.length; i++) {
    const p = b.posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    if (!s.post) {
      const names2 = ownTags(s);
      s.tagRefs = new Array(names2.length);
      for (let j = 0; j < names2.length; j++) {
        const name = names2[j];
        const slug = slugify(name);
        s.tagRefs[j] = bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      }
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  const pageOf = (s) => {
    // The base card is built once per source (its reading_minutes costs a scan);
    // the page object is a fresh copy of it, as the reference's spread is.
    const card = { ...(s.card ?? (s.card = cardOf(s))) };
    card.slug = s.slug;
    card.content = s.html;
    card.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    card.newer = linkOf(s.newer ?? null);
    card.older = linkOf(s.older ?? null);
    card.is_post = s.post;
    return card;
  };

  // 7. Layouts: every page through its layout, the index and tag pages through theirs.
  for (let i = 0; i < b.posts.length; i++) {
    const p = b.posts[i];
    b.cards.set(p, p.card ?? (p.card = cardOf(p)));
  }
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const EMPTY_VARS = {};
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, tctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) },
    });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', EMPTY_VARS);
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < b.statics.length; i++) {
    const f = b.statics[i];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < b.sources.length; i++) if (!b.sources[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}
