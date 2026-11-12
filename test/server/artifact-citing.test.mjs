import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, FEATURE, PATHS, formatServer, read, write } from "./fixtures/artifact-formats.mjs";

// Work that cites a nonconforming artifact is refused, whole, with the artifact, its broken rules, and an offer of migration.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-citing-data-")));
process.env.PLUGIN_DATA = privateData;
process.env.PRISM_REVIEW_APP_DIR = path.join(privateData, "app");
delete process.env.CLAUDE_PLUGIN_DATA;
const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const OLD = "docs/requirements/old.md";
const OLD_ADR = "docs/ADRs/old/plain.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";
const FILES = { ...CONFORMING, [OLD]: BROKEN, [OLD_ADR]: "# Plain decision\n\nWe retry.\n" };

const initiative = async (call, operations, id = "retries") => {
  const current = await call("get_initiative", { initiative: id });
  return call("update_initiative", { initiative: id, expectedRevision: current.value?.revision ?? null, operations });
};
const roadmap = async (call, operations) => {
  const current = await call("get_roadmap");
  return call("update_roadmap", { expectedRevision: current.value?.revision ?? null, operations });
};

function assertRefused(result, file, rule) {
  assert.equal(result.value?.code, "artifact_nonconforming", result.text);
  const artifact = result.value.artifacts.find((entry) => entry.path === file);
  assert.ok(artifact, `${file} is named`);
  assert.equal(typeof artifact.type, "string");
  assert.equal(typeof artifact.legacy, "boolean");
  assert.ok(artifact.findings.some((finding) => finding.rule === rule), rule);
  assert.match(result.text, new RegExp(file.replace(/[./]/g, "\\$&")));
  assert.match(result.text, new RegExp(rule.replace(/\./g, "\\.")));
  assert.match(result.text, new RegExp(`Ask for a migration of ${file.replace(/[./]/g, "\\$&")} in a session of its own\\.`));
}

test("clauses 24, 26: creating an initiative that cites a nonconforming requirement is refused and changes nothing", async (context) => {
  const { call } = await formatServer(context, FILES);
  const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["old.md§1", "retries.md§1"] }]);
  assertRefused(refused, OLD, "requirements.header");
  assert.equal((await call("get_initiative", { initiative: "retries" })).value.exists, false);
  const created = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["retries.md§1"] }]);
  assert.equal(created.error, null, created.text);
  assert.equal(created.result?.isError ?? false, false, created.text);
});

test("clause 24: splitting with a part that cites a nonconforming requirement is refused", async (context) => {
  const { call } = await formatServer(context, FILES);
  assert.equal((await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["retries.md§1"] }])).error, null);
  const refused = await initiative(call, [{ op: "split", parent: "retries", evidence: { kind: "user_gate", gate: "gate-00000000" }, children: [{ slug: "deadline", title: "Deadline", requirements: ["retries.md§1"] }, { slug: "old", title: "Old", requirements: ["old.md§1"] }] }]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
});

test("clause 24: adding or updating a roadmap entry that cites a nonconforming requirement is refused", async (context) => {
  const { call } = await formatServer(context, FILES);
  assertRefused(await roadmap(call, [{ op: "add_initiative", id: "retries", title: "Retries", intent: "Bounded retries.", band: "Now", requirements: ["old.md§1"] }]), OLD, "requirements.header");
  assert.equal((await roadmap(call, [{ op: "add_initiative", id: "retries", title: "Retries", intent: "Bounded retries.", band: "Now", requirements: ["retries.md§1"] }])).value?.code ?? null, null);
  assertRefused(await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: ["retries.md§1", "old.md§1"] }]), OLD, "requirements.header");
});

test("clauses 25, 26: a design whose slice.md links a nonconforming ADR, or whose frozen test is a nonconforming feature, is refused", async (context) => {
  const { root, call } = await formatServer(context, FILES);
  assert.equal((await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["retries.md§1"] }])).error, null);
  assert.equal((await initiative(call, [{ op: "claim", slug: "retries" }])).error, null);
  await write(root, "test/retries.test.mjs", "import test from \"node:test\";\ntest(\"retries stop\", () => {});\n");
  const contract = (links) => `# Retries\n\n## Contract\n\n1. Retries stop at the deadline, as ${links} decide.\n\n## Changes\n\n- change \`src/retry.mjs\`: stop at the deadline (§1)\n`;
  await write(root, "docs/plans/retries/slice.md", contract(`[the plain decision](../../ADRs/old/plain.md) and [the deadline](../../ADRs/retries/total-retry-deadline.md)`));
  const propose = (frozenTests) => initiative(call, [{ op: "propose_design", slug: "retries", operations: [{ op: "accept_design", slug: "retries", frozenTests, review: "none" }] }]);
  assertRefused(await propose(["test/retries.test.mjs"]), OLD_ADR, "adr.sections");
  await write(root, "docs/plans/retries/slice.md", contract("[the deadline](../../ADRs/retries/total-retry-deadline.md)"));
  await write(root, "docs/Features/F-broken.feature", FEATURE.replace("Feature: Request retries", "Capability: Request retries"));
  assertRefused(await propose(["test/retries.test.mjs", "docs/Features/F-broken.feature"]), "docs/Features/F-broken.feature", "feature.header");
  const accepted = await propose(["test/retries.test.mjs", PATHS.feature]);
  assert.equal(accepted.value?.code ?? null, null, accepted.text);
});

test("clause 26: a legacy mark does not let work cite the artifact", async (context) => {
  const { root, call } = await formatServer(context, FILES);
  const listed = await listActions({ projectRoot: root, target: "artifacts:requirements" });
  const mark = listed.actions.find((action) => action.id === "artifacts.mark-legacy");
  await applyAction({ projectRoot: root, target: "artifacts:requirements", action: "artifacts.mark-legacy", input: { paths: [OLD] }, revision: mark.revision, confirmed: true });
  const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["old.md§1"] }]);
  assertRefused(refused, OLD, "requirements.header");
  assert.equal(refused.value.artifacts.find((entry) => entry.path === OLD).legacy, true);
});

test("clause 27: a missing requirement file and an unknown value do not refuse, and a record that already cites a nonconforming file still loads", async (context) => {
  const { root, call } = await formatServer(context, { ...FILES, "docs/requirements/partial.md": CONFORMING[PATHS.requirements].replace("Created: 2026-09-02", "Created: unknown") });
  const created = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["gone.md§1", "partial.md§1"] }]);
  assert.equal(created.value?.code ?? null, null, created.text);
  const record = JSON.parse(await read(root, ".prism/initiatives/retries/initiative.json"));
  record.slices.retries.requirements.push("docs/requirements/old.md#1");
  await write(root, ".prism/initiatives/retries/initiative.json", `${JSON.stringify(record, null, 2)}\n`);
  const loaded = await call("get_initiative", { initiative: "retries" });
  assert.equal(loaded.value.valid, true, loaded.text);
  assert.equal((await initiative(call, [{ op: "update_slice", slug: "retries", title: "Bounded retries" }])).value?.code ?? null, null, "an operation that adds no citation is not refused");
});
