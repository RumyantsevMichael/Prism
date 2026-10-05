import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHUNKER_VERSION } from "../../native-runtime/versions.mjs";

let manifest = process.argv[2] && process.argv[2] !== "--default" ? path.resolve(process.argv[2]) : null;
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-native-mcp-")));
if (manifest && !manifest.endsWith(".json")) {
  const platform = `${process.platform}-${process.arch}`;
  const pinned = JSON.parse(await readFile(new URL("../../vendor/native-runtime/manifest.json", import.meta.url), "utf8"));
  pinned.bundles = JSON.parse(await readFile(path.join(manifest, platform + ".json"), "utf8"));
  pinned.bundles[platform].url = pathToFileURL(path.join(manifest, `prism-native-${platform}.tar.gz`)).href;
  manifest = path.join(temporary, "manifest.json");
  await writeFile(manifest, JSON.stringify(pinned));
}
const projectRoot = path.join(temporary, "project");
await mkdir(projectRoot);
await writeFile(path.join(projectRoot, "retry.ts"), "export function retryRequest() { return 1; }\n");
await writeFile(path.join(projectRoot, "instructions.md"), "# Retry\n\nRepeat temporary network failures.\n");
const server = fileURLToPath(new URL("../../server/mcp.mjs", import.meta.url));
const environment = { ...process.env, PATH: "", PLUGIN_DATA: path.join(temporary, "cache"), CLAUDE_PROJECT_DIR: projectRoot };
delete environment.PRISM_NATIVE_ASSET_MANIFEST;
if (manifest) environment.PRISM_NATIVE_ASSET_MANIFEST = manifest;
delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
let child, counter = 0;
const requests = new Map();
function start(offline = false) {
  const args = offline ? ["--import", "data:text/javascript,globalThis.fetch=async()=>{throw new Error('Offline smoke test')}", server] : [server];
  child = spawn(process.execPath, args, { cwd: projectRoot, env: environment, stdio: ["pipe", "pipe", "inherit"] });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line), pending = requests.get(response.id);
    requests.delete(response.id);
    if (response.error) pending.reject(Object.assign(new Error(response.error.message), { data: response.error.data }));
    else pending.resolve(response.result.structuredContent || response.result);
  });
  child.on("exit", () => { for (const request of requests.values()) request.reject(new Error("MCP exited.")); requests.clear(); });
}
function request(method, params) {
  return new Promise((resolve, reject) => { const id = ++counter; requests.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
}
const call = (name, args = {}) => request("tools/call", { name, arguments: { projectRoot, ...args } });
async function ready(name, args) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await call(name, args);
    if (result.status !== "preparing") return result;
    await call("get_repository_intelligence_status", { waitMs: 30000 });
  }
  throw new Error("Native preparation did not finish.");
}
async function stop() { const done = new Promise(resolve => child.once("exit", resolve)); child.stdin.end(); await done; }
async function managedTrial() {
  const publicClass = "export class PublicClass { before() { return 1; } }\n";
  const original = "export function retryRequest() { const result = 1; return result; }\n" + publicClass;
  const refactored = "export function retryRequest() { return 1; }\n" + publicClass;
  const target = path.join(projectRoot, "retry.mjs");
  await writeFile(target, original);
  await writeFile(path.join(projectRoot, "requirements.md"), "Preserve the retry result while removing the redundant local variable.\n");
  await mkdir(path.join(projectRoot, "vendor"));
  await writeFile(path.join(projectRoot, "vendor/large.js"), "// " + "x".repeat(2 * 1024 * 1024));
  const deltaPath = "plans/managed/concept-delta.json", reviewPath = "plans/managed/review.json";
  const omittedDeltaPath = "plans/omitted/concept-delta.json";
  await call("capture_repository_snapshot", { deltaPath: omittedDeltaPath });
  const baseline = await call("capture_repository_snapshot", { deltaPath });
  assert.equal(baseline.complete, false);
  const omitted = await call("update_concept_delta", { deltaPath: omittedDeltaPath, expectedRevision: null,
    baselineId: baseline.snapshotId, scope: ["vendor/large.js"], operations: [] });
  assert.equal(omitted.ready, false);
  assert.ok(omitted.diagnostics.some(item => item.code === "evidence_missing"), JSON.stringify(omitted));
  const reference = { path: "retry.mjs", selector: { type: "symbol", value: "retryRequest" } };
  const delta = await call("update_concept_delta", { deltaPath, expectedRevision: null, baselineId: baseline.snapshotId,
    scope: ["retry.mjs"], requirements: [{ path: "requirements.md" }], operations: [{ op: "insert", entry: {
      id: "retry", kind: "function", label: "Retry result", action: "MODIFY", before: [reference], after: [reference],
      reason: "Remove the redundant local variable while preserving the result.", requirements: [{ path: "requirements.md" }]
    } }] });
  assert.equal(delta.ready, true, JSON.stringify(delta));
  const compare = snapshotId => ready("compare_concept_delta", { deltaPath, expectedRevision: delta.revision,
    baselineId: baseline.snapshotId, resultSnapshotId: snapshotId });
  let revision = null;
  const mutate = async (id, operations) => {
    const result = await call("update_review", { reviewPath, deltaPath, delivery: "delivery", expectedRevision: revision,
      actor: { id, role: id === "coordinator" ? "coordinator" : id === "delivery" ? "delivery" : "reviewer" }, operations });
    revision = result.revision;
    return result;
  };
  const wave = (id, mode, snapshotId, comparisonId) => ({ op: "start_wave", id, mode, deltaRevision: delta.revision,
    snapshotId, comparisonId, lanes: [{ id: "main", reviewer: "reviewer", coverage: ["retry.mjs"] }] });
  const audit = await compare(baseline.snapshotId);
  await mutate("coordinator", [wave("audit", "design-audit", baseline.snapshotId, audit.comparisonId)]);
  await assert.rejects(mutate("coordinator", [{ op: "accept_wave" }]), error => error.data?.code === "gate_blocked");
  await assert.rejects(mutate("delivery", [{ op: "submit_lane", lane: "main", status: "CLEAN" }]), error => error.data?.code === "gate_blocked");
  await mutate("reviewer", [{ op: "submit_lane", lane: "main", status: "CLEAN" }]);
  await mutate("coordinator", [{ op: "accept_wave" }]);
  assert.equal((await call("check_review_gate", { reviewPath, gate: "implementation" })).ready, true);
  assert.equal((await import(pathToFileURL(target).href + "?before")).retryRequest(), 1);
  await writeFile(target, refactored);
  assert.equal((await import(pathToFileURL(target).href + "?after")).retryRequest(), 1);
  const final = await call("capture_repository_snapshot", { deltaPath });
  const comparison = await compare(final.snapshotId);
  assert.deepEqual(comparison.growth, [], JSON.stringify(comparison));
  await mutate("coordinator", [wave("implementation", "implementation-review", final.snapshotId, comparison.comparisonId)]);
  await mutate("reviewer", [{ op: "submit_lane", lane: "main", status: "CLEAN" }]);
  await mutate("coordinator", [{ op: "accept_wave" }]);
  assert.equal((await call("check_review_gate", { reviewPath, gate: "completion" })).ready, true);
  await writeFile(target, refactored.replace("return 1", "return 2"));
  await assert.rejects(call("check_review_gate", { reviewPath, gate: "completion" }), error => error.data?.code === "stale_snapshot");
  await writeFile(target, refactored.replace("before()", "after_()"));
  const renamedMethod = await call("capture_repository_snapshot", { deltaPath });
  const publicGrowth = await compare(renamedMethod.snapshotId);
  assert.ok(publicGrowth.growth.some(item => item.dimension === "code.publicDeclarationsAdded"), JSON.stringify(publicGrowth));
}
try {
  start();
  assert.equal((await call("discover_repository_intelligence")).status, "unprepared");
  const deltaPath = "plans/demo/concept-delta.json";
  const baseline = await call("capture_repository_snapshot", { deltaPath });
  const cold = ready("search_repository_concepts", { snapshotId: baseline.snapshotId, query: "retryRequest", filters: { domains: ["code"] } });
  const begin = performance.now();
  assert.ok((await request("tools/list")).tools.some(tool => tool.name === "search_repository_concepts"));
  assert.ok(performance.now() - begin < 2000, "Discovery must stay responsive during preparation.");
  const found = await cold;
  assert.equal(found.status, "ready", JSON.stringify(found));
  assert.equal((await call("get_repository_intelligence_status")).versions.chunker, CHUNKER_VERSION);
  assert.ok(found.results.every(candidate => !Object.hasOwn(candidate, "embeddingText")));
  assert.equal(found.results[0].file, "retry.ts");
  assert.ok(Number.isFinite(found.results[0].cosineSimilarity));
  const retained = await ready("search_repository_concepts", { snapshotId: baseline.snapshotId, query: "total retry deadline", limit: 5 });
  assert.equal(retained.status, "ready"); assert.ok(retained.receiptId);
  const receipt = await call("get_conservation_evidence", { evidenceId: retained.receiptId, section: "candidates" });
  assert.equal(receipt.snapshotId, baseline.snapshotId); assert.equal(receipt.capabilities.semanticSearch, true);
  const candidates = receipt.entries.map(candidate => ({ receiptId: retained.receiptId, candidateId: candidate.id,
    reference: { path: candidate.file, selector: candidate.span ? { type: "span", ...candidate.span, sourceHash: candidate.sourceHash } : candidate.selector || candidate.name },
    disposition: "PARTIAL", reason: "Fixture evidence: existing retry behavior can be reused but the proposed total deadline is distinct." }));
  const delta = await call("update_concept_delta", { deltaPath, expectedRevision: null, baselineId: baseline.snapshotId, scope: ["retry.ts", "instructions.md"], requirements: [{ path: "instructions.md" }], operations: [{ op: "insert", entry: {
    id: "deadline", kind: "rule", label: "Total retry deadline", action: "ADD", before: [], after: [{ path: "instructions.md", selector: { type: "text", value: "Use one total retry deadline." } }], reason: "Fixture requirement for a total deadline.", requirements: [{ path: "instructions.md" }],
    reuseEvidence: { receiptIds: [retained.receiptId], candidates, justification: "The existing per-attempt behavior does not express a total deadline.", ...(candidates.length ? {} : { emptyResultReason: "The retained fixture contains no returned reuse candidate." }) }
  } }] });
  assert.equal(delta.ready, true, JSON.stringify(delta));
  const live = await ready("search_repository_concepts", { query: "retryRequest", filters: { domains: ["code"] } });
  const plan = await ready("plan_repository_context", { task: "Change retryRequest", hints: { symbols: ["retryRequest"] }, expectedSnapshot: live.snapshot });
  assert.ok(plan.tokenEstimate.expected > 0, JSON.stringify(plan));
  const fit = await request("tools/call", { name: "evaluate_repository_fit", arguments: {
    session: { harness: "codex-cli", harnessVersion: "0.147.0", provider: "openai", model: "gpt-5.6-sol" },
    costs: { baseSessionContextTokens: 20000, featureDesignContextTokens: 10000, implementationReserveTokens: 90000 },
    tokenEstimate: { lower: plan.tokenEstimate.lower, expected: plan.tokenEstimate.expected, upper: plan.tokenEstimate.upper }
  } });
  assert.equal(fit.fit, "FIT");
  await stop(); start(true);
  const warm = await ready("search_repository_concepts", { query: "network failures", filters: { domains: ["instruction"] }, expectedSnapshot: live.snapshot });
  assert.equal(warm.status, "ready"); assert.equal(warm.indexRevision, live.indexRevision);
  assert.equal((await call("get_repository_intelligence_status")).versions.chunker, CHUNKER_VERSION);
  assert.equal(warm.results[0].file, "instructions.md");
  const retainedOffline = await ready("search_repository_concepts", { snapshotId: baseline.snapshotId, query: "total retry deadline", limit: 5 });
  assert.equal(retainedOffline.status, "ready"); assert.equal(retainedOffline.indexRevision, retained.indexRevision);
  const retryCandidate = retainedOffline.results.find(candidate => candidate.file === "retry.ts" && candidate.kind === "function");
  assert.ok(retryCandidate?.span, "The native parser must supply the function's exact source span.");
  const deleted = await call("update_concept_delta", { deltaPath, expectedRevision: delta.revision, operations: [{ op: "update", id: "deadline", set: {
    action: "DELETE", kind: "function", before: [{ path: "retry.ts", selector: { type: "span", ...retryCandidate.span, sourceHash: retryCandidate.sourceHash } }], after: []
  } }] });
  await writeFile(path.join(projectRoot, "retry.ts"), "export function retryRequest() { return 2; }\n");
  const changed = await call("capture_repository_snapshot", { deltaPath });
  const retainedDeletion = await ready("compare_concept_delta", { deltaPath, expectedRevision: deleted.revision, baselineId: baseline.snapshotId, resultSnapshotId: changed.snapshotId });
  assert.ok(retainedDeletion.observations.some(item => item.code === "retained_source" && item.conceptId === "deadline"), JSON.stringify(retainedDeletion));
  const falseAddition = await call("update_concept_delta", { deltaPath, expectedRevision: deleted.revision, operations: [{ op: "update", id: "deadline", set: {
    action: "ADD", before: [], after: [{ path: "retry.ts", selector: { type: "symbol", value: "retryRequest" } }]
  } }] });
  assert.equal(falseAddition.ready, false);
  assert.ok(falseAddition.diagnostics.some(item => item.code === "addition_already_exists"));
  const existingAddition = await ready("compare_concept_delta", { deltaPath, expectedRevision: falseAddition.revision, baselineId: baseline.snapshotId, resultSnapshotId: changed.snapshotId });
  assert.ok(existingAddition.observations.some(item => item.code === "addition_already_exists"));
  await writeFile(path.join(projectRoot, "retry.ts"), "export function retryRequest() { return 1; }\n");
  await rename(path.join(projectRoot, "retry.ts"), path.join(projectRoot, "renamed.ts"));
  await assert.rejects(call("search_repository_concepts", { query: "retryRequest", expectedSnapshot: live.snapshot }), error => error.data?.code === "stale_snapshot");
  const renamed = await ready("search_repository_concepts", { query: "retryRequest" });
  assert.equal(renamed.results[0].file, "renamed.ts");
  assert.notEqual(renamed.snapshot, live.snapshot);
  const original = await ready("search_repository_concepts", { snapshotId: baseline.snapshotId, query: "retryRequest", filters: { domains: ["code"] } });
  assert.equal(original.results[0].file, "retry.ts", "Baseline search must never substitute renamed live source.");
  await rm(path.join(projectRoot, "renamed.ts")); await rm(path.join(projectRoot, "instructions.md"));
  await rm(path.join(projectRoot, "plans"), { recursive: true });
  const empty = await ready("search_repository_concepts", { query: "retryRequest" });
  assert.equal(empty.status, "ready"); assert.deepEqual(empty.results, []);
  await managedTrial();
  process.stdout.write(JSON.stringify({ platform: `${process.platform}-${process.arch}`, defaultManifest: manifest === null, mcp: true, numericNativeEstimate: plan.tokenEstimate.expected,
    fit: fit.fit, responsiveDiscovery: true, warmOffline: true, retainedSemanticReceipt: true, retainedOffline: true, baselineAfterRename: true, additionReadiness: true, changedDeletionRejected: true, existingAdditionRejected: true, renameFreshness: true, deletionFreshness: true, emptyRepository: true,
    managedAudit: true, managedCompletion: true, reviewerOwnership: true, staleAcceptanceRejected: true, affectedOmissionRejected: true, unrelatedVendorOmissionAllowed: true, renamedPublicMethodDetected: true }) + "\n");
} finally { if (child?.exitCode === null) await stop(); await rm(temporary, { recursive: true, force: true }); }
