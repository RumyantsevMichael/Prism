import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CODE_EXTENSIONS } from "./units.mjs";
import { installFileBoundary } from "./fs-boundary.mjs";
import type { SourceUnit, Diagnostic, Progress, Relationship, SourceFile, UnresolvedReference, FileReference } from "../server/repository-intelligence/repository-unit-types.mjs";
import type { CodeGraph, DatabaseConnection, FileRecord } from "@colbymchenry/codegraph";

const boundary = installFileBoundary();
const require = createRequire(import.meta.url);
let sdk: typeof import("@colbymchenry/codegraph") | undefined;

// A kept graph and the hashes of the files it was built from, which an incremental build syncs for changed paths instead of indexing every file.
// `changes` names what changed since the build that wrote `state`; without it, or without a usable state, the graph is built in full.
export interface GraphState { directory: string; changes?: { changedFiles: string[]; removedFiles: string[] } }
interface StoredGraph { schemaVersion: 1; sdk: string; files: Record<string, string> }
const GRAPH_STATE = "graph.json";
type Graph = Awaited<ReturnType<typeof extractOnce>>;

async function readGraphState(directory: string): Promise<StoredGraph | undefined> {
  try {
    const stored = JSON.parse(await readFile(path.join(directory, GRAPH_STATE), "utf8"));
    return stored?.schemaVersion === 1 && typeof stored.sdk === "string" && stored.files && typeof stored.files === "object" ? stored : undefined;
  } catch { return undefined; }
}

/**
 * The code units, links, and unresolved references of the code files, from the code graph SDK.
 * With `state`, the graph stays in the mirror for the next build, which syncs only the paths that changed since, and falls back to a full build
 * whenever the kept graph or its record cannot be trusted or the sync reports anything a full build could report differently.
 */
export async function extractGraph(mirror: string, files: Pick<SourceFile, "file" | "content" | "hash">[], runtimeDirectory: string, progress: (value: Progress) => void = () => {}, state?: GraphState): Promise<Graph> {
  sdk ||= require("@colbymchenry/codegraph") as typeof import("@colbymchenry/codegraph");
  const version: string = require("@colbymchenry/codegraph/package.json").version;
  const database = sdk.getDatabasePath(mirror);
  const stored = state?.changes ? await readGraphState(state.directory) : undefined;
  let paths: string[] | undefined;
  if (state?.changes && stored?.sdk === version && existsSync(database)) {
    // The record names what the kept graph holds, so a path whose hash differs from it is synced even when the request did not name it.
    const current = new Map(files.map(file => [file.file, file.hash]));
    paths = [...new Set([...state.changes.changedFiles, ...state.changes.removedFiles, ...files.filter(file => stored.files[file.file] !== file.hash).map(file => file.file),
      ...Object.keys(stored.files).filter(file => !current.has(file))])].sort();
  }
  // The record is removed while the graph changes, so a build that stops part way leaves the next one to build in full.
  if (state) await rm(path.join(state.directory, GRAPH_STATE), { force: true });
  let graph = paths ? await extractOnce(mirror, files, runtimeDirectory, progress, paths) : undefined;
  if (graph && !graph.clean) graph = undefined;
  if (!graph) {
    await rm(path.join(mirror, ".codegraph"), { recursive: true, force: true });
    graph = await extractOnce(mirror, files, runtimeDirectory, progress);
  }
  if (state && graph.clean) {
    try {
      await mkdir(state.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(state.directory, `${GRAPH_STATE}.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sdk: version, files: Object.fromEntries(files.map(file => [file.file, file.hash])) } satisfies StoredGraph), { mode: 0o600 });
      await rename(temporary, path.join(state.directory, GRAPH_STATE));
    } catch { /* A record that cannot be written leaves the next build a full one. */ }
  }
  const { clean: _clean, ...result } = graph;
  return result as Graph;
}

// One graph build: `paths` syncs those paths of the kept graph, and otherwise every file is indexed into a new graph.
// `clean` is true when nothing went wrong that an incremental build could report differently from a full one, which is when the kept graph may serve the next build.
async function extractOnce(mirror: string, files: Pick<SourceFile, "file" | "content" | "hash">[], runtimeDirectory: string, progress: (value: Progress) => void, paths?: string[]) {
  const codeFiles = files.filter(file => CODE_EXTENSIONS.has(path.extname(file.file).toLowerCase()));
  if (!codeFiles.length) return { nodes: [] as SourceUnit[], edges: [] as Relationship[], references: [] as UnresolvedReference[], unresolvedByFile: {} as Record<string, FileReference[]>, diagnostics: [] as Diagnostic[], files: [] as string[], parsedFiles: [] as string[], clean: false };
  const diagnostics: Diagnostic[] = [], nodes: SourceUnit[] = [], edges: Relationship[] = [], references: UnresolvedReference[] = [];
  // Every reference the graph could not resolve, by the file that makes it, so that Prism can tell a call into a library from a missing link.
  const unresolvedByFile: Record<string, FileReference[]> = {};
  const failedFiles = new Set<string>();
  let graph: CodeGraph | null = null, connection: DatabaseConnection | undefined, indexedFiles: FileRecord[] = [], clean = true;
  boundary.begin({ readRoots: [mirror, runtimeDirectory], writeRoots: [path.join(mirror, ".codegraph")] });
  try {
    const onProgress = (value: { phase: string; current: number; total: number }) => progress({ phase: `graph:${value.phase}`, current: value.current, total: value.total });
    if (paths) {
      graph = await sdk!.CodeGraph.open(mirror, { sync: false });
      if (paths.length) await graph.sync({ paths, onProgress });
    } else {
      graph = await sdk!.CodeGraph.init(mirror, { index: false });
      const result = await graph.indexAll({ onProgress });
      for (const error of result.errors || []) { if (error.filePath) failedFiles.add(error.filePath); diagnostics.push({ code: "incomplete_structure", file: error.filePath, message: "The graph SDK reported an extraction failure." }); }
      if (!result.success && codeFiles.length) diagnostics.push({ code: "incomplete_structure", message: "The graph SDK did not complete indexing." });
      if ((result.errors || []).length || !result.success) clean = false;
    }
    await graph.close(); graph = null;
    connection = sdk!.DatabaseConnection.open(sdk!.getDatabasePath(mirror));
    const queries = new sdk!.QueryBuilder(connection.getDb());
    indexedFiles = queries.getAllFiles();
    // A file the graph could not parse may also carry an extraction failure that only a full index reports.
    if (indexedFiles.some(file => file.errors?.length)) clean = false;
    const source = new Map(files.map(file => [file.file, file]));
    const indexed = new Map(indexedFiles.map(file => [file.path, file]));
    for (const file of codeFiles) {
      const record = indexed.get(file.file);
      if (!record || record.errors?.length) diagnostics.push({ code: "incomplete_structure", file: file.file, message: "The graph SDK omitted or could not parse a source file." });
    }
    // The graph's own order follows when each file was last written to it, so every list is put in the order of the request's files, which a full build
    // and an incremental one of the same files share; within a file, nodes keep the order the graph extracted them in.
    const position = new Map(files.map((file, index) => [file.file, index]));
    const at = (file: string | undefined) => position.get(file ?? "") ?? files.length;
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
      nodes.push({ id: node.id, file: node.filePath, kind: node.kind, name: node.name, qualifiedName: node.qualifiedName,
        selector: node.qualifiedName || node.name, domain: "code", range: { startLine: node.startLine, endLine: node.endLine },
        sourceHash: file.hash, signature: node.signature, docstring: node.docstring, rangeComplete: true,
        ...(exactSpan ? { span: { start, end }, contentHash: createHash("sha256").update(file.content.slice(start, end)).digest("hex") } : {}),
        ...(node.isExported === undefined ? {} : { isExported: node.isExported }), ...(node.visibility ? { visibility: node.visibility } : {}) });
    }
    const ids = new Set(nodes.map(node => node.id));
    const compare = (a: string | number | undefined, b: string | number | undefined) => a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : 1;
    const edgeOrder = (a: { target: string; kind: string; line?: number; column?: number }, b: typeof a) => compare(a.line, b.line) || compare(a.column, b.column) || compare(a.kind, b.kind) || compare(a.target, b.target);
    for (const node of nodes) for (const edge of queries.getOutgoingEdges(node.id).sort(edgeOrder)) {
      if (ids.has(edge.target)) edges.push({ source: edge.source, target: edge.target, kind: edge.kind, provenance: edge.provenance,
        line: edge.line, column: edge.column, metadata: edge.metadata });
    }
    const unresolved = new Map();
    // The graph names an unresolved import by the binding it imports, so the import is named by its declaration's module specifier,
    // which tells a package from a file of the source.
    const imports = new Map<string, string>();
    for (const node of nodes) if (node.kind === "import") for (let line = node.range.startLine; line <= node.range.endLine; line++) {
      const key = `${node.file}:${line}`;
      if (!imports.has(key)) imports.set(key, node.name);
    }
    const fileOf = new Map(nodes.map(node => [node.id, node.file]));
    const refFile = (ref: { filePath?: string; fromNodeId: string }) => ref.filePath || fileOf.get(ref.fromNodeId);
    const refs = queries.getUnresolvedReferences().sort((a, b) => at(refFile(a)) - at(refFile(b)) || compare(a.line, b.line) || compare(a.column, b.column)
      || compare(a.referenceName, b.referenceName) || compare(a.referenceKind, b.referenceKind) || compare(a.fromNodeId, b.fromNodeId));
    for (const ref of refs) {
      const file = ref.filePath || nodes.find(node => node.id === ref.fromNodeId)?.file;
      if (file && source.has(file)) {
        unresolved.set(file, (unresolved.get(file) || 0) + 1);
        const name = ref.referenceKind === "imports" && imports.get(`${file}:${ref.line}`) || ref.referenceName;
        (unresolvedByFile[file] ||= []).push({ name, kind: ref.referenceKind });
      }
      // Calls into libraries and unresolved helpers name the work that a unit depends on, even without a target unit.
      if (ids.has(ref.fromNodeId) && ["calls", "instantiates"].includes(ref.referenceKind) && ref.referenceName)
        references.push({ source: ref.fromNodeId, name: ref.referenceName, kind: ref.referenceKind });
    }
    for (const [file, count] of unresolved) diagnostics.push({ code: "incomplete_structure", file, count, message: "The graph has unresolved references in this file." });
  } catch (error) {
    clean = false;
    diagnostics.push({ code: "incomplete_structure", message: error.code === "ERR_ACCESS_DENIED" ? "The graph requested an excluded dependency." : "The graph SDK failed to index the snapshot." });
  } finally {
    try { await graph?.close(); connection?.close(); }
    catch { diagnostics.push({ code: "incomplete_structure", message: "The graph database did not close cleanly." }); }
    const denied = boundary.end();
    if (denied.length) clean = false;
    if (denied.length) diagnostics.push({ code: "incomplete_structure", count: denied.length,
      denied: denied.map(item => ({ path: path.relative(mirror, item.path), write: item.write })),
      message: "The graph requested files outside its snapshot, including suppressed access failures." });
  }
  return { nodes, edges, references, unresolvedByFile, diagnostics, files: indexedFiles.map(file => file.path), parsedFiles: indexedFiles.filter(file => !file.errors?.length && !failedFiles.has(file.path)).map(file => file.path), clean };
}
