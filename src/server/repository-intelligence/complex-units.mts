import { codeFamily, codeOnly, type CodeFamily } from "./code-text.mjs";
import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface ComplexUnitOptions { include?: (unit: SourceUnit) => boolean }
export interface ComplexUnit { file: string; selector: string; kind: string; range: SourceRange; lines: number; branches: number; maxDepth: number; parameters: number; nestedFunctions: number; dispatch: { subject: string; values: number } | null }

// A unit is reported when it is long, branches often, or compares one value with many literals.
const MIN_LINES = 80, MIN_BRANCHES = 25, MIN_DISPATCH = 8;
const BRANCHES: Record<CodeFamily, RegExp> = {
  c: /\b(?:if|for|while|case|catch)\b|&&|\|\||\s\?\s/g,
  python: /\b(?:if|elif|for|while|except|and|or)\b/g,
  rust: /\b(?:if|for|while|loop)\b|=>|&&|\|\|/g
};
// Equality with a literal on either side, and literal case or match labels after one switch or match subject.
const COMPARISON = /([\w$.]+(?:\[[^\]\n]*\])?)\s*[!=]==?\s*(["'`])([^"'`\n]{1,80})\2|(["'`])([^"'`\n]{1,80})\4\s*[!=]==?\s*([\w$.]+)/g;
const SWITCH = /\b(?:switch|match)\s*\(?\s*([\w$.]+)\s*\)?\s*\{/g, LABEL = /\bcase\s+(["'`])([^"'`\n]{1,80})\1|(["'])([^"'\n]{1,80})\3\s*(?:\|[^=]*)?=>/g;

const lineCount = (range: SourceRange) => range.endLine - range.startLine + 1;

// Count top-level parameters in a signature such as "(a, { b, c } = {}, ...rest)".
function parameterCount(signature?: string) {
  const inner = (signature || "").match(/^\s*\((.*)\)/s)?.[1]?.trim();
  if (!inner) return 0;
  let depth = 0, count = 1;
  for (const character of inner) { if ("([{<".includes(character)) depth++; else if (")]}>".includes(character)) depth--; else if (character === "," && depth === 0) count++; }
  return inner.endsWith(",") ? count - 1 : count;
}

function maxDepth(code: string, family: CodeFamily) {
  if (family === "python") {
    const indents = code.split("\n").filter(line => line.trim()).map(line => line.match(/^\s*/)![0].length);
    // The first indentation level below the definition is the body itself, as the first brace is in other languages.
    return Math.max(0, new Set(indents.filter(indent => indent > indents[0])).size - 1);
  }
  let depth = 0, deepest = 0;
  for (const character of code) { if (character === "{") deepest = Math.max(deepest, ++depth); else if (character === "}") depth--; }
  // The first brace opens the body itself.
  return Math.max(0, deepest - 1);
}

// The expression that the unit compares with the most distinct literal values.
function dispatchOf(text: string) {
  const values = new Map<string, Set<string>>();
  const add = (subject: string, value: string) => (values.get(subject) || values.set(subject, new Set()).get(subject)!).add(value);
  for (const match of text.matchAll(COMPARISON)) add(match[1] || match[6], match[3] ?? match[5]);
  const subjects = [...text.matchAll(SWITCH)].map(match => match[1]);
  if (subjects.length === 1) for (const match of text.matchAll(LABEL)) add(subjects[0], match[2] ?? match[4]);
  const [subject, set] = [...values].sort((a, b) => b[1].size - a[1].size)[0] || [];
  return subject ? { subject, values: set!.size } : null;
}

// Report long and branchy functions and methods with facts about their size, branches, nesting, parameters, and dispatch on literal values.
export function complexUnits(index: Pick<IndexMetadata, "units">, contents: Map<string, string>, options: ComplexUnitOptions = {}) {
  const include = options.include || (() => true);
  const code = index.units.filter(unit => ["function", "method"].includes(unit.kind) && unit.span && include(unit));
  const byFile = new Map<string, SourceUnit[]>();
  for (const unit of code) (byFile.get(unit.file) || byFile.set(unit.file, []).get(unit.file)!).push(unit);
  const reported: ComplexUnit[] = [];
  for (const unit of code) {
    const text = (contents.get(unit.file) || "").slice(unit.span!.start, unit.span!.end), family = codeFamily(unit.file);
    const stripped = codeOnly(text, family), lines = lineCount(unit.range);
    const branches = (stripped.match(BRANCHES[family]) || []).length, dispatch = dispatchOf(codeOnly(text, family, true));
    if (lines < MIN_LINES && branches < MIN_BRANCHES && (dispatch?.values || 0) < MIN_DISPATCH) continue;
    const nestedFunctions = byFile.get(unit.file)!.filter(other => other !== unit && unit.span!.start <= other.span!.start && other.span!.end <= unit.span!.end).length;
    reported.push({ file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, kind: unit.kind, range: unit.range, lines, branches,
      maxDepth: maxDepth(stripped, family), parameters: parameterCount(unit.signature), nestedFunctions, dispatch: dispatch && dispatch.values >= 3 ? dispatch : null });
  }
  // Long units come first, because a reader must hold all of their code at once.
  reported.sort((a, b) => b.lines - a.lines || b.branches - a.branches || a.file.localeCompare(b.file));
  return { units: reported, coverage: { functions: code.length, reported: reported.length } };
}
