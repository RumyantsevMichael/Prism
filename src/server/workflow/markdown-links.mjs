// The destinations of the links that a Markdown file holds, read as CommonMark reads them, so text that CommonMark shows as code, as raw HTML, or as escaped characters names no link.
// Prism reads them to find the ADRs that an initiative's contracts cite, so the reader covers the block structure that decides where inline text starts and ends,
// block quotes, list items, fenced and indented code, HTML blocks, headings, and paragraphs, and inside inline text code spans, raw HTML, autolinks, backslash escapes, inline links, and reference links.
// An image is no link, and neither is a link inside an image's description, which CommonMark shows as plain alternative text.

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const LABEL_MAX = 999;
// Containers nest no deeper than this, so a line of thousands of list markers or quote markers stops the read rather than taking time with the square of its length.
const NESTING_MAX = 64;
const PAREN_DEPTH_MAX = 32;

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const BULLET = /^([-+*])(?=[ \t]|$)/;
const ORDERED = /^(\d{1,9})([.)])(?=[ \t]|$)/;
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const ATTRIBUTE = String.raw`(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^"'=<>\x60\s]+|'[^']*'|"[^"]*"))?)`;
const OPEN_TAG = String.raw`<[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\s*\/?>`;
const CLOSING_TAG = String.raw`<\/[A-Za-z][A-Za-z0-9-]*\s*>`;
// The seven kinds of HTML block, each with the condition that ends it: a line that holds the end text, or a blank line; the seventh cannot interrupt a paragraph.
const HTML_BLOCKS = [
  { start: /^<(?:script|pre|style|textarea)(?:\s|>|$)/i, end: /<\/(?:script|pre|style|textarea)>/i },
  { start: /^<!--/, end: /-->/ },
  { start: /^<\?/, end: /\?>/ },
  { start: /^<![A-Za-z]/, end: />/ },
  { start: /^<!\[CDATA\[/, end: /\]\]>/ },
  { start: new RegExp(String.raw`^<\/?(?:${BLOCK_TAGS})(?:\s|\/?>|$)`, "i"), end: null },
  { start: new RegExp(String.raw`^(?:${OPEN_TAG}|${CLOSING_TAG})\s*$`), end: null, paragraphStays: true, not: /^<\/?(?:script|pre|style|textarea)(?:\s|\/?>|$)/i }
];
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*>/y;
const EMAIL_AUTOLINK = /<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>/y;
const INLINE_TAG = new RegExp(`${OPEN_TAG}|${CLOSING_TAG}`, "y");
const DECLARATION = /<![A-Za-z][^>]*>/y;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

class OverBudget extends Error {}

const isBlank = (text) => /^[ \t]*$/.test(text);

// A thematic break: three or more of one of *, -, and _, with only spaces and tabs among them, looked at once from left to right.
function thematicBreak(text) {
  const marker = text[0];
  if (marker !== "*" && marker !== "-" && marker !== "_") return false;
  let count = 0;
  for (const character of text) {
    if (character === marker) count += 1;
    else if (character !== " " && character !== "\t") return false;
  }
  return count >= 3;
}
const isSpace = (character) => character === " " || character === "\t" || character === "\n";

// The columns and characters of a line's leading spaces and tabs, with a tab reaching the next multiple of four from the line's column.
function indentation(text, column) {
  let columns = 0, characters = 0;
  for (; characters < text.length; characters += 1) {
    if (text[characters] === " ") columns += 1;
    else if (text[characters] === "\t") columns += 4 - ((column + columns) % 4);
    else break;
  }
  return { columns, characters };
}

// A line without its first count columns of indentation, a tab that reaches past them leaving the rest of its width as spaces.
function stripColumns(text, column, count) {
  let taken = 0, index = 0;
  while (taken < count && index < text.length) {
    const width = text[index] === "\t" ? 4 - ((column + taken) % 4) : text[index] === " " ? 1 : 0;
    if (width === 0) break;
    if (taken + width > count) return { text: " ".repeat(taken + width - count) + text.slice(index + 1), column: column + count };
    taken += width;
    index += 1;
  }
  return { text: text.slice(index), column: column + taken };
}

function unescape(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/g, (whole, decimal, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

const normalizeLabel = (label) => label.trim().replace(/[ \t\r\n]+/g, " ").toLowerCase().toUpperCase();

/**
 * The parsers that inline text and link reference definitions share, over one text, each charging the characters it looks at to budget,
 * so a text built to make the reader look at its characters again and again stops the read instead of holding the server.
 */
function scanners(text, budget) {
  const charge = (count) => { budget.left -= count; if (budget.left < 0) throw new OverBudget(); };
  // A link label: its raw text and the index after its closing bracket, or null; [] gives the empty label, which only a collapsed reference takes.
  const label = (at) => {
    if (text[at] !== "[") return null;
    let index = at + 1;
    for (; index < text.length; index += 1) {
      if (index - at - 1 > LABEL_MAX) { charge(index - at); return null; }
      const character = text[index];
      if (character === "\\" && index + 1 < text.length) { index += 1; continue; }
      if (character === "[") { charge(index - at); return null; }
      if (character === "]") break;
    }
    charge(index - at);
    if (index >= text.length) return null;
    return { raw: text.slice(at + 1, index), end: index + 1 };
  };
  // A link destination at an index: its unescaped value and the index after it, or null.
  const destination = (at) => {
    if (text[at] === "<") {
      let index = at + 1;
      for (; index < text.length; index += 1) {
        const character = text[index];
        if (character === "\\" && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1])) { index += 1; continue; }
        if (character === ">" ) break;
        if (character === "<" || character === "\n") { charge(index - at); return null; }
      }
      charge(index - at);
      if (index >= text.length) return null;
      return { value: unescape(text.slice(at + 1, index)), end: index + 1 };
    }
    let index = at, depth = 0;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\" && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1])) { index += 1; continue; }
      const code = character.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f) break;
      if (character === "(") { depth += 1; if (depth > PAREN_DEPTH_MAX) { charge(index - at); return null; } }
      else if (character === ")") { if (depth === 0) break; depth -= 1; }
    }
    charge(index - at + 1);
    if (index === at || depth !== 0) return null;
    return { value: unescape(text.slice(at, index)), end: index };
  };
  // A link title at an index, in double quotes, single quotes, or parentheses: the index after it, or null.
  const title = (at) => {
    const open = text[at];
    const close = open === "(" ? ")" : open === "\"" || open === "'" ? open : null;
    if (close === null) return null;
    let index = at + 1;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\" && index + 1 < text.length) { index += 1; continue; }
      if (character === close) break;
      if (open === "(" && character === "(") { charge(index - at); return null; }
    }
    charge(index - at);
    return index < text.length ? index + 1 : null;
  };
  // Spaces and tabs with at most one line ending among them: the index after them.
  const whitespace = (at) => {
    let index = at, endings = 0;
    while (index < text.length && isSpace(text[index])) {
      if (text[index] === "\n" && (endings += 1) > 1) break;
      index += 1;
    }
    charge(index - at);
    return index;
  };
  return { charge, label, destination, title, whitespace };
}

/** The link reference definitions that open a paragraph: the definitions it holds, added to definitions where no earlier one has the label, and the rest of its text. */
function takeDefinitions(text, definitions, budget) {
  const { label, destination, title, whitespace } = scanners(text, budget);
  let at = 0;
  for (;;) {
    const named = label(at);
    if (!named || text[named.end] !== ":" || isBlank(named.raw.replace(/\n/g, " "))) break;
    const target = destination(whitespace(named.end + 1));
    if (!target || (target.value === "" && text[whitespace(named.end + 1)] !== "<")) break;
    const lineEnd = (from) => { const index = text.indexOf("\n", from); return index < 0 ? text.length : index; };
    // A title is optional; a definition whose title does not end its line keeps no title, and then its destination must end its line.
    let end = null;
    const afterTarget = whitespace(target.end);
    if (afterTarget > target.end) {
      const closed = title(afterTarget);
      if (closed !== null) {
        const stop = lineEnd(closed);
        if (isBlank(text.slice(closed, stop))) end = stop;
      }
    }
    if (end === null) {
      const stop = lineEnd(target.end);
      if (!isBlank(text.slice(target.end, stop))) break;
      end = stop;
    }
    const key = normalizeLabel(named.raw);
    if (!definitions.has(key)) definitions.set(key, target.value);
    at = Math.min(text.length, end + 1);
  }
  return text.slice(at);
}

/**
 * The destinations of the links of one piece of inline text, in order: inline links and reference links whose label a definition holds.
 * Each found destination is passed to found.
 */
function inlineLinks(text, definitions, budget, found) {
  const { charge, label, destination, title, whitespace } = scanners(text, budget);
  // Every maximal run of backticks by its length, so a code span finds its closing run without looking at the text again.
  const runs = new Map();
  for (let index = 0; index < text.length;) {
    if (text[index] !== "`") { index += 1; continue; }
    let end = index;
    while (text[end] === "`") end += 1;
    const length = end - index;
    if (!runs.has(length)) runs.set(length, { starts: [], next: 0 });
    runs.get(length).starts.push(index);
    index = end;
  }
  const closingRun = (length, from) => {
    const entry = runs.get(length);
    if (!entry) return -1;
    while (entry.next < entry.starts.length && entry.starts[entry.next] < from) entry.next += 1;
    return entry.next < entry.starts.length ? entry.starts[entry.next] : -1;
  };
  // The next index of a text from an index, remembered so that a search never looks at the same characters twice.
  const remembered = new Map();
  const nextIndex = (needle, from) => {
    const known = remembered.get(needle);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const index = text.indexOf(needle, from);
    charge((index < 0 ? text.length : index) - from);
    remembered.set(needle, index);
    return index;
  };
  const sticky = (pattern, at) => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return -1;
    charge(match[0].length);
    return at + match[0].length;
  };
  // Raw HTML or an autolink at a "<": the index after it, or -1.
  const html = (at) => {
    if (text.startsWith("<!-->", at)) return at + 5;
    if (text.startsWith("<!--->", at)) return at + 6;
    if (text.startsWith("<!--", at)) { const end = nextIndex("-->", at + 4); return end < 0 ? -1 : end + 3; }
    if (text.startsWith("<?", at)) { const end = nextIndex("?>", at + 2); return end < 0 ? -1 : end + 2; }
    if (text.startsWith("<![CDATA[", at)) { const end = nextIndex("]]>", at + 9); return end < 0 ? -1 : end + 3; }
    if (text.startsWith("<!", at)) return nextIndex(">", at) < 0 ? -1 : sticky(DECLARATION, at);
    const uri = sticky(AUTOLINK, at);
    if (uri >= 0) { autolink = text.slice(at + 1, uri - 1); return uri; }
    const email = sticky(EMAIL_AUTOLINK, at);
    if (email >= 0) { autolink = `mailto:${text.slice(at + 1, email - 1)}`; return email; }
    return sticky(INLINE_TAG, at);
  };
  // The destination of the autolink that html last read, which is a link too, though always to another site.
  let autolink = null;
  const links = [];
  const openers = [];
  let sequence = 0;
  // Openers of a link that were opened before a link that closed: a link holds no link, so they open none.
  let barrier = -1;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === "\\") { index += index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1]) ? 2 : 1; continue; }
    if (character === "`") {
      let end = index;
      while (text[end] === "`") end += 1;
      const close = closingRun(end - index, end);
      index = close < 0 ? end : close + (end - index);
      continue;
    }
    if (character === "<") {
      autolink = null;
      const end = html(index);
      if (autolink !== null) links.push(autolink);
      index = end < 0 ? index + 1 : end;
      continue;
    }
    if (character === "!" && text[index + 1] === "[") { openers.push({ image: true, textStart: index + 2, links: links.length, sequence: sequence++ }); index += 2; continue; }
    if (character === "[") { openers.push({ image: false, textStart: index + 1, links: links.length, sequence: sequence++ }); index += 1; continue; }
    if (character !== "]") { index += 1; continue; }
    const opener = openers.pop();
    if (!opener || (!opener.image && opener.sequence < barrier)) { index += 1; continue; }
    let target = null, end = index + 1;
    if (text[index + 1] === "(") {
      let at = whitespace(index + 2);
      if (text[at] === ")") { target = ""; end = at + 1; }
      else {
        const parsed = destination(at);
        if (parsed) {
          at = whitespace(parsed.end);
          if (at > parsed.end && "\"'(".includes(text[at])) { const closed = title(at); if (closed !== null) at = whitespace(closed); }
          if (text[at] === ")") { target = parsed.value; end = at + 1; }
        }
      }
    }
    if (target === null) {
      // A full or collapsed reference names its label after the text, and a shortcut reference is the text alone; a full reference whose label has no definition is no link.
      const following = text[index + 1] === "[" ? label(index + 1) : null;
      const raw = following && following.raw !== "" ? following.raw : text.slice(opener.textStart, index);
      charge(raw.length);
      const valid = raw.length <= LABEL_MAX && !isBlank(raw.replace(/\n/g, " ")) && (following && following.raw !== "" ? true : !/(^|[^\\])(\\\\)*[[\]]/.test(raw));
      const defined = valid ? definitions.get(normalizeLabel(raw)) : undefined;
      if (defined !== undefined) { target = defined; end = following ? following.end : index + 1; }
    }
    if (target === null) { index += 1; continue; }
    if (opener.image) links.length = opener.links;
    else { links.push(target); barrier = opener.sequence; }
    index = end;
  }
  for (const link of links) found(link);
}

/** The block structure of a Markdown text as its pieces of inline text, the paragraphs and headings in order, with the link reference definitions that its paragraphs open with. */
function inlineTexts(text, budget) {
  const pieces = [];
  const definitions = new Map();
  let containers = [];
  let leaf = null;
  const close = () => {
    if (leaf?.kind === "paragraph") pieces.push({ text: takeDefinitions(leaf.lines.join("\n"), definitions, budget) });
    leaf = null;
  };
  // A line that a container it does not continue would hold opens a block of its own rather than going on with the open paragraph:
  // the container that it continues holds no paragraph, so a list item of any number or none counts, while the seventh kind of HTML block still never interrupts a paragraph.
  const interrupts = (line, column) => {
    const { columns, characters } = indentation(line, column);
    if (columns >= 4) return false;
    const rest = line.slice(characters);
    const fence = FENCE_OPEN.exec(rest);
    if (rest.startsWith(">") || (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) || ATX_HEADING.test(rest) || thematicBreak(rest)) return true;
    return HTML_BLOCKS.some((block) => block.start.test(rest) && !(block.not?.test(rest)) && !block.paragraphStays) || BULLET.test(rest) || ORDERED.test(rest);
  };
  for (const original of text.split(/\r\n|\n|\r/)) {
    budget.left -= original.length + 1;
    if (budget.left < 0) throw new OverBudget();
    let line = original, column = 0, matched = 0;
    for (const container of containers) {
      if (container.kind === "quote") {
        const { columns, characters } = indentation(line, column);
        if (columns > 3 || line[characters] !== ">") break;
        ({ text: line, column } = stripColumns(line, column, columns));
        line = line.slice(1);
        column += 1;
        if (line[0] === " " || line[0] === "\t") ({ text: line, column } = stripColumns(line, column, 1));
      } else if (isBlank(line)) {
        // A list item holds at most one blank line before its content.
        if (container.empty) break;
        line = "";
      } else {
        const { columns } = indentation(line, column);
        if (columns < container.indent) break;
        ({ text: line, column } = stripColumns(line, column, container.indent));
        container.empty = false;
      }
      matched += 1;
    }
    if (matched < containers.length) {
      // A lazy continuation line goes on with the open paragraph of a container that it does not continue.
      if (leaf?.kind === "paragraph" && !isBlank(line) && !interrupts(line, column)) { leaf.lines.push(line.replace(/^[ \t]+/, "")); continue; }
      close();
      containers = containers.slice(0, matched);
    }
    if (leaf?.kind === "fence") {
      const { columns, characters } = indentation(line, column);
      const rest = line.slice(characters);
      const closing = new RegExp(`^${leaf.marker[0] === "`" ? "`" : "~"}{${leaf.marker.length},}[ \\t]*$`);
      if (columns <= 3 && closing.test(rest)) leaf = null;
      continue;
    }
    if (leaf?.kind === "html") {
      if (leaf.end === null ? isBlank(line) : leaf.end.test(line)) leaf = null;
      continue;
    }
    if (leaf?.kind === "indented") {
      if (isBlank(line) || indentation(line, column).columns >= 4) continue;
      leaf = null;
    }
    // Container starts: block quotes and list items, which a line may open one inside another.
    for (;;) {
      const { columns, characters } = indentation(line, column);
      if (columns >= 4) break;
      const rest = line.slice(characters);
      if (rest.startsWith(">")) {
        close();
        ({ text: line, column } = stripColumns(line, column, columns));
        line = line.slice(1);
        column += 1;
        if (line[0] === " " || line[0] === "\t") ({ text: line, column } = stripColumns(line, column, 1));
        containers.push({ kind: "quote" });
        if (containers.length > NESTING_MAX) throw new OverBudget();
        continue;
      }
      if (thematicBreak(rest) || (leaf?.kind === "paragraph" && SETEXT_UNDERLINE.test(rest) && !isBlank(takeDefinitions(leaf.lines.join("\n"), new Map(), budget).replace(/\n/g, " ")))) break;
      const bullet = BULLET.exec(rest);
      const ordered = bullet ? null : ORDERED.exec(rest);
      const marker = bullet?.[0] ?? ordered?.[0] ?? null;
      if (marker === null) break;
      const after = rest.slice(marker.length);
      if (leaf?.kind === "paragraph" && (isBlank(after) || (ordered && ordered[1] !== "1"))) break;
      const indented = stripColumns(line, column, columns);
      const start = { text: indented.text.slice(marker.length), column: indented.column + marker.length };
      const spacing = indentation(start.text, start.column).columns;
      const gap = isBlank(after) || spacing >= 5 ? 1 : spacing;
      close();
      containers.push({ kind: "item", indent: columns + marker.length + gap, empty: isBlank(after) });
      if (containers.length > NESTING_MAX) throw new OverBudget();
      ({ text: line, column } = isBlank(after) ? { text: "", column: start.column } : stripColumns(start.text, start.column, gap));
    }
    if (isBlank(line)) { close(); continue; }
    const { columns, characters } = indentation(line, column);
    if (columns >= 4) {
      if (leaf?.kind === "paragraph") leaf.lines.push(line.replace(/^[ \t]+/, ""));
      else { close(); leaf = { kind: "indented" }; }
      continue;
    }
    const rest = line.slice(characters);
    const fence = FENCE_OPEN.exec(rest);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) { close(); leaf = { kind: "fence", marker: fence[1] }; continue; }
    if (ATX_HEADING.test(rest)) { close(); pieces.push({ text: rest.replace(/^#{1,6}/, "") }); continue; }
    // An underline after a paragraph makes it a heading, unless link reference definitions are all it holds: then the line is a thematic break or goes on with the paragraph.
    if (leaf?.kind === "paragraph" && SETEXT_UNDERLINE.test(rest) && !isBlank(takeDefinitions(leaf.lines.join("\n"), new Map(), budget).replace(/\n/g, " "))) { close(); continue; }
    if (thematicBreak(rest)) { close(); continue; }
    const block = HTML_BLOCKS.find((candidate) => candidate.start.test(rest) && !(candidate.not?.test(rest)) && !(candidate.paragraphStays && leaf?.kind === "paragraph"));
    if (block) {
      close();
      if (!(block.end !== null && block.end.test(rest))) leaf = { kind: "html", end: block.end };
      continue;
    }
    if (leaf?.kind === "paragraph") leaf.lines.push(rest);
    else leaf = { kind: "paragraph", lines: [rest] };
  }
  close();
  return { pieces, definitions };
}

/**
 * The destinations of the links of a Markdown text, as CommonMark reads it, in the order they appear, with backslash escapes and character references resolved;
 * images, and links inside their descriptions, are left out. A text whose syntax would make the read look at its characters many times over gives null.
 */
export function markdownLinkDestinations(text) {
  const budget = { left: 32 * text.length + 65536 };
  try {
    const { pieces, definitions } = inlineTexts(text, budget);
    const found = [];
    for (const piece of pieces) inlineLinks(piece.text, definitions, budget, (link) => found.push(link));
    return found;
  } catch (error) {
    if (error instanceof OverBudget) return null;
    throw error;
  }
}
