import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  NATIVE_SNAPSHOT_IDENTITY_SCHEME,
  NativeRepositoryIntelligence,
  openNativeRepositoryIntelligence,
  withNativeRepositoryIntelligence
} from "../../dist/server/repository-intelligence/native-repository-intelligence.mjs";
import { planRepositoryContext } from "../../dist/server/repository-intelligence/repository-intelligence.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityFingerprint(kind, file, value) {
  const hash = createHash("sha256");
  hash.update(kind);
  hash.update("\0");
  hash.update(file);
  hash.update("\0");
  hash.update(sha256(value));
  hash.update("\0");
  return hash.digest("hex");
}

async function fixture(context, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function initializeGit(root) {
  await execFileAsync("git", ["init", "--quiet", root]);
}

test("implements the provider contract with Git nonignored source", async (context) => {
  const root = await fixture(context, "native-provider-git");
  await initializeGit(root);
  await write(root, ".gitignore", "ignored/\n");
  await write(root, "src/entry.mjs", "export function entry() {\n  return true;\n}\n");
  await write(root, "src/entry-factory.mjs", "export function entryFactory() {\n  return false;\n}\n");
  await write(root, "ignored/secret.mjs", "export function entry() {}\n");
  await write(root, "assets/image.bin", Buffer.from([0, 1, 2, 3]));

  const provider = await openNativeRepositoryIntelligence(root);
  const description = await provider.describe();
  const search = await provider.search("Change entry behavior.", { symbols: ["entry"] }, { topK: 8, budget: "balanced" });
  const graph = await provider.neighbors(search.hits.map(({ node }) => node), { maxNodes: 8 });
  const exactHit = search.hits.find(({ node }) => node.file === "src/entry.mjs");
  const source = await provider.read(exactHit.node);

  assert.equal(description.name, "native");
  assert.equal(NATIVE_SNAPSHOT_IDENTITY_SCHEME, "prism-native-sha256-v2");
  assert.equal(description.snapshotIdentity.scheme, "prism-native-sha256-v2");
  assert.match(description.commit, /^(snapshot|git):/);
  assert.match(description.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(description.capabilities, {
    lexicalSearch: true,
    semanticSearch: false,
    hybridSearch: false,
    symbolGraph: false,
    verifiedSource: true
  });
  assert.ok(exactHit.reasons.includes("explicit-design-reference"));
  assert.equal(search.hits.some(({ node }) => node.file === "ignored/secret.mjs"), false);
  assert.equal(search.hits.some(({ node }) => node.file === "assets/image.bin"), false);
  assert.equal(search.hits.find(({ node }) => node.file === "src/entry-factory.mjs")?.reasons.includes("explicit-design-reference"), false);
  assert.deepEqual(graph.neighbors, []);
  assert.equal(graph.graphCoverage, 0);
  assert.deepEqual(graph.diagnostics.map(({ code }) => code), ["structural_unavailable"]);
  assert.equal(source.content, "export function entry() {\n  return true;\n}\n");
  assert.deepEqual(source.range, { startLine: 1, endLine: 3 });
  assert.equal(source.rangeComplete, true);
});

test("produces a provider-independent context plan from native source", async (context) => {
  const root = await fixture(context, "native-provider-plan");
  await initializeGit(root);
  await write(root, "src/service.mjs", "export function handleRequest() {\n  return 200;\n}\n");
  const provider = new NativeRepositoryIntelligence(root);

  const plan = await planRepositoryContext({
    task: "Change handleRequest.",
    hints: { symbols: ["handleRequest"], expectedModifiedFiles: ["src/service.mjs"] },
    provider,
    tokenCounter: { name: "characters", exact: true, count: (value) => value.length }
  });

  assert.equal(plan.provider.name, "native");
  assert.match(plan.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.mustRead.map(({ file }) => file), ["src/service.mjs"]);
  assert.ok(plan.mustRead[0].reasons.includes("explicit-design-reference"));
  assert.ok(plan.mustRead[0].reasons.includes("expected-modification-target"));
  assert.deepEqual(plan.tokenEstimate, {
    lower: null,
    expected: null,
    upper: null,
    method: { name: "characters", exact: true }
  });
  assert.deepEqual(plan.diagnostics.provider.map(({ code }) => code), ["semantic_unavailable", "structural_unavailable"]);
});

test("changes the public source fingerprint when tracked source becomes dirty", async (context) => {
  const root = await fixture(context, "native-provider-dirty-fingerprint");
  await initializeGit(root);
  await write(root, "src/service.mjs", "export const value = 1;\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=Prism Test", "-c", "user.email=prism@example.invalid", "commit", "--quiet", "-m", "fixture"]);

  const first = await planRepositoryContext({ task: "Change value.", provider: new NativeRepositoryIntelligence(root) });
  await write(root, "src/service.mjs", "export const value = 2;\n");
  const second = await planRepositoryContext({ task: "Change value.", provider: new NativeRepositoryIntelligence(root) });

  assert.equal(first.commit, second.commit);
  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
});

test("rejects a context plan when unselected source changes before final verification", async (context) => {
  const root = await fixture(context, "native-provider-final-verification");
  await initializeGit(root);
  await write(root, "src/selected.mjs", "export const selected = true;\n");
  await write(root, "src/other.mjs", "export const untouched = 1;\n");
  const provider = await openNativeRepositoryIntelligence(root);
  const read = provider.read.bind(provider);
  let changed = false;
  provider.read = async (sourceRange) => {
    const result = await read(sourceRange);
    if (!changed) {
      changed = true;
      await write(root, "src/other.mjs", "export const untouched = 2;\n");
    }
    return result;
  };

  await assert.rejects(
    planRepositoryContext({ task: "Change selected.", hints: { files: ["src/selected.mjs"] }, provider }),
    (error) => error?.code === "snapshot-changed" && /native source snapshot changed/i.test(error.message)
  );
});

test("ranks lexical matches deterministically and preserves required hints", async (context) => {
  const root = await fixture(context, "native-provider-ranking");
  await initializeGit(root);
  await write(root, "src/alpha.mjs", "const retry = true;\n");
  await write(root, "src/beta.mjs", "const retry = retryPolicy();\nconst retryAgain = retry;\n");
  await write(root, "src/required.mjs", "export const required = true;\n");
  const provider = await openNativeRepositoryIntelligence(root);

  const first = await provider.search("retry policy", { files: ["src/required.mjs"] }, { topK: 2, budget: "fast" });
  const second = await provider.search("retry policy", { files: ["src/required.mjs"] }, { topK: 2, budget: "fast" });

  assert.deepEqual(first.hits, second.hits);
  assert.equal(first.hits[0].node.file, "src/required.mjs");
  assert.deepEqual(first.hits.slice(1).map(({ node }) => node.file), ["src/beta.mjs"]);
  assert.ok(first.hits[0].reasons.includes("explicit-design-reference"));
});

test("uses a bounded filesystem fallback without following symlinks", async (context) => {
  const root = await fixture(context, "native-provider-fallback");
  const outside = await fixture(context, "native-provider-outside");
  await write(root, "src/inside.js", "export const inside = true;\n");
  await write(root, "node_modules/dependency.js", "export const inside = false;\n");
  await write(outside, "outside.js", "export const inside = false;\n");
  await symlink(path.join(outside, "outside.js"), path.join(root, "src", "outside.js"));
  const provider = new NativeRepositoryIntelligence(root, { gitCommand: "prism-git-command-does-not-exist" });

  const description = await provider.describe();
  const search = await provider.search("inside", {}, { topK: 8, budget: "balanced" });

  assert.match(description.commit, /^snapshot:/);
  assert.equal(search.retrievalPlan.corpus.enumerator, "filesystem");
  assert.equal(search.retrievalPlan.corpus.complete, true);
  assert.deepEqual(search.hits.map(({ node }) => node.file), ["src/inside.js"]);
  assert.ok(search.diagnostics.some(({ code }) => code === "git_unavailable"));
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "symlink_recorded")?.details, { count: 1 });
  await provider.verifySnapshot({ requireComplete: true });
});

test("tracks a symbolic-link value without exposing the link as source", async (context) => {
  const root = await fixture(context, "native-provider-symlink-identity");
  await initializeGit(root);
  await write(root, "src/first.js", "export const first = true;\n");
  await write(root, "src/second.js", "export const second = true;\n");
  const linkPath = path.join(root, "src", "current.js");
  await symlink("first.js", linkPath);
  const provider = await openNativeRepositoryIntelligence(root);

  const description = await provider.describe();
  const search = await provider.search("first", { files: ["src/current.js"] }, { topK: 8, budget: "balanced" });

  assert.equal(search.retrievalPlan.corpus.complete, true);
  assert.equal(search.hits.some(({ node }) => node.file === "src/current.js"), false);
  assert.ok(search.unresolvedRequired.some(({ kind, value }) => kind === "file" && value === "src/current.js"));
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "symlink_recorded")?.details, { count: 1 });
  await provider.verifySnapshot({ requireComplete: true });

  await rm(linkPath);
  await symlink("second.js", linkPath);

  await assert.rejects(
    provider.verifySnapshot({ requireComplete: true }),
    (error) => error?.code === "snapshot-changed" && /native source snapshot changed/i.test(error.message)
  );
  const changed = await openNativeRepositoryIntelligence(root);
  assert.notEqual((await changed.describe()).sourceFingerprint, description.sourceFingerprint);
});

test("separates regular-file and symbolic-link identity with the same bytes", async (context) => {
  const fileRoot = await fixture(context, "native-provider-file-identity-kind");
  const linkRoot = await fixture(context, "native-provider-link-identity-kind");
  await initializeGit(fileRoot);
  await initializeGit(linkRoot);
  await write(fileRoot, "src/current.js", "first.js");
  await mkdir(path.join(linkRoot, "src"), { recursive: true });
  await symlink("first.js", path.join(linkRoot, "src", "current.js"));

  const fileDescription = await (await openNativeRepositoryIntelligence(fileRoot)).describe();
  const linkDescription = await (await openNativeRepositoryIntelligence(linkRoot)).describe();

  assert.equal(fileDescription.sourceFingerprint, identityFingerprint("source", "src/current.js", "first.js"));
  assert.equal(linkDescription.sourceFingerprint, identityFingerprint("symlink", "src/current.js", "first.js"));
});

test("bounds symbolic links by entry count", async (context) => {
  const countRoot = await fixture(context, "native-provider-link-count-bound");
  await mkdir(path.join(countRoot, "links"), { recursive: true });
  await symlink("one", path.join(countRoot, "links", "a"));
  await symlink("two", path.join(countRoot, "links", "b"));
  await symlink("three", path.join(countRoot, "links", "c"));
  const countProvider = new NativeRepositoryIntelligence(countRoot, {
    gitCommand: "prism-git-command-does-not-exist",
    maxFiles: 2
  });

  const countSearch = await countProvider.search("links", {}, { topK: 4, budget: "fast" });

  assert.equal(countSearch.retrievalPlan.corpus.complete, false);
  assert.ok(countSearch.diagnostics.some(({ code }) => code === "scan_incomplete"));
});

test("bounds each symbolic-link value by the per-entry byte limit", async (context) => {
  const byteRoot = await fixture(context, "native-provider-link-byte-bound");
  await mkdir(path.join(byteRoot, "links"), { recursive: true });
  await symlink("target-value-exceeds-limit", path.join(byteRoot, "links", "large"));
  const byteProvider = new NativeRepositoryIntelligence(byteRoot, {
    gitCommand: "prism-git-command-does-not-exist",
    maxFileBytes: 8
  });

  const byteSearch = await byteProvider.search("links", {}, { topK: 4, budget: "fast" });

  assert.equal(byteSearch.retrievalPlan.corpus.complete, false);
  assert.deepEqual(byteSearch.diagnostics.find(({ code }) => code === "oversized_symlink_skipped")?.details, { count: 1 });
});

test("bounds aggregate symbolic-link values by the whole-snapshot byte limit", async (context) => {
  const root = await fixture(context, "native-provider-link-total-byte-bound");
  await mkdir(path.join(root, "links"), { recursive: true });
  await symlink("first!", path.join(root, "links", "a"));
  await symlink("second", path.join(root, "links", "b"));
  const provider = new NativeRepositoryIntelligence(root, {
    gitCommand: "prism-git-command-does-not-exist",
    maxBytes: 10
  });

  const search = await provider.search("links", {}, { topK: 4, budget: "fast" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.ok(search.diagnostics.some(({ code }) => code === "scan_incomplete"));
});

test("marks a bounded or oversized scan as incomplete", async (context) => {
  const root = await fixture(context, "native-provider-limits");
  await initializeGit(root);
  await write(root, "src/a.js", "const bounded = 1;\n");
  await write(root, "src/b.js", "const bounded = 2;\n");
  await write(root, "src/large.js", "x".repeat(128));
  const provider = new NativeRepositoryIntelligence(root, { maxFiles: 2, maxBytes: 64, maxFileBytes: 64 });

  const search = await provider.search("bounded", {}, { topK: 8, budget: "balanced" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.ok(search.unresolvedRequired.some(({ kind }) => kind === "repository-scan"));
  assert.ok(search.diagnostics.some(({ code }) => code === "scan_incomplete"));
});

test("marks an enumerated Git submodule path as incomplete", async (context) => {
  const root = await fixture(context, "native-provider-gitlink");
  await initializeGit(root);
  await write(root, "src/main.js", "export const main = true;\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=Prism Test", "-c", "user.email=prism@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  await mkdir(path.join(root, "vendor", "dependency"), { recursive: true });
  await execFileAsync("git", ["-C", root, "update-index", "--add", "--cacheinfo", "160000", stdout.trim(), "vendor/dependency"]);
  const provider = await openNativeRepositoryIntelligence(root);

  const search = await provider.search("main", {}, { topK: 4, budget: "fast" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.ok(search.unresolvedRequired.some(({ kind }) => kind === "repository-scan"));
  assert.ok(search.diagnostics.some(({ code }) => code === "non_file_skipped"));
});

test("marks an unsupported fallback filesystem entry as incomplete", { skip: process.platform === "win32" }, async (context) => {
  const root = await fixture(context, "native-provider-fallback-special-entry");
  await execFileAsync("mkfifo", [path.join(root, "events.fifo")]);
  const provider = new NativeRepositoryIntelligence(root, { gitCommand: "prism-git-command-does-not-exist" });

  const search = await provider.search("events", {}, { topK: 4, budget: "fast" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "non_file_skipped")?.details, { count: 1 });
  assert.ok(search.diagnostics.some(({ code }) => code === "scan_incomplete"));
});

test("marks a tracked POSIX drive-relative name as an incomplete portable scan", { skip: path.sep !== "/" }, async (context) => {
  const root = await fixture(context, "native-provider-drive-relative-name");
  await initializeGit(root);
  await write(root, "C:tracked.mjs", "export const portableMarker = true;\n");
  await execFileAsync("git", ["-C", root, "add", "--all"]);
  const provider = await openNativeRepositoryIntelligence(root);

  const search = await provider.search("portableMarker", {}, { topK: 4, budget: "fast" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.equal(search.hits.length, 0);
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "portable_path_rejected")?.details, { count: 1 });
  assert.ok(search.unresolvedRequired.some(({ kind }) => kind === "repository-scan"));
});

test("marks a tracked POSIX backslash name as an incomplete portable scan", { skip: path.sep !== "/" }, async (context) => {
  const root = await fixture(context, "native-provider-backslash-name");
  await initializeGit(root);
  await write(root, "src\\tracked.mjs", "export const portableMarker = true;\n");
  await execFileAsync("git", ["-C", root, "add", "--all"]);
  const provider = await openNativeRepositoryIntelligence(root);

  const search = await provider.search("portableMarker", {}, { topK: 4, budget: "fast" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.equal(search.hits.length, 0);
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "portable_path_aliased")?.details, { count: 1 });
});

test("rejects both tracked names when portable normalization would collide", { skip: path.sep !== "/" }, async (context) => {
  const root = await fixture(context, "native-provider-portable-collision");
  await initializeGit(root);
  await write(root, "src/tracked.mjs", "export const slashMarker = true;\n");
  await write(root, "src\\tracked.mjs", "export const backslashMarker = true;\n");
  await execFileAsync("git", ["-C", root, "add", "--all"]);
  const provider = await openNativeRepositoryIntelligence(root);

  const search = await provider.search("Marker", {}, { topK: 4, budget: "fast" });

  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.equal(search.hits.length, 0);
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "portable_path_collision")?.details, { count: 2 });
});

test("bounds filesystem enumeration before it collects the complete tree", async (context) => {
  const root = await fixture(context, "native-provider-fallback-limit");
  await write(root, "src/a.js", "const bounded = 1;\n");
  await write(root, "src/b.js", "const bounded = 2;\n");
  await write(root, "src/c.js", "const bounded = 3;\n");
  const provider = new NativeRepositoryIntelligence(root, {
    gitCommand: "prism-git-command-does-not-exist",
    maxFiles: 2
  });

  const search = await provider.search("bounded", {}, { topK: 8, budget: "balanced" });

  assert.equal(search.retrievalPlan.corpus.enumerator, "filesystem");
  assert.equal(search.retrievalPlan.corpus.files, 2);
  assert.equal(search.retrievalPlan.corpus.complete, false);
  assert.ok(search.unresolvedRequired.some(({ kind }) => kind === "repository-scan"));
});

test("reports unresolved exact symbols without accepting longer identifiers", async (context) => {
  const root = await fixture(context, "native-provider-symbols");
  await initializeGit(root);
  await write(root, "src/runner.js", "export function runner() {}\nexport const rerun = runner;\n");
  const provider = await openNativeRepositoryIntelligence(root);

  const search = await provider.search("run", { symbols: ["run"] }, { topK: 8, budget: "balanced" });

  assert.equal(search.hits.some(({ reasons }) => reasons.includes("explicit-design-reference")), false);
  assert.deepEqual(search.unresolvedRequired, [{ kind: "symbol", value: "run" }]);
  assert.ok(search.diagnostics.some(({ code }) => code === "explicit_symbol_unresolved"));
});

test("bounds ubiquitous explicit symbol matches and exposes the truncation", async (context) => {
  const root = await fixture(context, "native-provider-symbol-limit");
  await initializeGit(root);
  for (let index = 0; index < 12; index += 1) {
    await write(root, `src/${String(index).padStart(2, "0")}.mjs`, "export const ubiquitousSymbol = true;\n");
  }
  const provider = await openNativeRepositoryIntelligence(root);

  const search = await provider.search("ubiquitousSymbol", { symbols: ["ubiquitousSymbol"] }, { topK: 4, budget: "fast" });

  assert.equal(search.hits.length, 4);
  assert.deepEqual(search.hits.map(({ node }) => node.file), ["src/00.mjs", "src/01.mjs", "src/02.mjs", "src/03.mjs"]);
  assert.equal(search.requiredEvidenceComplete, false);
  assert.deepEqual(search.diagnostics.find(({ code }) => code === "explicit_symbol_matches_truncated")?.details, { symbol: "ubiquitousSymbol", included: 4, omitted: 8 });
});

test("rejects explicit file hints that exceed the native result bound", async (context) => {
  const root = await fixture(context, "native-provider-required-limit");
  await initializeGit(root);
  await write(root, "src/a.mjs", "export const a = true;\n");
  await write(root, "src/b.mjs", "export const b = true;\n");
  const provider = await openNativeRepositoryIntelligence(root);

  await assert.rejects(
    provider.search("change", { files: ["src/a.mjs", "src/b.mjs"] }, { topK: 1, budget: "fast" }),
    /explicit file hints exceed/i
  );
});

test("uses Unicode identifier boundaries for exact symbol hints", async (context) => {
  const root = await fixture(context, "native-provider-unicode-symbols");
  await initializeGit(root);
  await write(root, "src/unicode.js", "const αrun = true;\nconst run = false;\n");
  const provider = await openNativeRepositoryIntelligence(root);

  const resolved = await provider.search("run", { symbols: ["run"] }, { topK: 8, budget: "balanced" });
  const unresolved = await provider.search("α", { symbols: ["α"] }, { topK: 8, budget: "balanced" });

  assert.ok(resolved.hits.some(({ reasons }) => reasons.includes("explicit-design-reference")));
  assert.deepEqual(unresolved.unresolvedRequired, [{ kind: "symbol", value: "α" }]);
});

test("rejects reads after source changes and rejects unindexed paths", async (context) => {
  const root = await fixture(context, "native-provider-change");
  await initializeGit(root);
  await write(root, "src/source.js", "export const value = 1;\n");
  const provider = await openNativeRepositoryIntelligence(root);
  const search = await provider.search("value", { files: ["src/source.js"] }, { topK: 4, budget: "balanced" });
  const node = search.hits.find(({ node: hit }) => hit.file === "src/source.js").node;

  await write(root, "src/source.js", "export const value = 2;\n");

  await assert.rejects(provider.read(node), /changed after the native snapshot/);
  await assert.rejects(provider.read({ file: "../outside.js", range: { startLine: 1, endLine: 1 } }), /safe project-relative path/);
});

test("runs an action through the native provider helper", async (context) => {
  const root = await fixture(context, "native-provider-helper");
  await write(root, "source.txt", "native baseline\n");

  const result = await withNativeRepositoryIntelligence(root, async (provider) => {
    const description = await provider.describe();
    return description.name;
  }, { gitCommand: "prism-git-command-does-not-exist" });

  assert.equal(result, "native");
});
