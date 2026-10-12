// Generated from src/server/repository-intelligence/complex-units.mts by scripts/native-build/compile.mjs.
import { codeFamily, codeOnly } from "./code-text.mjs";
const MIN_LINES = 80, MIN_BRANCHES = 25, MIN_DISPATCH = 8;
const BRANCHES = {
  c: /\b(?:if|for|while|case|catch)\b|&&|\|\||\s\?\s/g,
  python: /\b(?:if|elif|for|while|except|and|or)\b/g,
  rust: /\b(?:if|for|while|loop)\b|=>|&&|\|\|/g
};
const COMPARISON = /([\w$.]+(?:\[[^\]\n]*\])?)\s*[!=]==?\s*(["'`])([^"'`\n]{1,80})\2|(["'`])([^"'`\n]{1,80})\4\s*[!=]==?\s*([\w$.]+)/g;
const SWITCH = /\b(?:switch|match)\s*\(?\s*([\w$.]+)\s*\)?\s*\{/g, LABEL = /\bcase\s+(["'`])([^"'`\n]{1,80})\1|(["'])([^"'\n]{1,80})\3\s*(?:\|[^=]*)?=>/g;
const lineCount = (range) => range.endLine - range.startLine + 1;
function parameterCount(signature) {
  const inner = (signature || "").match(/^\s*\((.*)\)/s)?.[1]?.trim();
  if (!inner) return 0;
  let depth = 0, count = 1;
  for (const character of inner) {
    if ("([{<".includes(character)) depth++;
    else if (")]}>".includes(character)) depth--;
    else if (character === "," && depth === 0) count++;
  }
  return inner.endsWith(",") ? count - 1 : count;
}
function maxDepth(code, family) {
  if (family === "python") {
    const indents = code.split("\n").filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length);
    return Math.max(0, new Set(indents.filter((indent) => indent > indents[0])).size - 1);
  }
  let depth = 0, deepest = 0;
  for (const character of code) {
    if (character === "{") deepest = Math.max(deepest, ++depth);
    else if (character === "}") depth--;
  }
  return Math.max(0, deepest - 1);
}
function dispatchOf(text) {
  const values = /* @__PURE__ */ new Map();
  const add = (subject2, value) => (values.get(subject2) || values.set(subject2, /* @__PURE__ */ new Set()).get(subject2)).add(value);
  for (const match of text.matchAll(COMPARISON)) add(match[1] || match[6], match[3] ?? match[5]);
  const subjects = [...text.matchAll(SWITCH)].map((match) => match[1]);
  if (subjects.length === 1) for (const match of text.matchAll(LABEL)) add(subjects[0], match[2] ?? match[4]);
  const [subject, set] = [...values].sort((a, b) => b[1].size - a[1].size)[0] || [];
  return subject ? { subject, values: set.size } : null;
}
function complexUnits(index, contents, options = {}) {
  const include = options.include || (() => true);
  const code = index.units.filter((unit) => ["function", "method"].includes(unit.kind) && unit.span && include(unit));
  const byFile = /* @__PURE__ */ new Map();
  for (const unit of code) (byFile.get(unit.file) || byFile.set(unit.file, []).get(unit.file)).push(unit);
  const reported = [];
  for (const unit of code) {
    const text = (contents.get(unit.file) || "").slice(unit.span.start, unit.span.end), family = codeFamily(unit.file);
    const stripped = codeOnly(text, family), lines = lineCount(unit.range);
    const branches = (stripped.match(BRANCHES[family]) || []).length, dispatch = dispatchOf(codeOnly(text, family, true));
    if (lines < MIN_LINES && branches < MIN_BRANCHES && (dispatch?.values || 0) < MIN_DISPATCH) continue;
    const nestedFunctions = byFile.get(unit.file).filter((other) => other !== unit && unit.span.start <= other.span.start && other.span.end <= unit.span.end).length;
    reported.push({
      file: unit.file,
      selector: unit.selector || unit.qualifiedName || unit.name,
      kind: unit.kind,
      range: unit.range,
      lines,
      branches,
      maxDepth: maxDepth(stripped, family),
      parameters: parameterCount(unit.signature),
      nestedFunctions,
      dispatch: dispatch && dispatch.values >= 3 ? dispatch : null
    });
  }
  reported.sort((a, b) => b.lines - a.lines || b.branches - a.branches || a.file.localeCompare(b.file));
  return { units: reported, coverage: { functions: code.length, reported: reported.length } };
}
export {
  complexUnits
};
