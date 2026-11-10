import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Projects that declare components, and a native runtime whose helper builds and searches small indexes in process, for the acceptance tests of
// components.md §20-§26. A test file sets PLUGIN_DATA before it uses these helpers, because Prism modules read their data folder when they load,
// so every Prism module is imported here only inside a helper, never when this file loads.

export const manifestPath = fileURLToPath(new URL("./native-manifest-unavailable.json", import.meta.url));

/** net and app are declared components; README.md and .prism/workflow.md belong to the root component. */
export const DECLARATION = ["## Components", "- net: packages/net", "- app: packages/app", "  - Depends on: net", ""].join("\n");

const body = (name, lines) => `export function ${name}(value) {\n${Array.from({ length: lines }, (_, index) => `  value = value + ${index};`).join("\n")}\n  return value;\n}\n`;

export const FILES = {
  "README.md": "# Fixture\n\nRetry failed network requests.\n",
  "packages/net/retry.ts": body("retryRequest", 4),
  "packages/net/timeout.ts": body("timeoutAfter", 3),
  "packages/app/client.ts": body("fetchUser", 5)
};

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A workflow configuration with optional Components and Workspace lines. */
export function workflow({ components = DECLARATION, workspace = null } = {}) {
  return [
    "## Paths",
    "- Plans: docs/plans",
    "",
    ...(components === null ? [] : [components]),
    ...(workspace === null ? [] : ["## Workspace", ...workspace, ""])
  ].join("\n");
}

/** A Git project holding `files` and a `.prism/workflow.md`, with a storage folder for native indexes beside it. */
export async function project(t, { files = FILES, components = DECLARATION, workspace = null } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-indexes-")));
  const root = path.join(directory, "project");
  const storage = path.join(directory, "storage");
  await mkdir(root);
  // A preparation can still finish writing its cache after a test ends, so cleanup retries a directory that is not yet empty.
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  for (const [file, content] of Object.entries(files)) await write(file, content);
  await write(".prism/workflow.md", workflow({ components, workspace }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { directory, root, storage, write, configure: (options) => write(".prism/workflow.md", workflow(options)) };
}

/** The source files of `files` and the workflow that a component holds, in path order, as clause 3 fingerprints them. */
export function fingerprint(entries) {
  return sha256(entries.map(([file, content]) => `${file} ${sha256(content)}\n`).sort().join(""));
}

/**
 * A NativeSemanticRuntime whose helper and index store run in this process: build makes one function unit per `export function`, and search reads that index back.
 * control.builds lists each build's files; control.hold(file) keeps every build that holds the file waiting until control.release(file);
 * control.reached(file) settles once a build that holds the file has started waiting on its hold, so a test can observe a component while it prepares
 * without depending on how long the builds queued before it take;
 * control.fail(file, code) makes every build that holds the file fail with that code; control.cosine[file] and control.lexical[file] score search results,
 * which each index orders by lexicalScore from highest to lowest and then by path.
 */
export async function fakeRuntime(storage) {
  const { NativeSemanticRuntime } = await import("../../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
  const runtime = new NativeSemanticRuntime({ directory: storage, manifestPath });
  runtime.assets = async () => ({ runtime: "fake-runtime", modelDirectory: "fake-model", modelIdentity: "fake-model", assetIdentity: "fake-assets" });
  const holds = new Map();
  const reached = new Map();
  const arrival = (file) => {
    if (!reached.has(file)) { let resolve; const promise = new Promise((done) => { resolve = done; }); reached.set(file, { promise, resolve }); }
    return reached.get(file);
  };
  const failures = new Map();
  const control = {
    builds: [],
    searches: [],
    cosine: {},
    lexical: {},
    hold(file) { let release; const promise = new Promise((resolve) => { release = resolve; }); holds.set(file, { promise, release }); },
    release(file) { holds.get(file)?.release(); holds.delete(file); },
    reached(file) { return arrival(file).promise; },
    fail(file, code) { failures.set(file, code); },
    recover(file) { failures.delete(file); }
  };
  const build = async (args) => {
    const files = args.files.map((file) => file.file).sort();
    control.builds.push({ files, previousEmbeddings: Object.keys(args.previousEmbeddings || {}).sort() });
    for (const file of files) if (holds.has(file)) { arrival(file).resolve(); await holds.get(file).promise; }
    for (const file of files) if (failures.has(file)) {
      const code = failures.get(file);
      throw Object.assign(new Error(code === "resource_limit" ? "Native preparation exceeded its 30 minute operation limit." : "The native helper exited before completing its request."), { code });
    }
    const units = [], chunks = [], fileCoverage = {}, syntaxCoverage = {};
    let reused = 0;
    for (const { file, hash } of args.files) {
      const content = await readFile(path.join(args.mirror, file), "utf8");
      fileCoverage[file] = true;
      syntaxCoverage[file] = true;
      const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      units.push({ id: `file:${file}`, file, kind: "file", name: file, domain: "code", range: { startLine: 1, endLine: Math.max(1, lines) }, sourceHash: hash, rangeComplete: true });
      const match = /export function (\w+)/.exec(content);
      if (match) {
        units.push({ id: `function:${file}#${match[1]}`, file, kind: "function", name: match[1], qualifiedName: match[1], selector: match[1], domain: "code",
          range: { startLine: 1, endLine: lines }, span: { start: match.index, end: content.length - 1 }, contentHash: sha256(content.slice(match.index, content.length - 1)),
          sourceHash: hash, rangeComplete: true, isExported: true });
      }
      const embeddingKey = sha256(`${file}\0${hash}`);
      if (args.previousEmbeddings?.[embeddingKey]) reused += 1;
      chunks.push({ id: `chunk:${file}`, parentId: `file:${file}`, file, kind: "file", name: file, role: "whole", range: { startLine: 1, endLine: Math.max(1, lines) },
        rangeComplete: true, sourceStart: 0, sourceEnd: content.length, prefixLength: 0, text: content, embeddingText: content, context: "", embeddingKey, embedding: [1, 0] });
    }
    return { schemaVersion: 1, chunkerVersion: "fake-chunker", modelIdentity: "fake-model", snapshot: args.snapshot, units, edges: [], unresolvedReferences: [], chunks,
      fileCoverage, syntaxCoverage, diagnostics: [], counts: { files: args.files.length, units: units.length, fragments: chunks.length, reusedEmbeddings: reused, newEmbeddings: chunks.length - reused },
      structureComplete: true, resources: { rssBytes: 0, peakRssBytes: 0 } };
  };
  const search = async (args) => {
    const index = JSON.parse(await readFile(args.indexPath, "utf8"));
    const paths = args.filters?.paths || [];
    const results = index.units
      .filter((unit) => unit.kind === "function" && (!paths.length || paths.some((prefix) => unit.file === prefix || unit.file.startsWith(`${prefix}/`))))
      .map((unit) => ({ ...unit, cosineSimilarity: control.cosine[unit.file] ?? 0.5, lexicalScore: control.lexical[unit.file] ?? 0, fusedScore: (control.lexical[unit.file] ?? 0) / 100, excerpt: "" }))
      .sort((left, right) => right.lexicalScore - left.lexicalScore || left.file.localeCompare(right.file))
      .slice(0, args.limit)
      .map((result, position) => ({ ...result, fusedRank: position + 1 }));
    control.searches.push({ files: results.map((result) => result.file) });
    return results;
  };
  const helper = { request: async (method, args) => (method === "build" ? build(args) : search(args)) };
  runtime.helper = () => helper;
  runtime.store = runtime.inProcessStore();
  return { runtime, control };
}

/** Waits until no component of the project is waiting or preparing, reading only the runtime's status. */
export async function settled(runtime, root) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runtime.status(root, 200);
    const busy = (status.components ?? []).some((entry) => ["waiting", "preparing"].includes(entry.status)) || status.status === "preparing";
    if (!busy) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The component preparations did not settle.");
}

/** The entry of `components` that names `identity`. */
export const entry = (result, identity) => (result.components ?? []).find((item) => item.component === identity);
