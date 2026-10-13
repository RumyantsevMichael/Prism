// Build a demo project whose JSON artifacts come from the real Prism MCP tools, for trying the review browser views.
// Usage: node scripts/review-demo/seed.mjs [project-directory]
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = path.join(ROOT, "dist/server/mcp.mjs");
const MANIFEST = path.join(ROOT, "test/server/fixtures/native-manifest-unavailable.json");
const examples = JSON.parse(await readFile(path.join(ROOT, "test/server/fixtures/concept-delta.json"), "utf8"));

const requested = process.argv[2];
const projectRoot = requested ? path.resolve(requested) : await mkdtemp(path.join(os.tmpdir(), "prism-review-demo-"));
if (requested) {
  await rm(projectRoot, { recursive: true, force: true });
}
await mkdir(projectRoot, { recursive: true });
const realRoot = await realpath(projectRoot);
const dataDir = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-data`);
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

async function write(relative, content) {
  const target = path.join(realRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

const slice = "docs/plans/retry-hardening/timeout-retries";
const deltaPath = `${slice}/concept-delta.json`;
const reviewPath = `${slice}/review.json`;
const statePath = "docs/plans/retry-hardening/state.json";

await write(".prism/workflow.md", "# Workflow config\n\n## Paths\n- Requirements: docs/requirements/\n- ADRs: docs/ADRs/\n- Plans (scratch): docs/plans/\n");
await write("src/retry/strategy.ts", "export class RequestRetryStrategy {\n  constructor(private attempts = 3) {}\n  shouldRetry(error: Error, attempt: number) {\n    return attempt < this.attempts && error.name === \"TimeoutError\";\n  }\n}\n");
await write("src/retry/legacy.ts", "export class LegacyRetryHandler {\n  handle(error: Error) {\n    if (error.name === \"TimeoutError\") return true;\n    if (error.name === \"ConnectionError\") return true;\n    return false;\n  }\n}\n");
await write("config/retry.json", `${JSON.stringify({ attemptTimeoutMs: 2000 }, null, 2)}\n`);
await write("docs/retry.md", "# Retries\n\n## Examples\n\nA timed-out request retries three times.\n");
await write("instructions/answers.md", "# Answers\n\n- Do not repeat the user's question.\n- Keep introductions short.\n");
await write("docs/requirements/retries.md", "# Retry requirements\n\n- When a request exceeds the total retry deadline, the client shall stop retrying.\n");
await write(`${slice}/design.md`, "# Timeout retries\n\nThe existing strategy will own timeout retries, and a total deadline bounds every retry sequence.\n\nThe structured plan lives in `concept-delta.json`, and the review ledger in `review.json`.\n");

const env = { ...process.env, PLUGIN_DATA: dataDir, PRISM_NATIVE_ASSET_MANIFEST: MANIFEST };
delete env.CLAUDE_PROJECT_DIR;
const child = spawn(process.execPath, [SERVER], { cwd: realRoot, env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const pending = new Map();
let nextId = 0;
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const response = JSON.parse(line);
  pending.get(response.id)?.(response);
  pending.delete(response.id);
});

async function call(name, args) {
  const id = ++nextId;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out: ${stderr}`)), 120000);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
  if (response.error || response.result?.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(response.error ?? response.result)}`);
  }
  return response.result.structuredContent;
}

let reviewRevision = null;
async function review(actor, operations) {
  const result = await call("update_review", { projectRoot: realRoot, reviewPath, deltaPath, delivery: "delivery", expectedRevision: reviewRevision, actor, operations });
  reviewRevision = result.revision;
  return result;
}

try {
  const baseline = await call("capture_repository_snapshot", { projectRoot: realRoot, deltaPath });
  const search = await call("search_repository_concepts", { projectRoot: realRoot, snapshotId: baseline.snapshotId, query: "retry deadline timeout", limit: 5 });
  const concepts = examples.concepts.map((entry) => entry.id === "retry-deadline"
    ? { ...entry, requirements: [{ path: "docs/requirements/retries.md", selector: { type: "heading", value: "Retry requirements" } }], reuseEvidence: { ...entry.reuseEvidence, receiptIds: [search.receiptId] } }
    : entry);
  let delta = await call("update_concept_delta", { projectRoot: realRoot, deltaPath, expectedRevision: null, baselineId: baseline.snapshotId, scope: examples.scope, operations: concepts.map((entry) => ({ op: "insert", entry })) });
  delta = await call("update_concept_delta", { projectRoot: realRoot, deltaPath, expectedRevision: delta.revision, expectedGrowth: [{ dimension: "configurationOptions", increase: 1, reason: "The total retry deadline is a new option." }], operations: [] });
  const audit = await call("compare_concept_delta", { projectRoot: realRoot, deltaPath, expectedRevision: delta.revision, baselineId: baseline.snapshotId, resultSnapshotId: baseline.snapshotId });

  const coordinator = { id: "coordinator", role: "coordinator" };
  const reviewer = { id: "independent", role: "reviewer" };
  const security = { id: "security", role: "reviewer" };
  const delivery = { id: "delivery", role: "delivery" };
  await review(coordinator, [{ op: "start_wave", id: "design-audit", mode: "design-audit", deltaRevision: delta.revision, snapshotId: baseline.snapshotId, comparisonId: audit.comparisonId, lanes: [{ id: "main", reviewer: "independent", coverage: ["src", "config"] }, { id: "security", reviewer: "security", coverage: ["src"] }] }]);
  await review(reviewer, [{ op: "submit_lane", lane: "main", status: "CLEAN" }]);
  await review(security, [{ op: "submit_lane", lane: "security", status: "CLEAN" }]);
  // The acceptance gate needs native semantic receipts and bound requirements, so this demo leaves the audit wave unaccepted.

  await write("src/retry/strategy.ts", "export class RequestRetryStrategy {\n  constructor(private attempts = 3, private deadlineMs = 10000) {}\n  shouldRetry(error: Error, attempt: number, elapsedMs: number) {\n    if (elapsedMs >= this.deadlineMs) return false;\n    if (error.name === \"ConnectionError\") return attempt < this.attempts;\n    return attempt < this.attempts && error.name === \"TimeoutError\";\n  }\n}\n");
  await rm(path.join(realRoot, "src/retry/legacy.ts"));
  await write("config/retry.json", `${JSON.stringify({ attemptTimeoutMs: 2000, retryDeadlineMs: 10000 }, null, 2)}\n`);
  await write("docs/retry.md", "# Retries\n\n## Timeout examples\n\nA timed-out request retries until the total deadline.\n\n## Connection examples\n\nA dropped connection retries three times.\n");
  await write("instructions/answers.md", "# Answers\n\n- Answer directly and include only information needed to satisfy the request.\n");
  const result = await call("capture_repository_snapshot", { projectRoot: realRoot });
  const implementation = await call("compare_concept_delta", { projectRoot: realRoot, deltaPath, expectedRevision: delta.revision, baselineId: baseline.snapshotId, resultSnapshotId: result.snapshotId });

  await review(coordinator, [{ op: "start_wave", id: "implementation", mode: "implementation-review", deltaRevision: delta.revision, snapshotId: result.snapshotId, comparisonId: implementation.comparisonId, lanes: [{ id: "main", reviewer: "independent", coverage: ["src", "config", "docs"] }, { id: "security", reviewer: "security", coverage: ["src"] }] }]);
  await review(reviewer, [
    { op: "open_finding", lane: "main", localId: "F1", title: "Deadline check ignores the first attempt", severity: "high", affectedPath: "src/retry/strategy.ts", evidence: "shouldRetry compares elapsed time only after a failure, so a slow first attempt can exceed the deadline.", conditionToClose: "A test shows that no retry starts after the deadline elapses." },
    { op: "open_finding", lane: "main", localId: "F2", title: "Connection errors now retry without a requirement", severity: "blocker", affectedPath: "src/retry/strategy.ts", evidence: "The concept delta keeps connection retries out of scope, but the strategy now retries ConnectionError.", conditionToClose: "Either the delta records the behavior change with a requirement, or the branch is removed." },
    { op: "open_finding", lane: "main", localId: "F3", title: "Timeout examples omit the deadline value", severity: "low", affectedPath: "docs/retry.md", evidence: "The example does not say what the default deadline is.", conditionToClose: "The example names the default deadline." }
  ]);
  await review(security, [{ op: "open_finding", lane: "security", localId: "S1", title: "Unbounded deadline from configuration", severity: "medium", affectedPath: "config/retry.json", evidence: "retryDeadlineMs accepts any number, so a misconfiguration can retry for hours.", conditionToClose: "The loader rejects deadlines above a documented maximum." }]);
  await review(delivery, [
    { op: "set_finding_status", id: "implementation-review/main/F1", status: "IN PROGRESS", evidence: "Adding a pre-attempt deadline check." },
    { op: "set_finding_status", id: "implementation-review/main/F3", status: "FIXED", evidence: "docs/retry.md now names the 10 second default." },
    { op: "set_finding_status", id: "implementation-review/security/S1", status: "FIXED", evidence: "The loader caps retryDeadlineMs at 60000." }
  ]);
  await review(reviewer, [{ op: "set_finding_status", id: "implementation-review/main/F3", status: "VERIFIED", evidence: "The example states the default." }]);
  await review(security, [{ op: "set_finding_status", id: "implementation-review/security/S1", status: "REOPENED", evidence: "The cap exists, but the error message leaks the configuration path." }]);

  const state = await call("update_coordination_state", { projectRoot: realRoot, statePath, expectedRevision: null, changes: {
    settings: { autonomy: "broad", agentFlow: "multi", commit: "on", push: "off", continuation: "stepwise", models: "host defaults" },
    activeOperations: [{ op: "start", entry: { slice: "timeout-retries", activity: "review", label: "Implementation review, wave 2", workers: ["independent", "security"], workspace: realRoot, reviewPath, reviewLanes: [{ id: "main", reviewer: "independent" }, { id: "security", reviewer: "security" }] } }]
  } });
  await call("update_coordination_state", { projectRoot: realRoot, statePath, expectedRevision: state.revision, changes: { pending: ["connection-retries"], next: ["docs/plans/retry-hardening/connection-retries"], evidence: [`${slice}/design.md`] } });

  process.stdout.write(`Demo project: ${realRoot}\nPrivate evidence: ${dataDir}\n\nStart the review browser with:\n  cd ${realRoot} && PLUGIN_DATA=${dataDir} ${path.join(ROOT, "bin/prism")} review ${deltaPath}\n`);
} finally {
  child.stdin.end();
}
