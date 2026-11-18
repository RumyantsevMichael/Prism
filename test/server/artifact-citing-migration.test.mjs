import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING, FEATURE, PATHS, REQUIREMENT, write } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditProposal, listedTools, readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";

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
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, { hosts: [] });
  const run = await runFor(call, PATHS.requirements);
  await waitFor(async () => (await readRun(call, run)).status === "waiting-for-host" || null, { what: "the run waiting for a host" });
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

test("clause 4: the update_initiative and update_roadmap descriptions name the migration's state and never legacy marks or asking for a migration", async (context) => {
  const { root } = await runCheckout(context, CONFORMING);
  const tools = await listedTools(context, root);
  for (const name of ["update_initiative", "update_roadmap"]) {
    const description = tools[name]?.description ?? "";
    assert.match(description, /artifact_nonconforming/, name);
    assert.match(description, /state of (its|each artifact's) (format )?migration/i, name);
    assert.doesNotMatch(description, /legacy/i, name);
    assert.doesNotMatch(description, /ask for a migration|in a session of its own/i, name);
  }
});
