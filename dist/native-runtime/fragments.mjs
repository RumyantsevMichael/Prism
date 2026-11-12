// Generated from src/native-runtime/fragments.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { CODE_EXTENSIONS } from "./domains.mjs";
const CONTENT_NAMED = /* @__PURE__ */ new Set(["paragraph", "list-item", "code"]);
const TINY_KINDS = /* @__PURE__ */ new Set(["configuration-key", "list-item", "paragraph"]);
const TINY_TOKENS = 20;
const HEADER_TOKENS = 32;
const LINE_CHARACTERS = 120;
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;
const isCode = (file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
const wordBoundaries = (source) => [...source.matchAll(/\s+|[^\s]+/gu)].map((match) => match.index + match[0].length);
const sourceLines = (source) => [...source.matchAll(/[^\n]*\n|[^\n]+$/g)].map((match) => ({ start: match.index, text: match[0] }));
const indentOf = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length;
const closing = (line) => /^\s*([)\]}]|else\b|catch\b|finally\b|\.|\?|:)/.test(line);
const shorten = (line) => {
  const text = line.trim();
  return text.length <= LINE_CHARACTERS ? text : text.slice(0, text.lastIndexOf(" ", LINE_CHARACTERS) > 40 ? text.lastIndexOf(" ", LINE_CHARACTERS) : LINE_CHARACTERS) + " \u2026";
};
function spanOf(unit, file) {
  const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
  const start = Math.min(unit.range.startLine, lines.length), end = Math.min(unit.range.endLine, lines.length);
  const span = unit.span || { start: lines.slice(0, start - 1).join("").length, end: lines.slice(0, end).join("").length };
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.end > file.content.length) throw new Error("The unit span is outside its source.");
  return span;
}
function assignContainers(units, edges, files) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const spans = new Map(units.map((unit) => [unit.id, spanOf(unit, files.get(unit.file))]));
  const options = /* @__PURE__ */ new Map(), byFile = /* @__PURE__ */ new Map();
  for (const edge of edges) if (edge.kind === "contains" && byId.has(edge.source) && byId.has(edge.target))
    options.set(edge.target, [...options.get(edge.target) || [], byId.get(edge.source)]);
  for (const unit of units) byFile.set(unit.file, [...byFile.get(unit.file) || [], unit]);
  for (const unit of units) {
    if (unit.kind === "file") continue;
    const own = spans.get(unit.id), length = (span) => span.end - span.start;
    const candidates = [...options.get(unit.id) || [], ...isCode(unit.file) ? byFile.get(unit.file) : []];
    let best;
    for (const candidate of candidates) {
      if (candidate.id === unit.id || candidate.file !== unit.file) continue;
      const span = spans.get(candidate.id);
      if (candidate.kind !== "file" && !(span.start <= own.start && own.end <= span.end && length(span) > length(own))) continue;
      if (!best || best.kind === "file" && candidate.kind !== "file" || candidate.kind !== "file" && length(span) < length(spans.get(best.id))) best = candidate;
    }
    if (best) unit.containerId = best.id;
  }
}
function ancestors(unit, byId) {
  const list = [];
  for (let parent = unit.containerId && byId.get(unit.containerId); parent && parent.kind !== "file"; parent = parent.containerId && byId.get(parent.containerId)) list.push(parent);
  return list;
}
function labelsFor(unit, byId, countTokens) {
  const name = CONTENT_NAMED.has(unit.kind) || unit.kind === "file" ? "" : unit.name;
  const chain = ancestors(unit, byId).map((item) => item.name);
  const code = isCode(unit.file);
  const module = path.posix.basename(unit.file).replace(/\.[^.]+$/, "");
  let line = `${unit.kind}${name ? `: ${name}` : ""}`;
  if (chain.length) {
    const qualified = code ? `${unit.kind}: ${chain[0]}.${name}` : `${line} in: ${chain[0]}`;
    if (countTokens(qualified) <= HEADER_TOKENS) line = qualified;
  }
  const header = `${line}
${unit.docstring ? unit.docstring + "\n" : ""}`;
  return { header: countTokens(header) <= 128 ? header : `${unit.kind}
`, context: [...chain, module].join(" ") };
}
function fragment(unit, span, file, values, labels) {
  const start = lineAt(file.content, span.start), end = lineAt(file.content, Math.max(span.start, span.end - 1));
  return {
    ...unit,
    parentId: unit.id,
    prefixLength: labels.header.length,
    embeddingText: values.text,
    context: labels.context,
    sourceStart: span.start,
    sourceEnd: span.end,
    range: { startLine: start, endLine: end },
    ...values
  };
}
function cut(source, budget, countTokens, boundaries, code) {
  const base = countTokens("");
  const tokens = (text) => countTokens(text) - base;
  const lines = sourceLines(source);
  const body = lines.slice(1).filter((line) => line.text.trim() && !/^\s*[)\]}]+[;,]?\s*$/.test(line.text));
  const indent = code && body.length ? Math.min(...body.map((line) => indentOf(line.text))) : null;
  const pieces = [];
  lines.forEach((line, index) => {
    const next = lines[index + 1]?.text;
    const priority = !line.text.trim() ? 1 : indent !== null && next !== void 0 && next.trim() && indentOf(next) === indent && !closing(next) ? 2 : 3;
    const count = tokens(line.text);
    if (count <= budget) {
      pieces.push({ start: line.start, end: line.start + line.text.length, tokens: count, priority });
      return;
    }
    const points = boundaries(line.text);
    let offset = 0, first = 0;
    while (offset < line.text.length) {
      while (first < points.length && points[first] <= offset) first++;
      let good = first - 1, bad = points.length, step = 1;
      const fits = (index2) => tokens(line.text.slice(offset, points[index2])) <= budget;
      while (good + step < points.length && fits(good + step)) {
        good += step;
        step *= 2;
      }
      if (good + step < points.length) bad = good + step;
      let low = good + 1, high = bad - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (fits(middle)) {
          good = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      const best = good >= first ? points[good] : offset;
      if (best <= offset) throw new Error("A fragment cannot fit the model input limit.");
      pieces.push({ start: line.start + offset, end: line.start + best, tokens: tokens(line.text.slice(offset, best)), priority: best === line.text.length ? priority : 4 });
      offset = best;
    }
  });
  const sums = [0];
  for (const piece of pieces) sums.push(sums.at(-1) + piece.tokens);
  const cuts = [];
  for (let start = 0; sums.at(-1) - sums[start] > budget; ) {
    const remaining = sums.at(-1) - sums[start], target = remaining / Math.ceil(remaining / budget);
    let best = -1, key = [Infinity, Infinity];
    for (let end = start + 1; end < pieces.length && sums[end] - sums[start] <= budget; end++) {
      const size = sums[end] - sums[start];
      const candidate = size >= 0.6 * target ? [pieces[end - 1].priority, Math.abs(size - target)] : [9, -size];
      if (candidate[0] < key[0] || candidate[0] === key[0] && candidate[1] < key[1]) {
        best = end;
        key = candidate;
      }
    }
    if (best < 0) throw new Error("A fragment cannot fit the model input limit.");
    cuts.push(best);
    start = best;
  }
  return [0, ...cuts].map((first, index) => ({ start: pieces[first].start, end: pieces[(cuts[index] ?? pieces.length) - 1].end }));
}
function fragmentUnit(unit, file, countTokens, limit = 512, boundaries = wordBoundaries, labels) {
  labels ??= labelsFor(unit, /* @__PURE__ */ new Map(), countTokens);
  const span = spanOf(unit, file), source = file.content.slice(span.start, span.end);
  if (countTokens(labels.header + source) <= limit) return [fragment(unit, span, file, { id: unit.id, role: "whole", text: labels.header + source }, labels)];
  const [title, ...rest] = labels.header.split("\n");
  const shortened = shorten(source.split("\n")[0]);
  const firstLine = countTokens(shortened) - countTokens("") <= limit / 8 ? shortened + "\n" : "";
  const header = (index, total) => `${title} (part ${index + 1} of ${total})
${rest.join("\n")}${index ? firstLine : ""}`;
  const budget = limit - countTokens(header(99998, 99999));
  if (budget < 16) throw new Error("A fragment cannot fit the model input limit.");
  const parts = cut(source, budget, countTokens, boundaries, isCode(unit.file));
  return parts.map((part, index) => {
    const prefix = header(index, parts.length), text = prefix + source.slice(part.start, part.end);
    if (countTokens(text) > limit) throw new Error("A fragment exceeds the model input limit.");
    return fragment(unit, { start: span.start + part.start, end: span.start + part.end }, file, { id: `${unit.id}:${index}`, role: "part", text, prefixLength: prefix.length }, labels);
  });
}
function outline(unit, file, lines, labels, countTokens, limit, id) {
  const span = spanOf(unit, file), source = file.content.slice(span.start, span.end);
  const head = unit.kind === "file" ? "" : shorten(source.split("\n")[0]) + "\n";
  const reserve = countTokens(`  \u2026 and ${lines.length} more
`) - countTokens("");
  let text = labels.header + head;
  let used = countTokens(text);
  const included = /* @__PURE__ */ new Set();
  let shown = 0;
  for (const line of lines) {
    const entry = `  ${line.text}
`, cost = countTokens(entry) - countTokens("");
    if (used + cost > limit - reserve) break;
    text += entry;
    used += cost;
    shown++;
    if (line.id) included.add(line.id);
  }
  if (shown < lines.length) text += `  \u2026 and ${lines.length - shown} more
`;
  const value = fragment(unit, span, file, { id, role: "outline", text, excerpt: source.slice(0, 600) }, labels);
  return { fragment: value, included };
}
function childLine(child, file) {
  const span = spanOf(child, file);
  const lines = file.content.slice(span.start, span.end).split("\n").filter((line) => line.trim());
  const first = (child.kind === "code" && /^\s*(```|~~~)/.test(lines[0] || "") ? lines[1] : lines[0]) || child.name;
  if (!isCode(child.file)) return shorten(first);
  if (/^\s*(\/[/*]|\*|@|#\[)/.test(first)) return shorten(`${child.name}${child.signature || ""}`);
  const declared = new RegExp(`(^|[^\\w$])${child.name.replace(/[$]/g, "\\$")}($|[^\\w$])`).test(first.split(/[(=]/)[0]);
  return shorten(declared ? first : `${child.name} = ${first.trim()}`);
}
function statementLines(unit, file) {
  const span = spanOf(unit, file);
  const lines = sourceLines(file.content.slice(span.start, span.end)).slice(1).map((line) => line.text);
  const body = lines.filter((line) => line.trim() && !/^\s*[)\]}]+[;,]?\s*$/.test(line));
  if (!body.length) return [];
  const indent = Math.min(...body.map(indentOf));
  return body.filter((line) => indentOf(line) === indent && !closing(line) && /[\p{L}\p{N}]/u.test(line)).map((line) => ({ text: shorten(line) }));
}
function planFragments(units, files, options) {
  const { countTokens, limit = 512, boundaries = wordBoundaries, isCandidate, isStructured } = options;
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const candidates = units.filter(isCandidate);
  const children = /* @__PURE__ */ new Map();
  for (const unit of candidates) if (unit.containerId && byId.has(unit.containerId)) children.set(unit.containerId, [...children.get(unit.containerId) || [], unit]);
  const container = (unit) => (children.get(unit.id)?.length || 0) > 0 && (unit.kind !== "file" || isStructured(unit.file));
  const outlines = /* @__PURE__ */ new Map(), shown = /* @__PURE__ */ new Set(), skipped = /* @__PURE__ */ new Set();
  for (const unit of candidates) if (container(unit)) {
    if (children.get(unit.id).length === 1) {
      skipped.add(unit.id);
      continue;
    }
    const file = files.get(unit.file);
    const list = children.get(unit.id).map((child) => ({ child, start: spanOf(child, file).start })).sort((a, b) => a.start - b.start);
    const result = outline(unit, file, list.map(({ child }) => ({ text: childLine(child, file), id: child.id })), labelsFor(unit, byId, countTokens), countTokens, limit, unit.id);
    outlines.set(unit.id, result.fragment);
    for (const id of result.included) shown.add(id);
  }
  const fragments = [];
  for (const unit of candidates) {
    const file = files.get(unit.file), span = spanOf(unit, file);
    const tokens = countTokens(file.content.slice(span.start, span.end)) - countTokens("");
    if (outlines.has(unit.id)) {
      fragments.push({ ...outlines.get(unit.id), tokens, parts: 0 });
      continue;
    }
    if (skipped.has(unit.id)) continue;
    if (TINY_KINDS.has(unit.kind) && tokens < TINY_TOKENS && shown.has(unit.id)) continue;
    const labels = labelsFor(unit, byId, countTokens);
    const pieces = fragmentUnit(unit, file, countTokens, limit, boundaries, labels);
    const statements = pieces.length > 1 && isCode(unit.file) && unit.kind !== "file" ? statementLines(unit, file) : [];
    const summary = statements.length >= 2 ? [outline(unit, file, statements, labels, countTokens, limit, `${unit.id}:outline`).fragment] : [];
    for (const piece of [...summary, ...pieces]) fragments.push({ ...piece, tokens, parts: pieces.length });
  }
  return fragments;
}
export {
  assignContainers,
  fragmentUnit,
  labelsFor,
  planFragments,
  spanOf
};
