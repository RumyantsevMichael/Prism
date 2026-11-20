import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING, FEATURE, PATHS, REQUIREMENT, write } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditProposal, readRun, runCheckout, runFor } from "./fixtures/format-migration-runs.mjs";

// Work that cites a nonconforming artifact is refused with the artifact, its broken rules, and the state of its format migration, and never offers a migration.

const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const initiative = async (call, operations, id = "retries") => {
  const current = await call("get_initiative", { initiative: id });
  return call("update_initiative", { initiative: id, expectedRevision: current.value?.revision ?? null, operations });
};
const cite = (call, reference) => initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: [reference] }]);

function refusedFor(result, file) {
  assert.equal(result.value?.code, "artifact_nonconforming", result.text);
  const artifact = result.value.artifacts.find((entry) => entry.path === file);
  assert.ok(artifact, `${file} is named: ${JSON.stringify(result.value.artifacts)}`);
  assert.deepEqual(Object.keys(artifact).sort(), ["findings", "migration", "path", "scope", "type"]);
  assert.doesNotMatch(result.text, /in a session of its own/);
  assert.doesNotMatch(result.text, /Ask for a migration/i);
  assert.match(result.text, new RegExp(`${escaped(file)}[^\\n]*breaks `));
  return artifact;
}

test("clauses 1, 2, 3: a refusal while Prism runs the migration names the run and says Prism is migrating it", async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const refused = await cite(call, "retries.md§1");
  const artifact = refusedFor(refused, PATHS.requirements);
  assert.match(artifact.migration?.run ?? "", /^run-[0-9a-f]{16}$/, "the citing check starts the set's run");
  assert.ok(["starting", "running", "continuing"].includes(artifact.migration.status), artifact.migration.status);
  assert.ok(artifact.findings.some((finding) => finding.rule === "requirements.numbering"));
  assert.match(refused.text, /requirements\.numbering/);
  assert.match(refused.text, new RegExp(`Prism is migrating it into its format in the run ${artifact.migration.run}\\.`));
  assert.equal((await call("get_initiative", { initiative: "retries" })).value.exists, false, "nothing changes");
});

test("clause 2: a refusal while the run waits for the person says it waits for answers on Attention", async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE });
  const run = await runFor(call, AUDIT);
  const bare = await call("propose_migration", auditProposal(run));
  assert.equal(bare.value?.code, "migration_unsettled", bare.text);
  const asked = bare.value.points.map((point) => ({ point, recommendation: "Leave it unknown until the team decides." }));
  assert.equal((await call("propose_migration", auditProposal(run, { asked }))).refused, false);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  assert.equal((await readRun(call, run)).status, "asking");
  const refused = await cite(call, "audit.md§1");
  const artifact = refusedFor(refused, AUDIT);
  assert.deepEqual([artifact.migration.run, artifact.migration.status], [run, "asking"]);
  assert.match(refused.text, new RegExp(`Its format migration ${run} waits for your answers on Attention\\.`));
});

test("clause 2: a refusal after the run failed gives its reason and says to run it again from Attention", async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await call("fail_migration_run", { run, reason: "The section numbers are ambiguous." })).refused, false);
  const refused = await cite(call, "retries.md§1");
  const artifact = refusedFor(refused, PATHS.requirements);
  assert.deepEqual([artifact.migration.run, artifact.migration.status], [run, "failed"]);
  assert.match(refused.text, new RegExp(`Its format migration ${run} failed: The section numbers are ambiguous\\. Run it again from Attention\\.`));
});

test("clause 2: a refusal while no host is available says the run waits for one", async (context) => {
  const { root, call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, { hosts: [] });
  const run = await runFor(call, PATHS.requirements);
  // The run's record is put in waiting-for-host directly, since launching a run, which sets it when no host is available, is migration-launch's work.
  const { setRunStatus } = await import("../../dist/server/workflow/migration-runs.mjs");
  await setRunStatus(root, run, "waiting-for-host", { reason: "No host is available on this machine: no host is installed." });
  assert.equal((await readRun(call, run)).status, "waiting-for-host");
  const refused = await cite(call, "retries.md§1");
  const artifact = refusedFor(refused, PATHS.requirements);
  assert.equal(artifact.migration.status, "waiting-for-host");
  assert.match(refused.text, new RegExp(`Its format migration ${run} waits for an available host\\.`));
});

test("clause 2: a design whose frozen test is a nonconforming feature file says Prism does not migrate feature files", async (context) => {
  const { root, call } = await runCheckout(context, CONFORMING);
  assert.equal((await cite(call, "retries.md§1")).error, null);
  assert.equal((await initiative(call, [{ op: "claim", slug: "retries" }])).error, null);
  await write(root, "test/retries.test.mjs", "import test from \"node:test\";\ntest(\"retries stop\", () => {});\n");
  await write(root, "docs/plans/retries/slice.md", "# Retries\n\n## Contract\n\n1. Retries stop at the deadline.\n\n## Changes\n\n- change `src/retry.mjs`: stop at the deadline (§1)\n");
  const broken = "docs/Features/F-broken.feature";
  await write(root, broken, FEATURE.replace("Feature: Request retries", "Capability: Request retries"));
  const refused = await initiative(call, [{ op: "propose_design", slug: "retries", operations: [{ op: "accept_design", slug: "retries", frozenTests: ["test/retries.test.mjs", broken], review: "none" }] }]);
  const artifact = refusedFor(refused, broken);
  assert.equal(artifact.migration, null);
  assert.match(refused.text, /Prism does not migrate feature files, so bring it into its format in a change of its own\./);
});

test("clause 5: an unknown value refuses work that cites an Approved requirement file, and none that cites a Draft", async (context) => {
  const approved = "docs/requirements/partial.md";
  const draft = "docs/requirements/sketch.md";
  const sketch = REQUIREMENT.replace("# Request retries", "# Sketch").replace("Status: Approved", "Status: Draft").replace("Approved: 2026-09-04", "Approved: n/a").replace("Rationale: A request that retries forever holds a connection that other requests need.", "Rationale: unknown");
  const { call } = await runCheckout(context, { ...CONFORMING, [approved]: REQUIREMENT.replace("# Request retries", "# Partial retries").replace("Created: 2026-09-02", "Created: unknown"), [draft]: sketch });
  const refused = await cite(call, "partial.md§1");
  const artifact = refusedFor(refused, approved);
  assert.deepEqual([...new Set(artifact.findings.map((finding) => finding.rule))], ["requirements.unknown"]);
  assert.match(refused.text, /requirements\.unknown/);
  assert.equal((await call("get_initiative", { initiative: "retries" })).value.exists, false, "nothing changes");
  const cited = await cite(call, "sketch.md§1");
  assert.equal(cited.value?.code ?? null, null, cited.text);
});
