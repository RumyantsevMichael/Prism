// Generated from src/native-runtime/concepts.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseTree, getNodePath, getNodeValue } from "jsonc-parser";
import { parseDocument, isMap, isSeq, isAlias, LineCounter } from "yaml";
import { CODE_EXTENSIONS, domainFor } from "./domains.mjs";
import { CODE_EXTENSIONS as CODE_EXTENSIONS2, domainFor as domainFor2 } from "./domains.mjs";
import { CHUNKER_VERSION } from "./versions.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pointer = (parts) => "/" + parts.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;
const slug = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
function unit(file, kind, name, startLine, endLine, selector = name, exactSpan) {
  endLine = Math.min(endLine, Math.max(1, (file.content.match(/[^\n]*\n|[^\n]+$/g) || []).length));
  const id = hash(`${file.file}\0${kind}\0${selector}\0${startLine}\0${endLine}`);
  const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
  const span = exactSpan || { start: lines.slice(0, startLine - 1).join("").length, end: lines.slice(0, endLine).join("").length };
  return {
    id,
    file: file.file,
    kind,
    name,
    selector,
    domain: domainFor(file.file),
    range: { startLine, endLine },
    sourceHash: file.hash,
    span,
    contentHash: hash(file.content.slice(span.start, span.end)),
    rangeComplete: true
  };
}
function extractTextConcepts(file) {
  const units = [], edges = [], links = [], diagnostics = [];
  const text = file.content;
  const root = unit(file, "file", file.file, 1, Math.max(1, text.split("\n").length), "");
  units.push(root);
  const add = (node, parent = root) => {
    units.push(node);
    edges.push({ source: parent.id, target: node.id, kind: "contains", provenance: "parser" });
    return node;
  };
  const extension = path.extname(file.file).toLowerCase();
  let supported = false;
  const counts = { sections: 0, paragraphs: 0, listItems: 0, links: 0, configurationKeys: 0, configurationReferences: 0 };
  try {
    if ([".md", ".markdown"].includes(extension)) {
      supported = true;
      const tree = fromMarkdown(text), stack = [root], counts2 = /* @__PURE__ */ new Map(), definitions = /* @__PURE__ */ new Map();
      const plain = (node) => "value" in node ? node.value : "children" in node ? node.children.map((child) => plain(child)).join("") : "";
      const walk = (node, parent = stack.at(-1)) => {
        if (node.type === "definition") definitions.set(node.identifier, node.url);
        if (node.type === "link") links.push({ from: parent.id, url: node.url });
        if (node.type === "linkReference") links.push({ from: parent.id, identifier: node.identifier });
        if (["paragraph", "listItem", "code"].includes(node.type)) {
          const name = plain(node).trim().slice(0, 160) || node.type;
          const selected = add(unit(
            file,
            node.type === "listItem" ? "list-item" : node.type,
            name,
            node.position.start.line,
            node.position.end.line,
            name,
            { start: node.position.start.offset, end: node.position.end.offset }
          ), parent);
          const visitLinks = (item) => {
            if (item.type === "link") links.push({ from: selected.id, url: item.url });
            if (item.type === "linkReference") links.push({ from: selected.id, identifier: item.identifier });
            if ("children" in item) for (const child of item.children) visitLinks(child);
          };
          visitLinks(node);
          return;
        }
        if ("children" in node) for (const child of node.children) walk(child, parent);
      };
      for (let i = 0; i < tree.children.length; i++) {
        const node = tree.children[i];
        if (node.type === "heading") {
          const name = plain(node), base = slug(name), count = counts2.get(base) || 0;
          counts2.set(base, count + 1);
          const selector = `#${base}${count ? `-${count}` : ""}`;
          let end = root.range.endLine;
          for (const later of tree.children.slice(i + 1)) if (later.type === "heading" && later.depth <= node.depth) {
            end = later.position.start.line - 1;
            break;
          }
          while (stack.length > 1 && stack.at(-1).depth >= node.depth) stack.pop();
          const heading = add({ ...unit(file, "heading", name, node.position.start.line, end, selector), depth: node.depth }, stack.at(-1));
          stack.push(heading);
        } else walk(node);
      }
      for (const link of links) if (!link.url) link.url = definitions.get(link.identifier);
    } else if ([".json", ".jsonc"].includes(extension)) {
      supported = true;
      const errors = [], tree = parseTree(text, errors, { allowTrailingComma: extension === ".jsonc", disallowComments: extension === ".json" });
      if (errors.length) throw new Error("The configuration is not valid JSON.");
      const walk = (node, parent = root) => {
        if (!node) return;
        if (node.type === "property") {
          const value = node.children[1], key = node.children[0].value;
          const selected = add(unit(file, "configuration-key", String(key), lineAt(text, node.offset), lineAt(text, node.offset + node.length), pointer(getNodePath(value)), { start: node.offset, end: node.offset + node.length }), parent);
          if (key === "$ref" && typeof getNodeValue(value) === "string") links.push({ from: selected.id, url: getNodeValue(value) });
          walk(value, selected);
        } else for (const child of node.children || []) walk(child, parent);
      };
      walk(tree);
    } else if ([".yaml", ".yml"].includes(extension)) {
      supported = true;
      const counter = new LineCounter(), document = parseDocument(text, { lineCounter: counter, keepSourceTokens: true });
      if (document.errors.length) throw new Error("The configuration is not valid YAML.");
      const anchors = /* @__PURE__ */ new Map(), aliases = [];
      const walk = (node, parts = [], parent = root) => {
        if (!node) return;
        if (typeof node === "object" && "anchor" in node && typeof node.anchor === "string") anchors.set(node.anchor, parent.id);
        if (isAlias(node)) {
          aliases.push({ source: parent.id, name: node.source });
          return;
        }
        if (isMap(node)) for (const pair of node.items) {
          const name = String(pair.key?.value ?? "key"), next = [...parts, name];
          const begin = pair.key?.range?.[0] ?? 0, end = pair.value?.range?.[1] ?? pair.key?.range?.[1] ?? begin;
          const selected = add(unit(file, "configuration-key", name, counter.linePos(begin).line, counter.linePos(end).line, pointer(next), { start: begin, end }), parent);
          if (name === "$ref" && pair.value && "value" in pair.value && typeof pair.value.value === "string") links.push({ from: selected.id, url: pair.value.value });
          walk(pair.value, next, selected);
        }
        ;
        if (isSeq(node)) node.items.forEach((item, i) => walk(item, [...parts, i], parent));
      };
      walk(document.contents);
      for (const alias of aliases) {
        if (anchors.has(alias.name)) edges.push({ source: alias.source, target: anchors.get(alias.name), kind: "aliases", provenance: "parser" });
        else diagnostics.push({ code: "incomplete_structure", file: file.file, message: "A YAML alias has no anchor." });
      }
      counts.configurationReferences += aliases.length;
    }
  } catch (error) {
    diagnostics.push({ code: "incomplete_structure", file: file.file, message: error.message });
  }
  if (!supported && !CODE_EXTENSIONS.has(extension)) diagnostics.push({ code: "incomplete_structure", file: file.file, message: "No structural parser is available for this file type." });
  if ([".md", ".markdown"].includes(extension)) {
    const walkCounts = (node) => {
      const metric = { heading: "sections", paragraph: "paragraphs", listItem: "listItems", link: "links", linkReference: "links" }[node.type];
      if (metric) counts[metric] = (counts[metric] || 0) + 1;
      if ("children" in node) for (const child of node.children) walkCounts(child);
    };
    walkCounts(fromMarkdown(text));
  }
  counts.configurationKeys = units.filter((item) => item.kind === "configuration-key").length;
  if ([".json", ".jsonc", ".yaml", ".yml"].includes(extension)) counts.configurationReferences += links.length;
  return { units, edges, links, supported, diagnostics, counts };
}
function resolveTextLinks(groups) {
  const files = new Map(groups.map((group) => [group.units[0].file, group]));
  for (const group of groups) for (const link of group.links) {
    if (typeof link.url !== "string" || /^[a-z][a-z\d+.-]*:/i.test(link.url) || link.url.startsWith("//")) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(link.url);
    } catch {
      decoded = "../invalid";
    }
    const [name, fragment] = decoded.split("#");
    if (name.startsWith("/") || name.includes("\\")) {
      group.diagnostics.push({ code: "incomplete_structure", file: group.units[0].file, message: "A local reference uses a path outside the snapshot namespace." });
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(group.units[0].file), name || path.posix.basename(group.units[0].file)));
    const destination = files.get(target);
    const selected = fragment ? destination?.units.find((item) => item.selector === `#${fragment}` || item.selector === fragment) : destination?.units[0];
    if (selected) group.edges.push({ source: link.from, target: selected.id, kind: "references", provenance: "parser" });
    else group.diagnostics.push({ code: "incomplete_structure", file: group.units[0].file, message: "A local document or configuration reference is unresolved." });
  }
}
function bgeSourceBoundaries(tokenizer, configuration) {
  if (configuration.model?.type !== "WordPiece" || configuration.normalizer?.type !== "BertNormalizer" || configuration.pre_tokenizer?.type !== "BertPreTokenizer") throw new Error("The pinned tokenizer is not the supported BGE WordPiece tokenizer.");
  const specials = configuration.added_tokens.map((token) => token.content).sort((a, b) => b.length - a.length);
  const punctuation = /^[\p{P}\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]$/u;
  return (source) => {
    const points = /* @__PURE__ */ new Set([0, source.length]);
    for (let offset = 0; offset < source.length; ) {
      const special = specials.find((value) => source.startsWith(value, offset));
      if (special) {
        points.add(offset);
        offset += special.length;
        points.add(offset);
        continue;
      }
      const raw = String.fromCodePoint(source.codePointAt(offset)), end = offset + raw.length;
      const normalized = tokenizer.normalizer.normalize(raw);
      if (normalized && /^\s+$/u.test(normalized)) points.add(end);
      else if (punctuation.test(normalized) || normalized.trim() && normalized !== normalized.trim()) {
        points.add(offset);
        points.add(end);
      }
      offset = end;
    }
    return [...points].sort((a, b) => a - b);
  };
}
function fragmentConcept(concept, file, countTokens, limit = 512, boundaries = (source) => [...source.matchAll(/\s+|[^\s]+/gu)].map((match) => match.index + match[0].length)) {
  const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
  const start = Math.min(concept.range.startLine, lines.length), end = Math.min(concept.range.endLine, lines.length);
  const span = concept.span || { start: lines.slice(0, start - 1).join("").length, end: lines.slice(0, end).join("").length };
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.end > file.content.length) throw new Error("The concept span is outside its source.");
  const source = file.content.slice(span.start, span.end);
  const sourceLine = lineAt(file.content, span.start);
  const prefix = `${concept.file}
${concept.kind}: ${concept.name}
${concept.docstring ? concept.docstring + "\n" : ""}`;
  const safePrefix = countTokens(prefix) <= 128 ? prefix : `${concept.kind}
`;
  const embeddingPrefix = `${concept.kind}${concept.kind === "file" ? "" : ": " + concept.name}
${concept.docstring ? concept.docstring + "\n" : ""}`;
  const safeEmbeddingPrefix = countTokens(embeddingPrefix) <= 128 ? embeddingPrefix : `${concept.kind}
`;
  const fits = (part) => countTokens(safePrefix + part) <= limit && countTokens(safeEmbeddingPrefix + part) <= limit;
  if (fits(source)) return [{
    ...concept,
    parentId: concept.id,
    prefixLength: safePrefix.length,
    text: safePrefix + source,
    embeddingText: safeEmbeddingPrefix + source,
    sourceStart: span.start,
    sourceEnd: span.end
  }];
  const fragments = [];
  const points = boundaries(source);
  let offset = 0;
  while (offset < source.length) {
    let low = 0, high = points.length - 1, best = offset;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), candidate = points[middle];
      if (candidate <= offset) {
        low = middle + 1;
        continue;
      }
      if (fits(source.slice(offset, candidate))) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best <= offset) throw new Error("A concept fragment cannot fit the model input limit.");
    fragments.push({
      ...concept,
      id: `${concept.id}:${fragments.length}`,
      parentId: concept.id,
      sourceStart: span.start + offset,
      sourceEnd: span.start + best,
      range: { startLine: sourceLine + lineAt(source, offset) - 1, endLine: sourceLine + lineAt(source, Math.max(offset, best - 1)) - 1 },
      prefixLength: safePrefix.length,
      text: safePrefix + source.slice(offset, best),
      embeddingText: safeEmbeddingPrefix + source.slice(offset, best)
    });
    offset = best;
  }
  return fragments;
}
export {
  CHUNKER_VERSION,
  CODE_EXTENSIONS2 as CODE_EXTENSIONS,
  bgeSourceBoundaries,
  domainFor2 as domainFor,
  extractTextConcepts,
  fragmentConcept,
  resolveTextLinks
};
