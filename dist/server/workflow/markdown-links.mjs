// Generated from src/server/workflow/markdown-links.mts by scripts/native-build/compile.mjs.
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const LABEL_MAX = 999;
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
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xA0" };
class OverBudget extends Error {
}
const isBlank = (text) => /^[ \t]*$/.test(text);
function thematicBreak(text) {
  const marker = text[0];
  if (marker !== "*" && marker !== "-" && marker !== "_") return false;
  let count = 0;
  for (const character of text) {
    if (character === marker) count += 1;
    else if (character !== " " && character !== "	") return false;
  }
  return count >= 3;
}
const isSpace = (character) => character === " " || character === "	" || character === "\n";
function indentation(text, column) {
  let columns = 0, characters = 0;
  for (; characters < text.length; characters += 1) {
    if (text[characters] === " ") columns += 1;
    else if (text[characters] === "	") columns += 4 - (column + columns) % 4;
    else break;
  }
  return { columns, characters };
}
function stripColumns(text, column, count) {
  let taken = 0, index = 0;
  while (taken < count && index < text.length) {
    const width = text[index] === "	" ? 4 - (column + taken) % 4 : text[index] === " " ? 1 : 0;
    if (width === 0) break;
    if (taken + width > count) return { text: " ".repeat(taken + width - count) + text.slice(index + 1), column: column + count };
    taken += width;
    index += 1;
  }
  return { text: text.slice(index), column: column + taken };
}
function unescape(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/g, (whole, decimal, hex, name) => {
    if (name !== void 0) return NAMED_ENTITIES[name] ?? whole;
    const code = decimal !== void 0 ? Number(decimal) : Number.parseInt(hex, 16);
    return code > 0 && code <= 1114111 && !(code >= 55296 && code <= 57343) ? String.fromCodePoint(code) : "\uFFFD";
  });
}
const normalizeLabel = (label) => label.trim().replace(/[ \t\r\n]+/g, " ").toLowerCase().toUpperCase();
function scanners(text, budget) {
  const charge = (count) => {
    budget.left -= count;
    if (budget.left < 0) throw new OverBudget();
  };
  const label = (at) => {
    if (text[at] !== "[") return null;
    let index = at + 1;
    for (; index < text.length; index += 1) {
      if (index - at - 1 > LABEL_MAX) {
        charge(index - at);
        return null;
      }
      const character = text[index];
      if (character === "\\" && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (character === "[") {
        charge(index - at);
        return null;
      }
      if (character === "]") break;
    }
    charge(index - at);
    if (index >= text.length) return null;
    return { raw: text.slice(at + 1, index), end: index + 1 };
  };
  const destination = (at) => {
    if (text[at] === "<") {
      let index2 = at + 1;
      for (; index2 < text.length; index2 += 1) {
        const character = text[index2];
        if (character === "\\" && index2 + 1 < text.length && ASCII_PUNCTUATION.test(text[index2 + 1])) {
          index2 += 1;
          continue;
        }
        if (character === ">") break;
        if (character === "<" || character === "\n") {
          charge(index2 - at);
          return null;
        }
      }
      charge(index2 - at);
      if (index2 >= text.length) return null;
      return { value: unescape(text.slice(at + 1, index2)), end: index2 + 1 };
    }
    let index = at, depth = 0;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\" && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1])) {
        index += 1;
        continue;
      }
      const code = character.charCodeAt(0);
      if (code <= 32 || code === 127) break;
      if (character === "(") {
        depth += 1;
        if (depth > PAREN_DEPTH_MAX) {
          charge(index - at);
          return null;
        }
      } else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    charge(index - at + 1);
    if (index === at || depth !== 0) return null;
    return { value: unescape(text.slice(at, index)), end: index };
  };
  const title = (at) => {
    const open = text[at];
    const close = open === "(" ? ")" : open === '"' || open === "'" ? open : null;
    if (close === null) return null;
    let index = at + 1;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\" && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (character === close) break;
      if (open === "(" && character === "(") {
        charge(index - at);
        return null;
      }
    }
    charge(index - at);
    return index < text.length ? index + 1 : null;
  };
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
function takeDefinitions(text, definitions, budget) {
  const { label, destination, title, whitespace } = scanners(text, budget);
  let at = 0;
  for (; ; ) {
    const named = label(at);
    if (!named || text[named.end] !== ":" || isBlank(named.raw.replace(/\n/g, " "))) break;
    const target = destination(whitespace(named.end + 1));
    if (!target || target.value === "" && text[whitespace(named.end + 1)] !== "<") break;
    const lineEnd = (from) => {
      const index = text.indexOf("\n", from);
      return index < 0 ? text.length : index;
    };
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
function inlineLinks(text, definitions, budget, found) {
  const { charge, label, destination, title, whitespace } = scanners(text, budget);
  const runs = /* @__PURE__ */ new Map();
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
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
  const remembered = /* @__PURE__ */ new Map();
  const nextIndex = (needle, from) => {
    const known = remembered.get(needle);
    if (known !== void 0 && (known === -1 || known >= from)) return known;
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
  const html = (at) => {
    if (text.startsWith("<!-->", at)) return at + 5;
    if (text.startsWith("<!--->", at)) return at + 6;
    if (text.startsWith("<!--", at)) {
      const end = nextIndex("-->", at + 4);
      return end < 0 ? -1 : end + 3;
    }
    if (text.startsWith("<?", at)) {
      const end = nextIndex("?>", at + 2);
      return end < 0 ? -1 : end + 2;
    }
    if (text.startsWith("<![CDATA[", at)) {
      const end = nextIndex("]]>", at + 9);
      return end < 0 ? -1 : end + 3;
    }
    if (text.startsWith("<!", at)) return nextIndex(">", at) < 0 ? -1 : sticky(DECLARATION, at);
    const uri = sticky(AUTOLINK, at);
    if (uri >= 0) {
      autolink = text.slice(at + 1, uri - 1);
      return uri;
    }
    const email = sticky(EMAIL_AUTOLINK, at);
    if (email >= 0) {
      autolink = `mailto:${text.slice(at + 1, email - 1)}`;
      return email;
    }
    return sticky(INLINE_TAG, at);
  };
  let autolink = null;
  const links = [];
  const openers = [];
  let sequence = 0;
  let barrier = -1;
  for (let index = 0; index < text.length; ) {
    const character = text[index];
    if (character === "\\") {
      index += index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1]) ? 2 : 1;
      continue;
    }
    if (character === "`") {
      let end2 = index;
      while (text[end2] === "`") end2 += 1;
      const close = closingRun(end2 - index, end2);
      index = close < 0 ? end2 : close + (end2 - index);
      continue;
    }
    if (character === "<") {
      autolink = null;
      const end2 = html(index);
      if (autolink !== null) links.push(autolink);
      index = end2 < 0 ? index + 1 : end2;
      continue;
    }
    if (character === "!" && text[index + 1] === "[") {
      openers.push({ image: true, textStart: index + 2, links: links.length, sequence: sequence++ });
      index += 2;
      continue;
    }
    if (character === "[") {
      openers.push({ image: false, textStart: index + 1, links: links.length, sequence: sequence++ });
      index += 1;
      continue;
    }
    if (character !== "]") {
      index += 1;
      continue;
    }
    const opener = openers.pop();
    if (!opener || !opener.image && opener.sequence < barrier) {
      index += 1;
      continue;
    }
    let target = null, end = index + 1;
    if (text[index + 1] === "(") {
      let at = whitespace(index + 2);
      if (text[at] === ")") {
        target = "";
        end = at + 1;
      } else {
        const parsed = destination(at);
        if (parsed) {
          at = whitespace(parsed.end);
          if (at > parsed.end && `"'(`.includes(text[at])) {
            const closed = title(at);
            if (closed !== null) at = whitespace(closed);
          }
          if (text[at] === ")") {
            target = parsed.value;
            end = at + 1;
          }
        }
      }
    }
    if (target === null) {
      const following = text[index + 1] === "[" ? label(index + 1) : null;
      const raw = following && following.raw !== "" ? following.raw : text.slice(opener.textStart, index);
      charge(raw.length);
      const valid = raw.length <= LABEL_MAX && !isBlank(raw.replace(/\n/g, " ")) && (following && following.raw !== "" ? true : !/(^|[^\\])(\\\\)*[[\]]/.test(raw));
      const defined = valid ? definitions.get(normalizeLabel(raw)) : void 0;
      if (defined !== void 0) {
        target = defined;
        end = following ? following.end : index + 1;
      }
    }
    if (target === null) {
      index += 1;
      continue;
    }
    if (opener.image) links.length = opener.links;
    else {
      links.push(target);
      barrier = opener.sequence;
    }
    index = end;
  }
  for (const link of links) found(link);
}
function inlineTexts(text, budget) {
  const pieces = [];
  const definitions = /* @__PURE__ */ new Map();
  let containers = [];
  let leaf = null;
  const close = () => {
    if (leaf?.kind === "paragraph") pieces.push({ text: takeDefinitions(leaf.lines.join("\n"), definitions, budget) });
    leaf = null;
  };
  const interrupts = (line, column) => {
    const { columns, characters } = indentation(line, column);
    if (columns >= 4) return false;
    const rest = line.slice(characters);
    const fence = FENCE_OPEN.exec(rest);
    if (rest.startsWith(">") || fence && !(fence[1][0] === "`" && fence[2].includes("`")) || ATX_HEADING.test(rest) || thematicBreak(rest)) return true;
    return HTML_BLOCKS.some((block) => block.start.test(rest) && !block.not?.test(rest) && !block.paragraphStays) || BULLET.test(rest) || ORDERED.test(rest);
  };
  for (const original of text.split(/\r\n|\n|\r/)) {
    budget.left -= original.length + 1;
    if (budget.left < 0) throw new OverBudget();
    let line = original, column = 0, matched = 0;
    for (const container of containers) {
      if (container.kind === "quote") {
        const { columns: columns2, characters: characters2 } = indentation(line, column);
        if (columns2 > 3 || line[characters2] !== ">") break;
        ({ text: line, column } = stripColumns(line, column, columns2));
        line = line.slice(1);
        column += 1;
        if (line[0] === " " || line[0] === "	") ({ text: line, column } = stripColumns(line, column, 1));
      } else if (isBlank(line)) {
        if (container.empty) break;
        line = "";
      } else {
        const { columns: columns2 } = indentation(line, column);
        if (columns2 < container.indent) break;
        ({ text: line, column } = stripColumns(line, column, container.indent));
        container.empty = false;
      }
      matched += 1;
    }
    if (matched < containers.length) {
      if (leaf?.kind === "paragraph" && !isBlank(line) && !interrupts(line, column)) {
        leaf.lines.push(line.replace(/^[ \t]+/, ""));
        continue;
      }
      close();
      containers = containers.slice(0, matched);
    }
    if (leaf?.kind === "fence") {
      const { columns: columns2, characters: characters2 } = indentation(line, column);
      const rest2 = line.slice(characters2);
      const closing = new RegExp(`^${leaf.marker[0] === "`" ? "`" : "~"}{${leaf.marker.length},}[ \\t]*$`);
      if (columns2 <= 3 && closing.test(rest2)) leaf = null;
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
    for (; ; ) {
      const { columns: columns2, characters: characters2 } = indentation(line, column);
      if (columns2 >= 4) break;
      const rest2 = line.slice(characters2);
      if (rest2.startsWith(">")) {
        close();
        ({ text: line, column } = stripColumns(line, column, columns2));
        line = line.slice(1);
        column += 1;
        if (line[0] === " " || line[0] === "	") ({ text: line, column } = stripColumns(line, column, 1));
        containers.push({ kind: "quote" });
        if (containers.length > NESTING_MAX) throw new OverBudget();
        continue;
      }
      if (thematicBreak(rest2) || leaf?.kind === "paragraph" && SETEXT_UNDERLINE.test(rest2) && !isBlank(takeDefinitions(leaf.lines.join("\n"), /* @__PURE__ */ new Map(), budget).replace(/\n/g, " "))) break;
      const bullet = BULLET.exec(rest2);
      const ordered = bullet ? null : ORDERED.exec(rest2);
      const marker = bullet?.[0] ?? ordered?.[0] ?? null;
      if (marker === null) break;
      const after = rest2.slice(marker.length);
      if (leaf?.kind === "paragraph" && (isBlank(after) || ordered && ordered[1] !== "1")) break;
      const indented = stripColumns(line, column, columns2);
      const start = { text: indented.text.slice(marker.length), column: indented.column + marker.length };
      const spacing = indentation(start.text, start.column).columns;
      const gap = isBlank(after) || spacing >= 5 ? 1 : spacing;
      close();
      containers.push({ kind: "item", indent: columns2 + marker.length + gap, empty: isBlank(after) });
      if (containers.length > NESTING_MAX) throw new OverBudget();
      ({ text: line, column } = isBlank(after) ? { text: "", column: start.column } : stripColumns(start.text, start.column, gap));
    }
    if (isBlank(line)) {
      close();
      continue;
    }
    const { columns, characters } = indentation(line, column);
    if (columns >= 4) {
      if (leaf?.kind === "paragraph") leaf.lines.push(line.replace(/^[ \t]+/, ""));
      else {
        close();
        leaf = { kind: "indented" };
      }
      continue;
    }
    const rest = line.slice(characters);
    const fence = FENCE_OPEN.exec(rest);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      close();
      leaf = { kind: "fence", marker: fence[1] };
      continue;
    }
    if (ATX_HEADING.test(rest)) {
      close();
      pieces.push({ text: rest.replace(/^#{1,6}/, "") });
      continue;
    }
    if (leaf?.kind === "paragraph" && SETEXT_UNDERLINE.test(rest) && !isBlank(takeDefinitions(leaf.lines.join("\n"), /* @__PURE__ */ new Map(), budget).replace(/\n/g, " "))) {
      close();
      continue;
    }
    if (thematicBreak(rest)) {
      close();
      continue;
    }
    const block = HTML_BLOCKS.find((candidate) => candidate.start.test(rest) && !candidate.not?.test(rest) && !(candidate.paragraphStays && leaf?.kind === "paragraph"));
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
function markdownLinkDestinations(text) {
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
export {
  markdownLinkDestinations
};
