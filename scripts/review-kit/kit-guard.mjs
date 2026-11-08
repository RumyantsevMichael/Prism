#!/usr/bin/env node
// Names each raw design value and each control styled or written around the review app's kit.
// `node scripts/review-kit/kit-guard.mjs [root]` checks every stylesheet, script, and page under src/server/review/public/ and exits 1 on a finding.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = "src/server/review/public";
const CONTROL_ELEMENTS = ["button", "input", "select", "textarea", "dialog", "details", "summary", "option", "progress", "meter"];
const CONTROL_ROLES = ["button", "checkbox", "combobox", "dialog", "listbox", "menu", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "progressbar", "radio", "radiogroup", "slider", "switch", "tab", "tablist", "tooltip", "tree", "treeitem"];
const CONTROL_CLASS_ENDINGS = ["chip", "badge", "pill", "tag", "button", "btn", "tab", "tabs", "menu", "tooltip", "dialog", "modal", "popover", "drawer", "tree", "toast", "banner", "card", "panel", "field", "avatar", "stepper", "empty"];
const NAMED_COLORS = new Set("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" "));
const KEYWORDS = new Set(["none", "auto", "inherit", "initial", "unset"]);
const HEX = /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;

const isKit = (file) => /(?:^|\/)kit\//.test(file);
const rawValueExempt = (file) => /(?:^|\/)kit\/(?:tokens\.css|plantuml-defaults\.js)$/.test(file);

// Replaces every character of a span with a space, keeping line breaks, so offsets and line numbers stay put.
const blank = (text) => text.replace(/[^\n]/g, " ");

function stripCss(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, blank);
}

function stripHtml(text) {
  return text.replace(/<!--[\s\S]*?-->/g, blank);
}

// Blanks JavaScript comments and returns the spans of string and template text, which is where a script writes colors and markup.
function scanJs(text) {
  const out = text.split("");
  const strings = [];
  const stack = [];
  let index = 0;
  const blankRange = (from, to) => {
    for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
  };
  const readString = (quote) => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== quote && text[index] !== "\n") index += text[index] === "\\" ? 2 : 1;
    strings.push([start + 1, index]);
    index += 1;
  };
  const readTemplate = () => {
    let start = index;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index] === "`") {
        strings.push([start, index]);
        index += 1;
        stack.pop();
        return;
      } else if (text[index] === "$" && text[index + 1] === "{") {
        strings.push([start, index]);
        index += 2;
        stack.push({ kind: "expression", depth: 0 });
        return;
      } else index += 1;
    }
    strings.push([start, index]);
  };
  while (index < text.length) {
    const top = stack.at(-1);
    if (top?.kind === "template") {
      readTemplate();
      continue;
    }
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      blankRange(index, stop);
      index = stop;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      blankRange(index, stop);
      index = stop;
    } else if (char === '"' || char === "'") {
      readString(char);
    } else if (char === "`") {
      index += 1;
      stack.push({ kind: "template" });
    } else if (char === "{" && top?.kind === "expression") {
      top.depth += 1;
      index += 1;
    } else if (char === "}" && top?.kind === "expression") {
      if (top.depth === 0) {
        stack.pop();
        index += 1;
      } else {
        top.depth -= 1;
        index += 1;
      }
    } else index += 1;
  }
  return { text: out.join(""), strings };
}

function lineAt(text, offset) {
  let line = 1;
  for (let at = 0; at < offset; at += 1) if (text[at] === "\n") line += 1;
  return line;
}

// The end of a balanced parenthesis group that opens at `open`.
function closing(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")" && --depth === 0) return at + 1;
  }
  return text.length;
}

// Every color literal in a span: hex colors, color functions, and in CSS a named color other than transparent and currentColor.
function colorsIn(text, from, to, { named = false } = {}) {
  const span = text.slice(from, to);
  const found = [];
  for (const match of span.matchAll(HEX)) found.push({ at: from + match.index, value: match[0] });
  for (const match of span.matchAll(COLOR_FUNCTION)) {
    const open = match.index + match[0].length - 1;
    found.push({ at: from + match.index, value: span.slice(match.index, closing(span, open)) });
  }
  if (named) {
    const masked = span.replace(/(["'])(?:\\.|(?!\1).)*\1/g, blank).replace(/--[\w-]+/g, blank);
    for (const match of masked.matchAll(/(?<![\w-])[a-z]+(?![\w-])/gi)) {
      if (NAMED_COLORS.has(match[0].toLowerCase())) found.push({ at: from + match.index, value: match[0] });
    }
  }
  return found;
}

const SIZE_PROPERTY = /^(?:font-size|font|margin(?:-[\w-]+)?|padding(?:-[\w-]+)?|gap|row-gap|column-gap|border-radius(?:-[\w-]+)?|border-[\w-]+-radius|box-shadow|text-shadow|backdrop-filter|z-index)$/;
const TIME_PROPERTY = /^(?:transition|animation)(?:-[\w-]+)?$/;

// Each literal of a declaration value that a rule names: sizes and layers for size properties, times for motion properties.
function literalsIn(property, value) {
  const name = property.toLowerCase();
  const sizes = SIZE_PROPERTY.test(name);
  const times = TIME_PROPERTY.test(name);
  if (!sizes && !times) return [];
  // Strings, custom property names, and color functions hold no size literal of their own.
  let masked = value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, blank).replace(/--[\w-]+/g, blank);
  for (const match of [...masked.matchAll(COLOR_FUNCTION)].reverse()) {
    const end = closing(masked, match.index + match[0].length - 1);
    masked = masked.slice(0, match.index) + blank(masked.slice(match.index, end)) + masked.slice(end);
  }
  masked = masked.replace(HEX, blank);
  const found = [];
  const NUMBER = /(?<![\w.#-])-?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?([a-z%]*)/gi;
  for (const match of masked.matchAll(NUMBER)) {
    const unit = match[1].toLowerCase();
    if (times) {
      if (unit === "s" || unit === "ms") found.push({ offset: match.index, value: match[0] });
      continue;
    }
    if (Number.parseFloat(match[0]) === 0) continue;
    if (!unit && insideCalc(masked, match.index)) continue;
    found.push({ offset: match.index, value: match[0] });
  }
  return found;
}

function insideCalc(text, offset) {
  const stack = [];
  for (let at = 0; at < offset; at += 1) {
    if (text[at] === "(") stack.push(/calc$/i.test(text.slice(Math.max(0, at - 4), at)));
    else if (text[at] === ")") stack.pop();
  }
  return stack.includes(true);
}

// Walks the rules of a comment-free stylesheet, calling back with each selector list and each declaration and their offsets.
function walkCss(text, { selector, declaration }) {
  const visit = (from, to, inKeyframes) => {
    let at = from;
    while (at < to) {
      const open = text.indexOf("{", at);
      const semicolon = text.indexOf(";", at);
      if (open < 0 || open >= to) {
        declarations(at, to);
        return;
      }
      if (semicolon >= 0 && semicolon < open) {
        // A statement such as @import, or a declaration before a nested rule.
        declarations(at, semicolon + 1);
        at = semicolon + 1;
        continue;
      }
      let depth = 1;
      let close = open + 1;
      while (close < to && depth) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") depth -= 1;
        close += 1;
      }
      const head = text.slice(at, open);
      const trimmed = head.trim();
      if (trimmed.startsWith("@")) {
        const keyframes = /^@(?:-webkit-)?keyframes\b/i.test(trimmed);
        if (/^@(?:media|supports|layer|container|document|scope)\b/i.test(trimmed) || keyframes) visit(open + 1, close - 1, keyframes);
        else declarations(open + 1, close - 1);
      } else {
        if (!inKeyframes) selector(at, head);
        visit(open + 1, close - 1, false);
      }
      at = close;
    }
  };
  const declarations = (from, to) => {
    const body = text.slice(from, to);
    let start = 0;
    let depth = 0;
    let quote = null;
    for (let at = 0; at <= body.length; at += 1) {
      const char = body[at];
      if (quote) {
        if (char === "\\") at += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if ((char === ";" || at === body.length) && depth <= 0) {
        const part = body.slice(start, at);
        const colon = part.indexOf(":");
        if (colon > 0 && !/[{}]/.test(part)) {
          const property = part.slice(0, colon).trim();
          if (/^-?-?[\w-]+$/.test(property)) declaration(from + start, property, from + start + colon + 1, part.slice(colon + 1));
        }
        start = at + 1;
      }
    }
  };
  visit(0, text.length, false);
}

function controlSelector(selector) {
  const unquoted = selector.replace(/(["'])(?:\\.|(?!\1).)*\1/g, blank);
  const outsideAttributes = unquoted.replace(/\[[^\]]*\]/g, blank);
  if (new RegExp(`(?<![\\w.#:-])(?:${CONTROL_ELEMENTS.join("|")})(?![\\w-])`, "i").test(outsideAttributes)) return true;
  if (new RegExp(`\\[\\s*role\\s*[~|^$*]?=\\s*["']?(?:${CONTROL_ROLES.join("|")})["']?\\s*(?:[is]\\s*)?\\]`, "i").test(selector)) return true;
  if (/(?<![\w.#:-])prism-[\w-]+/.test(outsideAttributes) || /::part\(/.test(outsideAttributes)) return true;
  for (const match of outsideAttributes.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    const name = match[1];
    if (name.startsWith("tok-")) continue;
    if (CONTROL_CLASS_ENDINGS.some((ending) => name.endsWith(`-${ending}`))) return true;
  }
  return false;
}

// The comma-separated selectors of a selector list with their offsets in it.
function splitSelectors(head) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at <= head.length; at += 1) {
    const char = head[at];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if ((char === "," || at === head.length) && depth <= 0) {
      const raw = head.slice(start, at);
      const lead = raw.length - raw.trimStart().length;
      if (raw.trim()) parts.push({ offset: start + lead, value: raw.trim().replace(/\s+/g, " ") });
      start = at + 1;
    }
  }
  return parts;
}

function checkCss(file, source) {
  const text = stripCss(source);
  const findings = [];
  const add = (offset, rule, value) => findings.push({ file, line: lineAt(text, offset), rule, value });
  const raw = !rawValueExempt(file);
  walkCss(text, {
    selector(offset, head) {
      if (isKit(file)) return;
      for (const part of splitSelectors(head)) if (controlSelector(part.value)) add(offset + part.offset, "control-style", part.value);
    },
    declaration(offset, property, valueOffset, value) {
      if (!raw) return;
      for (const color of colorsIn(text, valueOffset, valueOffset + value.length, { named: true })) add(color.at, "raw-value", color.value);
      for (const literal of literalsIn(property, value)) add(valueOffset + literal.offset, "raw-value", literal.value);
    }
  });
  return findings;
}

const STYLE_PROPERTIES = { fontSize: "font-size", font: "font", gap: "gap", rowGap: "row-gap", columnGap: "column-gap", boxShadow: "box-shadow", textShadow: "text-shadow", backdropFilter: "backdrop-filter", zIndex: "z-index" };
const styleProperty = (name) => STYLE_PROPERTIES[name] ?? name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function checkMarkup(file, text, findings, ranges) {
  const add = (offset, rule, value) => findings.push({ file, line: lineAt(text, offset), rule, value });
  if (isKit(file)) return;
  const inRanges = (offset) => !ranges || ranges.some(([from, to]) => offset >= from && offset < to);
  for (const match of text.matchAll(new RegExp(`<(?:${CONTROL_ELEMENTS.join("|")})(?![\\w-])`, "g"))) if (inRanges(match.index)) add(match.index, "native-control", match[0]);
  for (const match of text.matchAll(new RegExp(`createElement\\(\\s*(["'\`])(?:${CONTROL_ELEMENTS.join("|")})\\1\\s*\\)`, "g"))) add(match.index, "native-control", match[0]);
  for (const match of text.matchAll(new RegExp(`(?<![\\w-])role\\s*=\\s*(["'])(?:${CONTROL_ROLES.join("|")})\\1`, "g"))) if (inRanges(match.index)) add(match.index, "native-control", match[0]);
  for (const match of text.matchAll(/(?<![\w-])title\s*=\s*(["'])(?:(?!\1)[^\n])*\1/g)) if (inRanges(match.index)) add(match.index, "native-control", match[0]);
}

function checkJs(file, source) {
  const { text, strings } = scanJs(source);
  const findings = [];
  const add = (offset, rule, value) => findings.push({ file, line: lineAt(text, offset), rule, value });
  if (!rawValueExempt(file)) {
    for (const [from, to] of strings) for (const color of colorsIn(text, from, to)) add(color.at, "raw-value", color.value);
    const literal = (property, valueOffset, value) => {
      for (const found of literalsIn(property, value)) add(valueOffset + found.offset, "raw-value", found.value);
    };
    for (const match of text.matchAll(/\.style\.([a-zA-Z]+)\s*=\s*(["'`])((?:(?!\2)[^\n])*)\2/g)) literal(styleProperty(match[1]), match.index + match[0].length - match[3].length - 1, match[3]);
    for (const match of text.matchAll(/\.style\.setProperty\(\s*(["'])([\w-]+)\1\s*,\s*(["'`])((?:(?!\3)[^\n])*)\3/g)) literal(match[2], match.index + match[0].length - match[4].length - 1, match[4]);
  }
  checkMarkup(file, text, findings, strings);
  return findings;
}

function checkHtml(file, source) {
  const text = stripHtml(source);
  const findings = [];
  if (!rawValueExempt(file)) for (const color of colorsIn(text, 0, text.length)) findings.push({ file, line: lineAt(text, color.at), rule: "raw-value", value: color.value });
  checkMarkup(file, text, findings, null);
  return findings;
}

/** Reads each file, relative to root, and resolves to its findings `{ file, line, rule, value }` sorted by file and line. */
export async function checkKitUsage({ root, files }) {
  const findings = [];
  for (const file of files) {
    const name = file.split(path.sep).join("/");
    const source = await readFile(path.join(root, file), "utf8");
    if (/\.css$/i.test(name)) findings.push(...checkCss(name, source));
    else if (/\.(?:m?js)$/i.test(name)) findings.push(...checkJs(name, source));
    else if (/\.html?$/i.test(name)) findings.push(...checkHtml(name, source));
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

async function listFiles(root, folder) {
  const out = [];
  let entries;
  try {
    entries = await readdir(path.join(root, folder), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const relative = `${folder}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await listFiles(root, relative));
    else if (entry.isFile() && /\.(?:css|m?js|html?)$/i.test(entry.name)) out.push(relative);
  }
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)));
  const findings = await checkKitUsage({ root, files: await listFiles(root, PUBLIC) });
  for (const finding of findings) console.log(`${finding.file}:${finding.line}: ${finding.rule} ${finding.value}`);
  process.exitCode = findings.length ? 1 : 0;
}
