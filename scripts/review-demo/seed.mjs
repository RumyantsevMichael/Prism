// Build a demo project whose JSON artifacts come from the real Prism MCP tools, for trying the review browser views.
// Usage: node scripts/review-demo/seed.mjs [project-directory]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, prepareProject, startTools } from "./project.mjs";

const examples = JSON.parse(await readFile(path.join(ROOT, "test/server/fixtures/change-map.json"), "utf8"));
const { realRoot, dataDir, write } = await prepareProject(process.argv[2], "prism-review-demo-");

const slice = "docs/plans/retry-hardening/timeout-retries";
const deltaPath = `${slice}/change-map.json`;
const reviewPath = `${slice}/review.json`;
const statePath = "docs/plans/retry-hardening/state.json";

await write(".prism/workflow.md", "# Workflow config\n\n## Paths\n- Requirements: docs/requirements/\n- ADRs: docs/ADRs/\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n- Glossary: docs/Glossary.md\n");
await write("src/retry/strategy.ts", "export class RequestRetryStrategy {\n  constructor(private attempts = 3) {}\n  shouldRetry(error: Error, attempt: number) {\n    return attempt < this.attempts && error.name === \"TimeoutError\";\n  }\n}\n");
await write("src/retry/legacy.ts", "export class LegacyRetryHandler {\n  handle(error: Error) {\n    if (error.name === \"TimeoutError\") return true;\n    if (error.name === \"ConnectionError\") return true;\n    return false;\n  }\n}\n");
await write("config/retry.json", `${JSON.stringify({ attemptTimeoutMs: 2000 }, null, 2)}\n`);
await write("docs/retry.md", "# Retries\n\n## Examples\n\nA timed-out request retries three times.\n");
await write("instructions/answers.md", "# Answers\n\n- Do not repeat the user's question.\n- Keep introductions short.\n");
await write("docs/requirements/retries.md", "# Retry requirements\n\nStatus: Approved\nCreated: 2026-09-02\nApproved: 2026-09-04\n\n<a id=\"1\"></a>\n## 1. Total deadline\n\nWhen a request exceeds the total retry deadline, the client shall stop retrying.\n\n<a id=\"2\"></a>\n## 2. Connection drops\n\nWhen a connection drops, the client shall retry at most three times.\n\n<a id=\"3\"></a>\n## 3. Retry metrics\n\nThe client shall report retry attempts and outcomes as metrics.\n");
await write("docs/requirements/reports.md", "# Activity reports\n\nStatus: Approved\nCreated: 2026-09-10\nApproved: 2026-09-12\n\n<a id=\"1\"></a>\n## 1. Signed export\n\nWhen a user requests an export, the system shall produce a signed report.\n\n<a id=\"2\"></a>\n## 2. Authorized downloads\n\nThe system shall restrict report downloads to authorized users.\n");
await write("docs/requirements/search.md", "# Search indexing\n\nStatus: Draft\nCreated: 2026-10-01\n\n## 1\n\nThe system shall index activity for full-text search.\n");
await write("docs/requirements/audit-log.md", "# Audit log\n\nStatus: Approved\nCreated: 2026-08-01\nApproved: 2026-08-02\n\n## 1\n\nThe system shall record every administrative action.\n");
await write("docs/ADRs/retries/total-retry-deadline.md", "# Bound retries by a total deadline\n\nStatus: Proposed\nCreated: 2026-09-20\n\n## Decision\n\nEvery retry sequence MUST stop when its total deadline elapses.\n");
await write("docs/ADRs/reporting/signed-exports.md", "# Sign exported reports\n\nStatus: Accepted\nCreated: 2026-09-11\n\n## Decision\n\nExported reports MUST carry a detached signature.\n");
await write("docs/ADRs/reporting/csv-only-exports.md", "# Export reports as CSV only\n\nStatus: Superseded\nCreated: 2026-07-01\n\n## Decision\n\nReports were CSV only.\n");
await write("docs/Glossary.md", "# Glossary\n\nTerms used by the payments API team.\n\n| Term | Definition |\n| --- | --- |\n| Retry deadline | The total time a request may spend across all retry attempts. |\n| Attempt timeout | The time one attempt may take before it counts as failed. |\n| Signed report | An exported activity report with a detached signature. |\n");
await write(`${slice}/slice.md`, "# Retry timed-out requests until a total deadline\n\n## Context\n\nThe existing strategy owns timeout retries, and a total deadline bounds every retry sequence.\nConnection retries stay out of scope until their own slice.\n");
await write(`${slice}/timeout-retries.puml`, "@startuml\nclass RequestRetryStrategy\n@enduml\n");

const { call, close } = startTools(realRoot, dataDir);

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
  let delta = await call("update_change_map", { projectRoot: realRoot, deltaPath, expectedRevision: null, baselineId: baseline.snapshotId, scope: examples.scope, operations: concepts.map((entry) => ({ op: "insert", entry })) });
  delta = await call("update_change_map", { projectRoot: realRoot, deltaPath, expectedRevision: delta.revision, expectedGrowth: [{ dimension: "configurationOptions", increase: 1, reason: "The total retry deadline is a new option." }], operations: [] });
  const audit = await call("compare_change_map", { projectRoot: realRoot, deltaPath, expectedRevision: delta.revision, baselineId: baseline.snapshotId, resultSnapshotId: baseline.snapshotId });

  const coordinator = { id: "coordinator", role: "coordinator" };
  const reviewer = { id: "independent", role: "reviewer" };
  const security = { id: "security", role: "reviewer" };
  const delivery = { id: "delivery", role: "delivery" };
  await review(coordinator, [{ op: "start_wave", id: "design-audit", mode: "design-audit", deltaRevision: delta.revision, snapshotId: baseline.snapshotId, comparisonId: audit.comparisonId, lanes: [{ id: "main", reviewer: "independent", coverage: ["src", "config", "docs", "instructions"] }, { id: "security", reviewer: "security", coverage: ["src"] }] }]);
  // The acceptance gate needs native semantic receipts and bound requirements, so this demo keeps the audit wave in flight, and start_wave refuses implementation review until the audit is accepted.
  await review(reviewer, [
    { op: "open_finding", lane: "main", localId: "F1", title: "The delta does not say when the deadline is checked", severity: "high", affectedPath: deltaPath, evidence: "The retry-deadline concept bounds retries, but nothing says the deadline is checked before each attempt, so a slow first attempt can exceed it.", conditionToClose: "The retry-policy concept states that no attempt starts after the deadline elapses." },
    { op: "open_finding", lane: "main", localId: "F2", title: "Deleting LegacyRetryHandler drops connection retries", severity: "blocker", affectedPath: "src/retry/legacy.ts", evidence: "LegacyRetryHandler is the only code that retries ConnectionError, and the delta deletes it without saying where that behavior goes.", conditionToClose: "Either the delta records where connection retries move with a requirement, or a decision removes them." },
    { op: "open_finding", lane: "main", localId: "F3", title: "The replacement examples omit the deadline value", severity: "low", affectedPath: "docs/retry.md", evidence: "The retry-documentation concept does not say what the default deadline is.", conditionToClose: "The replacement examples name the default deadline." }
  ]);
  await review(security, [{ op: "open_finding", lane: "security", localId: "S1", title: "Unbounded deadline from configuration", severity: "medium", affectedPath: "config/retry.json", evidence: "The retry-deadline concept accepts any number, so a misconfiguration can retry for hours.", conditionToClose: "The concept caps retryDeadlineMs at a documented maximum." }]);
  await review(delivery, [
    { op: "set_finding_status", id: "design-audit/main/F1", status: "IN PROGRESS", evidence: "Adding a pre-attempt deadline check to the retry-policy concept." },
    { op: "set_finding_status", id: "design-audit/main/F3", status: "FIXED", evidence: "The retry-documentation concept now names the 10 second default." },
    { op: "set_finding_status", id: "design-audit/security/S1", status: "FIXED", evidence: "The retry-deadline concept caps the value at 60000." }
  ]);
  await review(reviewer, [{ op: "set_finding_status", id: "design-audit/main/F3", status: "VERIFIED", evidence: "The examples state the default." }]);
  await review(security, [{ op: "set_finding_status", id: "design-audit/security/S1", status: "REOPENED", evidence: "The cap exists, but the rejection message would leak the configuration path." }]);

  // Initiative records and the roadmap come from the record tools, exactly as orchestration and the roadmap skill write them.
  const retries = ["docs/requirements/retries.md#1", "docs/requirements/retries.md#2", "docs/requirements/retries.md#3"];
  const initiative = await call("update_initiative", { projectRoot: realRoot, initiative: "retry-hardening", expectedRevision: null, actor: "orchestrator", operations: [
    { op: "create", slug: "retry-hardening", title: "Harden request retries", outcome: "Requests retry predictably within a total deadline.", requirements: retries }
  ] });
  await call("update_initiative", { projectRoot: realRoot, initiative: "retry-hardening", expectedRevision: initiative.revision, actor: "orchestrator", operations: [
    { op: "split", parent: "retry-hardening", children: [
      { slug: "timeout-retries", title: "Retry timed-out requests until a total deadline", outcome: "Timed-out requests retry until the total deadline elapses.", requirements: [retries[0]] },
      { slug: "connection-retries", title: "Retry dropped connections", outcome: "Dropped connections retry at most three times.", requirements: [retries[1]] },
      { slug: "retry-observability", title: "Observe retry behavior", outcome: "Operators see retry attempts and outcomes.", requirements: [retries[2]] }
    ] },
    { op: "split", parent: "retry-observability", children: [
      { slug: "retry-metrics", title: "Emit retry metrics", outcome: "Each attempt and outcome emits a metric.", requirements: [retries[2]] },
      { slug: "retry-dashboard", title: "Chart retries on the service dashboard", outcome: "The dashboard charts retry rates.", requirements: [retries[2]] }
    ] },
    { op: "set_dependencies", slug: "connection-retries", dependencies: ["timeout-retries"] },
    { op: "set_dependencies", slug: "retry-dashboard", dependencies: ["retry-metrics"] },
    { op: "set_status", slug: "timeout-retries", status: "in-progress" },
    { op: "set_status", slug: "retry-metrics", status: "in-progress" },
    { op: "set_status", slug: "connection-retries", status: "blocked" }
  ] });
  await call("update_initiative", { projectRoot: realRoot, initiative: "activity-reports", expectedRevision: null, actor: "orchestrator", operations: [
    { op: "create", slug: "activity-reports", title: "Export activity reports", outcome: "Users export signed activity reports.", requirements: ["docs/requirements/reports.md#1", "docs/requirements/reports.md#2"] },
    { op: "split", parent: "activity-reports", children: [
      { slug: "download", title: "Download signed reports", outcome: "A signed report downloads.", requirements: ["docs/requirements/reports.md#1"] },
      { slug: "authorize", title: "Authorize report access", outcome: "Only authorized users download reports.", requirements: ["docs/requirements/reports.md#2"] }
    ] },
    { op: "set_dependencies", slug: "download", dependencies: ["authorize"] }
  ] });
  // The shipped initiative's record is written directly because its completion gates need accepted reviews this demo cannot produce offline.
  await write("docs/plans/audit-log/initiative.json", `${JSON.stringify({ schemaVersion: 1, id: "audit-log", slices: { "audit-log": { title: "Record administrative actions", outcome: "Every administrative action is recorded.", status: "done", parent: null, requirements: ["docs/requirements/audit-log.md#1"], dependencies: [] } }, history: [] }, null, 2)}\n`);
  let roadmap = await call("update_roadmap", { projectRoot: realRoot, expectedRevision: null, actor: "roadmap", operations: [
    { op: "set_serves", serves: "Reliable retries and auditable reporting for the payments API" },
    { op: "add_initiative", id: "audit-log", title: "Audit administrative actions", intent: "Record every administrative action for compliance review.", pillar: "Compliance", band: "Now", requirements: ["docs/requirements/audit-log.md"] },
    { op: "add_initiative", id: "retry-hardening", title: "Harden request retries", intent: "Make retries predictable so callers never wait past a total deadline.", pillar: "Reliability", band: "Now", requirements: ["docs/requirements/retries.md"], rationale: "Retry storms caused the last two incidents, and reporting depends on stable calls." },
    { op: "add_initiative", id: "activity-reports", title: "Export activity reports", intent: "Let users export signed activity reports.", pillar: "Compliance", band: "Next", requirements: ["docs/requirements/reports.md"], requires: ["retry-hardening"], rationale: "Exports call the payments API in bursts and need bounded retries first." },
    { op: "add_initiative", id: "csv-exports", title: "CSV-only exports", intent: "Export raw activity as CSV files.", band: "Next" },
    { op: "add_initiative", id: "search-indexing", title: "Index activity for search", intent: "Find past activity by full-text search.", pillar: "Insight", band: "Later", requires: ["activity-reports"] },
    { op: "add_initiative", id: "legacy-exporter", title: "Retire the legacy exporter", intent: "Remove the nightly batch exporter.", band: "Parked", rationale: "Won't, this cycle: two customers still depend on it." },
    { op: "set_open_questions", questions: ["Should search indexing reuse the report export pipeline?", "Who owns the retry dashboard after launch?"] }
  ] });
  roadmap = await call("update_roadmap", { projectRoot: realRoot, expectedRevision: roadmap.revision, actor: "orchestrator", operations: [
    { op: "ship", id: "audit-log" },
    { op: "supersede", id: "csv-exports", by: "activity-reports", reason: "Signed reports cover the CSV use case." }
  ] });

  const state = await call("update_coordination_state", { projectRoot: realRoot, statePath, expectedRevision: null, changes: {
    settings: { autonomy: "broad", agentFlow: "multi", commit: "on", push: "off", continuation: "stepwise", models: "host defaults" },
    activeOperations: [{ op: "start", entry: { slice: "timeout-retries", activity: "review", label: "Design audit", workers: ["independent", "security"], workspace: realRoot, reviewPath, reviewLanes: [{ id: "main", reviewer: "independent" }, { id: "security", reviewer: "security" }] } }]
  } });
  // User gates are recorded exactly as the orchestrator records a question before asking it.
  await call("update_coordination_state", { projectRoot: realRoot, statePath, expectedRevision: state.revision, changes: {
    next: ["docs/plans/retry-hardening/connection-retries"],
    evidence: [`${slice}/slice.md`],
    gateOperations: [
      { op: "ask", kind: "visual-review", slice: "timeout-retries", question: "Review the change map and the total-deadline ADR before implementation starts.", artifacts: [deltaPath, "docs/ADRs/retries/total-retry-deadline.md", `${slice}/slice.md`] },
      { op: "ask", kind: "decision", slice: "connection-retries", question: "The design deletes the only handler that retries dropped connections (finding F2). Approve requirement 2 for this slice now, or drop connection retries until their slice starts?", artifacts: [reviewPath, "docs/requirements/retries.md"] }
    ]
  } });
  await call("update_coordination_state", { projectRoot: realRoot, statePath: "docs/plans/activity-reports/state.json", expectedRevision: null, changes: {
    settings: { autonomy: "conservative", agentFlow: "multi" },
    gateOperations: [{ op: "ask", kind: "decision", slice: "authorize", question: "Should a report download require a fresh login, or is an active session enough?", artifacts: ["docs/requirements/reports.md"], options: [{ id: "fresh-login", label: "Require a fresh login" }, { id: "active-session", label: "Accept the active session" }] }]
  } });

  process.stdout.write(`Demo project: ${realRoot}\nPrivate evidence: ${dataDir}\n\nStart the review browser with:\n  cd ${realRoot} && PLUGIN_DATA=${dataDir} ${path.join(ROOT, "bin/prism")} review\n`);
} finally {
  close();
}
