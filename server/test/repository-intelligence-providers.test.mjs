import assert from "node:assert/strict";
import test from "node:test";
import {
  RepositoryIntelligenceSelectionError,
  createRepositoryIntelligenceDescriptors,
  listRepositoryIntelligenceProviders,
  withRepositoryIntelligence
} from "../repository-intelligence-providers.mjs";

test("publishes the same external executable ranges that adapters enforce", () => {
  const descriptors = createRepositoryIntelligenceDescriptors();

  assert.equal(descriptors.find(({ id }) => id === "codegraph").metadata.version, ">=1.6.0,<1.7.0");
  assert.equal(descriptors.find(({ id }) => id === "codenib").metadata.version, "0.2.3");
});

function provider(name, capabilities = {}, behavior = {}) {
  return {
    async describe() {
      if (behavior.describeError) throw behavior.describeError;
      const commit = behavior.commit || "snapshot:abc";
      const sourceFingerprint = behavior.sourceFingerprint || "abc";
      return {
        name,
        version: "1.0.0",
        commit,
        sourceFingerprint,
        snapshotIdentity: { scheme: "prism-native-sha256-v1", commit, fingerprint: sourceFingerprint },
        capabilities
      };
    },
    async search() {
      if (behavior.searchError) throw behavior.searchError;
      return { hits: [], diagnostics: [] };
    },
    async neighbors() {
      return { neighbors: [], diagnostics: [] };
    },
    async read() {
      return { rendered: "source", rangeComplete: true };
    }
  };
}

function descriptorMetadata(id, capabilities = {}) {
  return { version: `descriptor-${id}-1`, capabilities };
}

function descriptors(entries, closes = [], nativeValue = provider("native", { lexicalSearch: true, verifiedSource: true })) {
  return [
    {
      id: "native",
      kind: "built-in",
      metadata: descriptorMetadata("native", { lexicalSearch: true, verifiedSource: true }),
      async open() {
        return { provider: nativeValue, close: async () => closes.push("native") };
      }
    },
    ...entries.map(({ id, value, error, capabilities = {} }) => ({
      id,
      kind: "external",
      metadata: descriptorMetadata(id, capabilities),
      async open() {
        if (error) throw error;
        return { provider: value, close: async () => closes.push(id) };
      }
    }))
  ];
}

test("lists registered providers deterministically with sanitized diagnostics", async () => {
  const missing = Object.assign(new Error("secret stderr and /private/path"), { code: "not-installed" });
  const catalog = descriptors([
    { id: "codenib", error: missing },
    { id: "codegraph", value: provider("codegraph", { lexicalSearch: true, symbolGraph: true }) }
  ]);

  const result = await listRepositoryIntelligenceProviders("/project", { descriptors: catalog });

  assert.deepEqual(result.map(({ id }) => id), ["codegraph", "codenib", "native"]);
  assert.equal(result[0].status, "available");
  assert.equal(result[1].status, "unavailable");
  assert.equal(result[1].version, "descriptor-codenib-1");
  assert.deepEqual(result[1].capabilities, {});
  assert.equal(result[1].diagnosticCode, "not-installed");
  assert.doesNotMatch(result[1].message, /secret|private/);
  assert.equal(result[2].kind, "built-in");
});

test("uses descriptor capabilities when a registered provider is unavailable", async () => {
  const missing = Object.assign(new Error("missing"), { code: "not-installed" });
  const catalog = descriptors([
    { id: "codenib", error: missing, capabilities: { lexicalSearch: true, semanticSearch: true, hybridSearch: true, symbolGraph: true, verifiedSource: true } }
  ]);

  const result = await listRepositoryIntelligenceProviders("/project", { descriptors: catalog });
  const unavailable = result.find(({ id }) => id === "codenib");

  assert.equal(unavailable.version, "descriptor-codenib-1");
  assert.deepEqual(unavailable.capabilities, {
    lexicalSearch: true,
    semanticSearch: true,
    hybridSearch: true,
    symbolGraph: true,
    verifiedSource: true
  });
});

test("closes an opened session when its provider shape is malformed", async () => {
  const closes = [];
  const catalog = descriptors([{ id: "codenib", value: {} }], closes);

  const result = await listRepositoryIntelligenceProviders("/project", { descriptors: catalog });

  assert.equal(result.find(({ id }) => id === "codenib").diagnosticCode, "open-failed");
  assert.deepEqual(closes, ["codenib", "native"]);
});

test("closes an opened session when its supplied description is malformed", async () => {
  const closes = [];
  const catalog = descriptors([], closes);
  catalog.push({
    id: "codenib",
    kind: "external",
    metadata: descriptorMetadata("codenib"),
    async open() {
      return { provider: provider("codenib"), description: [], close: async () => closes.push("codenib") };
    }
  });

  const result = await listRepositoryIntelligenceProviders("/project", { descriptors: catalog });

  assert.equal(result.find(({ id }) => id === "codenib").diagnosticCode, "open-failed");
  assert.deepEqual(closes, ["codenib", "native"]);
});

test("automatic selection chooses the strongest healthy external provider", async () => {
  const catalog = descriptors([
    { id: "codegraph", value: provider("codegraph", { lexicalSearch: true, symbolGraph: true, verifiedSource: true }) },
    { id: "codenib", value: provider("codenib", { lexicalSearch: true, semanticSearch: true, hybridSearch: true, symbolGraph: true, verifiedSource: true }) }
  ]);

  const result = await withRepositoryIntelligence("/project", (selected) => selected.describe(), { descriptors: catalog, selection: "auto" });

  assert.deepEqual(result.selection, { requested: "auto", selected: "codenib" });
  assert.deepEqual(result.contributors.map(({ id }) => id), ["native", "codenib"]);
});

test("explicit external selection fails without substitution", async () => {
  const missing = Object.assign(new Error("missing"), { code: "not-indexed" });
  const catalog = descriptors([
    { id: "codegraph", error: missing },
    { id: "codenib", value: provider("codenib", { hybridSearch: true }) }
  ]);

  await assert.rejects(
    withRepositoryIntelligence("/project", () => "unused", { descriptors: catalog, selection: "codegraph" }),
    (error) => error instanceof RepositoryIntelligenceSelectionError && error.provider === "codegraph" && error.code === "not-indexed"
  );
});

test("automatic runtime failure retries once with native and records fallback", async () => {
  const failure = Object.assign(new Error("changed"), { code: "snapshot-changed" });
  const catalog = descriptors([
    { id: "codegraph", value: provider("codegraph", { symbolGraph: true, verifiedSource: true }, { searchError: failure }) }
  ]);
  const attempts = [];

  const result = await withRepositoryIntelligence("/project", async (selected) => {
    const description = await selected.describe();
    attempts.push(description.selection.selected);
    await selected.search("task", {}, { topK: 4, budget: "fast" });
    return description;
  }, { descriptors: catalog, selection: "auto" });

  assert.deepEqual(attempts, ["codegraph", "native"]);
  assert.equal(result.selection.selected, "native");
  assert.equal(result.fallback.provider, "codegraph");
  assert.equal(result.fallback.code, "snapshot-changed");
  assert.doesNotMatch(result.fallback.message, /changed/);
});

test("automatic selection does not retry an arbitrary consumer failure", async () => {
  const catalog = descriptors([
    { id: "codegraph", value: provider("codegraph", { lexicalSearch: true, symbolGraph: true, verifiedSource: true }) }
  ]);
  const failure = Object.assign(new Error("consumer failed"), { code: "snapshot-changed" });
  let attempts = 0;

  await assert.rejects(withRepositoryIntelligence("/project", async () => {
    attempts += 1;
    throw failure;
  }, { descriptors: catalog, selection: "auto" }), /consumer failed/);

  assert.equal(attempts, 1);
});

test("automatic selection does not retry a native provider failure", async () => {
  const nativeFailure = Object.assign(new Error("native failed"), { code: "snapshot-changed" });
  const native = provider("native", { lexicalSearch: true, verifiedSource: true }, { searchError: nativeFailure });
  const catalog = descriptors([
    { id: "codegraph", value: provider("codegraph", { lexicalSearch: true, symbolGraph: true, verifiedSource: true }) }
  ], [], native);
  let attempts = 0;

  await assert.rejects(withRepositoryIntelligence("/project", async (selected) => {
    attempts += 1;
    await selected.describe();
    return selected.search("task", {}, { topK: 4, budget: "fast" });
  }, { descriptors: catalog, selection: "auto" }), /native failed/);

  assert.equal(attempts, 1);
});

test("automatic selection records a typed snapshot mismatch fallback", async () => {
  const catalog = descriptors([
    {
      id: "codenib",
      value: provider("codenib", { semanticSearch: true, hybridSearch: true, symbolGraph: true }, { sourceFingerprint: "other" })
    }
  ]);

  const result = await withRepositoryIntelligence("/project", (selected) => selected.describe(), { descriptors: catalog, selection: "auto" });

  assert.deepEqual(result.selection, { requested: "auto", selected: "native" });
  assert.equal(result.fallback.provider, "codenib");
  assert.equal(result.fallback.code, "snapshot-mismatch");
});

test("explicit selection exposes a typed snapshot mismatch", async () => {
  const catalog = descriptors([
    { id: "codegraph", value: provider("codegraph", { symbolGraph: true }, { commit: "b".repeat(40) }) }
  ], [], provider("native", { lexicalSearch: true, verifiedSource: true }, { commit: "a".repeat(40) }));

  await assert.rejects(
    withRepositoryIntelligence("/project", (selected) => selected.describe(), { descriptors: catalog, selection: "codegraph" }),
    (error) => error instanceof Error && error.name === "ExternalRepositoryIntelligenceError" && error.code === "snapshot-mismatch" && error.provider === "codegraph"
  );
});

test("rejects duplicate and unknown provider identifiers", async () => {
  const duplicate = descriptors([]);
  duplicate.push(duplicate[0]);
  await assert.rejects(listRepositoryIntelligenceProviders("/project", { descriptors: duplicate }), /identifiers must be unique/);
  await assert.rejects(
    withRepositoryIntelligence("/project", () => "unused", { descriptors: descriptors([]), selection: "other" }),
    (error) => error instanceof RepositoryIntelligenceSelectionError && error.code === "unknown-provider"
  );
});
