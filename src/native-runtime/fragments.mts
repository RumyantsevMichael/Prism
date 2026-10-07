import path from "node:path";
import type { Concept, Fragment, Relationship } from "../server/repository-intelligence/repository-concept-types.mjs";
import { CODE_EXTENSIONS } from "./domains.mjs";

type InputFile = { file: string; content: string; hash: string };
type Count = (text: string) => number;
type Boundaries = (text: string) => number[];
type Span = { start: number; end: number };
export interface Labels { header: string; context: string }
export interface PlanOptions { countTokens: Count; boundaries?: Boundaries; limit?: number; isCandidate: (concept: Concept) => boolean; isStructured: (file: string) => boolean }

// Text kinds take their names from their own content, so a name in the header only repeats the source.
const CONTENT_NAMED = new Set(["paragraph", "list-item", "code"]);
// Leaves below this size add no meaning beyond the line that their parent outline shows.
// With a parent in the header, a tiny leaf would otherwise match queries about its parent.
const TINY_KINDS = new Set(["configuration-key", "list-item", "paragraph"]);
const TINY_TOKENS = 20;
const HEADER_TOKENS = 32;
const LINE_CHARACTERS = 120;
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
const isCode = (file: string) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
const wordBoundaries: Boundaries = source => [...source.matchAll(/\s+|[^\s]+/gu)].map(match => match.index + match[0].length);
const sourceLines = (source: string) => [...source.matchAll(/[^\n]*\n|[^\n]+$/g)].map(match => ({ start: match.index, text: match[0] }));
const indentOf = (line: string) => line.match(/^[ \t]*/)![0].replace(/\t/g, "  ").length;
const closing = (line: string) => /^\s*([)\]}]|else\b|catch\b|finally\b|\.|\?|:)/.test(line);
const shorten = (line: string) => {
  const text = line.trim();
  return text.length <= LINE_CHARACTERS ? text : text.slice(0, text.lastIndexOf(" ", LINE_CHARACTERS) > 40 ? text.lastIndexOf(" ", LINE_CHARACTERS) : LINE_CHARACTERS) + " …";
};

export function spanOf(concept: Concept, file: InputFile): Span {
  const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
  const start = Math.min(concept.range.startLine, lines.length), end = Math.min(concept.range.endLine, lines.length);
  const span = concept.span || { start: lines.slice(0, start - 1).join("").length, end: lines.slice(0, end).join("").length };
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.end > file.content.length) throw new Error("The concept span is outside its source.");
  return span;
}

// The logical parent is the smallest concept that contains a concept: a method belongs to its class, and a class to its file.
// Extractors can omit nested containment, so code concepts also use span containment within their file.
export function assignContainers(units: Concept[], edges: Relationship[], files: Map<string, InputFile>) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const spans = new Map(units.map(unit => [unit.id, spanOf(unit, files.get(unit.file)!)]));
  const options = new Map<string, Concept[]>(), byFile = new Map<string, Concept[]>();
  for (const edge of edges) if (edge.kind === "contains" && byId.has(edge.source) && byId.has(edge.target))
    options.set(edge.target, [...(options.get(edge.target) || []), byId.get(edge.source)!]);
  for (const unit of units) byFile.set(unit.file, [...(byFile.get(unit.file) || []), unit]);
  for (const unit of units) {
    if (unit.kind === "file") continue;
    const own = spans.get(unit.id)!, length = (span: Span) => span.end - span.start;
    const candidates = [...(options.get(unit.id) || []), ...(isCode(unit.file) ? byFile.get(unit.file)! : [])];
    let best: Concept | undefined;
    for (const candidate of candidates) {
      if (candidate.id === unit.id || candidate.file !== unit.file) continue;
      const span = spans.get(candidate.id)!;
      if (candidate.kind !== "file" && !(span.start <= own.start && own.end <= span.end && length(span) > length(own))) continue;
      if (!best || (best.kind === "file" && candidate.kind !== "file") || (candidate.kind !== "file" && length(span) < length(spans.get(best.id)!))) best = candidate;
    }
    if (best) unit.containerId = best.id;
  }
}

function ancestors(concept: Concept, byId: Map<string, Concept>) {
  const list: Concept[] = [];
  for (let parent = concept.containerId && byId.get(concept.containerId); parent && parent.kind !== "file"; parent = parent.containerId && byId.get(parent.containerId)) list.push(parent);
  return list;
}

// The vector gets only the nearest context, so siblings stay distinct and similar code in different classes stays similar.
// The lexical context field gets the full logical path and the module name.
export function labelsFor(concept: Concept, byId: Map<string, Concept>, countTokens: Count): Labels {
  const name = CONTENT_NAMED.has(concept.kind) || concept.kind === "file" ? "" : concept.name;
  const chain = ancestors(concept, byId).map(item => item.name);
  const code = isCode(concept.file);
  const module = path.posix.basename(concept.file).replace(/\.[^.]+$/, "");
  let line = `${concept.kind}${name ? `: ${name}` : ""}`;
  // The benchmark compared no ancestor, the nearest ancestor, and the full path. The nearest ancestor ranked best.
  if (chain.length) {
    const qualified = code ? `${concept.kind}: ${chain[0]}.${name}` : `${line} in: ${chain[0]}`;
    if (countTokens(qualified) <= HEADER_TOKENS) line = qualified;
  }
  const header = `${line}\n${concept.docstring ? concept.docstring + "\n" : ""}`;
  return { header: countTokens(header) <= 128 ? header : `${concept.kind}\n`, context: [...chain, module].join(" ") };
}

function fragment(concept: Concept, span: Span, file: InputFile, values: Partial<Fragment> & Pick<Fragment, "id" | "role" | "text">, labels: Labels): Fragment {
  const start = lineAt(file.content, span.start), end = lineAt(file.content, Math.max(span.start, span.end - 1));
  return { ...concept, parentId: concept.id, prefixLength: labels.header.length, embeddingText: values.text, context: labels.context,
    sourceStart: span.start, sourceEnd: span.end, range: { startLine: start, endLine: end }, ...values };
}

// Cut a long source into parts of about equal size, at the strongest structural boundary near each target size.
// BERT pretokens never cross a line end, so the token count of a text is the sum of the counts of its lines.
function cut(source: string, budget: number, countTokens: Count, boundaries: Boundaries, code: boolean) {
  const base = countTokens("");
  const tokens = (text: string) => countTokens(text) - base;
  const lines = sourceLines(source);
  const body = lines.slice(1).filter(line => line.text.trim() && !/^\s*[)\]}]+[;,]?\s*$/.test(line.text));
  const indent = code && body.length ? Math.min(...body.map(line => indentOf(line.text))) : null;
  const pieces: { start: number; end: number; tokens: number; priority: number }[] = [];
  lines.forEach((line, index) => {
    const next = lines[index + 1]?.text;
    const priority = !line.text.trim() ? 1 : indent !== null && next !== undefined && next.trim() && indentOf(next) === indent && !closing(next) ? 2 : 3;
    const count = tokens(line.text);
    if (count <= budget) { pieces.push({ start: line.start, end: line.start + line.text.length, tokens: count, priority }); return; }
    // Only a line longer than the budget falls back to tokenizer boundaries.
    const points = boundaries(line.text);
    let offset = 0, first = 0;
    while (offset < line.text.length) {
      while (first < points.length && points[first] <= offset) first++;
      let good = first - 1, bad = points.length, step = 1;
      const fits = (index: number) => tokens(line.text.slice(offset, points[index])) <= budget;
      while (good + step < points.length && fits(good + step)) { good += step; step *= 2; }
      if (good + step < points.length) bad = good + step;
      let low = good + 1, high = bad - 1;
      while (low <= high) { const middle = Math.floor((low + high) / 2); if (fits(middle)) { good = middle; low = middle + 1; } else high = middle - 1; }
      const best = good >= first ? points[good] : offset;
      if (best <= offset) throw new Error("A concept fragment cannot fit the model input limit.");
      pieces.push({ start: line.start + offset, end: line.start + best, tokens: tokens(line.text.slice(offset, best)), priority: best === line.text.length ? priority : 4 });
      offset = best;
    }
  });
  const sums = [0];
  for (const piece of pieces) sums.push(sums.at(-1)! + piece.tokens);
  const cuts: number[] = [];
  for (let start = 0; sums.at(-1)! - sums[start] > budget;) {
    const remaining = sums.at(-1)! - sums[start], target = remaining / Math.ceil(remaining / budget);
    let best = -1, key = [Infinity, Infinity];
    for (let end = start + 1; end < pieces.length && sums[end] - sums[start] <= budget; end++) {
      const size = sums[end] - sums[start];
      const candidate = size >= 0.6 * target ? [pieces[end - 1].priority, Math.abs(size - target)] : [9, -size];
      if (candidate[0] < key[0] || (candidate[0] === key[0] && candidate[1] < key[1])) { best = end; key = candidate; }
    }
    if (best < 0) throw new Error("A concept fragment cannot fit the model input limit.");
    cuts.push(best); start = best;
  }
  return [0, ...cuts].map((first, index) => ({ start: pieces[first].start, end: pieces[(cuts[index] ?? pieces.length) - 1].end }));
}

// Preserve raw source: a fragment is the whole concept, or one structural part of a concept longer than the model limit.
export function fragmentConcept(concept: Concept, file: InputFile, countTokens: Count, limit = 512, boundaries: Boundaries = wordBoundaries, labels?: Labels): Fragment[] {
  labels ??= labelsFor(concept, new Map(), countTokens);
  const span = spanOf(concept, file), source = file.content.slice(span.start, span.end);
  if (countTokens(labels.header + source) <= limit) return [fragment(concept, span, file, { id: concept.id, role: "whole", text: labels.header + source }, labels)];
  const [title, ...rest] = labels.header.split("\n");
  // Later parts repeat the first line of the concept, unless that line would take too much of the budget.
  const shortened = shorten(source.split("\n")[0]);
  const firstLine = countTokens(shortened) - countTokens("") <= limit / 8 ? shortened + "\n" : "";
  const header = (index: number, total: number) => `${title} (part ${index + 1} of ${total})\n${rest.join("\n")}${index ? firstLine : ""}`;
  // The budget reserves room for the widest part numbers, so any part count fits.
  const budget = limit - countTokens(header(99998, 99999));
  if (budget < 16) throw new Error("A concept fragment cannot fit the model input limit.");
  const parts = cut(source, budget, countTokens, boundaries, isCode(concept.file));
  return parts.map((part, index) => {
    const prefix = header(index, parts.length), text = prefix + source.slice(part.start, part.end);
    if (countTokens(text) > limit) throw new Error("A concept fragment exceeds the model input limit.");
    return fragment(concept, { start: span.start + part.start, end: span.start + part.end }, file, { id: `${concept.id}:${index}`, role: "part", text, prefixLength: prefix.length }, labels);
  });
}

// An outline names each child on one line. The children supply the body text, so the outline does not repeat it.
function outline(concept: Concept, file: InputFile, lines: { text: string; id?: string }[], labels: Labels, countTokens: Count, limit: number, id: string) {
  const span = spanOf(concept, file), source = file.content.slice(span.start, span.end);
  const head = concept.kind === "file" ? "" : shorten(source.split("\n")[0]) + "\n";
  const reserve = countTokens(`  … and ${lines.length} more\n`) - countTokens("");
  let text = labels.header + head;
  let used = countTokens(text);
  const included = new Set<string>();
  let shown = 0;
  for (const line of lines) {
    const entry = `  ${line.text}\n`, cost = countTokens(entry) - countTokens("");
    if (used + cost > limit - reserve) break;
    text += entry; used += cost; shown++;
    if (line.id) included.add(line.id);
  }
  if (shown < lines.length) text += `  … and ${lines.length - shown} more\n`;
  const value = fragment(concept, span, file, { id, role: "outline", text, excerpt: source.slice(0, 600) }, labels);
  return { fragment: value, included };
}

function childLine(child: Concept, file: InputFile) {
  const span = spanOf(child, file);
  const lines = file.content.slice(span.start, span.end).split("\n").filter(line => line.trim());
  // A fenced code block shows its first code line instead of the fence.
  const first = (child.kind === "code" && /^\s*(```|~~~)/.test(lines[0] || "") ? lines[1] : lines[0]) || child.name;
  if (!isCode(child.file)) return shorten(first);
  if (/^\s*(\/[/*]|\*|@|#\[)/.test(first)) return shorten(`${child.name}${child.signature || ""}`);
  // Some extractors start an arrow function at its parameters, so the line names the symbol first.
  const declared = new RegExp(`(^|[^\\w$])${child.name.replace(/[$]/g, "\\$")}($|[^\\w$])`).test(first.split(/[(=]/)[0]);
  return shorten(declared ? first : `${child.name} = ${first.trim()}`);
}

// A long function also gets an outline of its top-level statements, which represents the function as one unit.
function statementLines(concept: Concept, file: InputFile) {
  const span = spanOf(concept, file);
  const lines = sourceLines(file.content.slice(span.start, span.end)).slice(1).map(line => line.text);
  const body = lines.filter(line => line.trim() && !/^\s*[)\]}]+[;,]?\s*$/.test(line));
  if (!body.length) return [];
  const indent = Math.min(...body.map(indentOf));
  return body.filter(line => indentOf(line) === indent && !closing(line) && /[\p{L}\p{N}]/u.test(line)).map(line => ({ text: shorten(line) }));
}

export function planFragments(units: Concept[], files: Map<string, InputFile>, options: PlanOptions): Fragment[] {
  const { countTokens, limit = 512, boundaries = wordBoundaries, isCandidate, isStructured } = options;
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const candidates = units.filter(isCandidate);
  const children = new Map<string, Concept[]>();
  for (const unit of candidates) if (unit.containerId && byId.has(unit.containerId)) children.set(unit.containerId, [...(children.get(unit.containerId) || []), unit]);
  // A file without complete structure keeps its full text, because its symbols may not cover it.
  const container = (unit: Concept) => (children.get(unit.id)?.length || 0) > 0 && (unit.kind !== "file" || isStructured(unit.file));
  const outlines = new Map<string, Fragment>(), shown = new Set<string>(), skipped = new Set<string>();
  for (const unit of candidates) if (container(unit)) {
    // A container with one child, such as a document with one top heading, adds only a duplicate of that child.
    if (children.get(unit.id)!.length === 1) { skipped.add(unit.id); continue; }
    const file = files.get(unit.file)!;
    const list = children.get(unit.id)!.map(child => ({ child, start: spanOf(child, file).start })).sort((a, b) => a.start - b.start);
    const result = outline(unit, file, list.map(({ child }) => ({ text: childLine(child, file), id: child.id })), labelsFor(unit, byId, countTokens), countTokens, limit, unit.id);
    outlines.set(unit.id, result.fragment);
    for (const id of result.included) shown.add(id);
  }
  const fragments: Fragment[] = [];
  for (const unit of candidates) {
    const file = files.get(unit.file)!, span = spanOf(unit, file);
    const tokens = countTokens(file.content.slice(span.start, span.end)) - countTokens("");
    if (outlines.has(unit.id)) { fragments.push({ ...outlines.get(unit.id)!, tokens, parts: 0 }); continue; }
    if (skipped.has(unit.id)) continue;
    if (TINY_KINDS.has(unit.kind) && tokens < TINY_TOKENS && shown.has(unit.id)) continue;
    const labels = labelsFor(unit, byId, countTokens);
    const pieces = fragmentConcept(unit, file, countTokens, limit, boundaries, labels);
    const statements = pieces.length > 1 && isCode(unit.file) && unit.kind !== "file" ? statementLines(unit, file) : [];
    const summary = statements.length >= 2 ? [outline(unit, file, statements, labels, countTokens, limit, `${unit.id}:outline`).fragment] : [];
    for (const piece of [...summary, ...pieces]) fragments.push({ ...piece, tokens, parts: pieces.length });
  }
  return fragments;
}
