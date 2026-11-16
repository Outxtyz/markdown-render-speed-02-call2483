// parse.js — a fast Markdown parser whose output matches marked 18.1.3
// (GFM on, breaks off) byte for byte. Written from scratch for the
// markdown-render-speed-02 bounty: a block lexer that turns the source into
// block tokens, an inline lexer that turns leaf text into HTML, and a small
// renderer. No dependencies, no network, no use of marked itself.

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML characters. With encode=true every & becomes &amp; (code, href
// of autolinks, fenced-code language). With encode=false an & that already
// starts a valid character/entity reference is left alone.
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_NOENC_RE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s, encode) {
  if (encode) return s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0 ? s : s.replace(ESCAPE_RE, c => ESCAPE_MAP[c]);
  return s.replace(ESCAPE_NOENC_RE, c => ESCAPE_MAP[c]);
}

// Decode numeric character references (&#65; &#x41;) and turn a bare & that
// is not part of a reference into &amp;. Named references are left alone.
const NUMREF_RE = /&(?:#(\d{1,7})|#[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescape(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(NUMREF_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function encURI(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}

// Unescape a backslash before a punctuation character (any Unicode P/S,
// including ~ — marked's anyPunctuation does not exclude it).
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return s.indexOf('\\') < 0 ? s : s.replace(ANY_PUNCT_RE, '$1');
}

// Link label normalisation: trim, collapse inner whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing characters equal to `ch` (or, with invert, trailing chars
// different from `ch`) — mirrors the "trim the end of a raw match" step.
function stripEnd(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Expand tabs to spaces, tracking the visual column (a tab jumps to the next
// multiple of 4). Used when a marker consumed part of a line's indentation.
function expandTabs(s, col) {
  let out = '', c = col;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\t') { const n = 4 - (c % 4); out += ' '.repeat(n); c += n; }
    else { out += s[i]; c++; }
  }
  return out;
}

// Split a table row on unescaped pipes (a \| stays a literal pipe), trimming
// a leading/trailing empty cell from outer pipes, and pad/truncate to `cols`.
function splitRow(row, cols) {
  const cells = [];
  let cur = '', i = 0, n = row.length;
  while (i < n) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < n && row[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  if (cols !== undefined) {
    if (cells.length > cols) cells.length = cols;
    while (cells.length < cols) cells.push('');
  }
  return cells;
}

// Index of the unmatched closing paren in `s`, skipping backslash escapes.
// -1 when there is none, -2 when parens are left open.
function closingParen(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// ---------------------------------------------------------------------------
// block lexer
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp(`^(?:${BLOCK_TAGS})$`, 'i');

// Strip trailing blank lines the way a block's raw match is trimmed: if the
// text ends with at most one blank line keep it, else drop all trailing
// blank lines.
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  lex(src) {
    src = src.replace(/\r\n?/g, '\n');
    this.blockTokens(src, this.tokens, false);
    for (let q = 0; q < this.inlineQueue.length; q++) {
      const item = this.inlineQueue[q];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue inline parsing of `src` into `tokens` (filled in by lex() later).
  inline(src, tokens) {
    tokens = tokens || [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  // Fill a queued token array with the inline nodes for `src`. The link
  // state (whether we are inside an <a>) is shared across queue items:
  // marked resets inRawBlock per paragraph but NOT inLink, so an unclosed
  // <a> suppresses GFM autolinks for the rest of the document.
  inlineTokens(src, tokens) {
    const nodes = parseInline(src, this.tokens.links, this.state);
    for (let k = 0; k < nodes.length; k++) tokens.push(nodes[k]);
    return tokens;
  }

  // Lex block tokens out of `src` into `arr`. `inside` is true when lexing
  // the contents of a blockquote (paragraphs merge across chunks); `top`
  // decides whether leaf text becomes paragraph tokens (top-level and
  // blockquote contents) or bare text tokens (list item contents).
  blockTokens(src, arr, inside, top) {
    top = top === undefined ? true : top;
    let pos = 0;
    const end = src.length;
    const prevTop = this.state.top;
    this.state.top = top;
    while (pos < end) {
      const rest = src.slice(pos);
      let m, tok;
      // blank lines
      if ((m = /^[ \t]*(?:\n|$)/.exec(rest)) && m[0].length > 0) {
        // a run of blank lines: a single newline is folded into the previous
        // token's raw, longer runs become a space token (which renders as
        // nothing but marks looseness inside lists)
        const blank = /^(?:[ \t]*(?:\n|$))+/.exec(rest)[0];
        pos += blank.length;
        const prev = arr[arr.length - 1];
        if (blank.length === 1 && prev !== undefined) prev.raw += '\n';
        else if (blank.length > 0) arr.push({ type: 'space', raw: blank });
        continue;
      }
      if ((tok = this.tokIndentedCode(rest))) { pos += tok.raw.length; this.absorbOrPush(arr, tok); continue; }
      if ((tok = this.tokFences(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokHeading(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokHr(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokBlockquote(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokList(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokHtml(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokDef(rest))) {
        pos += tok.raw.length;
        const prev = arr[arr.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!Object.hasOwn(this.tokens.links, tok.tag)) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          arr.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if ((tok = this.tokSetext(rest))) { pos += tok.raw.length; arr.push(tok); continue; }
      if (top) {
        if ((tok = this.tokParagraph(rest))) {
          pos += tok.raw.length;
          const prev = arr[arr.length - 1];
          if (inside && prev && prev.type === 'paragraph') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            prev.text += '\n' + tok.text;
            this.inlineQueue.pop();
            this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
          } else arr.push(tok);
          continue;
        }
      }
      if ((tok = this.tokText(rest))) {
        pos += tok.raw.length;
        const prev = arr[arr.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else arr.push(tok);
        continue;
      }
      // Should not happen: consume one char to guarantee progress.
      pos += 1;
    }
    this.state.top = prevTop;
    return arr;
  }

  // An indented code block that directly follows a paragraph or text token
  // is folded into that token instead of standing alone.
  absorbOrPush(arr, tok) {
    const prev = arr[arr.length - 1];
    if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      prev.text += '\n' + tok.text;
      this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
    } else arr.push(tok);
  }

  tokIndentedCode(src) {
    const m = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/.exec(src);
    if (!m) return null;
    const raw = trimTrailingBlanks(m[0]);
    const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  tokFences(src) {
    const m = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(src);
    if (!m) return null;
    const fence = m[1], ch = fence[0];
    let info = m[2];
    if (ch === '`' && info.indexOf('`') >= 0) return null;
    const afterOpen = m[0].length;
    // find the closing fence: same char, at least as long, only spaces after;
    // the trailing newline is NOT part of the raw (marked's fence regex ends
    // the closing line with a lookahead) — the block loop's space rule folds
    // a lone trailing newline into this token's raw instead
    const closeRe = new RegExp(`^ {0,3}${ch}{${fence.length},} *(?=\\n|$)`, 'm');
    const cm = closeRe.exec(src.slice(afterOpen));
    let content, rawLen;
    if (cm) {
      content = src.slice(afterOpen, afterOpen + cm.index);
      rawLen = afterOpen + cm.index + cm[0].length;
    } else {
      content = src.slice(afterOpen);
      rawLen = src.length;
    }
    if (content.endsWith('\n')) content = content.slice(0, -1);
    // opening-fence indent compensation (backtick fences only)
    const raw = src.slice(0, rawLen);
    const comp = /^(\s+)(?:```)/.exec(raw);
    if (comp) {
      const ind = comp[1].length;
      content = content.split('\n').map(line => {
        const lead = /^\s*/.exec(line)[0];
        return lead ? line.slice(Math.min(lead.length, ind)) : line;
      }).join('\n');
    }
    let lang = '';
    if (info) lang = info.trim().replace(/\\([\p{P}\p{S}])/gu, '$1');
    return { type: 'code', raw, lang, text: content };
  }

  tokHeading(src) {
    const m = /^ {0,3}(#{1,6})(?=[ \t]|\n|$)/.exec(src);
    if (!m) return null;
    const lineEnd = src.indexOf('\n');
    const line = lineEnd < 0 ? src : src.slice(0, lineEnd);
    let text = line.slice(m[0].length).trim();
    if (/#$/.test(text)) {
      const stripped = stripEnd(text, 35); // '#'
      if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
    }
    const raw = lineEnd < 0 ? src : src.slice(0, lineEnd + 1);
    return { type: 'heading', raw: stripEnd(raw, 10), depth: m[1].length, text, tokens: this.inline(text) };
  }

  tokHr(src) {
    const m = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*(?:\n+|$)/.exec(src);
    if (!m) return null;
    return { type: 'hr', raw: stripEnd(m[0], 10) };
  }

  // A setext heading: paragraph lines followed by a === or --- underline.
  // The paragraph part stops at blank lines and at lines that start a list,
  // fence, blockquote, heading, thematic break, html block or table.
  tokSetext(src) {
    const lines = src.split('\n');
    if (lines.length < 2) return null;
    const first = lines[0];
    if (/^[ \t]*$/.test(first)) return null;
    const acc = [first];
    let i = 1, rawLen = first.length + 1;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^[ \t]*$/.test(line)) return null;
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
      if (sm) {
        const text = acc.join('\n').trim();
        const raw = src.slice(0, rawLen + line.length);
        return { type: 'heading', raw: stripEnd(raw, 10), depth: sm[1][0] === '=' ? 1 : 2, text, tokens: this.inline(text) };
      }
      if (this.lineStartsBlock(line, lines[i + 1], true)) return null;
      acc.push(line);
      rawLen += line.length + 1;
    }
    return null;
  }

  // Does `line` start a block that interrupts a paragraph (or a setext
  // paragraph, when `forSetext`)? The table check needs the following line.
  lineStartsBlock(line, nextLine, forSetext) {
    if (/^ {0,3}#{1,6}(?:[ \t]|\n|$)/.test(line)) return true;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
    if (/^ {0,3}>/.test(line)) return true;
    if (/^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line)) return true;
    if (forSetext ? /^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]/.test(line) : /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
    if (this.isHtmlStart(line)) return true;
    if (nextLine !== undefined && this.isTableStart(line, nextLine)) return true;
    return false;
  }

  // A paragraph: lines of text, each continuing while it is non-blank and
  // does not start an interrupting block.
  tokParagraph(src) {
    const lines = src.split('\n');
    const first = lines[0];
    if (/^[ \t]*$/.test(first)) return null;
    const acc = [first];
    let rawLen = first.length;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // a whitespace-only line ends the paragraph, except when it is a real
      // last line (marked's paragraph regex only treats `[ \t]+\n` as a
      // break, so a trailing whitespace-only line with no newline joins);
      // the empty tail produced by a final newline is not a real line
      if (/^[ \t]*$/.test(line) && (i < lines.length - 1 || line === '')) break;
      if (this.lineStartsBlock(line, lines[i + 1], false)) break;
      acc.push(line);
      rawLen += 1 + line.length;
    }
    const text = acc.join('\n');
    return { type: 'paragraph', raw: text, text, tokens: this.inline(text) };
  }

  tokText(src) {
    const m = /^[^\n]+/.exec(src);
    if (!m) return null;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }

  // Is this line the start of an html block (types 1-6)? Used both to open
  // an html block and to interrupt a paragraph.
  isHtmlStart(line) {
    return /^ {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>)|<(?:script|pre|style|textarea)(?:[\s>]|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/i.test(line);
  }

  // Do `header` + `delim` form a table header and delimiter row? The
  // delimiter must contain a : or | and its cell count must match the
  // header's.
  tableParts(header, delim) {
    if (!header || !/^ *[^ ]/.test(header)) return null;
    const dm = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)[ \t]*$/.exec(delim);
    if (!dm || !/[:|]/.test(dm[1])) return null;
    const hCells = splitRow(header.trim());
    const dCells = dm[1].replace(/^\||\| *$/g, '').split('|');
    if (hCells.length !== dCells.length) return null;
    const align = dCells.map(c => /^ *-+: *$/.test(c) ? 'right' : /^ *:-+: *$/.test(c) ? 'center' : /^ *:-+ *$/.test(c) ? 'left' : null);
    return { header: hCells, align };
  }

  isTableStart(header, delim) {
    return this.tableParts(header, delim) !== null;
  }

  tokTable(src) {
    const lines = src.split('\n');
    if (lines.length < 2) return null;
    const parts = this.tableParts(lines[0], lines[1]);
    if (!parts) return null;
    const rows = [];
    let rawLen = lines[0].length + 1 + lines[1].length;
    let i = 2;
    for (; i < lines.length; i++) {
      const line = lines[i];
      // a row ends at a spaces-only line; a tab-only line is NOT blank here
      // (marked's table row regex only excludes ` *\n`), it becomes an
      // empty row
      if (/^ *$/.test(line)) break;
      if (/^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line)) break;
      if (/^ {0,3}#{1,6}(?:[ \t]|\n|$)/.test(line)) break;
      if (/^ {0,3}>/.test(line)) break;
      if (/^(?: {4}| {0,3}\t)[^\n]/.test(line)) break;
      if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) break;
      if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) break;
      if (this.isHtmlStart(line)) break;
      rows.push(splitRow(line, parts.header.length));
      rawLen += 1 + line.length;
    }
    const raw = src.slice(0, rawLen);
    const cell = (s) => ({ text: s, tokens: this.inline(s) });
    return { type: 'table', raw, header: parts.header.map(cell), align: parts.align, rows: rows.map(r => r.map(cell)) };
  }

  // An html block (types 1-7). Types 1-5 run to their closing marker, types
  // 6-7 run to the first blank line.
  tokHtml(src) {
    const lines = src.split('\n');
    const first = lines[0];
    const start = /^ {0,3}/.exec(first)[0].length;
    const rest = first.slice(start);
    let kind = 0, closer = null, closeTag = null;
    let m;
    if ((m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest))) { kind = 1; closeTag = m[1].toLowerCase(); }
    else if (rest.startsWith('<!--')) kind = 2;
    else if (rest.startsWith('<?')) kind = 3;
    else if (/^<![A-Za-z]/.test(rest)) kind = 4;
    else if (rest.startsWith('<![CDATA[')) kind = 5;
    else if ((m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest)) && BLOCK_TAG_RE.test(m[1])) kind = 6;
    else if (/^<[A-Za-z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"\n]*"|\s*=\s*'[^'\n]*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>[ \t]*$/.test(rest) && !/^(?:script|pre|style|textarea)(?![a-z0-9-])/i.test(rest.slice(1)) && !/^<\//.test(rest)) kind = 7;
    else if (/^<\/[A-Za-z][a-zA-Z0-9-]*\s*>[ \t]*$/.test(rest)) kind = 7;
    else return null;
    if (kind === 6 && !this.isHtmlStart(first)) return null;
    // type 7 must be a complete tag alone on its line
    if (kind === 7) {
      // handled by the regexes above
    }
    let endLine = -1;
    if (kind === 1) {
      const re = new RegExp(`</${closeTag}(?:[\\s>]|$)`, 'i');
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { endLine = i; break; }
    } else if (kind === 2) {
      for (let i = 0; i < lines.length; i++) if (lines[i].indexOf('-->') >= 0) { endLine = i; break; }
    } else if (kind === 3) {
      for (let i = 0; i < lines.length; i++) if (lines[i].indexOf('?>') >= 0) { endLine = i; break; }
    } else if (kind === 4) {
      for (let i = 0; i < lines.length; i++) if (lines[i].indexOf('>') >= 0) { endLine = i; break; }
    } else if (kind === 5) {
      for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(']]>') >= 0) { endLine = i; break; }
    }
    let text;
    if (kind <= 5) {
      if (endLine < 0) {
        text = src;
      } else {
        // up to the terminator line and its newline, plus any additional
        // consecutive newlines (empty lines) right after it -- marked's
        // html regex ends with (\n+|$), so a whitespace-only line (tab or
        // spaces) stops the match, while an empty line is included and
        // then trimmed by ge() to no trailing newline
        let upto = 0;
        for (let i = 0; i <= endLine; i++) upto += lines[i].length + 1;
        while (upto < src.length && src[upto] === '\n') upto++;
        text = trimTrailingBlanks(src.slice(0, upto));
      }
      const raw = text;
      return { type: 'html', raw, text, pre: kind === 1 && (closeTag === 'pre' || closeTag === 'script' || closeTag === 'style') };
    }
    // types 6-7: run to the first blank line; the raw does NOT end with a
    // trailing newline when a blank line follows (marked's html regex stops
    // before it)
    const body = [];
    for (let i = 0; i < lines.length; i++) {
      // a blank line ends the block, but the empty tail produced by a final
      // newline is not a blank line (there is no content after it)
      if (/^[ \t]*$/.test(lines[i]) && i < lines.length - 1) break;
      body.push(lines[i]);
    }
    text = body.join('\n');
    if (body.length === lines.length && src.endsWith('\n') && !text.endsWith('\n')) text += '\n';
    return { type: 'html', raw: text, text, pre: false };
  }

  // A link reference definition: [label]: destination "optional title".
  // Hand-scanned so multi-line labels, titles and destinations behave.
  tokDef(src) {
    let i = 0;
    while (i < 3 && src[i] === ' ') i++;
    if (src[i] !== '[') return null;
    let j = i + 1, label = '';
    // label: escaped chars, or any char except [ ] \ newline; a newline is
    // allowed when the next line is not blank; the label cannot be blank.
    // Backslashes are kept in the label text (only the lookup normalises).
    for (;;) {
      if (j >= src.length) return null;
      const c = src[j];
      if (c === '\\' && j + 1 < src.length) { label += src[j] + src[j + 1]; j += 2; continue; }
      if (c === ']') break;
      if (c === '[' || c === '\n' && (j + 1 >= src.length || /^\s*\n/.test(src.slice(j + 1)))) return null;
      if (c === '\n') { label += '\n'; j++; continue; }
      label += c; j++;
    }
    if (/^\s*$/.test(label)) return null;
    j++; // ]
    if (src[j] !== ':') return null;
    j++;
    // optional spaces, and one optional newline + indent
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (src[j] === '\n') { j++; while (src[j] === ' ' || src[j] === '\t') j++; }
    // destination: <...> or a bare run of non-space chars
    let dest = '';
    if (src[j] === '<') {
      j++;
      while (j < src.length && src[j] !== '>') {
        if (src[j] === '\n') return null;
        if (src[j] === '\\' && j + 1 < src.length && /[\p{P}\p{S}]/u.test(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
        dest += src[j]; j++;
      }
      if (src[j] !== '>') return null;
      j++;
    } else {
      const start = j;
      while (j < src.length && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) { j += 2; continue; }
        j++;
      }
      const rawDest = src.slice(start, j);
      dest = unescapePunct(rawDest);
      if (dest === '') return null;
      if (closingParen(rawDest) !== -1) return null;
      if (rawDest.indexOf('<') >= 0) return null;
    }
    // optional title on the same line or the next (after spaces/newline);
    // a title needs a separator (spaces/tabs and/or one newline) before it.
    // If a title is present but the definition does not end cleanly after
    // it, fall back to the no-title form when the destination line itself
    // ends cleanly (the title line then becomes ordinary content).
    const destEnd = j;
    let title = null, titleEnd = -1;
    let k = j, hadSep = false;
    while (src[k] === ' ' || src[k] === '\t') { k++; hadSep = true; }
    if (src[k] === '\n') {
      let k2 = k + 1;
      while (src[k2] === ' ' || src[k2] === '\t') k2++;
      if (src[k2] === '"' || src[k2] === "'" || src[k2] === '(') { k = k2; hadSep = true; }
    }
    if (hadSep && (src[k] === '"' || src[k] === "'" || src[k] === '(')) {
      const open = src[k], close = open === '(' ? ')' : open;
      let t = k + 1, val = '', ok = true;
      for (;;) {
        if (t >= src.length) { ok = false; break; }
        const c = src[t];
        if (c === '\\' && t + 1 < src.length) {
          if (/[\p{P}\p{S}]/u.test(src[t + 1])) { val += src[t + 1]; t += 2; }
          else { val += '\\'; t++; }
          continue;
        }
        if (c === close) break;
        if (open === "'" && c === '\n' && src[t + 1] === '\n') { ok = false; break; }
        if (open === '(' && (c === '(' || c === ')')) { ok = false; break; }
        val += c; t++;
      }
      if (ok) { title = val; titleEnd = t + 1; }
    }
    // try the title form first
    if (titleEnd >= 0) {
      let m = titleEnd;
      while (src[m] === ' ' || src[m] === '\t') m++;
      if (src[m] === '\n' || m >= src.length) {
        const raw = src.slice(0, m);
        const tag = normLabel(label);
        return { type: 'def', raw: stripEnd(raw, 10), tag, href: dest, title };
      }
    }
    // fall back to the no-title form when the destination line ends cleanly
    let m = destEnd;
    while (src[m] === ' ' || src[m] === '\t') m++;
    if (src[m] === '\n' || m >= src.length) {
      const raw = src.slice(0, m);
      const tag = normLabel(label);
      return { type: 'def', raw: stripEnd(raw, 10), tag, href: dest, title: null };
    }
    return null;
  }

  // Strip one level of blockquote markers from a chunk of lines, expanding
  // tabs after the marker, and neutralise a setext underline that follows
  // another line inside the chunk (it was a lazy line, not a real underline).
  stripQuoteMarkers(h) {
    return h
      .replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
  }

  // A blockquote: a run of lines starting with >, plus lazy paragraph lines.
  tokBlockquote(src) {
    const lines = src.split('\n');
    if (!/^ {0,3}>/.test(lines[0])) return null;
    // how many lines the quote consumes (the regex's reach)
    let i = 0, paraOpen = false;
    const n = lines.length;
    while (i < n) {
      const line = lines[i];
      if (/^ {0,3}>/.test(line)) {
        const content = line.replace(/^ {0,3}>[ \t]?/, '');
        paraOpen = !/^[ \t]*$/.test(content);
        i++;
      } else {
        if (!paraOpen) break;
        if (/^[ \t]*$/.test(line)) break;
        if (this.isKeInterrupt(line)) break;
        i++;
      }
    }
    if (i === 0) return null;
    // drop a trailing empty line produced by the final newline
    let consumed = lines.slice(0, i);
    if (consumed.length > 0 && consumed[consumed.length - 1] === '' && src.endsWith('\n')) consumed = consumed.slice(0, -1);
    let rest = consumed.slice();
    const rawParts = [], textParts = [];
    const tokens = [];
    const stripMarkersOnly = s => s.replace(/^ {0,3}>[ \t]?/gm, '');
    while (rest.length > 0) {
      let p = 0, seenGT = false;
      const chunk = [];
      for (; p < rest.length; p++) {
        if (/^ {0,3}>/.test(rest[p])) { chunk.push(rest[p]); seenGT = true; }
        else if (!seenGT) chunk.push(rest[p]);
        else break;
      }
      rest = rest.slice(p);
      const h = chunk.join('\n');
      const u = this.stripQuoteMarkers(h);
      rawParts.push(h);
      textParts.push(u);
      this.blockTokens(u, tokens, true, true);
      if (rest.length === 0) break;
      const k = tokens[tokens.length - 1];
      if (!k || k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table') break;
      if (k.type === 'blockquote') {
        const b = rest.join('\n');
        const m = k.raw + '\n' + stripMarkersOnly(b);
        const f = this.tokBlockquote(m);
        if (!f) break;
        tokens[tokens.length - 1] = f;
        // swap the nested quote's old text for the new one at the end
        const last = textParts[textParts.length - 1];
        textParts[textParts.length - 1] = last.slice(0, last.length - k.text.length) + f.text;
        const y = m.slice(f.raw.length).replace(/^\n/, '');
        const R = y ? y.split('\n').length : 0;
        const A = R ? rest.slice(0, -R) : rest.slice();
        if (A.length > 0) rawParts.push(A.join('\n'));
        rest = rest.slice(A.length);
        if (rest.length > 0 && /^ {0,3}>/.test(rest[0])) continue;
        break;
      }
      if (k.type === 'list') {
        const b = k.raw + '\n' + rest.join('\n');
        const m = this.tokList(b);
        if (!m) break;
        tokens[tokens.length - 1] = m;
        const f = m.raw.length > k.raw.length ? b.slice(k.raw.length + 1, m.raw.length).split('\n').length : 0;
        if (f > 0) {
          const y = rest.slice(0, f).join('\n');
          rawParts.push(y);
          textParts.push(y);
        }
        rest = rest.slice(f);
        continue;
      }
      // any other token type: keep consuming chunks
    }
    const raw = rawParts.join('\n');
    const text = textParts.join('\n');
    return { type: 'blockquote', raw, tokens, text };
  }

  // A lazy line inside a quote stops being consumed when it starts a block
  // (the paragraph rule used by the quote's own regex).
  isKeInterrupt(line) {
    if (/^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line)) return true;
    if (/^ {0,3}#{1,6}(?:[ \t]|\n|$)/.test(line)) return true;
    if (/^ {0,3}>/.test(line)) return true;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
    if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(line)) return true;
    if (this.isHtmlStart(line)) return true;
    return false;
  }

  // A list: items with the same bullet (or the same ordered delimiter),
  // each item's text gathered by the continuation rules, then re-lexed.
  tokList(src) {
    const first = /^( {0,3})([*+-]|\d{1,9}[.)])(?=[ \t]|\n|$)/.exec(src);
    if (!first) return null;
    if (/^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*(?:\n+|$)/.test(src)) return null;
    const marker = first[2];
    const ordered = /\d/.test(marker[0]);
    const delim = ordered ? marker[marker.length - 1] : null;
    const start = ordered ? parseInt(marker.slice(0, -1), 10) : '';
    const bulletPat = ordered ? `\\d{1,9}\\${delim}` : `\\${marker}`;
    const itemRe = new RegExp(`^( {0,3}${bulletPat})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
    const list = { type: 'list', raw: '', ordered, start, loose: false, items: [] };
    let e = src;
    let prevDoubleBlank = false;
    let listEnd = 0;
    const D = n => Math.max(0, Math.min(3, n - 1));
    while (e) {
      let u = false, d = '';
      const t = itemRe.exec(e);
      if (!t || /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*(?:\n+|$)/.test(e)) break;
      const itemStart = src.length - e.length;
      e = e.slice(t[0].length);
      const g = t[2].split('\n')[0];
      const b = t[1].length;
      let m = g.replace(/^[ \t]+/, v => expandTabs(v, b));
      let f = e.split('\n')[0];
      const y0 = !m.trim();
      let R = 0;
      if (y0) R = b + 1;
      else {
        R = m.search(/[^ ]/);
        if (R > 4) R = 1;
        d = m.slice(R);
        R += b;
      }
      let y = y0;
      if (y && /^[ \t]*$/.test(f)) { e = e.slice(f.length + 1); u = true; }
      if (!u) {
        const vRe = new RegExp(`^ {0,${D(R)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
        const qRe = new RegExp(`^ {0,${D(R)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
        const eeRe = new RegExp(`^ {0,${D(R)}}(?:\`\`\`|~~~)`);
        const teRe = new RegExp(`^ {0,${D(R)}}#{1,6}(?:\\s|$)`);
        const mRe = new RegExp(`^ {0,${D(R)}}(?:<\\/?(?:${BLOCK_TAGS})(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
        const neRe = new RegExp(`^ {0,${D(R)}}>`);
        while (e) {
          const U = e.split('\n')[0];
          f = U;
          const Z = f.replace(/^[ \t]+/, me => expandTabs(me, 0));
          if (eeRe.test(f) || teRe.test(f) || mRe.test(f) || neRe.test(f) || vRe.test(f) || qRe.test(f)) break;
          if (Z.search(/[^ ]/) >= R || !f.trim()) d += '\n' + Z.slice(R);
          else {
            if (y || m.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || eeRe.test(m) || teRe.test(m) || mRe.test(m) || qRe.test(m)) break;
            let qe = f;
            if (/^ {0,3}(?:=+|-+) *$/.test(f) && this.isSetextText(m + '\n' + f)) qe = '    ' + Z.replace(/^ {0,3}/, '');
            d += '\n' + qe;
          }
          y = !f.trim();
          e = e.slice(U.length + 1);
          m = Z.slice(R);
        }
      }
      const itemEnd = src.length - e.length;
      listEnd = itemEnd;
      const A = src.slice(itemStart, itemEnd);
      if (prevDoubleBlank) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(A)) prevDoubleBlank = true;
      list.items.push({ type: 'list_item', raw: A, task: /^\[[ xX]\][ \t]+\S/.test(d), loose: false, text: d, tokens: [] });
    }
    if (list.items.length === 0) return null;
    const last = list.items[list.items.length - 1];
    last.raw = last.raw.replace(/[ \t\n]+$/, '');
    last.text = last.text.replace(/[ \t\n]+$/, '');
    list.raw = src.slice(0, listEnd).replace(/[ \t\n]+$/, '');
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, [], false, false);
      if (!list.loose) {
        const spaces = item.tokens.filter(tk => tk.type === 'space');
        if (spaces.length > 0 && spaces.some(tk => /\n.*\n/.test(tk.raw))) list.loose = true;
      }
    }
    this.state.top = true;
    // task checkboxes
    for (const item of list.items) {
      if (!item.task) continue;
      const firstTok = item.tokens[0];
      if (firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
        item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
        firstTok.raw = firstTok.raw.replace(/^\[[ xX]\][ \t]+/, '');
        firstTok.text = firstTok.text.replace(/^\[[ xX]\][ \t]+/, '');
        for (let gi = this.inlineQueue.length - 1; gi >= 0; gi--) {
          if (/^\[[ xX]\][ \t]+\S/.test(this.inlineQueue[gi].src)) {
            this.inlineQueue[gi].src = this.inlineQueue[gi].src.replace(/^\[[ xX]\][ \t]+/, '');
            break;
          }
        }
        const cb = /\[[ xX]\]/.exec(item.raw);
        if (cb) {
          const box = { t: 12, type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose && firstTok.tokens) {
            firstTok.raw = box.raw + firstTok.raw;
            firstTok.text = box.raw + firstTok.text;
            firstTok.tokens.unshift(box);
          } else if (list.loose) {
            item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
          } else item.tokens.unshift(box);
        }
      } else item.task = false;
    }
    if (list.loose) for (const item of list.items) {
      item.loose = true;
      for (const tk of item.tokens) if (tk.type === 'text') tk.type = 'paragraph';
    }
    return list;
  }

  // Would `s` (a paragraph plus a ===/--- line) be a setext heading?
  isSetextText(s) {
    const lines = s.split('\n');
    if (lines.length < 2) return false;
    const last = lines[lines.length - 1];
    if (!/^ {0,3}(=+|-+)[ \t]*$/.test(last)) return false;
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^[ \t]*$/.test(lines[i])) return false;
      if (this.lineStartsBlock(lines[i], lines[i + 1], true)) return false;
    }
    return true;
  }
}

// ================= inline lexer =================
// Node types (numeric): 0=text 1=escaped char 2=code span 3=raw html 4=br
// 5=delimiter run 6=em 7=strong 8=del 9=link 10=image
const WS_CHARS = ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
// ASCII punctuation for flanking (excludes ~, which is not punctuation there)
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}';
// ASCII punctuation escapable by a backslash (includes ~)
const ASCII_ESC_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isWsCh(c) { return c !== undefined && WS_CHARS.indexOf(c) >= 0; }
function isPunctCh(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT.indexOf(c) >= 0;
  return PUNCT_RE.test(c);
}
function isEmailCh(c) {
  if (!c) return false;
  const code = c.charCodeAt(0);
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || '.!#$%&\'*+/=?^_`{|}~-'.indexOf(c) >= 0;
  return false;
}
function isEmailLocalCh(c) {
  if (!c) return false;
  const code = c.charCodeAt(0);
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || '._+-'.indexOf(c) >= 0;
  return false;
}

// a \w character (for the \b_ word-boundary test on _)
function isWordCh(c) {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === '_';
}
const EMAIL_SRC = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_RE = new RegExp('^' + EMAIL_SRC);
const URL_RE = new RegExp('^(?:mailto:' + EMAIL_SRC + '|xmpp:' + EMAIL_SRC + '(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' + EMAIL_SRC.replace('@', '(@)'));
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const AUTOLINK_RE = /^<((?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}):[^\s<>]*|(?:[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*))>/;
const TAG_OPEN_RE = /^<([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\r\n"'=<>`]+|'[^']*'|"[^"]*"))?)*)\s*(\/?)>|^<\/([A-Za-z][A-Za-z0-9-]*)\s*>/;
const TAG_COMMENT_RE = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const TAG_PI_RE = /^<\?(?:(?!\?>)[\s\S])*?\?>/;
const TAG_DECL_RE = /^<![A-Za-z](?:(?!>)[\s\S])*?>/;
const TAG_CDATA_RE = /^<!\[CDATA\[(?:(?!\]\]>)[\s\S])*?\]\]>/;
const RAW_TAGS = { pre: 1, code: 1, kbd: 1, script: 1 };
const LINK_START_RE = /^!?\[/;
const TEXT_STOP_RE = /[\\`*!\[<>\n~_]|www\.|:\/\/|@|mailto:|xmpp:/g;

// GFM extended autolink at src[i]; returns {node, len} or null
function tryGfmUrl(src, i) {
  const m = URL_RE.exec(src.slice(i));
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[0]; href = 'mailto:' + m[0]; }
  else {
    let t = m[0], r;
    do { r = t; t = BACKPEDAL_RE.exec(t)?.[0] ?? ''; } while (r !== t);
    text = t;
    href = m[1] === 'www.' ? 'http://' + t : t;
  }
  const h = encURI(href);
  if (h === null) return null;
  return { node: { t: 9, auto: true, href: esc(h, false), title: null, children: [{ t: 11, s: text }] }, len: text.length };
}

// find the end of a bracketed label starting at src[i]=='['; returns index just past the matching ']' or -1.
// Handles nested brackets, backslash escapes, and code spans (a `]` inside a code span does not close).
function findLabelEnd(src, i) {
  let level = 0, j = i;
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      // marked's label code-span alternative is `+[^`]*?`+ : the closing run
      // is the FIRST backtick run after the opening run (any length, the
      // content between them has no backtick by construction)
      let m = k, found = -1;
      while (m < n) {
        if (src[m] === '`') { found = m; break; }
        m++;
      }
      if (found >= 0) {
        let e = found;
        while (e < n && src[e] === '`') e++;
        j = e;
        continue;
      }
      // no closing run: the run is only valid as literal backticks if it is
      // 2+ backticks immediately followed by ']' (marked's ``+(?=]) alternative)
      if (src[k] === ']' && k - j >= 2) { j = k; continue; }
      return -1;
    }
    if (c === '[') level++;
    else if (c === ']') { level--; if (level === 0) return j + 1; }
    j++;
  }
  return -1;
}
// parse an inline link destination+title starting at src[i]=='('.
// Mirrors marked's link regex: greedy bare dest, optional title, ke() truncation.
// Returns {end, href, title} or null.
function parseLinkDest(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  let href, destEnd;
  if (src[j] === '<') {
    // angle-bracket destination: no \n or <> inside, backslash escapes allowed
    let k = j + 1;
    while (k < n && src[k] !== '>' && src[k] !== '\n') {
      if (src[k] === '\\') k++;
      if (src[k] === '<') return null;
      k++;
    }
    if (k >= n || src[k] !== '>') return null;
    href = src.slice(j + 1, k);
    destEnd = k + 1;
  } else {
    // bare destination: maximal run of non-space/control chars
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c < 32 || c === 127) break;
      k++;
    }
    const run = src.slice(j, k);
    if (run.length === 0) {
      // empty destination: only valid if the next char is ')'
      if (src[j] === ')') return { end: j + 1, href: '', title: null };
      return null;
    }
    // ke() is applied to the matched destination first: -2 rejects, an
    // unmatched ')' truncates the destination (and drops any title).
    const kl = closingParen(run);
    if (kl === -2) return null;
    if (kl > -1) return { end: j + kl + 1, href: run.slice(0, kl), title: null };
    // title form: after the run, a separator + title + whitespace + ')'
    let p = k, hadSep = false;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) { p++; hadSep = true; }
    if (p < n && src[p] === '\n') { p++; hadSep = true; while (p < n && (src[p] === ' ' || src[p] === '\t')) p++; }
    if (hadSep && p < n && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
      const t = parseTitle(src, p);
      if (t) {
        let q = t.end;
        while (q < n && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
        if (q < n && src[q] === ')') return { end: q + 1, href: run, title: t.title };
      }
    }
    // no-title form: after the run, whitespace + ')'
    {
      let q = k;
      while (q < n && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
      if (q < n && src[q] === ')') return { end: q + 1, href: run, title: null };
    }
    // otherwise the link's closing paren is the LAST ')' in the run
    const lastClose = run.lastIndexOf(')');
    if (lastClose < 0) return null;
    const dest = run.slice(0, lastClose);
    const l = closingParen(dest);
    if (l === -2) return null;
    if (l > -1) return { end: j + l + 1, href: dest.slice(0, l), title: null };
    return { end: j + lastClose + 1, href: dest, title: null };
  }
  // angle-bracket destination: optional title, then ')' (no ke() check here)
  let p = destEnd, hadSep = false;
  while (p < n && (src[p] === ' ' || src[p] === '\t')) { p++; hadSep = true; }
  if (p < n && src[p] === '\n') { p++; hadSep = true; while (p < n && (src[p] === ' ' || src[p] === '\t')) p++; }
  if (hadSep && p < n && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
    const t = parseTitle(src, p);
    if (t) {
      let q = t.end;
      while (q < n && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
      if (q < n && src[q] === ')') return { end: q + 1, href, title: t.title };
    }
  }
  while (p < n && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  if (p >= n || src[p] !== ')') return null;
  return { end: p + 1, href, title: null };
}
// parse a link title starting at src[p] ('"' / "'" / '('); returns {end, title} or null
function parseTitle(src, p) {
  const n = src.length;
  const q = src[p];
  if (q === '(') {
    let r = p + 1, depth = 0;
    while (r < n) {
      if (src[r] === '\\' && r + 1 < n) { r += 2; continue; }
      if (src[r] === '(') depth++;
      else if (src[r] === ')') { if (depth === 0) return { end: r + 1, title: src.slice(p + 1, r) }; depth--; }
      r++;
    }
    return null;
  }
  let r = p + 1;
  while (r < n) {
    if (src[r] === '\\' && r + 1 < n) { r += 2; continue; }
    if (src[r] === q) return { end: r + 1, title: src.slice(p + 1, r) };
    r++;
  }
  return null;
}

// ---- inline link/image parsing (uses the helpers above) ----
function outputLinkReplace(s) { return s; } // label text is used as-is
function matchTagAt(src, i) {
  let m = TAG_COMMENT_RE.exec(src.slice(i, i + 200));
  if (m) return m[0];
  m = TAG_PI_RE.exec(src.slice(i, i + 200));
  if (m) return m[0];
  m = TAG_DECL_RE.exec(src.slice(i, i + 200));
  if (m) return m[0];
  m = TAG_CDATA_RE.exec(src.slice(i, i + 200));
  if (m) return m[0];
  m = TAG_OPEN_RE.exec(src.slice(i));
  if (m) return m[0];
  return null;
}
function matchAutolinkAt(src, i) {
  const m = AUTOLINK_RE.exec(src.slice(i));
  return m ? m[0] : null;
}
// Be(): does the label contain a '<' starting a tag/autolink that extends past the label end?
function labelHasTagPastEnd(src, labelStart, labelEnd) {
  const label = src.slice(labelStart, labelEnd);
  if (label.indexOf('<') < 0) return false;
  for (let s = 0; s < label.length; s++) {
    const c = label[s];
    if (c === '\\') { s++; continue; }
    if (c === '`') {
      let k = s;
      while (k < label.length && label[k] === '`') k++;
      const run = k - s;
      let m2 = k;
      while (m2 < label.length) {
        if (label[m2] === '`') {
          let e = m2;
          while (e < label.length && label[e] === '`') e++;
          if (e - m2 === run) { s = e - 1; break; }
          m2 = e;
        } else m2++;
      }
      if (m2 >= label.length) return false;
      continue;
    }
    if (c !== '<') continue;
    const abs = labelStart + s;
    const o = matchTagAt(src, abs) || matchAutolinkAt(src, abs);
    if (o) {
      if (o.length > label.length - s) return true;
      s += o.length - 1;
    }
  }
  return false;
}
// A real [..](..) / reference link inside a label blocks the outer link
// (marked's linkEmitted); an autolink (<...> or GFM) inside the label does
// not, so the outer link is still created around it.
function containsLinkNode(nodes) {
  for (const nd of nodes) {
    if (nd.t === 9 && !nd.auto) return true;
    if (nd.children && containsLinkNode(nd.children)) return true;
  }
  return false;
}
function textify(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 1) out += nd.s;
    else if (nd.t === 2) out += nd.s;
    else if (nd.t === 3) out += nd.s;
    else if (nd.t === 4) out += '';
    else if (nd.t === 5) out += nd.ch.repeat(nd.len);
    else if (nd.t === 6 || nd.t === 7 || nd.t === 8) out += textify(nd.children);
    else if (nd.t === 9) out += textify(nd.children);
    else if (nd.t === 10) out += nd.alt || '';
    else if (nd.t === 11) out += nd.s;
  }
  return out;
}
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += esc(nd.s, false);
    else if (nd.t === 1) out += esc(nd.s, false);
    else if (nd.t === 11) out += esc(nd.s, true);
    else if (nd.t === 2) out += '<code>' + esc(nd.s, true) + '</code>';
    else if (nd.t === 3) out += nd.s;
    else if (nd.t === 4) out += '<br>';
    else if (nd.t === 5) out += nd.ch.repeat(nd.len);
    else if (nd.t === 6) out += '<em>' + renderInline(nd.children) + '</em>';
    else if (nd.t === 7) out += '<strong>' + renderInline(nd.children) + '</strong>';
    else if (nd.t === 8) out += '<del>' + renderInline(nd.children) + '</del>';
    else if (nd.t === 12) out += '<input' + (nd.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
    else if (nd.t === 9) {
      if (nd.href === null) { out += renderInline(nd.children); continue; }
      out += '<a href="' + nd.href + '"';
      if (nd.title !== null && nd.title !== undefined) out += ' title="' + esc(nd.title, false) + '"';
      out += '>' + renderInline(nd.children) + '</a>';
    } else if (nd.t === 10) {
      if (nd.href === null) { out += esc(nd.alt || '', false); continue; }
      out += '<img src="' + nd.href + '" alt="' + esc(nd.alt || '', false) + '"';
      if (nd.title !== null && nd.title !== undefined) out += ' title="' + esc(nd.title, false) + '"';
      out += '>';
    }
  }
  return out;
}
// Strikethrough, mirroring marked's del tokenizer: a ~ run of 1 or 2 can
// open; 3+ cannot. The opener needs a non-whitespace, non-~ char after it,
// and if that char is punctuation the char before the run must be the start
// or whitespace/punctuation (not a word char, and not * or _). The closer
// is a run of the same length; nested openers of that length raise a
// balance that the closer must drain. Code spans and backslash escapes are
// skipped while scanning for the closer.
// tryEmStrong: marked's emStrong tokenizer, reimplemented from the
// CommonMark flanking rules + the balance / rule-of-3 scan.
// src = full inline source, i = index of the start of a * or _ run.
// Returns {kind:'em'|'strong', text, rawLen} or null.
// The content is lexed recursively by the caller (so an email at the end of
// the content does not see the closing delimiter, exactly as in marked).
const ALNUM_RE = /[\p{L}\p{N}]/u;
function tryEmStrong(src, i, links) {
  const n = src.length;
  const r = src[i];
  // walk back over preceding same chars: the opener checks use the char
  // before the whole run (marked's l/n), and y is the whole run length
  let l = i;
  while (l > 0 && src[l - 1] === r) l--;
  let j = i;
  while (j < n && src[j] === r) j++;
  const k = j - i;
  const y = j - l;
  const prev = l === 0 ? '' : src[l - 1];
  const next = j < n ? src[j] : '';
  if (next === '' || isWsCh(next)) return null;
  const nextPunct = isPunctCh(next);
  const prevPunct = prev === '' ? false : isPunctCh(prev);
  const prevWs = prev === '' || isWsCh(prev);
  // left-flanking (can open)
  const leftFlank = !nextPunct || prevWs || prevPunct;
  if (!leftFlank) return null;
  // '_' intra-word rule: followed by a non-punct char, preceded by alnum
  if (r === '_' && !nextPunct && prev !== '' && ALNUM_RE.test(prev)) return null;
  // R: the opener can also close (right-flanking)
  const rightFlank = prev !== '' && !prevWs && (!prevPunct || isWsCh(next) || nextPunct);
  const R = rightFlank;
  let m = k, f = 0;
  let p = j, closerStart = -1, closerLen = 0;
  // marked's RDelim first alternative skips a delimiter of our kind that
  // sits inside a strong of the other kind right at the scan start
  // (__...*...__ for *, **..._...** for _): the inner delimiter is
  // invisible to this opener. Only the exact pattern counts (no other
  // delimiter between the strong fences).
  {
    const other = r === '*' ? '_' : '*';
    let q = j;
    while (q < n && src[q] !== '*' && src[q] !== '_') q++;
    if (q + 1 < n && src[q] === other && src[q + 1] === other && src[q + 2] !== other) {
      q += 2;
      while (q < n && src[q] !== '*' && src[q] !== '_') q++;
      if (q < n && src[q] === r && src[q + 1] !== r) {
        q++;
        while (q < n && src[q] !== '*' && src[q] !== '_') q++;
        if (q + 1 < n && src[q] === other && src[q + 1] === other && src[q + 2] !== other) p = q;
      }
    }
  }
  // Scan for the closer with a regex jump: the engine (C) skips plain text
  // and only stops at escapes, backtick runs, '[', '<', or a * / _ run.
  // A fresh RegExp object per call (pattern is cached by V8) so nested
  // tryEmStrong calls (via recursive content lexing) cannot clobber
  // each other's lastIndex.
  const SCAN_RE = new RegExp('\\\\.|`+|\\[|<|\\*+|_+', 'g');
  SCAN_RE.lastIndex = p;
  let match;
  while ((match = SCAN_RE.exec(src)) !== null) {
    const tok = match[0];
    const tp = match.index;
    const tc = tok[0];
    if (tc === '\\') continue;
    if (tc === '`') {
      const run = tok.length;
      let m2 = tp + run, found = -1;
      while (m2 < n) {
        if (src[m2] === '`') {
          let e = m2;
          while (e < n && src[e] === '`') e++;
          if (e - m2 === run) { found = m2; break; }
          m2 = e;
        } else m2++;
      }
      SCAN_RE.lastIndex = found >= 0 ? found + run : tp + run;
      continue;
    }
    if (tc === '<') {
      // a delimiter inside an HTML tag attribute cannot close an emphasis
      // (marked masks tags in the source it scans for closers)
      const tag = matchTagAt(src, tp);
      if (tag) { SCAN_RE.lastIndex = tp + tag.length; continue; }
      const al = matchAutolinkAt(src, tp);
      if (al) { SCAN_RE.lastIndex = tp + al.length; continue; }
      continue;
    }
    if (tc === '[') {
      // a delimiter inside a link/image label cannot close an emphasis
      // that started outside the label -- but only when the [...] actually
      // forms a link (marked masks reflink-like patterns only when the
      // reference resolves; an unresolvable [...] leaves its * visible)
      const lb = tp;
      const le = findLabelEnd(src, lb);
      if (le > 0) {
        const labelText = src.slice(lb + 1, le - 1);
        let isLink = false, endPos = le;
        if (src[le] === '(') {
          const dest = parseLinkDest(src, le);
          if (dest) { isLink = true; endPos = dest.end; }
        } else if (src[le] === '[') {
          const re2 = findLabelEnd(src, le);
          if (re2 > 0) {
            const ref = normLabel(src.slice(le + 1, re2 - 1) === '' ? labelText : src.slice(le + 1, re2 - 1));
            if (links && links[ref]) { isLink = true; endPos = re2; }
          }
        } else {
          const ref = normLabel(labelText);
          if (links && links[ref]) { isLink = true; endPos = le; }
        }
        if (isLink) { SCAN_RE.lastIndex = endPos; continue; }
      }
      continue;
    }
    if (tc !== r) continue;
    const q = tp + tok.length;
    const len = tok.length;
    const bprev = tp === 0 ? '' : src[tp - 1];
    const bnext = q < n ? src[q] : '';
    const bprevWs = bprev === '' || isWsCh(bprev);
    const bnextWs = bnext === '' || isWsCh(bnext);
    const bprevPunct = bprev === '' ? false : isPunctCh(bprev);
    const bnextPunct = bnext === '' ? false : isPunctCh(bnext);
    const bLeft = !bnextWs && (!bnextPunct || bprevWs || bprevPunct);
    const bRight = bprev !== '' && !bprevWs && (!bprevPunct || bnextWs || bnextPunct);
    let canOpen, canClose;
    if (tc === '*') { canOpen = bLeft; canClose = bRight; }
    else { canOpen = bLeft && (!bRight || bprevPunct); canClose = bRight && (!bLeft || bnextPunct); }
    if (!canOpen && !canClose) continue;
    if (canOpen && !canClose) { m += len; continue; }
    // closer (canClose); if it can also open, or the opener can also close,
    // the rule-of-3 odd-match check applies first
    if ((canOpen && canClose) || R) {
      if (y % 3 !== 0 && (y + len) % 3 === 0) { f += len; continue; }
    }
    m -= len;
    if (m > 0) continue;
    closerLen = Math.min(len, len + m + f);
    closerStart = tp;
    break;
  }
  if (closerStart < 0) return null;
  const closerEnd = closerStart + closerLen;
  const use = Math.min(k, closerLen) % 2 === 1 ? 1 : 2;
  return { kind: use === 1 ? 'em' : 'strong', text: src.slice(i + use, closerEnd - use), rawLen: closerEnd - i };
}

function tryDel(src, i, n) {
  let j = i;
  while (j < n && src[j] === '~') j++;
  const o = j - i;
  if (o < 1 || o > 2) return null;
  const next = j < n ? src[j] : '\n';
  if (isWsCh(next) || next === '~') return null;
  const prev = i === 0 ? '' : src[i - 1];
  // if the first content char is punctuation, the char before the run must
  // be the start or whitespace/punctuation (not a word char, and not * or _)
  if (isPunctCh(next) && prev !== '') {
    const prevOk = isWsCh(prev) || (PUNCT_RE.test(prev) && prev !== '*' && prev !== '_');
    if (!prevOk) return null;
  }
  let p = o, k = j;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '`') {
      let e = k;
      while (e < n && src[e] === '`') e++;
      const run = e - k;
      let m2 = e, found = -1;
      while (m2 < n) {
        if (src[m2] === '`') {
          let f = m2;
          while (f < n && src[f] === '`') f++;
          if (f - m2 === run) { found = m2; break; }
          m2 = f;
        } else m2++;
      }
      k = found >= 0 ? found + run : n;
      continue;
    }
    if (c !== '~') { k++; continue; }
    let e = k;
    while (e < n && src[e] === '~') e++;
    const len = e - k;
    if (len < 1 || len > 2 || len !== o) { k = e; continue; }
    const pprev = k === 0 ? '\n' : src[k - 1];
    const nnext = e >= n ? '\n' : src[e];
    const pWs = isWsCh(pprev), nWs = isWsCh(nnext);
    const pPunct = isPunctCh(pprev), nPunct = isPunctCh(nnext);
    const leftFlank = !nWs && (!nPunct || pWs || pPunct);
    const rightFlank = !pWs && (!pPunct || nWs || nPunct);
    if (leftFlank && !rightFlank) { p += len; k = e; continue; }
    if (!rightFlank) { k = e; continue; }
    p -= len;
    if (p > 0) { k = e; continue; }
    return { rawLen: e - i, content: src.slice(j, k) };
  }
  return null;
}
// `linkState` (when given) is a shared {inLink} object: parseInline reads
// <a> leaks inLink into later paragraphs (marked's behaviour). Recursive
// calls for link labels get a fresh {inLink:true} that does not leak back.
function parseInline(src, links, linkState) {
  const nodes = [];
  const state = { inLink: !!(linkState && linkState.inLink), inRaw: false };
  const n = src.length;
  let i = 0;
  let textStart = -1;
  const flushText = (end) => {
    if (textStart >= 0 && end > textStart) {
      let s = src.slice(textStart, end);
      if (!state.inRaw) s = unescape(s);
      const last = nodes[nodes.length - 1];
      if (last && last.t === 0) last.s += s; else nodes.push({ t: 0, s });
    }
    textStart = -1;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        let k = i + 2;
        while (k < n && isWsCh(src[k])) k++;
        if (k < n) {
          flushText(i);
          nodes.push({ t: 4 });
          i = i + 2;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
        if (textStart < 0) textStart = i;
        i++;
        continue;
      }
      if (d !== undefined && d.charCodeAt(0) < 128 && ASCII_ESC_PUNCT.indexOf(d) >= 0) {
        flushText(i);
        nodes.push({ t: 1, s: d });
        i += 2;
        continue;
      }
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    if (c === '<') {
      const tag = matchTagAt(src, i);
      if (tag) {
        flushText(i);
        const m = TAG_OPEN_RE.exec(tag);
        if (m) {
          const name = (m[1] || m[4]).toLowerCase();
          const closing = tag[1] === '/';
          if (RAW_TAGS[name]) {
            if (closing) state.inRaw = false; else state.inRaw = true;
          }
          if (name === 'a') {
            if (closing) state.inLink = false; else state.inLink = true;
          }
        }
        nodes.push({ t: 3, s: tag });
        i += tag.length;
        continue;
      }
      const al = matchAutolinkAt(src, i);
      if (al) {
        flushText(i);
        const inner = al.slice(1, -1);
        let href, text;
        if (inner.indexOf('@') >= 0 && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner)) {
          href = 'mailto:' + inner; text = inner;
        } else { href = inner; text = inner; }
        const h = encURI(href);
        nodes.push({ t: 9, auto: true, href: h === null ? null : esc(h, false), title: null, children: [{ t: 11, s: text }] });
        i += al.length;
        continue;
      }
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const run = k - i;
      let m2 = k, found = -1;
      while (m2 < n) {
        if (src[m2] === '`') {
          let e = m2;
          while (e < n && src[e] === '`') e++;
          if (e - m2 === run) { found = m2; break; }
          m2 = e;
        } else m2++;
      }
      if (found >= 0) {
        flushText(i);
        let content = src.slice(k, found).replace(/\n/g, ' ');
        if (/[^\s]/.test(content) && content[0] === ' ' && content[content.length - 1] === ' ') content = content.slice(1, -1);
        nodes.push({ t: 2, s: content });
        i = found + run;
        continue;
      }
      // no closing run of the same length: the whole run is literal text
      // (marked's code regex cannot retry with a shorter opening run, since
      // the content may not start with a backtick)
      if (textStart < 0) textStart = i;
      i = k;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImg = c === '!';
      const lb = isImg ? i + 1 : i;
      const le = findLabelEnd(src, lb);
      if (le > 0) {
        const labelText = src.slice(lb + 1, le - 1);
        let link = null, endPos = -1;
        if (src[le] === '(') {
          const dest = parseLinkDest(src, le);
          if (dest) { link = { href: dest.href, title: dest.title }; endPos = dest.end; }
          else {
            // not a valid inline link: fall back to a shortcut reference link
            const ref = normLabel(labelText);
            const def = links && links[ref];
            if (def) { link = { href: def.href, title: def.title }; endPos = le; }
          }
        } else if (src[le] === '[') {
          const re2 = findLabelEnd(src, le);
          if (re2 > 0) {
            const refText = src.slice(le + 1, re2 - 1);
            // a collapsed reference [label][] uses the label itself as the key
            const ref = normLabel(refText === '' ? labelText : refText);
            const def = links && links[ref];
            if (def) { link = { href: def.href, title: def.title }; endPos = re2; }
          }
        } else {
          const ref = normLabel(labelText);
          const def = links && links[ref];
          if (def) { link = { href: def.href, title: def.title }; endPos = le; }
        }
        if (link && !labelHasTagPastEnd(src, lb + 1, le)) {
          // inside a link label, GFM autolinks are suppressed (marked's
          // inLink state), so a bare URL in the label stays plain text and
          // does not block the outer link
          const childNodes = parseInline(labelText, links, { inLink: true });
          if (isImg || !containsLinkNode(childNodes)) {
            flushText(i);
            const href = encURI(unescapePunct(link.href));
            const title = link.title === null || link.title === undefined ? null : unescapePunct(link.title);
            if (isImg) {
              nodes.push({ t: 10, href: href === null ? null : esc(href, false), title, alt: textify(childNodes) });
            } else {
              nodes.push({ t: 9, href: href === null ? null : esc(href, false), title, children: childNodes });
            }
            i = endPos;
            continue;
          }
        }
      }
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    if (c === '~') {
      const d = tryDel(src, i, n);
      if (d) {
        flushText(i);
        nodes.push({ t: 8, children: parseInline(d.content, links, linkState) });
        // the recursive call may have changed the shared inLink (e.g. a
        // </a> inside the del content); sync our snapshot or the final
        // write-back would overwrite it with the stale value
        if (linkState) state.inLink = linkState.inLink;
        i += d.rawLen;
        continue;
      }
      // not a strikethrough: the whole run is literal text
      let j = i;
      while (j < n && src[j] === '~') j++;
      if (textStart < 0) textStart = i;
      i = j;
      continue;
    }
    if (c === '*' || c === '_') {
      const em = tryEmStrong(src, i, links);
      if (em) {
        flushText(i);
        nodes.push({ t: em.kind === 'em' ? 6 : 7, children: parseInline(em.text, links, linkState) });
        // the recursive call may have changed the shared inLink (e.g. a
        // </a> inside the emphasis content); sync our snapshot or the
        // final write-back would overwrite it with the stale value
        if (linkState) state.inLink = linkState.inLink;
        i += em.rawLen;
        continue;
      }
      // not an opener here: only this one delimiter char is literal text
      // (marked retries emStrong at the next char of the run, so **foo*
      // yields a literal * plus an <em>foo</em> starting at the second *)
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    if (c === '\n') {
      // hard break is handled in the text scanner; a bare \n here is a softbreak
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    // text chunk (stops at special chars, GFM triggers, or a hard break)
    if (textStart < 0) textStart = i;
    TEXT_STOP_RE.lastIndex = i;
    let m, end = n, brEnd = -1, trig = 0;
    while ((m = TEXT_STOP_RE.exec(src)) !== null) {
      const p = m.index, ch = m[0];
      if (ch === '\n') {
        let q = p - 1, spaces = 0;
        while (q >= i && src[q] === ' ') { spaces++; q--; }
        if (spaces >= 2) {
          let k = p + 1;
          while (k < n && isWsCh(src[k])) k++;
          if (k < n) { end = p - spaces; brEnd = p + 1; break; }
        }
        continue;
      }
      if (ch === '_') {
        // a _ run between two word characters (a_b, or an email local part
        // like a.b-c_d) is plain text and must not split the chunk; any
        // other _ run (at a word boundary on either side, judged by the
        // characters around the whole run) can delimit emphasis, so stop
        let q = p + 1;
        while (q < n && src[q] === '_') q++;
        if (p === i || !isWordCh(src[p - 1]) || !isWordCh(src[q])) { end = p; break; }
        continue;
      }
      if (!state.inLink && ch === 'www.') {
        const prev = p === 0 ? '' : src[p - 1];
        if (p === 0 || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(') { end = p; trig = 1; break; }
        continue;
      }
      if (!state.inLink && ch === '://') {
        const before = src.slice(Math.max(0, p - 5), p).toLowerCase();
        if (before.endsWith('https')) { end = p - 5; trig = 1; break; }
        if (before.endsWith('http')) { end = p - 4; trig = 1; break; }
        if (before.endsWith('ftp')) { end = p - 3; trig = 1; break; }
        continue;
      }
      if (!state.inLink && ch === '@') {
        let ls = p - 1;
        while (ls >= 0 && isEmailLocalCh(src[ls])) ls--;
        ls++;
        // the local part cannot start before this text chunk (an earlier
        // part was already emitted as text); clamp to the chunk start
        if (ls < i) ls = i;
        if (ls < p && EMAIL_RE.test(src.slice(ls))) {
          // if the email's first char is escaped by an odd run of backslashes
          // it is consumed by the escape tokenizer and cannot start an email
          let bs = 0, q = ls - 1;
          while (q >= 0 && src[q] === '\\') { bs++; q--; }
          const escCh = src[ls];
          if (!(bs % 2 === 1 && escCh !== undefined && ASCII_ESC_PUNCT.indexOf(escCh) >= 0)) { end = ls; trig = 1; break; }
        }
        continue;
      }
      if (!state.inLink && (ch === 'mailto:' || ch === 'xmpp:')) {
        const prev = p === 0 ? '' : src[p - 1];
        if ((p === 0 || !/[a-zA-Z0-9]/.test(prev)) && URL_RE.test(src.slice(p))) { end = p; trig = 1; break; }
        continue;
      }
      end = p;
      break;
    }
    if (brEnd >= 0) {
      flushText(end);
      nodes.push({ t: 4 });
      i = brEnd;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      continue;
    }
    if (trig) {
      flushText(end);
      const g = tryGfmUrl(src, end);
      if (g) { nodes.push(g.node); i = end + g.len; continue; }
      if (textStart < 0) textStart = end;
      i = end + 1;
      continue;
    }
    if (end > i) {
      if (textStart < 0) textStart = i;
      i = end;
      continue;
    }
    // a special char the loop above stopped at immediately; handle it next iteration
    if (textStart < 0) textStart = i;
    i++;
  }
  flushText(n);
  if (linkState) linkState.inLink = state.inLink;
  return nodes;
}

// ================= block renderer =================
function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    if (tok.type === 'space') continue;
    if (tok.type === 'heading') {
      out += '<h' + tok.depth + '>' + renderInline(tok.tokens) + '</h' + tok.depth + '>\n';
    } else if (tok.type === 'paragraph') {
      out += '<p>' + renderInline(tok.tokens) + '</p>\n';
    } else if (tok.type === 'text') {
      out += renderInline(tok.tokens);
    } else if (tok.type === 'code') {
      const s = tok.lang ? /^\S*/.exec(tok.lang)[0] : '';
      const code = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
      if (s) out += '<pre><code class="language-' + esc(s, false) + '">' + esc(code, true) + '</code></pre>\n';
      else out += '<pre><code>' + esc(code, true) + '</code></pre>\n';
    } else if (tok.type === 'blockquote') {
      out += '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
    } else if (tok.type === 'list') {
      const tag = tok.ordered ? 'ol' : 'ul';
      const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
      out += '<' + tag + startAttr + '>\n';
      for (const item of tok.items) {
        out += '<li>';
        // a loose task list's checkbox lives inside the first paragraph
        // (renderInline handles it); a tight one renders it before the text
        if (item.task && !item.loose) {
          out += '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
        }
        out += renderBlocks(item.tokens);
        out += '</li>\n';
      }
      out += '</' + tag + '>\n';
    } else if (tok.type === 'hr') {
      out += '<hr>\n';
    } else if (tok.type === 'table') {
      out += '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < tok.header.length; c++) {
        const align = tok.align[c] ? ' align="' + tok.align[c] + '"' : '';
        out += '<th' + align + '>' + renderInline(tok.header[c].tokens) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (tok.rows.length > 0) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const align = tok.align[c] ? ' align="' + tok.align[c] + '"' : '';
            out += '<td' + align + '>' + renderInline(row[c].tokens) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
    } else if (tok.type === 'html') {
      out += tok.text;
    }
  }
  return out;
}

export function parse(markdown) {
  const lx = new Lexer();
  const tokens = lx.lex(markdown);
  return renderBlocks(tokens);
}
