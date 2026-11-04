import { escapeHtml } from "./util.js";

// Highlights source text with a small scanner: comments, strings, numbers, keywords, literals, types, function calls, and a few per-language marks.
// It reads tokens, not grammar, so it never fails on odd input; a language it does not know stays plain text.

const words = (text) => new Set(text.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = "as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield";
const JS_LITERALS = "true false null undefined NaN Infinity";

// A string rule is [open, close, escapes, multiline]; a comment rule is [open, close] with close "\n" for a line comment.
const C_COMMENTS = [["//", "\n"], ["/*", "*/"]];
const HASH_COMMENTS = [["#", "\n"]];

const LANGUAGES = {
  javascript: { keywords: words(JS_KEYWORDS), literals: words(JS_LITERALS), comments: C_COMMENTS, strings: [['"', '"', true], ["'", "'", true], ["`", "`", true, true]] },
  rust: {
    keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
    literals: words("true false None Some Ok Err"),
    comments: C_COMMENTS,
    strings: [['"', '"', true, true]],
    macros: true,
    attributes: /#!?\[[^\]\n]*\]/y
  },
  go: {
    keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    literals: words("true false nil iota"),
    comments: C_COMMENTS,
    strings: [['"', '"', true], ["`", "`", false, true], ["'", "'", true]]
  },
  c: {
    keywords: words("abstract auto break case catch class const constexpr continue default delete do else enum explicit extends extern final finally for fun goto if implements import in inline interface internal is namespace new object operator override package private protected public return sealed static struct super switch template this throw throws try typedef typename union using val var virtual void volatile when while"),
    literals: words("true false null nullptr NULL"),
    comments: C_COMMENTS,
    strings: [['"""', '"""', false, true], ['"', '"', true], ["'", "'", true]],
    directives: /#\s*[a-z]+/y
  },
  python: {
    keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield"),
    literals: words("True False None self"),
    comments: HASH_COMMENTS,
    strings: [['"""', '"""', true, true], ["'''", "'''", true, true], ['"', '"', true], ["'", "'", true]],
    decorators: /@[A-Za-z_][\w.]*/y
  },
  shell: {
    keywords: words("if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit source alias"),
    literals: words("true false"),
    comments: HASH_COMMENTS,
    strings: [['"', '"', true, true], ["'", "'", false, true]],
    variables: /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@#?$*!-])/y
  },
  json: { literals: words("true false null"), comments: C_COMMENTS, strings: [['"', '"', true]], keys: true },
  yaml: { literals: words("true false null yes no on off ~"), comments: HASH_COMMENTS, strings: [['"', '"', true], ["'", "'", false]], keys: /[A-Za-z_][\w .\/-]*(?=:(?:\s|$))/y },
  toml: { literals: words("true false"), comments: HASH_COMMENTS, strings: [['"""', '"""', true, true], ['"', '"', true], ["'", "'", false]], keys: /[A-Za-z_][\w.-]*(?=\s*=)/y, sections: /^\[[^\]\n]*\]/my },
  css: {
    keywords: words("important"),
    comments: [["/*", "*/"]],
    strings: [['"', '"', true], ["'", "'", true]],
    keys: /-{0,2}[A-Za-z][\w-]*(?=\s*:\s*[^\s{;])/y,
    atRules: /@[A-Za-z-]+/y,
    units: true
  },
  sql: {
    keywords: words("add all alter and as asc begin between by case check column commit constraint create cross default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction union unique update using values view when where with"),
    literals: words("true false null"),
    comments: [["--", "\n"], ["/*", "*/"]],
    strings: [["'", "'", true], ['"', '"', true]],
    caseless: true
  },
  markup: { markup: true },
  plantuml: {
    keywords: words("@startuml @enduml @startmindmap @endmindmap actor participant boundary control entity database collections queue usecase class interface abstract enum package namespace node component rectangle frame folder cloud artifact card note end as of left right top bottom over title legend skinparam alt else opt loop par group activate deactivate return if then endif while endwhile repeat start stop fork again partition"),
    comments: [["'", "\n"], ["/'", "'/"]],
    strings: [['"', '"', false]],
    directives: /!\w+/y
  },
  gherkin: {
    keywords: words("Feature Rule Background Scenario Example Examples Outline Template Given When Then And But Scenarios"),
    comments: HASH_COMMENTS,
    strings: [['"""', '"""', false, true], ['"', '"', false]],
    decorators: /@[\w-]+/y,
    placeholders: /<[^>\n]+>/y
  },
  diff: { diff: true },
  markdown: { markdown: true }
};

const ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "javascript", mts: "javascript", cts: "javascript", tsx: "javascript", typescript: "javascript", node: "javascript",
  rs: "rust", golang: "go",
  h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", "c++": "c", cs: "c", csharp: "c", java: "c", kt: "c", kts: "c", kotlin: "c", swift: "c", scala: "c", dart: "c", php: "c",
  py: "python", pyi: "python",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", console: "shell", shellsession: "shell", dockerfile: "shell", makefile: "shell", mk: "shell",
  jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", webmanifest: "json",
  yml: "yaml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml", env: "toml",
  scss: "css", less: "css", postcss: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", plist: "markup",
  puml: "plantuml", pu: "plantuml", uml: "plantuml", iuml: "plantuml", wsd: "plantuml",
  feature: "gherkin", cucumber: "gherkin",
  patch: "diff",
  md: "markdown", mdx: "markdown"
};

const NAMED_FILES = { dockerfile: "shell", makefile: "shell", gnumakefile: "shell", justfile: "shell", ".bashrc": "shell", ".zshrc": "shell", ".env": "toml", ".gitignore": "shell", ".npmrc": "toml", ".editorconfig": "toml" };

// The language of a fence's info string, such as `ts` or `json title="x"`, or of a file path by its name or extension.
export function languageOf(nameOrPath) {
  if (!nameOrPath) return null;
  const value = String(nameOrPath).trim().toLowerCase();
  const fence = value.split(/[\s{,]/)[0];
  if (LANGUAGES[fence]) return fence;
  if (ALIASES[fence]) return ALIASES[fence];
  const base = value.split(/[\\/]/).pop();
  if (NAMED_FILES[base]) return NAMED_FILES[base];
  const extension = base.includes(".") ? base.split(".").pop() : "";
  return LANGUAGES[extension] ? extension : ALIASES[extension] ?? null;
}

// Very large inputs stay plain, so a generated file never stalls the page.
const LIMIT = 400_000;
// Data formats have no types or calls, so a capitalized word or a word before a parenthesis stays plain there.
const DATA_LANGUAGES = new Set(["json", "yaml", "toml", "gherkin", "plantuml", "markdown"]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?:[a-zA-Z%_]\w*)?/y;

function at(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0] ?? null;
}

function closeOf(text, start, close, escapes) {
  for (let index = start; index < text.length; index += 1) {
    if (escapes && text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text.startsWith(close, index)) return index + close.length;
  }
  return text.length;
}

function scanMarkup(text) {
  const tokens = [];
  const pattern = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:.-]*|\/?>|[A-Za-z_:][\w:.-]*(?==)|"[^"]*"|'[^']*'|&[#\w]+;/g;
  let last = 0;
  let inTag = false;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    let type = null;
    if (value.startsWith("<!--")) type = "comment";
    else if (value.startsWith("<")) { type = "tag"; inTag = true; }
    else if (value.endsWith(">")) { type = inTag ? "tag" : null; inTag = false; }
    else if (value.startsWith("&")) type = "literal";
    else if (inTag) type = /^["']/.test(value) ? "string" : "attr";
    if (!type) continue;
    if (match.index > last) tokens.push([null, text.slice(last, match.index)]);
    tokens.push([type, value]);
    last = match.index + value.length;
  }
  if (last < text.length) tokens.push([null, text.slice(last)]);
  return tokens;
}

function scanLines(text, classify) {
  return text.split(/(?<=\n)/).map((line) => [classify(line), line]);
}

function scan(text, language) {
  const spec = LANGUAGES[language];
  if (spec.markup) return scanMarkup(text);
  if (spec.diff) return scanLines(text, (line) => (/^(\+\+\+|---)/.test(line) ? "meta" : line.startsWith("+") ? "inserted" : line.startsWith("-") ? "deleted" : line.startsWith("@@") ? "meta" : null));
  if (spec.markdown) return scanLines(text, (line) => (/^#{1,6}\s/.test(line) ? "title" : /^\s*([-*+]|\d+[.)])\s/.test(line) ? "bullet" : null));
  const tokens = [];
  let plain = "";
  const push = (type, value) => {
    if (!type) {
      plain += value;
      return;
    }
    if (plain) tokens.push([null, plain]);
    plain = "";
    tokens.push([type, value]);
  };
  const lineStart = (index) => index === 0 || text[index - 1] === "\n";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const comment = spec.comments?.find(([open]) => text.startsWith(open, index) && (open !== "#" || language !== "shell" || index === 0 || /[\s;|&(]/.test(text[index - 1])));
    if (comment) {
      const [open, close] = comment;
      const end = close === "\n" ? (text.indexOf("\n", index) + 1 || text.length) : closeOf(text, index + open.length, close, false);
      push("comment", text.slice(index, close === "\n" && text[end - 1] === "\n" ? end - 1 : end));
      index = close === "\n" && text[end - 1] === "\n" ? end - 1 : end;
      continue;
    }
    const string = spec.strings?.find(([open]) => text.startsWith(open, index));
    // A single quote between word characters is an apostrophe or a Rust lifetime, not a string.
    if (string && !(string[0] === "'" && /\w/.test(text[index - 1] ?? "") ) && !(language === "rust" && string[0] === "'")) {
      const [open, close, escapes, multiline] = string;
      let end = closeOf(text, index + open.length, close, escapes);
      if (!multiline) {
        const newline = text.indexOf("\n", index);
        if (newline !== -1 && newline < end) end = newline;
      }
      const key = spec.keys === true && /^\s*:/.test(text.slice(end, end + 40));
      push(key ? "attr" : "string", text.slice(index, end));
      index = end;
      continue;
    }
    let match;
    for (const [rule, type] of [[spec.sections, "title"], [spec.attributes, "meta"], [spec.directives, "meta"], [spec.decorators, "meta"], [spec.atRules, "keyword"], [spec.variables, "variable"], [spec.placeholders, "variable"]]) {
      if (!rule) continue;
      if (rule.flags.includes("m") && !lineStart(index)) continue;
      if ((match = at(rule, text, index))) {
        push(type, match);
        break;
      }
    }
    if (match) {
      index += match.length;
      continue;
    }
    if (spec.keys instanceof RegExp && (match = at(spec.keys, text, index)) && (language === "css" || /^\s*$/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index)) || language === "yaml" && /^\s*-\s+$/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index)))) {
      push("attr", match);
      index += match.length;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text[index + 1] ?? ""))) {
      if (!/[\w$]/.test(text[index - 1] ?? "") && (match = at(NUMBER, text, index))) {
        push("number", match);
        index += match.length;
        continue;
      }
    }
    if ((match = at(IDENTIFIER, text, index)) || (language === "plantuml" && (match = at(/@\w+/y, text, index)))) {
      const word = spec.caseless ? match.toLowerCase() : match;
      const after = text.slice(index + match.length, index + match.length + 2);
      let type = null;
      if (spec.keywords?.has(word)) type = "keyword";
      else if (spec.literals?.has(word)) type = "literal";
      else if (DATA_LANGUAGES.has(language)) type = null;
      else if (spec.macros && after[0] === "!" && after[1] !== "=") type = "function";
      else if (/^\s*\(/.test(after) || after.startsWith("(")) type = language === "css" ? null : "function";
      else if (/^[A-Z][a-z0-9]\w*$/.test(match)) type = "type";
      push(type, match);
      index += match.length;
      continue;
    }
    push(null, char);
    index += 1;
  }
  if (plain) tokens.push([null, plain]);
  return tokens;
}

function tokensOf(text, language) {
  return language && LANGUAGES[language] && text.length <= LIMIT ? scan(text, language) : [[null, text]];
}

const span = (type, value) => (type ? `<span class="tok-${type}">${escapeHtml(value)}</span>` : escapeHtml(value));

/** The highlighted HTML of a text, escaped, for one `<code>` element. */
export function highlight(text, language) {
  return tokensOf(text, language).map(([type, value]) => span(type, value)).join("");
}

/** The highlighted HTML of each line of a text, so a numbered source view keeps one element per line; a token across lines is split at each line end. */
export function highlightLines(text, language) {
  const lines = [""];
  for (const [type, value] of tokensOf(text, language)) {
    value.split("\n").forEach((part, index) => {
      if (index) lines.push("");
      if (part) lines[lines.length - 1] += span(type, part);
    });
  }
  return lines;
}
