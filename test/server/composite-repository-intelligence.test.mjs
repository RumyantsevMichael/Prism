import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeNibRepositoryIntelligence } from "../../dist/server/codenib-provider.mjs";
import { CompositeRepositoryIntelligence, ExternalRepositoryIntelligenceError } from "../../dist/server/composite-repository-intelligence.mjs";
import { planRepositoryContext } from "../../dist/server/repository-intelligence.mjs";

function node(id, file, startLine, endLine, name, kind = "function") {
  return { id, file, range: { startLine, endLine }, name, kind, rangeComplete: true };
}

function provider(name, {
  hits = [],
  neighbors = [],
  capabilities = {},
  unresolvedConcepts = [],
  unresolvedRequired = [],
  requiredEvidenceComplete = true,
  estimateEligible = true,
  commit = "snapshot:abc",
  sourceFingerprint = "source-abc",
  snapshotScheme = "prism-native-sha256-v2"
} = {}) {
  const reads = [];
  return {
    reads,
    async describe() {
      return {
        name,
        version: "1.0.0",
        commit,
        sourceFingerprint,
        snapshotIdentity: { scheme: snapshotScheme, commit, fingerprint: sourceFingerprint },
        capabilities
      };
    },
    async search() {
      return { hits, diagnostics: [], unresolvedConcepts, unresolvedRequired, requiredEvidenceComplete, estimateEligible, retrievalCoverage: 1 };
    },
    async neighbors() {
      return { neighbors, diagnostics: [], estimateEligible, graphCoverage: capabilities.symbolGraph ? 1 : 0 };
    },
    async read(sourceRange) {
      reads.push(sourceRange);
      return { rendered: "native source", range: sourceRange.range, rangeComplete: true };
    }
  };
}

async function projectFixture(context, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function codeNibClient(callTool) {
  return { serverInfo: { name: "codenib", version: "0.2.3" }, callTool };
}

test("fuses ranked contributors deterministically and returns source through native", async () => {
  const native = provider("native", {
    hits: [
      { node: node("native-a", "src/a.mjs", 1, 20, "src/a.mjs", "file"), reasons: ["lexical-match"] },
      { node: node("native-b", "src/b.mjs", 1, 10, "src/b.mjs", "file"), reasons: ["lexical-match"] }
    ],
    capabilities: { lexicalSearch: true, verifiedSource: true }
  });
  const external = provider("codegraph", {
    hits: [
      { node: node("graph-b", "src/b.mjs", 2, 5, "b"), reasons: ["lexical-match"] },
      { node: node("graph-c", "src/c.mjs", 4, 8, "c"), reasons: ["graph-expansion"] }
    ],
    neighbors: [{ node: node("caller", "src/main.mjs", 1, 4, "main"), from: "graph-b", relationship: "caller" }],
    capabilities: { lexicalSearch: true, symbolGraph: true }
  });
  const composite = new CompositeRepositoryIntelligence(native, external, { requestedSelection: "auto", selectedExternal: "codegraph" });

  const description = await composite.describe();
  const search = await composite.search("change b", {}, { topK: 4, budget: "balanced" });
  const graph = await composite.neighbors(search.hits.map(({ node: value }) => value), { maxNodes: 4 });
  await composite.read(search.hits[0].node);

  assert.equal(description.name, "native+codegraph");
  assert.deepEqual(description.selection, { requested: "auto", selected: "codegraph" });
  assert.deepEqual(description.contributors.map(({ id, kind }) => ({ id, kind })), [
    { id: "native", kind: "built-in" },
    { id: "codegraph", kind: "external" }
  ]);
  assert.deepEqual(search.hits.map(({ node: value }) => value.file), ["src/b.mjs", "src/a.mjs", "src/c.mjs"]);
  assert.equal(search.hits.find(({ node: value }) => value.file === "src/b.mjs").node.kind, "function");
  assert.deepEqual(graph.neighbors.map(({ relationship }) => relationship), ["caller"]);
  assert.equal(native.reads.length, 1);
  assert.equal(external.reads.length, 0);
  assert.equal(search.estimateEligible, false);
});

test("rejects a CodeNib composite with a mismatched normalized source fingerprint", async () => {
  const native = provider("native", { sourceFingerprint: "native-source" });
  const external = provider("codenib", { sourceFingerprint: "other-source" });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await assert.rejects(
    composite.describe(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codenib" && error.code === "snapshot-mismatch"
  );
});

test("normalizes a compatible CodeNib fingerprint namespace through native identity", async (context) => {
  const root = await projectFixture(context, "codenib-compatible-root");
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  let freshnessChecks = 0;
  native.verifySnapshot = async () => {
    freshnessChecks += 1;
    return { snapshotIdentity: nativeDescription.snapshotIdentity };
  };
  const calls = [];
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async (name) => {
    calls.push(name);
    assert.equal(name, "get_manifest");
    return {
      payload: {
        repo: { path: root, commit, source_fingerprint: "codenib-secure-fingerprint" },
        runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
      }
    };
  }), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  const description = await composite.describe();
  await composite.verifySnapshot();

  assert.equal(description.commit, commit);
  assert.equal(description.sourceFingerprint, "native-sha256");
  assert.equal(freshnessChecks, 2);
  assert.deepEqual(calls, ["get_manifest", "get_manifest"]);
});

test("rejects a CodeNib snapshot that changes after native identity binding", async (context) => {
  const root = await projectFixture(context, "codenib-changing-snapshot");
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  native.verifySnapshot = async () => ({ snapshotIdentity: nativeDescription.snapshotIdentity });
  let calls = 0;
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async (name) => {
    assert.equal(name, "get_manifest");
    calls += 1;
    return {
      payload: {
        repo: { path: root, commit, source_fingerprint: calls === 1 ? "codenib-first" : "codenib-second" },
        runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
      }
    };
  }), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await composite.describe();
  await assert.rejects(
    composite.verifySnapshot(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codenib" && error.code === "snapshot-changed"
  );
});

test("rejects a CodeNib manifest root that changes during final verification", async (context) => {
  const root = await projectFixture(context, "codenib-final-root");
  const other = await projectFixture(context, "codenib-final-other-root");
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  let nativeVerifications = 0;
  native.verifySnapshot = async () => {
    nativeVerifications += 1;
    return { snapshotIdentity: nativeDescription.snapshotIdentity };
  };
  let calls = 0;
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async () => {
    calls += 1;
    return {
      payload: {
        repo: { path: calls === 1 ? root : other, commit, source_fingerprint: "codenib-fingerprint" },
        runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
      }
    };
  }), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await composite.describe();
  await assert.rejects(
    composite.verifySnapshot(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.code === "snapshot-changed"
  );

  assert.equal(nativeVerifications, 1);
});

test("rejects CodeNib native identity adoption without native whole-snapshot verification", async (context) => {
  const root = await projectFixture(context, "codenib-no-native-verifier");
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-sha256" });
  native.projectRoot = root;
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async (name) => {
    assert.equal(name, "get_manifest");
    return {
      payload: {
        repo: { path: root, commit, source_fingerprint: "codenib-secure-fingerprint" },
        runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
      }
    };
  }), { projectRoot: root, sourceProvider: native, sourceDescription: await native.describe() });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await assert.rejects(
    composite.describe(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codenib" && error.code === "snapshot-mismatch"
  );
});

test("rejects CodeNib when native whole-snapshot freshness verification fails", async (context) => {
  const root = await projectFixture(context, "codenib-stale-native");
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-dirty-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  native.verifySnapshot = async () => {
    throw new Error("The native source snapshot changed.");
  };
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async (name) => {
    assert.equal(name, "get_manifest");
    return {
      payload: {
        repo: { path: root, commit, source_fingerprint: "codenib-stale-fingerprint" },
        runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
      }
    };
  }), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await assert.rejects(
    composite.describe(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codenib" && error.code === "snapshot-mismatch"
  );
});

test("rejects CodeNib without a manifest root, an exact root, or verified source binding", async (context) => {
  const root = await projectFixture(context, "codenib-root-binding");
  const other = await projectFixture(context, "codenib-other-root");
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  let freshnessChecks = 0;
  native.verifySnapshot = async () => {
    freshnessChecks += 1;
    return { snapshotIdentity: nativeDescription.snapshotIdentity };
  };
  for (const binding of [
    { manifestPath: undefined, verified: true },
    { manifestPath: other, verified: true },
    { manifestPath: root, verified: false }
  ]) {
    const external = new CodeNibRepositoryIntelligence(codeNibClient(async (name) => {
      assert.equal(name, "get_manifest");
      return {
        payload: {
          repo: { ...(binding.manifestPath ? { path: binding.manifestPath } : {}), commit, source_fingerprint: "codenib-secure-fingerprint" },
          runtime: { loaded_views: ["bm25"], source_read: { verified: binding.verified } }
        }
      };
    }), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
    const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

    await assert.rejects(
      composite.describe(),
      (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codenib" && error.code === "snapshot-mismatch"
    );
  }
  assert.equal(freshnessChecks, 0);
});

test("accepts a symlink-equivalent CodeNib manifest root", async (context) => {
  const root = await projectFixture(context, "codenib-symlink-root");
  const linkedRoot = `${root}-link`;
  await symlink(root, linkedRoot, "dir");
  context.after(() => rm(linkedRoot, { force: true }));
  const commit = "a".repeat(40);
  const native = provider("native", { commit, sourceFingerprint: "native-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  native.verifySnapshot = async () => ({ snapshotIdentity: nativeDescription.snapshotIdentity });
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async () => ({
    payload: {
      repo: { path: linkedRoot, commit, source_fingerprint: "codenib-fingerprint" },
      runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
    }
  })), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  const description = await composite.describe();

  assert.equal(description.commit, commit);
});

test("rejects a CodeNib manifest with a mismatched concrete commit", async (context) => {
  const root = await projectFixture(context, "codenib-commit-mismatch");
  const native = provider("native", { commit: "a".repeat(40), sourceFingerprint: "native-sha256" });
  const nativeDescription = await native.describe();
  native.projectRoot = root;
  native.verifySnapshot = async () => ({ snapshotIdentity: nativeDescription.snapshotIdentity });
  const external = new CodeNibRepositoryIntelligence(codeNibClient(async (name) => {
    assert.equal(name, "get_manifest");
    return {
      payload: {
        repo: { path: root, commit: "b".repeat(40), source_fingerprint: "codenib-secure-fingerprint" },
        runtime: { loaded_views: ["bm25"], source_read: { verified: true } }
      }
    };
  }), { projectRoot: root, sourceProvider: native, sourceDescription: nativeDescription });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await assert.rejects(
    composite.describe(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codenib" && error.code === "snapshot-mismatch"
  );
});

test("rejects a CodeGraph composite with a mismatched normalized commit", async () => {
  const native = provider("native", { commit: "a".repeat(40) });
  const external = provider("codegraph", { commit: "b".repeat(40) });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codegraph" });

  await assert.rejects(
    composite.describe(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.provider === "codegraph" && error.code === "snapshot-mismatch"
  );
});

test("rejects unsafe composite source paths before it calls an external provider", async () => {
  const native = provider("native");
  const external = provider("codenib");
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await assert.rejects(
    composite.read({ file: "../outside.mjs", range: { startLine: 1, endLine: 2 } }),
    /safe project-relative path/
  );
  assert.equal(external.reads.length, 0);
  assert.equal(native.reads.length, 0);
});

test("keeps an explicit native whole-file hit over an external symbol range", async () => {
  const native = provider("native", {
    hits: [{ node: node("native", "src/a.mjs", 1, 20, "src/a.mjs", "file"), reasons: ["explicit-design-reference"] }]
  });
  const external = provider("codegraph", {
    hits: [{ node: node("external", "src/a.mjs", 5, 8, "target"), reasons: ["lexical-match"] }]
  });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codegraph" });

  const search = await composite.search("target", { files: ["src/a.mjs"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(search.hits.map(({ node: value }) => value.kind), ["file", "function"]);
});

test("clears a native unresolved symbol when an external contributor resolves it", async () => {
  const native = provider("native", { unresolvedRequired: [{ kind: "symbol", value: "Domain.Target" }] });
  const resolved = node("target", "src/target.mjs", 1, 3, "Target", "class");
  resolved.qualifiedName = "Domain.Target";
  const external = provider("codegraph", { hits: [{ node: resolved, reasons: ["explicit-design-reference"] }] });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codegraph" });

  const search = await composite.search("Target", { symbols: ["Domain.Target"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(search.unresolvedRequired, []);
});

test("clears a native unresolved concept when an external contributor resolves it", async () => {
  const native = provider("native", { unresolvedConcepts: ["retry policy"] });
  const external = provider("codenib", { unresolvedConcepts: [] });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  const search = await composite.search("change retries", { concepts: ["retry policy"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(search.unresolvedConcepts, []);
});

test("keeps a concept unresolved when no contributor resolves it", async () => {
  const native = provider("native", { unresolvedConcepts: ["retry policy"] });
  const external = provider("codenib", { unresolvedConcepts: ["retry policy"] });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  const search = await composite.search("change retries", { concepts: ["retry policy"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(search.unresolvedConcepts, ["retry policy"]);
});

test("makes native required-evidence truncation composite estimate-ineligible", async () => {
  const native = provider("native", { requiredEvidenceComplete: false });
  const external = provider("codenib", {
    capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true },
    estimateEligible: true
  });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });
  await composite.describe();

  const search = await composite.search("change", {}, { topK: 4, budget: "fast" });

  assert.equal(search.estimateEligible, false);
});

test("verifies an external snapshot once after any number of selected source reads", async () => {
  const targets = Array.from({ length: 5 }, (_, index) => node(`target-${index}`, `src/target-${index}.mjs`, 1, 2, `target${index}`));
  const native = provider("native", {
    hits: targets.map((target) => ({ node: target, reasons: ["provider-ranked-match"] })),
    capabilities: { lexicalSearch: true, semanticSearch: false, symbolGraph: false, verifiedSource: true },
    estimateEligible: false
  });
  let nativeVerifications = 0;
  native.validateSourceRange = async (range) => range;
  native.verifySnapshot = async () => { nativeVerifications += 1; };
  const external = provider("codenib", {
    hits: targets.map((target) => ({ node: target, reasons: ["hybrid-match"] })),
    capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true },
    estimateEligible: true
  });
  let externalVerifications = 0;
  external.verifySnapshot = async () => { externalVerifications += 1; };
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await planRepositoryContext({ task: "Change target.", provider: composite });

  assert.equal(native.reads.length, 5);
  assert.equal(external.reads.length, 0);
  assert.equal(externalVerifications, 1);
  assert.equal(nativeVerifications, 1);
});

test("checks the external snapshot before rejecting a final native mutation", async () => {
  const target = node("target", "src/target.mjs", 1, 2, "target");
  const native = provider("native", {
    hits: [{ node: target, reasons: ["provider-ranked-match"] }],
    capabilities: { lexicalSearch: true, verifiedSource: true },
    estimateEligible: false
  });
  native.validateSourceRange = async (range) => range;
  const events = [];
  native.verifySnapshot = async () => {
    events.push("native");
    const error = new Error("The native source snapshot changed.");
    error.code = "snapshot-changed";
    throw error;
  };
  const external = provider("codenib", {
    hits: [{ node: target, reasons: ["hybrid-match"] }],
    capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true },
    estimateEligible: true
  });
  external.verifySnapshot = async () => { events.push("external"); };
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });

  await assert.rejects(
    planRepositoryContext({ task: "Change target.", provider: composite }),
    (error) => error?.code === "snapshot-changed"
  );

  assert.deepEqual(events, ["external", "native"]);
});

test("fails closed when an external provider cannot verify its final snapshot", async () => {
  const native = provider("native");
  native.verifySnapshot = async () => ({ snapshotIdentity: (await native.describe()).snapshotIdentity });
  const external = provider("codenib");
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });
  await composite.describe();

  await assert.rejects(
    composite.verifySnapshot(),
    (error) => error instanceof ExternalRepositoryIntelligenceError && error.code === "snapshot-mismatch"
  );
});

test("propagates contributor eligibility and fallback provenance", async () => {
  const native = provider("native", { estimateEligible: false });
  const composite = new CompositeRepositoryIntelligence(native, null, {
    requestedSelection: "auto",
    fallback: { provider: "codegraph", code: "snapshot-changed" }
  });

  const description = await composite.describe();
  const search = await composite.search("change", {}, { topK: 4, budget: "fast" });

  assert.deepEqual(description.fallback, { provider: "codegraph", code: "snapshot-changed" });
  assert.equal(search.estimateEligible, false);
});

test("makes a complete hybrid and graph contributor eligible over native capability gaps", async () => {
  const native = provider("native", {
    hits: [{ node: node("native", "src/a.mjs", 1, 10, "src/a.mjs", "file"), reasons: ["lexical-match"] }],
    capabilities: { lexicalSearch: true, semanticSearch: false, symbolGraph: false, verifiedSource: true },
    estimateEligible: false
  });
  const external = provider("codenib", {
    hits: [{ node: node("target", "src/a.mjs", 2, 4, "target"), reasons: ["hybrid-match"] }],
    capabilities: { lexicalSearch: true, semanticSearch: true, hybridSearch: true, symbolGraph: true },
    estimateEligible: true
  });
  const composite = new CompositeRepositoryIntelligence(native, external, { selectedExternal: "codenib" });
  await composite.describe();

  const search = await composite.search("target", {}, { topK: 4, budget: "balanced" });
  const graph = await composite.neighbors(search.hits.map(({ node: value }) => value), { maxNodes: 4 });

  assert.equal(search.estimateEligible, true);
  assert.equal(graph.estimateEligible, true);
});
