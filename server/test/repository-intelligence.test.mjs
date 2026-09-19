import assert from "node:assert/strict";
import test from "node:test";
import { CodeNibRepositoryIntelligence } from "../codenib-provider.mjs";
import { REPOSITORY_CONTEXT_INPUT_LIMITS, planRepositoryContext } from "../repository-intelligence.mjs";

function node(id, file, startLine, endLine, name, kind = "function") {
  return { id, file, range: { startLine, endLine }, name, kind };
}

function codeNibClient(client) {
  return { serverInfo: { name: "codenib", version: "0.2.3" }, ...client };
}

test("plans bounded repository context through a provider-independent boundary", async () => {
  const calls = [];
  const provider = {
    async describe() {
      return {
        name: "fixture",
        commit: "0123456789abcdef",
        sourceFingerprint: "source-0123456789abcdef",
        capabilities: { hybridSearch: true, symbolGraph: true, verifiedSource: true }
      };
    },
    async search(task, hints, options) {
      calls.push(["search", task, hints, options]);
      return {
        hits: [
          { node: node("a", "src/service.mjs", 10, 20, "handleRequest"), score: 1, reasons: ["explicit-design-reference", "lexical-match"] },
          { node: node("b", "src/service.mjs", 18, 28, "validateRequest"), score: 0.9, reasons: ["semantic-match"] },
          { node: node("c", "src/format.mjs", 5, 8, "formatResult"), score: 0.6, reasons: ["lexical-match"] }
        ],
        retrievalCoverage: 0.8,
        unresolvedConcepts: ["retry policy"],
        diagnostics: [{ code: "semantic_partial", message: "One semantic shard was unavailable." }]
      };
    },
    async neighbors(nodes, options) {
      calls.push(["neighbors", nodes.map(({ id }) => id), options]);
      return {
        neighbors: [
          { node: node("d", "src/contracts.mjs", 1, 6, "RequestContract", "interface"), from: "a", relationship: "definition", score: 0.8 },
          { node: node("e", "test/service.test.mjs", 30, 42, "handles valid input", "test"), from: "b", relationship: "tests", score: 0.7 },
          { node: node("f", "src/bootstrap.mjs", 2, 4, "start", "function"), from: "c", relationship: "imports", score: 0.2 }
        ],
        graphCoverage: 0.75,
        diagnostics: []
      };
    },
    async read(sourceRange) {
      calls.push(["read", sourceRange.file, sourceRange.range.startLine, sourceRange.range.endLine]);
      const rendered = `${sourceRange.file}:${sourceRange.range.startLine}-${sourceRange.range.endLine}`;
      return { content: rendered, rendered, rangeComplete: true };
    }
  };

  const plan = await planRepositoryContext({
    task: "Add request validation and result formatting.",
    hints: {
      files: ["src/service.mjs"],
      symbols: ["handleRequest"],
      concepts: ["retry policy"],
      expectedModifiedFiles: ["src/service.mjs"]
    },
    provider,
    tokenCounter: { name: "characters", exact: true, count: (value) => value.length },
    limits: { searchHits: 6, graphNodes: 6 }
  });

  assert.equal(plan.commit, "0123456789abcdef");
  assert.equal(plan.sourceFingerprint, "source-0123456789abcdef");
  assert.equal(plan.provider.name, "fixture");
  assert.deepEqual(plan.mustRead.map(({ file }) => file), ["src/contracts.mjs", "src/service.mjs"]);
  assert.deepEqual(plan.likelyRead.map(({ file }) => file), ["src/format.mjs", "test/service.test.mjs"]);
  assert.deepEqual(plan.possibleRead.map(({ file }) => file), ["src/bootstrap.mjs"]);
  assert.deepEqual(plan.mustRead.find(({ file }) => file === "src/service.mjs").range, { startLine: 10, endLine: 28 });
  assert.deepEqual(plan.mustRead.find(({ file }) => file === "src/service.mjs").reasons, ["explicit-design-reference", "lexical-match", "semantic-match"]);
  assert.equal(plan.tokenEstimate.lower, null);
  assert.equal(plan.tokenEstimate.expected, null);
  assert.equal(plan.tokenEstimate.upper, null);
  assert.deepEqual(plan.tokenEstimate.method, { name: "characters", exact: true });
  assert.equal(plan.diagnostics.retrievalCoverage, 0.8);
  assert.equal(plan.diagnostics.graphCoverage, 0.75);
  assert.deepEqual(plan.diagnostics.unresolvedConcepts, ["retry policy"]);
  assert.deepEqual(plan.diagnostics.provider, [{ code: "semantic_partial", message: "One semantic shard was unavailable." }]);
  assert.equal(calls.filter(([name]) => name === "search").length, 1);
  assert.equal(calls.filter(([name]) => name === "neighbors").length, 1);
  assert.equal(calls.filter(([name]) => name === "read").length, 5);
});

test("rejects oversized repository context inputs before provider work", async () => {
  let providerCalled = false;
  const provider = {
    async describe() {
      providerCalled = true;
      throw new Error("The provider must not run for invalid input.");
    },
    async search() {
      throw new Error("unreachable");
    },
    async neighbors() {
      throw new Error("unreachable");
    },
    async read() {
      throw new Error("unreachable");
    }
  };

  await assert.rejects(
    planRepositoryContext({ task: "x".repeat(REPOSITORY_CONTEXT_INPUT_LIMITS.taskCharacters + 1), provider }),
    /task must contain at most/
  );
  await assert.rejects(
    planRepositoryContext({
      task: "Change behavior.",
      hints: { files: Array.from({ length: REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind + 1 }, (_, index) => `src/${index}.mjs`) },
      provider
    }),
    /files must contain at most/
  );
  await assert.rejects(
    planRepositoryContext({
      task: "Change behavior.",
      hints: { symbols: ["x".repeat(REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters + 1)] },
      provider
    }),
    /symbols entries must contain at most/
  );
  assert.equal(providerCalled, false);
});

test("rejects an incomplete provider instead of inventing repository evidence", async () => {
  await assert.rejects(
    planRepositoryContext({ task: "Change behavior.", provider: { search() {} } }),
    /describe, search, neighbors, and read/
  );
});

test("rejects a provider description without a concrete commit", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", capabilities: {} };
    },
    async search() {
      throw new Error("Search must not run without repository provenance.");
    },
    async neighbors() {
      return { neighbors: [] };
    },
    async read() {
      return { rendered: "source", rangeComplete: true };
    }
  };

  await assert.rejects(planRepositoryContext({ task: "Change behavior.", provider }), /concrete repository commit/);
});

test("normalizes CodeNib data without leaking provider-specific fields", async () => {
  const calls = [];
  const responses = {
    get_manifest: {
      repo: { commit: "abcdef", source_fingerprint: "source-abcdef" },
      runtime: { loaded_views: ["bm25", "vector", "symbol_graph"], source_read: { verified: true } }
    },
    search_context: {
      plan: { stages: [{ engine: "sparse" }, { engine: "dense" }], graph: { hops: 1 } },
      source: { commit: "abcdef", source_fingerprint: "source-abcdef" },
      results: [{ node_id: "node-1", node_name: "handleRequest", type: "function", file: "src/service.mjs", start_line: 10, end_line: 20, score: 0.9, content: "request handler" }]
    },
    dependency_subgraph: {
      root: "handleRequest",
      nodes: [{ name: "validateRequest", file: "src/validate.mjs", line: 4, kind: "function", depth: 1 }],
      edges: [{ source: "handleRequest", target: "validateRequest", type: "reference" }]
    },
    search_regex: [{ node_id: "validate", node_name: "validateRequest", type: "function", file: "src/validate.mjs", start_line: 4, end_line: 9 }],
    read_source: { file: "src/service.mjs", start_line: 10, end_line: 20, content: "source", source: { commit: "abcdef", source_fingerprint: "source-abcdef", verified: true } }
  };
  const client = {
    async callTool(name, args) {
      calls.push([name, args]);
      return { payload: responses[name], rendered: JSON.stringify(responses[name]) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(codeNibClient(client));

  const description = await provider.describe();
  const search = await provider.search("request handling", { symbols: ["handleRequest"], concepts: ["missing concept"] }, { topK: 4, budget: "balanced" });
  const graph = await provider.neighbors(search.hits.map(({ node }) => node), { maxNodes: 4 });
  const source = await provider.read(search.hits[0].node);

  assert.deepEqual(description.capabilities, { lexicalSearch: true, semanticSearch: true, hybridSearch: true, symbolGraph: true, verifiedSource: true });
  assert.deepEqual(search.hits[0].reasons, ["explicit-design-reference", "provider-ranked-match", "hybrid-match", "graph-expansion"]);
  assert.deepEqual(search.unresolvedConcepts, ["missing concept"]);
  assert.equal(graph.neighbors[0].relationship, "reference");
  assert.equal(graph.neighbors[0].node.file, "src/validate.mjs");
  assert.deepEqual(graph.neighbors[0].node.range, { startLine: 4, endLine: 9 });
  assert.equal(source.content, "source");
  assert.deepEqual(calls.map(([name]) => name), ["get_manifest", "search_context", "dependency_subgraph", "search_regex", "read_source"]);
});

test("resolves explicit CodeNib hints and modification targets when ranked search misses them", async () => {
  const client = {
    async callTool(name) {
      const payloads = {
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [] },
        lsp_definition: [{ node_id: "symbol", node_name: "explicitSymbol", type: "function", file: "src/symbol.mjs", start_line: 3, end_line: 7 }],
        search_regex: [{ node_id: "file-symbol", node_name: "insideFile", type: "function", file: "src/explicit.mjs", start_line: 10, end_line: 12 }]
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(codeNibClient(client));

  const result = await provider.search("unrelated terms", { symbols: ["explicitSymbol"], expectedModifiedFiles: ["src/explicit.mjs"] }, { topK: 4, budget: "balanced" });

  assert.deepEqual(result.hits.map(({ node }) => node.id), ["symbol", "file-symbol"]);
  assert.ok(result.hits[0].reasons.includes("explicit-design-reference"));
  assert.ok(result.hits[1].reasons.includes("expected-modification-target"));
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ["semantic_unavailable"]);
});

test("marks a sparse-only CodeNib plan ineligible when the vector view is loaded", async () => {
  const client = {
    async callTool(name) {
      const payloads = {
        get_manifest: {
          repo: { commit: "abc", source_fingerprint: "source-abc" },
          runtime: { loaded_views: ["bm25", "vector", "symbol_graph"], source_read: { verified: true } }
        },
        search_context: {
          plan: { stages: [{ engine: "sparse" }], graph: { hops: 1 } },
          source: { commit: "abc", source_fingerprint: "source-abc" },
          results: [{ node_id: "entry", node_name: "entry", type: "function", file: "src/entry.mjs", start_line: 1, end_line: 3 }]
        }
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(codeNibClient(client));

  const description = await provider.describe();
  const search = await provider.search("Change entry.", {}, { topK: 4, budget: "balanced" });

  assert.equal(description.capabilities.semanticSearch, true);
  assert.equal(search.estimateEligible, false);
  assert.ok(search.diagnostics.some(({ code }) => code === "semantic_unavailable"));
});

test("uses current CodeNib provenance and rejects a search mismatch", async () => {
  const client = {
    async callTool(name) {
      const payloads = {
        get_manifest: { repo: { commit: "manifest-commit", source_fingerprint: "manifest-source" }, runtime: { loaded_views: ["bm25"], source_read: { verified: true } } },
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "search-commit", source_fingerprint: "search-source" }, results: [] }
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(codeNibClient(client));

  const description = await provider.describe();

  assert.equal(description.commit, "manifest-commit");
  await assert.rejects(provider.search("query", {}, { topK: 4, budget: "fast" }), /search provenance/);
});

test("rejects missing CodeNib search provenance after loading a manifest", async () => {
  const client = {
    async callTool(name) {
      const payloads = {
        get_manifest: { repo: { commit: "abc", source_fingerprint: "source-abc" }, runtime: { loaded_views: ["bm25"], source_read: { verified: true } } },
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [] }
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(codeNibClient(client));

  await provider.describe();

  await assert.rejects(provider.search("query", {}, { topK: 4, budget: "fast" }), /search provenance/);
});

test("rejects a CodeNib manifest without a source fingerprint", async () => {
  const provider = new CodeNibRepositoryIntelligence(codeNibClient({
    async callTool() {
      const payload = { repo: { commit: "abc" }, runtime: { loaded_views: [], source_read: { verified: true } } };
      return { payload, rendered: JSON.stringify(payload) };
    }
  }));

  await assert.rejects(provider.describe(), /source fingerprint/);
});

test("rejects CodeNib retrieval errors instead of returning a zero-context plan", async () => {
  const provider = new CodeNibRepositoryIntelligence(codeNibClient({
    async callTool() {
      return { payload: { error: "bm25 index not available" }, rendered: "error" };
    }
  }));

  await assert.rejects(provider.search("query", {}, { topK: 4, budget: "fast" }), /CodeNib search failed/);
});

test("makes incomplete source ranges prevent numeric fit estimates", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: {} };
    },
    async search() {
      return { hits: [{ node: { ...node("compact", "src/compact.mjs", 10, 10, "compact"), rangeComplete: false }, score: 1, reasons: ["explicit-design-reference"] }] };
    },
    async neighbors() {
      return { neighbors: [] };
    },
    async read() {
      return { content: "one line", rendered: "one line" };
    }
  };

  const plan = await planRepositoryContext({ task: "Change compact.", provider });

  assert.equal(plan.mustRead[0].rangeComplete, false);
  assert.equal(plan.tokenEstimate.lower, null);
  assert.equal(plan.tokenEstimate.expected, null);
  assert.equal(plan.tokenEstimate.upper, null);
  assert.deepEqual(plan.diagnostics.incompleteRanges.map(({ file }) => file), ["src/compact.mjs"]);
});

test("makes malformed provider node ranges prevent numeric fit estimates", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: {} };
    },
    async search() {
      return { hits: [{ node: { id: "invalid", file: "src/invalid.mjs", range: { startLine: 10, endLine: 5 }, name: "invalid", kind: "function" }, score: 1, reasons: ["provider-ranked-match"] }] };
    },
    async neighbors() {
      return { neighbors: [] };
    },
    async read(sourceRange) {
      return { content: "source", rendered: "source", range: sourceRange.range };
    }
  };

  const plan = await planRepositoryContext({ task: "Change invalid.", provider });

  assert.deepEqual(plan.mustRead[0].range, { startLine: 10, endLine: 10 });
  assert.equal(plan.mustRead[0].rangeComplete, false);
  assert.equal(plan.tokenEstimate.lower, null);
});

test("makes a short provider read incomplete even when its flag is omitted", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: {} };
    },
    async search() {
      return { hits: [{ node: node("large", "src/large.mjs", 1, 100, "large"), score: 1, reasons: ["provider-ranked-match"] }] };
    },
    async neighbors() {
      return { neighbors: [] };
    },
    async read() {
      return { content: "short", rendered: "short", range: { startLine: 1, endLine: 10 } };
    }
  };

  const plan = await planRepositoryContext({ task: "Change large.", provider });

  assert.deepEqual(plan.mustRead[0].range, { startLine: 1, endLine: 10 });
  assert.equal(plan.mustRead[0].rangeComplete, false);
  assert.equal(plan.tokenEstimate.lower, null);
});

test("re-reads response-expanded overlaps and counts the merged representation once", async () => {
  const reads = [];
  const counted = [];
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", sourceFingerprint: "source-abc", capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true } };
    },
    async search() {
      return {
        hits: [
          { node: node("left", "src/overlap.mjs", 1, 10, "left"), score: 1, reasons: ["explicit-design-reference"] },
          { node: node("right", "src/overlap.mjs", 13, 20, "right"), score: 0.9, reasons: ["semantic-match"] }
        ],
        estimateEligible: true
      };
    },
    async neighbors() {
      return { neighbors: [], estimateEligible: true };
    },
    async read(sourceRange) {
      reads.push(sourceRange.range);
      if (sourceRange.range.startLine === 1 && sourceRange.range.endLine === 10) {
        return { rendered: "left-expanded", range: { startLine: 1, endLine: 12 }, rangeComplete: true };
      }
      if (sourceRange.range.startLine === 13 && sourceRange.range.endLine === 20) {
        return { rendered: "right-expanded", range: { startLine: 10, endLine: 20 }, rangeComplete: true };
      }
      assert.deepEqual(sourceRange.range, { startLine: 1, endLine: 20 });
      return { rendered: "x".repeat(20), range: sourceRange.range, rangeComplete: true };
    }
  };

  const plan = await planRepositoryContext({
    task: "Change overlapping source.",
    provider,
    tokenCounter: {
      name: "characters",
      exact: true,
      count(value) {
        counted.push(value);
        return value.length;
      }
    }
  });

  assert.deepEqual(reads, [
    { startLine: 1, endLine: 10 },
    { startLine: 13, endLine: 20 },
    { startLine: 1, endLine: 20 }
  ]);
  assert.equal(plan.mustRead.length, 1);
  assert.deepEqual(plan.mustRead[0].range, { startLine: 1, endLine: 20 });
  assert.deepEqual(plan.mustRead[0].reasons, ["explicit-design-reference", "semantic-match"]);
  assert.deepEqual(plan.mustRead[0].symbols.map(({ name }) => name), ["left", "right"]);
  assert.deepEqual(counted, ["x".repeat(20)]);
  assert.equal(plan.mustRead[0].sourceTokens, 20);
  assert.equal(plan.tokenEstimate.lower, 20);
});

test("requires an affirmative completeness signal when a provider read omits its range", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: {} };
    },
    async search() {
      return { hits: [{ node: node("large", "src/large.mjs", 1, 100, "large"), score: 1, reasons: ["provider-ranked-match"] }] };
    },
    async neighbors() {
      return { neighbors: [] };
    },
    async read() {
      return { content: "only ten lines", rendered: "only ten lines" };
    }
  };

  const plan = await planRepositoryContext({ task: "Change large.", provider });

  assert.equal(plan.mustRead[0].rangeComplete, false);
  assert.equal(plan.tokenEstimate.lower, null);
});

test("makes unresolved required hints prevent numeric fit estimates", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: {} };
    },
    async search() {
      return { hits: [], unresolvedRequired: [{ kind: "symbol", value: "missingSymbol" }] };
    },
    async neighbors() {
      return { neighbors: [] };
    },
    async read() {
      throw new Error("No source should be read.");
    }
  };

  const plan = await planRepositoryContext({ task: "Change missingSymbol.", provider });

  assert.equal(plan.tokenEstimate.lower, null);
  assert.equal(plan.tokenEstimate.expected, null);
  assert.equal(plan.tokenEstimate.upper, null);
  assert.deepEqual(plan.diagnostics.unresolvedRequired, [{ kind: "symbol", value: "missingSymbol" }]);
  assert.equal(plan.diagnostics.noAnchors, true);
});

test("makes unresolved concepts prevent numeric fit estimates", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true } };
    },
    async search() {
      return { hits: [{ node: node("a", "src/a.mjs", 1, 2, "a"), reasons: ["semantic-match"] }], unresolvedConcepts: ["critical policy"], estimateEligible: true };
    },
    async neighbors() {
      return { neighbors: [], estimateEligible: true };
    },
    async read(sourceRange) {
      return { rendered: "source", range: sourceRange.range, rangeComplete: true };
    }
  };

  const plan = await planRepositoryContext({ task: "Change policy.", hints: { concepts: ["critical policy"] }, provider });

  assert.equal(plan.diagnostics.estimateEligible, false);
  assert.equal(plan.tokenEstimate.lower, null);
  assert.equal(plan.tokenEstimate.expected, null);
  assert.equal(plan.tokenEstimate.upper, null);
});

test("requires affirmative provider eligibility and all fit capabilities", async () => {
  const cases = [
    { capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true }, search: {}, graph: { estimateEligible: true } },
    { capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true, verifiedSource: true }, search: { estimateEligible: true }, graph: {} },
    { capabilities: { lexicalSearch: true, semanticSearch: true, symbolGraph: true }, search: { estimateEligible: true }, graph: { estimateEligible: true } }
  ];
  for (const fixture of cases) {
    const provider = {
      async describe() {
        return { name: "fixture", commit: "abc", capabilities: fixture.capabilities };
      },
      async search() {
        return { hits: [{ node: node("a", "src/a.mjs", 1, 2, "a"), reasons: ["provider-ranked-match"] }], ...fixture.search };
      },
      async neighbors() {
        return { neighbors: [], ...fixture.graph };
      },
      async read(sourceRange) {
        return { rendered: "source", range: sourceRange.range, rangeComplete: true };
      }
    };

    const plan = await planRepositoryContext({ task: "Change a.", provider });
    assert.equal(plan.diagnostics.estimateEligible, false);
    assert.equal(plan.tokenEstimate.expected, null);
  }
});

test("preserves composite provenance and blocks estimates when a provider marks evidence ineligible", async () => {
  const provider = {
    async describe() {
      return {
        name: "native+codegraph",
        commit: "abc",
        capabilities: { lexicalSearch: true, symbolGraph: true },
        selection: { requested: "auto", selected: "codegraph" },
        contributors: [{ id: "native", kind: "built-in" }, { id: "codegraph", kind: "external" }],
        fallback: null
      };
    },
    async search() {
      return {
        hits: [{ node: node("a", "src/a.mjs", 1, 2, "a"), reasons: ["lexical-match"] }],
        estimateEligible: false,
        diagnostics: [{ code: "semantic_unavailable", message: "Semantic retrieval is unavailable." }]
      };
    },
    async neighbors() {
      return { neighbors: [], estimateEligible: true };
    },
    async read() {
      return { rendered: "source", rangeComplete: true };
    }
  };

  const plan = await planRepositoryContext({ task: "Change a.", provider });

  assert.deepEqual(plan.provider.selection, { requested: "auto", selected: "codegraph" });
  assert.deepEqual(plan.provider.contributors.map(({ id }) => id), ["native", "codegraph"]);
  assert.equal(plan.provider.fallback, null);
  assert.equal(plan.diagnostics.estimateEligible, false);
  assert.deepEqual(plan.tokenEstimate, {
    lower: null,
    expected: null,
    upper: null,
    method: { name: "utf8-bytes-divided-by-3", exact: false }
  });
});

test("marks ranked CodeNib locations without an end line as incomplete", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool() {
      const payload = {
        plan: { stages: [{ engine: "sparse" }] },
        source: { commit: "abc" },
        results: [{ node_id: "compact", node_name: "compact", type: "function", file: "src/compact.mjs", start_line: 10 }]
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.search("compact", {}, { topK: 4, budget: "fast" });

  assert.equal(result.hits[0].node.rangeComplete, false);
});

test("reports an unresolved explicit CodeNib symbol as required uncertainty", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      const payloads = {
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [] },
        lsp_definition: []
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  });

  const result = await provider.search("missing", { symbols: ["missingSymbol"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(result.unresolvedRequired, [{ kind: "symbol", value: "missingSymbol" }]);
});

test("does not satisfy an explicit CodeNib symbol with a longer substring match", async () => {
  const calls = [];
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      calls.push(name);
      const payloads = {
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [{ node_id: "factory", node_name: "FooFactory", type: "class", file: "src/foo.mjs", start_line: 1, end_line: 8 }] },
        lsp_definition: [{ node_id: "foo", node_name: "Foo", type: "class", file: "src/foo.mjs", start_line: 10, end_line: 18 }]
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  });

  const result = await provider.search("Foo", { symbols: ["Foo"] }, { topK: 4, budget: "fast" });

  assert.ok(calls.includes("lsp_definition"));
  assert.equal(result.hits.find(({ node }) => node.id === "factory").reasons.includes("explicit-design-reference"), false);
  assert.equal(result.hits.find(({ node }) => node.id === "foo").reasons.includes("explicit-design-reference"), true);
});

test("does not satisfy a qualified CodeNib symbol with a different qualified name", async () => {
  const calls = [];
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      calls.push(name);
      const payloads = {
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [{ node_id: "other", node_name: "Other.Foo", type: "class", file: "src/other.mjs", start_line: 1, end_line: 8 }] },
        lsp_definition: [{ node_id: "domain", node_name: "Domain.Foo", type: "class", file: "src/domain.mjs", start_line: 10, end_line: 18 }]
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  });

  const result = await provider.search("Domain.Foo", { symbols: ["Domain.Foo"] }, { topK: 4, budget: "fast" });

  assert.ok(calls.includes("lsp_definition"));
  assert.equal(result.hits.find(({ node }) => node.id === "other").reasons.includes("explicit-design-reference"), false);
  assert.equal(result.hits.find(({ node }) => node.id === "domain").reasons.includes("explicit-design-reference"), true);
});

test("treats a qualified CodeNib identity as authoritative over its short display name", async () => {
  const calls = [];
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      calls.push(name);
      const payloads = {
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [{ node_id: "other", node_name: "Foo", qualified_name: "Other.Foo", type: "class", file: "src/other.mjs", start_line: 1, end_line: 8 }] },
        lsp_definition: [{ node_id: "domain", node_name: "Foo", qualified_name: "Domain.Foo", type: "class", file: "src/domain.mjs", start_line: 10, end_line: 18 }]
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  });

  const result = await provider.search("Domain.Foo", { symbols: ["Domain.Foo"] }, { topK: 4, budget: "fast" });

  assert.ok(calls.includes("lsp_definition"));
  assert.equal(result.hits.find(({ node }) => node.id === "other").reasons.includes("explicit-design-reference"), false);
  assert.equal(result.hits.find(({ node }) => node.id === "domain").reasons.includes("explicit-design-reference"), true);
});

test("rejects an LSP definition with a different qualified identity", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      const payloads = {
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc" }, results: [] },
        lsp_definition: [{ node_id: "other", node_name: "Other.Foo", type: "class", file: "src/other.mjs", start_line: 1, end_line: 8 }]
      };
      return { payload: payloads[name], rendered: JSON.stringify(payloads[name]) };
    }
  });

  const result = await provider.search("Domain.Foo", { symbols: ["Domain.Foo"] }, { topK: 4, budget: "fast" });

  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.unresolvedRequired, [{ kind: "symbol", value: "Domain.Foo" }]);
});

test("completes a compact symbol from the matching same-name location", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      assert.equal(name, "search_regex");
      const payload = [
        { node_id: "first", node_name: "run", type: "method", file: "src/service.mjs", start_line: 5, end_line: 12 },
        { node_id: "second", node_name: "run", type: "method", file: "src/service.mjs", start_line: 48, end_line: 60 }
      ];
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.completeNodeRange({ id: "compact", file: "src/service.mjs", range: { startLine: 52, endLine: 52 }, kind: "method", name: "run", rangeComplete: false });

  assert.equal(result.id, "second");
  assert.deepEqual(result.range, { startLine: 48, endLine: 60 });
});

test("leaves a compact symbol incomplete when no same-name range contains its line", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      assert.equal(name, "search_regex");
      const payload = [
        { node_id: "first", node_name: "run", type: "method", file: "src/service.mjs", start_line: 5, end_line: 12 },
        { node_id: "second", node_name: "run", type: "method", file: "src/service.mjs", start_line: 48, end_line: 60 }
      ];
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.completeNodeRange({ id: "compact", file: "src/service.mjs", range: { startLine: 30, endLine: 30 }, kind: "method", name: "run", rangeComplete: false });

  assert.equal(result.id, "compact");
  assert.deepEqual(result.range, { startLine: 30, endLine: 30 });
  assert.equal(result.rangeComplete, false);
});

test("does not complete a qualified compact symbol from a different qualified identity", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      assert.equal(name, "search_regex");
      const payload = [
        { node_id: "other", node_name: "Foo", qualified_name: "Other.Foo", type: "class", file: "src/foo.mjs", start_line: 9, end_line: 18 }
      ];
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.completeNodeRange({ id: "domain", file: "src/foo.mjs", range: { startLine: 10, endLine: 10 }, kind: "class", name: "Foo", qualifiedName: "Domain.Foo", rangeComplete: false });

  assert.equal(result.id, "domain");
  assert.deepEqual(result.range, { startLine: 10, endLine: 10 });
  assert.equal(result.rangeComplete, false);
});

test("preserves compact symbol identity and signature when completing its range", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      assert.equal(name, "search_regex");
      const payload = [
        { node_id: "range", node_name: "Foo", type: "class", file: "src/foo.mjs", start_line: 9, end_line: 18 }
      ];
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.completeNodeRange({ id: "domain", file: "src/foo.mjs", range: { startLine: 10, endLine: 10 }, kind: "class", name: "Foo", qualifiedName: "Domain.Foo", signature: "class Domain.Foo", rangeComplete: false });

  assert.deepEqual(result.range, { startLine: 9, endLine: 18 });
  assert.equal(result.rangeComplete, true);
  assert.equal(result.qualifiedName, "Domain.Foo");
  assert.equal(result.signature, "class Domain.Foo");
});

test("marks an inverted CodeNib result range as incomplete", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool() {
      const payload = {
        plan: { stages: [{ engine: "sparse" }] },
        source: { commit: "abc" },
        results: [{ node_id: "invalid", node_name: "invalid", type: "function", file: "src/invalid.mjs", start_line: 10, end_line: 5 }]
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.search("invalid", {}, { topK: 4, budget: "fast" });

  assert.deepEqual(result.hits[0].node.range, { startLine: 10, endLine: 10 });
  assert.equal(result.hits[0].node.rangeComplete, false);
});

test("marks a CodeNib result without a start line as incomplete", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool() {
      const payload = {
        plan: { stages: [{ engine: "sparse" }] },
        source: { commit: "abc" },
        results: [{ node_id: "invalid", node_name: "invalid", type: "function", file: "src/invalid.mjs", end_line: 5 }]
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  });

  const result = await provider.search("invalid", {}, { topK: 4, budget: "fast" });

  assert.deepEqual(result.hits[0].node.range, { startLine: 1, endLine: 5 });
  assert.equal(result.hits[0].node.rangeComplete, false);
});

test("reads CodeNib source ranges in bounded windows", async () => {
  const calls = [];
  const client = {
    async callTool(name, args) {
      assert.equal(name, "read_source");
      calls.push(args);
      const payload = {
        file: "src/large.mjs",
        start_line: args.start_line,
        end_line: args.end_line,
        content: `${args.start_line}-${args.end_line}\n`,
        content_projection: { truncated: false },
        source: { verified: true }
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(client);

  const result = await provider.read({ file: "src/large.mjs", range: { startLine: 1, endLine: 450 } });

  assert.deepEqual(calls.map(({ start_line, end_line }) => [start_line, end_line]), [[1, 200], [201, 400], [401, 450]]);
  assert.deepEqual(result.range, { startLine: 1, endLine: 450 });
  assert.match(result.content, /401-450/);
});

test("marks a short CodeNib source read as incomplete", async () => {
  const client = {
    async callTool(name, args) {
      assert.equal(name, "read_source");
      const payload = {
        file: "src/short.mjs",
        start_line: args.start_line,
        end_line: 20,
        content: "short\n",
        content_projection: { truncated: false },
        source: { verified: true }
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(client);

  const result = await provider.read({ file: "src/short.mjs", range: { startLine: 1, endLine: 100 } });

  assert.deepEqual(result.range, { startLine: 1, endLine: 20 });
  assert.equal(result.rangeComplete, false);
});

test("marks a discontinuous CodeNib source read as incomplete", async () => {
  const calls = [];
  const client = {
    async callTool(name, args) {
      assert.equal(name, "read_source");
      calls.push(args);
      const payload = {
        file: "src/gapped.mjs",
        start_line: 1,
        end_line: 20,
        content: "first window\n",
        content_projection: { truncated: true, next_start_line: 50 },
        source: { verified: true }
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  };
  const provider = new CodeNibRepositoryIntelligence(client);

  const result = await provider.read({ file: "src/gapped.mjs", range: { startLine: 1, endLine: 100 } });

  assert.equal(calls.length, 1);
  assert.deepEqual(result.range, { startLine: 1, endLine: 20 });
  assert.equal(result.rangeComplete, false);
});

test("rejects CodeNib source responses that cannot prove source identity", async () => {
  const read = async (readPayload) => {
    const provider = new CodeNibRepositoryIntelligence(codeNibClient({
      async callTool(name) {
        const payload = name === "get_manifest"
          ? { repo: { commit: "abc", source_fingerprint: "fingerprint" }, runtime: { loaded_views: [], source_read: { verified: true } } }
          : readPayload;
        return { payload, rendered: JSON.stringify(payload) };
      }
    }));
    await provider.describe();
    return provider.read({ file: "src/source.mjs", range: { startLine: 1, endLine: 10 } });
  };

  await assert.rejects(read({
    file: "src/source.mjs",
    start_line: 1,
    end_line: 10,
    content_projection: { truncated: false },
    source: { commit: "abc", source_fingerprint: "fingerprint", verified: true }
  }), /source content/);
  await assert.rejects(read({
    file: "src/other.mjs",
    start_line: 1,
    end_line: 10,
    content: "source\n",
    content_projection: { truncated: false },
    source: { commit: "abc", source_fingerprint: "fingerprint", verified: true }
  }), /source identity/);
  await assert.rejects(read({
    file: "src/source.mjs",
    start_line: 1,
    end_line: 10,
    content: "source\n",
    content_projection: { truncated: false },
    source: { commit: "other", source_fingerprint: "other", verified: true }
  }), /source provenance/);
  await assert.rejects(read({
    file: "src/source.mjs",
    file_path: "src/other.mjs",
    start_line: 1,
    end_line: 10,
    content: "source\n",
    content_projection: { truncated: false },
    source: { commit: "abc", source_fingerprint: "fingerprint", verified: true }
  }), /source identity/);
  await assert.rejects(read({
    file: "src/source.mjs",
    start_line: 1,
    end_line: 10,
    content: "",
    content_projection: { truncated: false },
    source: { commit: "abc", source_fingerprint: "fingerprint", verified: true }
  }), /source content/);
});

test("rejects a CodeNib source response that starts after the requested line", async () => {
  const provider = new CodeNibRepositoryIntelligence(codeNibClient({
    async callTool(name) {
      assert.equal(name, "read_source");
      const payload = {
        file: "src/gapped.mjs",
        start_line: 50,
        end_line: 100,
        content: "late source\n",
        content_projection: { truncated: false },
        source: { verified: true }
      };
      return { payload, rendered: JSON.stringify(payload) };
    }
  }));

  await assert.rejects(
    provider.read({ file: "src/gapped.mjs", range: { startLine: 1, endLine: 100 } }),
    /discontinuous source range/
  );
});

test("uses a qualified anchor identity for CodeNib graph expansion", async () => {
  let graphSymbol;
  const provider = new CodeNibRepositoryIntelligence(codeNibClient({
    async callTool(name, args) {
      const payloads = {
        get_manifest: { repo: { commit: "abc", source_fingerprint: "source-abc" }, runtime: { loaded_views: ["bm25", "symbol_graph"], source_read: { verified: true } } },
        search_context: { plan: { stages: [{ engine: "sparse" }] }, source: { commit: "abc", source_fingerprint: "source-abc" }, results: [{ node_id: "domain", node_name: "Foo", qualified_name: "Domain.Foo", type: "class", file: "src/domain.mjs", start_line: 1, end_line: 8 }] },
        dependency_subgraph: { root: "Domain.Foo", nodes: [], edges: [] },
        read_source: { file: "src/domain.mjs", start_line: 1, end_line: 8, content: "class Foo {}\n", content_projection: { truncated: false }, source: { commit: "abc", source_fingerprint: "source-abc", verified: true } }
      };
      if (name === "dependency_subgraph") graphSymbol = args.symbol;
      const payload = payloads[name];
      return { payload, rendered: JSON.stringify(payload) };
    }
  }));

  await planRepositoryContext({ task: "Change Domain.Foo.", hints: { symbols: ["Domain.Foo"] }, provider });

  assert.equal(graphSymbol, "Domain.Foo");
});

test("makes a seed-bounded CodeNib graph plan ineligible for numeric estimates", async () => {
  const provider = new CodeNibRepositoryIntelligence(codeNibClient({
    async callTool(name, args) {
      if (name === "get_manifest") {
        const payload = {
          repo: { commit: "abc", source_fingerprint: "source-abc" },
          runtime: { loaded_views: ["bm25", "vector", "symbol_graph"], source_read: { verified: true } }
        };
        return { payload, rendered: JSON.stringify(payload) };
      }
      if (name === "search_context") {
        const payload = {
          plan: { stages: [{ engine: "sparse" }, { engine: "dense" }], graph: { hops: 1 } },
          source: { commit: "abc", source_fingerprint: "source-abc" },
          results: Array.from({ length: 4 }, (_, index) => ({
            node_id: `anchor-${index}`,
            node_name: `anchor${index}`,
            type: "function",
            file: `src/anchor-${index}.mjs`,
            start_line: 1,
            end_line: 2
          }))
        };
        return { payload, rendered: JSON.stringify(payload) };
      }
      if (name === "dependency_subgraph") {
        const payload = { root: args.symbol, nodes: [], edges: [] };
        return { payload, rendered: JSON.stringify(payload) };
      }
      if (name === "read_source") {
        const payload = {
          file: args.file_path,
          start_line: args.start_line,
          end_line: args.end_line,
          content: "source\n",
          source: { commit: "abc", source_fingerprint: "source-abc", verified: true }
        };
        return { payload, rendered: JSON.stringify(payload) };
      }
      throw new Error(`Unexpected tool: ${name}`);
    }
  }));

  const plan = await planRepositoryContext({ task: "Change bounded anchors.", provider, limits: { searchHits: 4, graphNodes: 4 } });

  assert.equal(plan.diagnostics.estimateEligible, false);
  assert.equal(plan.tokenEstimate.lower, null);
  assert.equal(plan.tokenEstimate.expected, null);
  assert.equal(plan.tokenEstimate.upper, null);
  assert.ok(plan.diagnostics.provider.some(({ code }) => code === "graph_seed_limit"));
});

test("marks CodeNib graph notes and incomplete compact ranges ineligible", async () => {
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name) {
      if (name === "dependency_subgraph") {
        return {
          payload: {
            root: "anchor",
            note: "The graph response is partial.",
            truncated: true,
            nodes: [{ name: "neighbor", file: "src/neighbor.mjs", line: 3, kind: "function", depth: 1 }]
          }
        };
      }
      assert.equal(name, "search_regex");
      return { payload: [] };
    }
  });

  const result = await provider.neighbors(
    [{ id: "anchor", file: "src/anchor.mjs", range: { startLine: 1, endLine: 2 }, kind: "function", name: "anchor", rangeComplete: true }],
    { maxNodes: 4 }
  );

  assert.equal(result.estimateEligible, false);
  assert.equal(result.neighbors[0].node.rangeComplete, false);
  assert.ok(result.diagnostics.some(({ code }) => code === "graph_note"));
  assert.ok(result.diagnostics.some(({ code }) => code === "graph_truncated"));
  assert.ok(result.diagnostics.some(({ code }) => code === "graph_range_incomplete"));
});

test("caps CodeNib over-return across search and hint-resolution paths", async () => {
  const calls = [];
  const provider = new CodeNibRepositoryIntelligence({
    async callTool(name, args) {
      calls.push([name, args]);
      if (name === "search_context") {
        const payload = {
          plan: { stages: [{ engine: "sparse" }] },
          source: { commit: "abc" },
          results: Array.from({ length: 12 }, (_, index) => ({
            node_id: `ranked-${index}`,
            node_name: `ranked${index}`,
            type: "function",
            file: `src/ranked-${index}.mjs`,
            start_line: 1,
            end_line: 2
          }))
        };
        return { payload, rendered: JSON.stringify(payload) };
      }
      if (name === "lsp_definition") {
        const payload = Array.from({ length: 10 }, (_, index) => ({
          node_id: `definition-${index}`,
          node_name: "Target",
          type: "function",
          file: `src/definition-${index}.mjs`,
          line: 10
        }));
        return { payload, rendered: JSON.stringify(payload) };
      }
      if (name === "search_regex" && args.node_type === "file") {
        const payload = Array.from({ length: 20 }, (_, index) => ({
          node_id: `file-${index}`,
          node_name: `inside${index}`,
          type: "function",
          file: "src/explicit.mjs",
          start_line: index + 1,
          end_line: index + 1
        }));
        return { payload, rendered: JSON.stringify(payload) };
      }
      if (name === "search_regex") {
        const payload = Array.from({ length: 9 }, (_, index) => ({
          node_id: `candidate-${index}`,
          node_name: index === 8 ? "Target" : "Other",
          type: "function",
          file: args.file_glob,
          start_line: 1,
          end_line: 20
        }));
        return { payload, rendered: JSON.stringify(payload) };
      }
      throw new Error(`Unexpected tool: ${name}`);
    }
  });

  const result = await provider.search(
    "Change target.",
    { symbols: ["Target"], files: ["src/explicit.mjs"] },
    { topK: 2, budget: "balanced" }
  );

  assert.deepEqual(result.hits.slice(0, 2).map(({ node: value }) => value.id), ["ranked-0", "ranked-1"]);
  assert.deepEqual(result.hits.filter(({ node: value }) => value.id.startsWith("definition-")).map(({ node: value }) => value.id), [
    "definition-0",
    "definition-1",
    "definition-2",
    "definition-3"
  ]);
  assert.equal(result.hits.filter(({ node: value }) => value.id.startsWith("file-")).length, 8);
  assert.ok(result.hits.filter(({ node: value }) => value.id.startsWith("definition-")).every(({ node: value }) => value.rangeComplete === false));
  assert.equal(calls.filter(([name]) => name === "search_regex").length, 5);
});

test("rejects unsafe CodeNib read paths before it invokes the client", async () => {
  let calls = 0;
  const provider = new CodeNibRepositoryIntelligence({
    async callTool() {
      calls += 1;
      throw new Error("The client must not run for an unsafe path.");
    }
  }, { projectRoot: "/project" });

  for (const file of ["/outside.mjs", "src/../outside.mjs", "C:\\outside.mjs", "C:outside.mjs", "\\\\server\\share\\outside.mjs"]) {
    await assert.rejects(provider.read({ file, range: { startLine: 1, endLine: 2 } }), /safe project-relative path/);
  }
  assert.equal(calls, 0);
});

test("keeps the strongest tier when duplicate anchor identities seed graph expansion", async () => {
  const provider = {
    async describe() {
      return { name: "fixture", commit: "abc", capabilities: { symbolGraph: true } };
    },
    async search() {
      return {
        hits: [
          { node: node("same", "src/root.mjs", 1, 8, "root"), score: 1, reasons: ["provider-ranked-match"] },
          { node: node("other", "src/other.mjs", 1, 8, "other"), score: 0.9, reasons: ["provider-ranked-match"] },
          { node: node("same", "src/root.mjs", 1, 8, "root"), score: 0.8, reasons: ["provider-ranked-match"] }
        ]
      };
    },
    async neighbors() {
      return {
        neighbors: [
          { node: node("definition", "src/definition.mjs", 1, 8, "RootDefinition"), from: "same", relationship: "definition", score: 1 }
        ]
      };
    },
    async read(sourceRange) {
      return { rendered: sourceRange.file, range: sourceRange.range, rangeComplete: true };
    }
  };

  const plan = await planRepositoryContext({ task: "Change root.", provider });

  assert.ok(plan.mustRead.some(({ file }) => file === "src/definition.mjs"));
  assert.equal(plan.possibleRead.some(({ file }) => file === "src/definition.mjs"), false);
});
