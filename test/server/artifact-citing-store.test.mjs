import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, otherCheckout, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";

// Work that cites a nonconforming store artifact is refused with the artifact named by path and scope.

const OLD = "docs/requirements/old.md";
const SHARED = "docs/requirements/shared.md";
const OLD_ADR = "docs/ADRs/old/plain.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";

const initiative = async (call, operations, id = "retries") => {
  const current = await call("get_initiative", { initiative: id });
  return call("update_initiative", { initiative: id, expectedRevision: current.value?.revision ?? null, operations });
};

async function project(context) {
  const { place, root, call } = await storeProject(context, { ...CONFORMING, [OLD]: BROKEN, [SHARED]: BROKEN, [OLD_ADR]: "# Plain decision\n\nWe retry.\n" });
  await storeRead(call, OLD);
  const web = await otherCheckout(context, place);
  await storeWrite(web.call, SHARED, REQUIREMENT, { scope: "workspace" });
  return { root, call };
}

test("clauses 26, 56: a refusal names a nonconforming store artifact by path and scope and offers its migration in that scope", async (context) => {
  const { call } = await project(context);
  const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["old.md§1"] }]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  const [artifact] = refused.value.artifacts;
  assert.deepEqual([artifact.path, labelOf(artifact), artifact.type, artifact.legacy], [OLD, "api", "requirements", false]);
  assert.ok(artifact.findings.some((finding) => finding.rule === "requirements.header"));
  assert.match(refused.text, /Ask for a migration of docs\/requirements\/old\.md in scope api in a session of its own\./);
  assert.equal((await call("get_initiative", { initiative: "retries" })).value.exists, false, "nothing changed");
});

test("clause 56: a requirement reference cites every copy that a seen scope holds at its path", async (context) => {
  const { call } = await project(context);
  const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["shared.md§1"] }]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.deepEqual(refused.value.artifacts.map((entry) => [entry.path, labelOf(entry)]), [[SHARED, "api"]], "only the nonconforming copy is named");
});

test("clauses 25, 56: a design whose store slice.md links a nonconforming store ADR is refused, and one that links only conforming ones is accepted", async (context) => {
  const { root, call } = await project(context);
  const created = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["retries.md§1"] }]);
  assert.equal(created.value?.code ?? null, null, created.text);
  assert.equal((await initiative(call, [{ op: "claim", slug: "retries" }])).value?.code ?? null, null);
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "test/retries.test.mjs"), "import test from \"node:test\";\ntest(\"retries stop\", () => {});\n");
  const contract = (links) => `# Retries\n\n## Contract\n\n1. Retries stop at the deadline, as ${links} decide.\n\n## Changes\n\n- change \`src/retry.mjs\`: stop at the deadline (§1)\n`;
  const first = await storeWrite(call, "docs/plans/retries/slice.md", contract("[the plain decision](../../ADRs/old/plain.md) and [the deadline](../../ADRs/retries/total-retry-deadline.md)"));
  const propose = () => initiative(call, [{ op: "propose_design", slug: "retries", operations: [{ op: "accept_design", slug: "retries", frozenTests: ["test/retries.test.mjs"], review: "none", component: "api" }] }]);
  const refused = await propose();
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.deepEqual(refused.value.artifacts.map((entry) => [entry.path, labelOf(entry)]), [[OLD_ADR, "api"]]);
  await storeWrite(call, "docs/plans/retries/slice.md", contract("[the deadline](../../ADRs/retries/total-retry-deadline.md)"), { expectedVersion: first.version });
  const accepted = await propose();
  assert.equal(accepted.value?.code ?? null, null, accepted.text);
});
