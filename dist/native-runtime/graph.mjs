// Generated from src/native-runtime/graph.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CODE_EXTENSIONS } from "./units.mjs";
import { installFileBoundary } from "./fs-boundary.mjs";
const boundary = installFileBoundary();
const require2 = createRequire(import.meta.url);
let sdk;
const GRAPH_STATE = "graph.json";
const PROSE = /\.(md|mdx|markdown|rst|adoc)$/i;
const syncable = (file) => !file.split("/").some((part) => part.startsWith(".")) && (CODE_EXTENSIONS.has(path.extname(file).toLowerCase()) || PROSE.test(file));
async function readGraphState(directory) {
  try {
    const stored = JSON.parse(await readFile(path.join(directory, GRAPH_STATE), "utf8"));
    return stored?.schemaVersion === 1 && typeof stored.sdk === "string" && stored.files && typeof stored.files === "object" && Array.isArray(stored.frameworks) && stored.frameworks.every((name) => typeof name === "string") ? stored : void 0;
  } catch {
    return void 0;
  }
}
async function extractGraph(mirror, files, runtimeDirectory, progress = () => {
}, state) {
  sdk ||= require2("@colbymchenry/codegraph");
  const version = require2("@colbymchenry/codegraph/package.json").version;
  const database = sdk.getDatabasePath(mirror);
  const stored = state?.changes ? await readGraphState(state.directory) : void 0;
  let paths;
  if (state?.changes && stored?.sdk === version && existsSync(database)) {
    const current = new Map(files.map((file) => [file.file, file.hash]));
    paths = [.../* @__PURE__ */ new Set([
      ...state.changes.changedFiles,
      ...state.changes.removedFiles,
      ...files.filter((file) => stored.files[file.file] !== file.hash).map((file) => file.file),
      ...Object.keys(stored.files).filter((file) => !current.has(file))
    ])].sort();
    if (!paths.every(syncable)) paths = void 0;
  }
  if (state) await rm(path.join(state.directory, GRAPH_STATE), { force: true });
  let graph = paths ? await extractOnce(mirror, files, runtimeDirectory, progress, paths) : void 0;
  if (graph && (!graph.clean || graph.frameworks.join("\n") !== stored.frameworks.join("\n"))) graph = void 0;
  if (!graph) {
    await rm(path.join(mirror, ".codegraph"), { recursive: true, force: true });
    graph = await extractOnce(mirror, files, runtimeDirectory, progress);
  }
  if (state && graph.clean) {
    try {
      await mkdir(state.directory, { recursive: true, mode: 448 });
      const temporary = path.join(state.directory, `${GRAPH_STATE}.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sdk: version, files: Object.fromEntries(files.map((file) => [file.file, file.hash])), frameworks: graph.frameworks }), { mode: 384 });
      await rename(temporary, path.join(state.directory, GRAPH_STATE));
    } catch {
    }
  }
  const { clean: _clean, frameworks: _frameworks, ...result } = graph;
  return result;
}
async function extractOnce(mirror, files, runtimeDirectory, progress, paths) {
  const codeFiles = files.filter((file) => CODE_EXTENSIONS.has(path.extname(file.file).toLowerCase()));
  if (!codeFiles.length) return { nodes: [], edges: [], references: [], unresolvedByFile: {}, diagnostics: [], files: [], parsedFiles: [], frameworks: [], clean: false };
  const diagnostics = [], nodes = [], edges = [], references = [];
  const unresolvedByFile = {};
  const failedFiles = /* @__PURE__ */ new Set();
  let graph = null, connection, indexedFiles = [], frameworks = [], clean = true;
  boundary.begin({ readRoots: [mirror, runtimeDirectory], writeRoots: [path.join(mirror, ".codegraph")] });
  try {
    const onProgress = (value) => progress({ phase: `graph:${value.phase}`, current: value.current, total: value.total });
    if (paths) {
      graph = await sdk.CodeGraph.open(mirror, { sync: false });
      if (paths.length) await graph.sync({ paths, onProgress });
    } else {
      graph = await sdk.CodeGraph.init(mirror, { index: false });
      const result = await graph.indexAll({ onProgress });
      for (const error of result.errors || []) {
        if (error.filePath) failedFiles.add(error.filePath);
        diagnostics.push({ code: "incomplete_structure", file: error.filePath, message: "The graph SDK reported an extraction failure." });
      }
      if (!result.success && codeFiles.length) diagnostics.push({ code: "incomplete_structure", message: "The graph SDK did not complete indexing." });
      if ((result.errors || []).length || !result.success) clean = false;
    }
    graph.reinitializeResolver();
    frameworks = [...graph.getDetectedFrameworks()].sort();
    await graph.close();
    graph = null;
    connection = sdk.DatabaseConnection.open(sdk.getDatabasePath(mirror));
    const queries = new sdk.QueryBuilder(connection.getDb());
    indexedFiles = queries.getAllFiles();
    if (indexedFiles.some((file) => file.errors?.length)) clean = false;
    const source = new Map(files.map((file) => [file.file, file]));
    const indexed = new Map(indexedFiles.map((file) => [file.path, file]));
    for (const file of codeFiles) {
      const record = indexed.get(file.file);
      if (!record || record.errors?.length) diagnostics.push({ code: "incomplete_structure", file: file.file, message: "The graph SDK omitted or could not parse a source file." });
    }
    const position = new Map(files.map((file, index) => [file.file, index]));
    const at = (file) => position.get(file ?? "") ?? files.length;
    const ordered = queries.getAllNodes().map((node, index) => ({ node, index })).sort((a, b) => at(a.node.filePath) - at(b.node.filePath) || a.index - b.index).map(({ node }) => node);
    for (const node of ordered) {
      const file = source.get(node.filePath);
      if (!file || node.kind === "file") continue;
      if (!Number.isInteger(node.startLine) || !Number.isInteger(node.endLine) || node.startLine < 1 || node.endLine < node.startLine || node.endLine > file.content.split("\n").length) {
        failedFiles.add(node.filePath);
        diagnostics.push({ code: "incomplete_structure", file: node.filePath, message: "The graph SDK returned an invalid source range." });
        continue;
      }
      const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
      const start = lines.slice(0, node.startLine - 1).join("").length + node.startColumn;
      const end = lines.slice(0, node.endLine - 1).join("").length + node.endColumn;
      const exactSpan = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= file.content.length;
      nodes.push({
        id: node.id,
        file: node.filePath,
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName,
        selector: node.qualifiedName || node.name,
        domain: "code",
        range: { startLine: node.startLine, endLine: node.endLine },
        sourceHash: file.hash,
        signature: node.signature,
        docstring: node.docstring,
        rangeComplete: true,
        ...exactSpan ? { span: { start, end }, contentHash: createHash("sha256").update(file.content.slice(start, end)).digest("hex") } : {},
        ...node.isExported === void 0 ? {} : { isExported: node.isExported },
        ...node.visibility ? { visibility: node.visibility } : {}
      });
    }
    const ids = new Set(nodes.map((node) => node.id));
    const compare = (a, b) => a === b ? 0 : a === void 0 ? 1 : b === void 0 ? -1 : a < b ? -1 : 1;
    const edgeOrder = (a, b) => compare(a.line, b.line) || compare(a.column, b.column) || compare(a.kind, b.kind) || compare(a.target, b.target);
    for (const node of nodes) for (const edge of queries.getOutgoingEdges(node.id).sort(edgeOrder)) {
      if (ids.has(edge.target)) edges.push({
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        provenance: edge.provenance,
        line: edge.line,
        column: edge.column,
        metadata: edge.metadata
      });
    }
    const unresolved = /* @__PURE__ */ new Map();
    const imports = /* @__PURE__ */ new Map();
    for (const node of nodes) if (node.kind === "import") for (let line = node.range.startLine; line <= node.range.endLine; line++) {
      const key = `${node.file}:${line}`;
      if (!imports.has(key)) imports.set(key, node.name);
    }
    const fileOf = new Map(nodes.map((node) => [node.id, node.file]));
    const refFile = (ref) => ref.filePath || fileOf.get(ref.fromNodeId);
    const refs = queries.getUnresolvedReferences().sort((a, b) => at(refFile(a)) - at(refFile(b)) || compare(a.line, b.line) || compare(a.column, b.column) || compare(a.referenceName, b.referenceName) || compare(a.referenceKind, b.referenceKind) || compare(a.fromNodeId, b.fromNodeId));
    for (const ref of refs) {
      const file = ref.filePath || nodes.find((node) => node.id === ref.fromNodeId)?.file;
      if (file && source.has(file)) {
        unresolved.set(file, (unresolved.get(file) || 0) + 1);
        const name = ref.referenceKind === "imports" && imports.get(`${file}:${ref.line}`) || ref.referenceName;
        (unresolvedByFile[file] ||= []).push({ name, kind: ref.referenceKind });
      }
      if (ids.has(ref.fromNodeId) && ["calls", "instantiates"].includes(ref.referenceKind) && ref.referenceName)
        references.push({ source: ref.fromNodeId, name: ref.referenceName, kind: ref.referenceKind });
    }
    for (const [file, count] of unresolved) diagnostics.push({ code: "incomplete_structure", file, count, message: "The graph has unresolved references in this file." });
  } catch (error) {
    clean = false;
    diagnostics.push({ code: "incomplete_structure", message: error.code === "ERR_ACCESS_DENIED" ? "The graph requested an excluded dependency." : "The graph SDK failed to index the snapshot." });
  } finally {
    try {
      await graph?.close();
      connection?.close();
    } catch {
      diagnostics.push({ code: "incomplete_structure", message: "The graph database did not close cleanly." });
    }
    const denied = boundary.end();
    if (denied.length) clean = false;
    if (denied.length) diagnostics.push({
      code: "incomplete_structure",
      count: denied.length,
      denied: denied.map((item) => ({ path: path.relative(mirror, item.path), write: item.write })),
      message: "The graph requested files outside its snapshot, including suppressed access failures."
    });
  }
  return { nodes, edges, references, unresolvedByFile, diagnostics, files: indexedFiles.map((file) => file.path), parsedFiles: indexedFiles.filter((file) => !file.errors?.length && !failedFiles.has(file.path)).map((file) => file.path), frameworks, clean };
}
export {
  extractGraph
};
