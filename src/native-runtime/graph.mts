import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
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
interface StoredGraph { schemaVersion: 1; sdk: string; files: Record<string, string>; frameworks: string[] }
const GRAPH_STATE = "graph.json";
type Graph = Awaited<ReturnType<typeof extractOnce>>;
// The code graph also reads files that are not code to decide how every file is indexed: ignore files and its own `codegraph.json` set the scope,
// and manifests such as `package.json`, `go.mod`, or `requirements.txt` decide which frameworks it detects.
// That set is the SDK's and grows with it, so only code files and prose documents outside dot folders count as files a sync can take alone,
// and a change to any other path builds the graph in full.
const PROSE = /\.(md|mdx|markdown|rst|adoc)$/i;
const syncable = (file: string) => !file.split("/").some(part => part.startsWith("."))
  && (CODE_EXTENSIONS.has(path.extname(file).toLowerCase()) || PROSE.test(file));

async function readGraphState(directory: string): Promise<StoredGraph | undefined> {
  try {
    const stored = JSON.parse(await readFile(path.join(directory, GRAPH_STATE), "utf8"));
    return stored?.schemaVersion === 1 && typeof stored.sdk === "string" && stored.files && typeof stored.files === "object"
      && Array.isArray(stored.frameworks) && stored.frameworks.every((name: unknown) => typeof name === "string") ? stored : undefined;
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
    if (!paths.every(syncable)) paths = undefined;
  }
  // The record is removed while the graph changes, so a build that stops part way leaves the next one to build in full.
  if (state) await rm(path.join(state.directory, GRAPH_STATE), { force: true });
  let graph = paths ? await extractOnce(mirror, files, runtimeDirectory, progress, paths) : undefined;
  // Frameworks are detected from the whole file set, so a sync that changes which ones the graph detects would leave the other files indexed under the old ones.
  if (graph && (!graph.clean || graph.frameworks.join("\n") !== stored!.frameworks.join("\n"))) graph = undefined;
  if (!graph) {
    await rm(path.join(mirror, ".codegraph"), { recursive: true, force: true });
    graph = await extractOnce(mirror, files, runtimeDirectory, progress);
  }
  if (state && graph.clean) {
    try {
      await mkdir(state.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(state.directory, `${GRAPH_STATE}.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sdk: version, files: Object.fromEntries(files.map(file => [file.file, file.hash])), frameworks: graph.frameworks } satisfies StoredGraph), { mode: 0o600 });
      await rename(temporary, path.join(state.directory, GRAPH_STATE));
    } catch { /* A record that cannot be written leaves the next build a full one. */ }
  }
  const { clean: _clean, frameworks: _frameworks, ...result } = graph;
  return result as Graph;
}

// A sync re-reads only the files it is given, and a file whose own content did not change can still resolve differently when a file it reaches changes:
// it imports a module by a path that now exists, or through a re-exporting file that now points elsewhere.
// So every unchanged code file that may resolve through a changed or removed one is synced with it, and is marked changed in the kept graph,
// because the graph skips a file whose recorded hash still matches. A file may resolve through another when, in the graph, it links to that
// file's units or to the units that file imports, when it holds an import the graph could not resolve by a name that a path alias or a workspace
// package of the snapshot declares, since such a name need not name the file it leads to, or when its text names as a module (by its stem, or the
// folder of an index or package file) that file or, transitively, a file so found that may re-export what it imports.
// The links are read again from the synced graph, since a changed file can import units it did not import before, until no file is added.
// When the synced files would exceed half the code files and 32, or the graph cannot be read, the graph is built in full, which `undefined` asks for.
// The cost is a sync of the files that reach a change: in a graph of 400 files, an edit that two files reach syncs three, and one that forty reach syncs 41.
const MODULE_FILES = new Set(["index", "__init__", "mod", "lib", "main", "package-info"]);
function moduleNames(file: string) {
  const parsed = path.posix.parse(file);
  const names = [parsed.name];
  // Go imports a package by its folder.
  if ((MODULE_FILES.has(parsed.name) || parsed.ext === ".go") && parsed.dir) names.push(path.posix.basename(parsed.dir));
  return names;
}
// The import names that the snapshot's path aliases (`compilerOptions.paths` of a `tsconfig` or `jsconfig` file) and workspace packages (the `name` of a
// `package.json`) declare, as prefixes, or undefined when one of those files cannot be read, so that any unresolved import may lead to any file.
function declaredImportNames(files: Pick<SourceFile, "file" | "content">[]): string[] | undefined {
  const names: string[] = [];
  for (const file of files) {
    const base = path.posix.basename(file.file);
    const config = /^(ts|js)config.*\.json$/i.test(base), manifest = base === "package.json";
    if (!config && !manifest) continue;
    const errors: ParseError[] = [];
    const value = parseJsonc(file.content, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== "object") return undefined;
    if (manifest && typeof value.name === "string" && value.name) names.push(value.name);
    const aliases = config ? value.compilerOptions?.paths : undefined;
    if (aliases && typeof aliases === "object") for (const key of Object.keys(aliases)) names.push(key.replace(/\*.*$/, ""));
  }
  return names;
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whether a file may re-export what it imports, so that a file importing it resolves through the files it imports; on doubt it may.
const JS = /\.(m|c)?(j|t)sx?$/i;
function passesOn(file: string, content: string) {
  const extension = path.extname(file).toLowerCase();
  if (JS.test(file)) return /\bexport\s*(\*|\{|type\s*\{)/.test(content) || /\bexport\s+default\s+[A-Za-z_$][\w$.]*\s*;?\s*$/m.test(content)
    || /\b(module\.)?exports\b/.test(content) && /\brequire\s*\(/.test(content);
  if (extension === ".rs") return /\bpub\s*(\([^)]*\)\s*)?use\b/.test(content);
  return !KNOWN_ROOTED.has(extension);
}
// Languages that resolve a reference by its full name or its package rather than through the file that imports it; a Python module or a C header
// passes on what it imports, and so does a language not named here.
const KNOWN_ROOTED = new Set([".java", ".kt", ".kts", ".scala", ".cs", ".go", ".c", ".cc", ".cpp", ".cxx", ".swift"]);
const isCode = (file: string) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase());
// The files to sync with `paths` that `synced` does not hold yet, marked changed in the graph; the first round, without `synced`, also reads the text and
// the unresolved imports.
function dependents(mirror: string, files: Pick<SourceFile, "file" | "content">[], paths: string[], synced?: Set<string>): string[] | undefined {
  const codeFiles = files.filter(file => isCode(file.file));
  const changed = paths.filter(isCode);
  if (!changed.length) return [];
  let connection: DatabaseConnection | undefined;
  try {
    connection = sdk!.DatabaseConnection.open(sdk!.getDatabasePath(mirror));
    const db = connection.getDb();
    const tracked = new Set((db.prepare("SELECT path FROM files").all() as { path: string }[]).map(row => row.path));
    const found = new Set<string>();
    const marks = changed.map(() => "?").join(",");
    // Files linking to the units of a changed or removed file, or to the units that file imports, which a re-exporting file passes on.
    const linked = db.prepare(`SELECT DISTINCT s.file_path AS file FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE t.file_path IN (${marks}) OR e.target IN (SELECT e2.target FROM edges e2 JOIN nodes s2 ON s2.id = e2.source WHERE s2.file_path IN (${marks}) AND e2.kind = 'imports')`)
      .all(...changed, ...changed) as { file: string }[];
    for (const row of linked) found.add(row.file);
    if (!synced) {
      const declared = declaredImportNames(files);
      if (!declared || declared.length) {
        const failed = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(r.file_path, ''), n.file_path) AS file, r.reference_name AS name FROM unresolved_refs r
          LEFT JOIN nodes n ON n.id = r.from_node_id WHERE r.reference_kind = 'imports'`).all() as { file: string | null; name: string }[];
        for (const row of failed) if (row.file && (!declared || declared.some(prefix => row.name === prefix || row.name.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)))) found.add(row.file);
      }
      const content = new Map(codeFiles.map(file => [file.file, file.content]));
      const reached = new Set(changed);
      // A found file passes its importers on only when it may re-export what it imports.
      const onward = () => [...found].filter(file => !reached.has(file) && passesOn(file, content.get(file) ?? ""));
      let names = [...changed, ...onward()].flatMap(moduleNames);
      while (names.length) {
        for (const file of found) reached.add(file);
        const pattern = new RegExp(`(?<![\\w$-])(?:${[...new Set(names)].map(escape).join("|")})(?![\\w$-])`);
        for (const file of codeFiles) if (!reached.has(file.file) && pattern.test(file.content)) found.add(file.file);
        names = onward().flatMap(moduleNames);
      }
    }
    const present = new Set(codeFiles.map(file => file.file));
    const before = synced ?? new Set(paths);
    const added = [...found].filter(file => present.has(file) && !before.has(file));
    if (before.size + added.length > Math.max(32, codeFiles.length / 2)) return undefined;
    const stale = db.prepare("UPDATE files SET content_hash = '', size = -1 WHERE path = ?");
    for (const file of added) if (tracked.has(file)) stale.run(file);
    return added.sort();
  } catch { return undefined; }
  finally { try { connection?.close(); } catch { /* The sync that follows opens the graph again and reports a database it cannot use. */ } }
}

// Whether the graph's detected frameworks run a pass over several files at once, or undefined when the graph does not show them.
function crossFilePass(graph: CodeGraph): boolean | undefined {
  const frameworks = (graph as unknown as { resolver?: { frameworks?: unknown } }).resolver?.frameworks;
  return Array.isArray(frameworks) ? frameworks.some(framework => typeof framework?.postExtract === "function") : undefined;
}

// One graph build: `paths` syncs those paths of the kept graph, and otherwise every file is indexed into a new graph.
// `clean` is true when nothing went wrong that an incremental build could report differently from a full one, which is when the kept graph may serve the next build.
async function extractOnce(mirror: string, files: Pick<SourceFile, "file" | "content" | "hash">[], runtimeDirectory: string, progress: (value: Progress) => void, paths?: string[]) {
  const codeFiles = files.filter(file => CODE_EXTENSIONS.has(path.extname(file.file).toLowerCase()));
  if (!codeFiles.length) return { nodes: [] as SourceUnit[], edges: [] as Relationship[], references: [] as UnresolvedReference[], unresolvedByFile: {} as Record<string, FileReference[]>, diagnostics: [] as Diagnostic[], files: [] as string[], parsedFiles: [] as string[], frameworks: [] as string[], clean: false };
  const diagnostics: Diagnostic[] = [], nodes: SourceUnit[] = [], edges: Relationship[] = [], references: UnresolvedReference[] = [];
  // Every reference the graph could not resolve, by the file that makes it, so that Prism can tell a call into a library from a missing link.
  const unresolvedByFile: Record<string, FileReference[]> = {};
  const failedFiles = new Set<string>();
  let graph: CodeGraph | null = null, connection: DatabaseConnection | undefined, indexedFiles: FileRecord[] = [], frameworks: string[] = [], clean = true;
  boundary.begin({ readRoots: [mirror, runtimeDirectory], writeRoots: [path.join(mirror, ".codegraph")] });
  try {
    const onProgress = (value: { phase: string; current: number; total: number }) => progress({ phase: `graph:${value.phase}`, current: value.current, total: value.total });
    if (paths) {
      const incomplete = () => ({ nodes, edges, references, unresolvedByFile, diagnostics, files: [] as string[], parsedFiles: [] as string[], frameworks, clean: false });
      let added = dependents(mirror, files, paths);
      if (!added) return incomplete();
      const synced = new Set([...paths, ...added]);
      graph = await sdk!.CodeGraph.open(mirror, { sync: false });
      // A framework pass that rewrites units from what several files hold together (NestJS route prefixes from module wiring) does not undo
      // what it wrote for files a sync leaves alone, so a graph that runs one, or whose passes cannot be read, is built in full.
      if (crossFilePass(graph) !== false) return incomplete();
      let next = [...synced].sort();
      while (next.length) {
        await graph.sync({ paths: next, onProgress });
        await graph.close(); graph = null;
        added = dependents(mirror, files, paths, synced);
        if (!added) return incomplete();
        for (const file of added) synced.add(file);
        next = added;
        graph = await sdk!.CodeGraph.open(mirror, { sync: false });
      }
    } else {
      graph = await sdk!.CodeGraph.init(mirror, { index: false });
      const result = await graph.indexAll({ onProgress });
      for (const error of result.errors || []) { if (error.filePath) failedFiles.add(error.filePath); diagnostics.push({ code: "incomplete_structure", file: error.filePath, message: "The graph SDK reported an extraction failure." }); }
      if (!result.success && codeFiles.length) diagnostics.push({ code: "incomplete_structure", message: "The graph SDK did not complete indexing." });
      if ((result.errors || []).length || !result.success) clean = false;
    }
    // Detected again from the files the graph now holds, as a full build of them would detect them.
    graph.reinitializeResolver();
    frameworks = [...graph.getDetectedFrameworks()].sort();
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
  return { nodes, edges, references, unresolvedByFile, diagnostics, files: indexedFiles.map(file => file.path), parsedFiles: indexedFiles.filter(file => !file.errors?.length && !failedFiles.has(file.path)).map(file => file.path), frameworks, clean };
}
