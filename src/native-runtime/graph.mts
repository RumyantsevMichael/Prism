import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { CODE_EXTENSIONS } from "./concepts.mjs";
import { installFileBoundary } from "./fs-boundary.mjs";
import type { Concept, Diagnostic, Progress, Relationship, SourceFile } from "../server/repository-intelligence/repository-concept-types.mjs";
import type { CodeGraph, DatabaseConnection, FileRecord } from "@colbymchenry/codegraph";

const boundary = installFileBoundary();
const require = createRequire(import.meta.url);
let sdk: typeof import("@colbymchenry/codegraph") | undefined;

export async function extractGraph(mirror: string, files: Pick<SourceFile, "file" | "content" | "hash">[], runtimeDirectory: string, progress: (value: Progress) => void = () => {}) {
  const codeFiles = files.filter(file => CODE_EXTENSIONS.has(path.extname(file.file).toLowerCase()));
  if (!codeFiles.length) return { nodes: [], edges: [], diagnostics: [], files: [], parsedFiles: [] };
  const diagnostics: Diagnostic[] = [], nodes: Concept[] = [], edges: Relationship[] = [];
  const failedFiles = new Set<string>();
  let graph: CodeGraph | null = null, connection: DatabaseConnection | undefined, indexedFiles: FileRecord[] = [];
  boundary.begin({ readRoots: [mirror, runtimeDirectory], writeRoots: [path.join(mirror, ".codegraph")] });
  try {
    sdk ||= require("@colbymchenry/codegraph") as typeof import("@colbymchenry/codegraph");
    graph = await sdk.CodeGraph.init(mirror, { index: false });
    const result = await graph.indexAll({ onProgress: value => progress({ phase: `graph:${value.phase}`, current: value.current, total: value.total }) });
    for (const error of result.errors || []) { if (error.filePath) failedFiles.add(error.filePath); diagnostics.push({ code: "incomplete_structure", file: error.filePath, message: "The graph SDK reported an extraction failure." }); }
    if (!result.success && codeFiles.length) diagnostics.push({ code: "incomplete_structure", message: "The graph SDK did not complete indexing." });
    await graph.close(); graph = null;
    connection = sdk.DatabaseConnection.open(sdk.getDatabasePath(mirror));
    const queries = new sdk.QueryBuilder(connection.getDb());
    indexedFiles = queries.getAllFiles();
    const source = new Map(files.map(file => [file.file, file]));
    const indexed = new Map(indexedFiles.map(file => [file.path, file]));
    for (const file of codeFiles) {
      const record = indexed.get(file.file);
      if (!record || record.errors?.length) diagnostics.push({ code: "incomplete_structure", file: file.file, message: "The graph SDK omitted or could not parse a source file." });
    }
    for (const node of queries.getAllNodes()) {
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
    for (const node of nodes) for (const edge of queries.getOutgoingEdges(node.id)) {
      if (ids.has(edge.target)) edges.push({ source: edge.source, target: edge.target, kind: edge.kind, provenance: edge.provenance,
        line: edge.line, column: edge.column, metadata: edge.metadata });
    }
    const unresolved = new Map();
    for (const ref of queries.getUnresolvedReferences()) {
      const file = ref.filePath || nodes.find(node => node.id === ref.fromNodeId)?.file;
      if (file && source.has(file)) unresolved.set(file, (unresolved.get(file) || 0) + 1);
    }
    for (const [file, count] of unresolved) diagnostics.push({ code: "incomplete_structure", file, count, message: "The graph has unresolved references in this file." });
  } catch (error) {
    diagnostics.push({ code: "incomplete_structure", message: error.code === "ERR_ACCESS_DENIED" ? "The graph requested an excluded dependency." : "The graph SDK failed to index the snapshot." });
  } finally {
    try { await graph?.close(); connection?.close(); }
    catch { diagnostics.push({ code: "incomplete_structure", message: "The graph database did not close cleanly." }); }
    const denied = boundary.end();
    if (denied.length) diagnostics.push({ code: "incomplete_structure", count: denied.length,
      denied: denied.map(item => ({ path: path.relative(mirror, item.path), write: item.write })),
      message: "The graph requested files outside its snapshot, including suppressed access failures." });
  }
  return { nodes, edges, diagnostics, files: indexedFiles.map(file => file.path), parsedFiles: indexedFiles.filter(file => !file.errors?.length && !failedFiles.has(file.path)).map(file => file.path) };
}
