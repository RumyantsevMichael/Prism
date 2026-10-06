import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CODEGRAPH_SUPPORTED_VERSION,
  CodeGraphAvailabilityError,
  CodeGraphRuntimeError,
  createCodeGraphCommandRunner,
  openCodeGraphRepositoryIntelligence,
  probeCodeGraphAvailability
} from "../../dist/server/repository-intelligence/codegraph-provider.mjs";

async function projectFixture(context, name = "project") {
  const parent = await mkdtemp(path.join(tmpdir(), "prism-codegraph-"));
  const root = path.join(parent, name);
  await mkdir(path.join(root, ".codegraph"), { recursive: true });
  context.after(() => rm(parent, { recursive: true, force: true }));
  return realpath(root);
}

function healthyStatus(projectRoot, overrides = {}) {
  return {
    initialized: true,
    version: "1.6.0",
    projectPath: projectRoot,
    indexPath: path.join(projectRoot, ".codegraph"),
    lastIndexed: "2026-09-19T10:00:00.000Z",
    fileCount: 4,
    nodeCount: 12,
    edgeCount: 8,
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    worktreeMismatch: null,
    index: {
      builtWithVersion: "1.6.0",
      builtWithExtractionVersion: 42,
      currentExtractionVersion: 42,
      reindexRecommended: false,
      state: "complete",
      pendingRefs: 0
    },
    ...overrides
  };
}

function sourceProvider() {
  const reads = [];
  return {
    reads,
    async describe() {
      return {
        name: "native",
        commit: "0123456789abcdef",
        sourceFingerprint: "source-0123456789abcdef",
        snapshotIdentity: {
          scheme: "prism-native-sha256-v2",
          commit: "0123456789abcdef",
          fingerprint: "source-0123456789abcdef"
        },
        capabilities: { verifiedSource: true }
      };
    },
    async read(sourceRange) {
      reads.push(sourceRange);
      return {
        content: `${sourceRange.file}:${sourceRange.range.startLine}-${sourceRange.range.endLine}`,
        rendered: `${sourceRange.file}:${sourceRange.range.startLine}-${sourceRange.range.endLine}`,
        range: sourceRange.range,
        rangeComplete: true
      };
    }
  };
}

function fixtureRunner(projectRoot, options = {}) {
  const calls = [];
  const statuses = options.statuses || [healthyStatus(projectRoot)];
  let statusIndex = 0;
  const run = async (args, commandOptions = {}) => {
    calls.push({ args, options: commandOptions });
    if (args[0] === "--version") {
      return { stdout: `${options.version || "1.6.0"}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "status") {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return { stdout: JSON.stringify(status), stderr: "", exitCode: 0 };
    }
    if (args[0] === "context") {
      return { stdout: JSON.stringify(options.context || { entryPoints: [], nodes: [], edges: [], relatedFiles: [], stats: {} }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "query") {
      const symbol = args.at(-1);
      const payload = options.queries?.[symbol] || [];
      return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  return { calls, run };
}

test("probes a compatible exact-root CodeGraph index", async (context) => {
  const root = await projectFixture(context);
  const runner = fixtureRunner(root);

  const result = await probeCodeGraphAvailability(root, { runner: runner.run });

  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.provider, "codegraph");
  assert.equal(result.version, "1.6.0");
  assert.deepEqual(CODEGRAPH_SUPPORTED_VERSION, { minimum: "1.6.0", maximumExclusive: "1.7.0" });
  assert.deepEqual(runner.calls.map(({ args }) => args[0]), ["--version", "status"]);
  assert.deepEqual(runner.calls[1].args, ["status", "--json", root]);
});

test("accepts later CodeGraph 1.6 patch versions", async (context) => {
  const root = await projectFixture(context);
  const runner = fixtureRunner(root, { version: "1.6.99", statuses: [healthyStatus(root, { version: "1.6.99" })] });

  const result = await probeCodeGraphAvailability(root, { runner: runner.run });

  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.version, "1.6.99");
});

test("reports a missing exact-root index without starting CodeGraph", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "prism-codegraph-missing-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(path.join(parent, ".codegraph"));
  const nestedRoot = path.join(parent, "nested");
  await mkdir(nestedRoot);
  let called = false;

  const result = await probeCodeGraphAvailability(nestedRoot, { runner: async () => { called = true; } });

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.code, "not-indexed");
  assert.equal(called, false);
});

test("rejects unsupported CodeGraph versions", async (context) => {
  const root = await projectFixture(context);
  for (const version of ["1.5.9", "1.7.0", "2.0.0", "not-semver"]) {
    const result = await probeCodeGraphAvailability(root, { runner: fixtureRunner(root, { version }).run });
    assert.equal(result.status, "UNAVAILABLE", version);
    assert.equal(result.code, "incompatible-version", version);
  }
});

test("rejects stale, partial, and mismatched indexes", async (context) => {
  const root = await projectFixture(context);
  const cases = [
    ["stale-index", { pendingChanges: { added: 0, modified: 1, removed: 0 } }],
    ["incomplete-index", { index: { ...healthyStatus(root).index, state: "partial" } }],
    ["incomplete-index", { index: { ...healthyStatus(root).index, pendingRefs: 2 } }],
    ["incompatible-index", { index: { ...healthyStatus(root).index, reindexRecommended: true } }],
    ["worktree-mismatch", { worktreeMismatch: { worktreeRoot: root, indexRoot: `${root}-other` } }],
    ["project-mismatch", { projectPath: path.dirname(root) }],
    ["project-mismatch", { indexPath: path.join(path.dirname(root), ".codegraph") }]
  ];

  for (const [code, override] of cases) {
    const result = await probeCodeGraphAvailability(root, { runner: fixtureRunner(root, { statuses: [healthyStatus(root, override)] }).run });
    assert.equal(result.status, "UNAVAILABLE", code);
    assert.equal(result.code, code, code);
  }
});

test("describes the adapter through native source identity", async (context) => {
  const root = await projectFixture(context);
  const native = sourceProvider();
  const provider = await openCodeGraphRepositoryIntelligence(root, native, { runner: fixtureRunner(root).run });

  const description = await provider.describe();

  assert.equal(description.name, "codegraph");
  assert.equal(description.version, "1.6.0");
  assert.equal(description.commit, "0123456789abcdef");
  assert.equal(description.sourceFingerprint, "source-0123456789abcdef");
  assert.equal(description.snapshotIdentity.scheme, "prism-native-sha256-v2");
  assert.deepEqual(description.capabilities, {
    lexicalSearch: true,
    semanticSearch: false,
    hybridSearch: false,
    symbolGraph: true,
    verifiedSource: true
  });
});

test("normalizes CodeGraph entry points and directional graph relationships", async (context) => {
  const root = await projectFixture(context);
  const contextPayload = {
    entryPoints: [
      { id: "service", kind: "class", name: "Service", qualifiedName: "src/service.mjs::Service", filePath: "src/service.mjs", startLine: 2, endLine: 20, signature: "class Service" }
    ],
    nodes: [
      { id: "service", kind: "class", name: "Service", qualifiedName: "src/service.mjs::Service", filePath: "src/service.mjs", startLine: 2, endLine: 20, signature: "class Service" },
      { id: "run", kind: "method", name: "run", qualifiedName: "src/service.mjs::Service.run", filePath: "src/service.mjs", startLine: 5, endLine: 10, signature: "run()" },
      { id: "caller", kind: "function", name: "main", qualifiedName: "src/main.mjs::main", filePath: "src/main.mjs", startLine: 1, endLine: 8, signature: "main()" },
      { id: "test", kind: "function", name: "tests service", qualifiedName: "test/service.test.mjs::tests service", filePath: "test/service.test.mjs", startLine: 3, endLine: 12 }
    ],
    edges: [
      { source: "service", target: "run", kind: "contains" },
      { source: "caller", target: "service", kind: "calls" },
      { source: "test", target: "service", kind: "calls" }
    ],
    relatedFiles: ["src/service.mjs", "src/main.mjs", "test/service.test.mjs"],
    stats: { nodeCount: 4, edgeCount: 3, fileCount: 3, codeBlockCount: 0, totalCodeSize: 0 }
  };
  const runner = fixtureRunner(root, { context: contextPayload });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });
  await provider.describe();

  const search = await provider.search("change Service", { symbols: ["Service"], concepts: ["missing policy"] }, { topK: 4, budget: "balanced" });
  const graph = await provider.neighbors(search.hits.map(({ node }) => node), { maxNodes: 8 });

  assert.deepEqual(search.hits[0].node, {
    id: "service",
    file: "src/service.mjs",
    range: { startLine: 2, endLine: 20 },
    kind: "class",
    name: "Service",
    rangeComplete: true,
    qualifiedName: "src/service.mjs::Service",
    signature: "class Service"
  });
  assert.deepEqual(search.hits[0].reasons, ["explicit-design-reference", "provider-ranked-match", "lexical-match", "graph-expansion"]);
  assert.deepEqual(search.unresolvedConcepts, ["missing policy"]);
  assert.equal(search.estimateEligible, true);
  assert.equal(search.retrievalPlan.engines.includes("semantic"), false);
  assert.ok(search.diagnostics.some(({ code }) => code === "semantic_unavailable"));
  assert.ok(graph.neighbors.some(({ node, relationship }) => node.id === "caller" && relationship === "caller"));
  assert.ok(graph.neighbors.some(({ node, relationship }) => node.id === "test" && relationship === "tests"));
  assert.ok(graph.neighbors.some(({ node, relationship }) => node.id === "run" && relationship === "reference"));
  assert.equal(graph.estimateEligible, true);
  const contextCall = runner.calls.find(({ args }) => args[0] === "context");
  assert.deepEqual(contextCall.args.slice(0, 9), ["context", "--path", root, "--format", "json", "--max-nodes", "100", "--no-code", "--"]);
});

test("uses exact symbol queries and reports unresolved required symbols", async (context) => {
  const root = await projectFixture(context);
  const foo = { id: "foo", kind: "class", name: "Foo", qualifiedName: "Domain.Foo", filePath: "src/foo.mjs", startLine: 4, endLine: 18, signature: "class Foo" };
  const runner = fixtureRunner(root, {
    queries: {
      "Domain.Foo": [{ node: foo, score: 91 }],
      Missing: []
    }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });
  await provider.describe();

  const result = await provider.search("change types", { files: ["docs/contract.md"], symbols: ["Domain.Foo", "Missing"] }, { topK: 4, budget: "fast" });

  assert.equal(result.hits[0].node.qualifiedName, "Domain.Foo");
  assert.deepEqual(result.hits[0].reasons, ["explicit-design-reference", "lexical-match"]);
  assert.deepEqual(result.unresolvedRequired, [
    { kind: "file", value: "docs/contract.md" },
    { kind: "symbol", value: "Missing" }
  ]);
  assert.equal(result.estimateEligible, false);
  assert.deepEqual(
    runner.calls.filter(({ args }) => args[0] === "query").map(({ args }) => args),
    [
      ["query", "--path", root, "--limit", "5", "--json", "--", "Domain.Foo"],
      ["query", "--path", root, "--limit", "5", "--json", "--", "Missing"]
    ]
  );
});

test("ignores CodeGraph query results above the requested consumer limit", async (context) => {
  const root = await projectFixture(context);
  const overReturned = Array.from({ length: 25 }, (_, index) => ({
    node: {
      id: `other-${index}`,
      kind: "class",
      name: index === 20 ? "Target" : `Other${index}`,
      qualifiedName: index === 20 ? "Domain.Target" : `Domain.Other${index}`,
      filePath: `src/other-${index}.mjs`,
      startLine: 1,
      endLine: 2
    },
    score: 25 - index
  }));
  const runner = fixtureRunner(root, { queries: { "Domain.Target": overReturned } });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  const result = await provider.search("change target", { symbols: ["Domain.Target"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.unresolvedRequired, [{ kind: "symbol", value: "Domain.Target" }]);
});

test("marks bounded graph evidence as ineligible for token estimates", async (context) => {
  const root = await projectFixture(context);
  const node = { id: "service", kind: "class", name: "Service", filePath: "src/service.mjs", startLine: 2, endLine: 20 };
  const runner = fixtureRunner(root, {
    context: {
      entryPoints: [node],
      nodes: [node],
      edges: [{ source: "service", target: "omitted", kind: "calls" }],
      relatedFiles: ["src/service.mjs"],
      stats: { nodeCount: 1, edgeCount: 1, fileCount: 1, codeBlockCount: 0, totalCodeSize: 0 }
    }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  const search = await provider.search("change Service", {}, { topK: 4, budget: "fast" });
  const graph = await provider.neighbors(search.hits.map(({ node: sourceNode }) => sourceNode), { maxNodes: 4 });

  assert.equal(search.estimateEligible, false);
  assert.equal(graph.estimateEligible, false);
  assert.ok(search.diagnostics.some(({ code }) => code === "graph_edges_bounded"));
});

test("caps over-returned context nodes, entry points, and edges", async (context) => {
  const root = await projectFixture(context);
  const values = Array.from({ length: 60 }, (_, index) => ({
    id: `node-${index}`,
    kind: "function",
    name: `node${index}`,
    filePath: `src/${index}.mjs`,
    startLine: 1,
    endLine: 2
  }));
  const edges = Array.from({ length: 220 }, (_, index) => ({ source: `node-${index % 50}`, target: `node-${(index + 1) % 50}`, kind: "calls" }));
  const runner = fixtureRunner(root, {
    context: { entryPoints: values, nodes: values, edges, relatedFiles: [], stats: {} }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  const search = await provider.search("change", {}, { topK: 4, budget: "fast" });
  const graph = await provider.neighbors(search.hits.map(({ node }) => node), { maxNodes: 100 });

  assert.equal(search.hits.length, 4);
  assert.equal(provider.graph.nodes.size <= 50, true);
  assert.equal(provider.graph.entryPoints.length <= 4, true);
  assert.equal(provider.graph.edges.length <= 200, true);
  assert.equal(search.estimateEligible, false);
  assert.equal(graph.estimateEligible, false);
  assert.ok(search.diagnostics.some(({ code }) => code === "context_results_bounded"));
});

test("makes an exact context cap ineligible without affirmative completeness", async (context) => {
  const root = await projectFixture(context);
  const values = Array.from({ length: 50 }, (_, index) => ({
    id: `node-${index}`,
    kind: "function",
    name: `node${index}`,
    filePath: `src/${index}.mjs`,
    startLine: 1,
    endLine: 2
  }));
  const runner = fixtureRunner(root, {
    context: { entryPoints: values.slice(0, 1), nodes: values, edges: [], relatedFiles: [], stats: {} }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  const search = await provider.search("change", {}, { topK: 4, budget: "fast" });

  assert.equal(provider.graph.nodes.size, 50);
  assert.equal(search.estimateEligible, false);
  assert.ok(search.diagnostics.some(({ code }) => code === "context_results_bounded"));
});

test("caps explicit symbol matches returned from context", async (context) => {
  const root = await projectFixture(context);
  const values = Array.from({ length: 10 }, (_, index) => ({
    id: `target-${index}`,
    kind: "function",
    name: "Target",
    filePath: `src/${index}.mjs`,
    startLine: 1,
    endLine: 2
  }));
  const runner = fixtureRunner(root, {
    context: { entryPoints: values.slice(0, 1), nodes: values, edges: [], relatedFiles: [], stats: {}, truncated: false }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  const search = await provider.search("change", { symbols: ["Target"] }, { topK: 2, budget: "fast" });

  assert.equal(search.hits.filter(({ node }) => node.name === "Target").length, 4);
  assert.equal(search.estimateEligible, false);
  assert.ok(search.diagnostics.some(({ code }) => code === "symbol_matches_bounded"));
});

test("accepts an exact context cap with affirmative completeness", async (context) => {
  const root = await projectFixture(context);
  const values = Array.from({ length: 50 }, (_, index) => ({
    id: `node-${index}`,
    kind: "function",
    name: `node${index}`,
    filePath: `src/${index}.mjs`,
    startLine: 1,
    endLine: 2
  }));
  const runner = fixtureRunner(root, {
    context: { entryPoints: values.slice(0, 1), nodes: values, edges: [], relatedFiles: [], stats: {}, truncated: false }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  const search = await provider.search("change", {}, { topK: 4, budget: "fast" });

  assert.equal(search.estimateEligible, true);
  assert.equal(search.diagnostics.some(({ code }) => code === "context_results_bounded"), false);
});

test("makes over-limit graph neighbors ineligible", async (context) => {
  const root = await projectFixture(context);
  const values = Array.from({ length: 6 }, (_, index) => ({
    id: `node-${index}`,
    kind: "function",
    name: `node${index}`,
    filePath: `src/${index}.mjs`,
    startLine: 1,
    endLine: 2
  }));
  const runner = fixtureRunner(root, {
    context: {
      entryPoints: values.slice(0, 1),
      nodes: values,
      edges: values.slice(1).map((value) => ({ source: "node-0", target: value.id, kind: "calls" })),
      relatedFiles: [],
      stats: {},
      truncated: false
    }
  });
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });
  const search = await provider.search("change", {}, { topK: 4, budget: "fast" });

  const graph = await provider.neighbors(search.hits.map(({ node }) => node), { maxNodes: 2 });

  assert.equal(graph.neighbors.length, 2);
  assert.equal(graph.estimateEligible, false);
  assert.ok(graph.diagnostics.some(({ code }) => code === "graph_neighbor_limit"));
});

test("rejects unsafe paths and invalid source ranges", async (context) => {
  const root = await projectFixture(context);
  for (const node of [
    { id: "escape", kind: "function", name: "escape", qualifiedName: "escape", filePath: "../escape.mjs", startLine: 1, endLine: 2 },
    { id: "drive", kind: "function", name: "drive", qualifiedName: "drive", filePath: "C:\\escape.mjs", startLine: 1, endLine: 2 },
    { id: "drive-relative", kind: "function", name: "driveRelative", qualifiedName: "driveRelative", filePath: "C:escape.mjs", startLine: 1, endLine: 2 },
    { id: "unc", kind: "function", name: "unc", qualifiedName: "unc", filePath: "\\\\server\\share\\escape.mjs", startLine: 1, endLine: 2 },
    { id: "invalid", kind: "function", name: "invalid", qualifiedName: "invalid", filePath: "src/invalid.mjs", startLine: 10, endLine: 2 }
  ]) {
    const runner = fixtureRunner(root, { context: { entryPoints: [node], nodes: [node], edges: [], relatedFiles: [], stats: {} } });
    const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });
    await provider.describe();
    await assert.rejects(
      provider.search("unsafe", {}, { topK: 4, budget: "fast" }),
      (error) => error instanceof CodeGraphRuntimeError && error.code === "invalid-response"
    );
  }
});

test("rejects Windows drive and UNC file hints before CodeGraph context use", async (context) => {
  const root = await projectFixture(context);
  const runner = fixtureRunner(root);
  const provider = await openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run });

  for (const file of ["C:\\escape.mjs", "C:escape.mjs", "\\\\server\\share\\escape.mjs"]) {
    await assert.rejects(
      provider.search("unsafe", { files: [file] }, { topK: 4, budget: "fast" }),
      (error) => error instanceof CodeGraphRuntimeError && error.code === "invalid-input"
    );
  }
  assert.equal(runner.calls.some(({ args }) => args[0] === "context"), false);
});

test("delegates source reads and rejects a changed graph snapshot", async (context) => {
  const root = await projectFixture(context);
  const initial = healthyStatus(root);
  const changed = healthyStatus(root, { lastIndexed: "2026-09-19T10:01:00.000Z" });
  const native = sourceProvider();
  const runner = fixtureRunner(root, { statuses: [initial, initial, initial, initial, initial, changed] });
  const provider = await openCodeGraphRepositoryIntelligence(root, native, { runner: runner.run });
  await provider.describe();

  const first = await provider.read({ file: "src/service.mjs", range: { startLine: 1, endLine: 2 } });
  assert.equal(first.rangeComplete, true);
  await assert.rejects(
    provider.read({ file: "src/service.mjs", range: { startLine: 3, endLine: 4 } }),
    (error) => error instanceof CodeGraphRuntimeError && error.code === "snapshot-changed"
  );
  assert.equal(native.reads.length, 2);
});

test("verifies a graph snapshot without reading native source", async (context) => {
  const root = await projectFixture(context);
  const initial = healthyStatus(root);
  const changed = healthyStatus(root, { lastIndexed: "2026-09-19T10:01:00.000Z" });
  const native = sourceProvider();
  const provider = await openCodeGraphRepositoryIntelligence(root, native, {
    runner: fixtureRunner(root, { statuses: [initial, initial, changed] }).run
  });

  const verified = await provider.verifySnapshot();

  assert.equal(verified.provider, "codegraph");
  assert.equal(verified.version, "1.6.0");
  assert.equal(native.reads.length, 0);
  await assert.rejects(
    provider.verifySnapshot(),
    (error) => error instanceof CodeGraphRuntimeError && error.code === "snapshot-changed"
  );
  assert.equal(native.reads.length, 0);
});

test("throws a typed availability error when an explicit provider cannot open", async (context) => {
  const root = await projectFixture(context);
  const runner = fixtureRunner(root, { statuses: [healthyStatus(root, { pendingChanges: { added: 1, modified: 0, removed: 0 } })] });

  await assert.rejects(
    openCodeGraphRepositoryIntelligence(root, sourceProvider(), { runner: runner.run }),
    (error) => error instanceof CodeGraphAvailabilityError && error.code === "stale-index" && error.recoverable === true
  );
});

test("the default command runner spawns without a shell", async () => {
  let invocation;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.end("1.6.0\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const run = createCodeGraphCommandRunner({ command: "codegraph", spawnImpl });

  const result = await run(["--version"], { cwd: process.cwd() });

  assert.equal(result.stdout, "1.6.0\n");
  assert.equal(invocation.command, "codegraph");
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
});

test("the command runner ignores settled output and force-terminates an uncooperative child", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal || "SIGTERM");
    return true;
  };
  const run = createCodeGraphCommandRunner({
    command: "codegraph",
    spawnImpl: () => child,
    maxOutputBytes: 8,
    killGraceMs: 10
  });
  const result = run(["--version"], { cwd: process.cwd() });

  child.stdout.write("0123456789");
  await assert.rejects(result, (error) => error instanceof CodeGraphRuntimeError && error.code === "output-too-large");
  for (let index = 0; index < 100; index += 1) child.stdout.emit("data", "more output");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("the command runner force-terminates an uncooperative timed-out child", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal || "SIGTERM");
    return true;
  };
  const run = createCodeGraphCommandRunner({ command: "codegraph", spawnImpl: () => child, timeoutMs: 5, killGraceMs: 10 });

  await assert.rejects(run(["status"], { cwd: process.cwd() }), (error) => error instanceof CodeGraphRuntimeError && error.code === "timeout");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.stdout.listenerCount("data"), 0);
});
