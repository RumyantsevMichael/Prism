import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, checked, entryOf, formatProject } from "./fixtures/artifact-formats.mjs";
import { apply, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";
import { mcp } from "./fixtures/shipped-work.mjs";

// No legacy marks: Attention counts every artifact that breaks its format, and each listed record carries the findings the review app marks it with.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-format-marks-data-")));
process.env.PLUGIN_DATA = privateData;
process.env.PRISM_REVIEW_APP_DIR = path.join(privateData, "app");
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const BROKEN = "# Old notes\n\nThe client retries.\n";
const OLD = "docs/requirements/old-a.md";
const PLAIN = "docs/ADRs/old/plain.md";

async function served(context, extra = {}) {
  const root = await formatProject(context, { ...CONFORMING, [OLD]: BROKEN, "docs/requirements/old-b.md": BROKEN, [PLAIN]: "# Plain decision\n\nWe retry.\n", ...extra });
  const { review, base, opened } = await startActionReview(context, root);
  const headers = await pageSession(review, opened);
  const attention = async () => (await get(base, "api/entity?ref=attention", headers)).json.data;
  const index = async () => (await get(base, "api/index", headers)).json.navigation;
  return { root, base, headers, attention, index };
}

test("clause 1: the review app offers no legacy action or target", async (context) => {
  const { base, headers } = await served(context);
  for (const target of ["artifacts:requirements", "legacy:legacy-0123456789abcdef"]) {
    const listed = await listing(base, target, headers);
    assert.notEqual(listed.status, 200, `${target} is no target: ${listed.text}`);
  }
  for (const action of ["artifacts.mark-legacy", "artifacts.remove-legacy"]) {
    const refused = await apply(base, { action, target: "artifacts:requirements", input: { paths: [OLD] }, revision: "x", confirmed: true }, headers);
    assert.notEqual(refused.status, 200, `${action} is refused`);
  }
});

test("clauses 2, 3: check_artifacts, Attention, and the citing refusal carry no legacy field, and Attention counts every nonconforming artifact", async (context) => {
  const { root, attention } = await served(context);
  const call = await mcp(context, root);
  const value = await checked(call);
  for (const artifact of value.artifacts) assert.equal(Object.hasOwn(artifact, "legacy"), false, artifact.path);
  const [requirements, adr] = (await attention()).formats;
  assert.equal(Object.hasOwn(requirements, "legacy"), false);
  assert.deepEqual([requirements.count, requirements.earlier, adr.count], [2, 0, 1]);
  for (const artifact of requirements.artifacts) assert.deepEqual(Object.keys(artifact).filter((key) => key !== "migration").sort(), ["earlierFormat", "findings", "path", "scope"]);
  const created = await call("update_initiative", { initiative: "notes", expectedRevision: null, operations: [{ op: "create", slug: "notes", title: "Notes", requirements: ["old-a.md§1"] }] });
  assert.equal(created.value?.code ?? created.error?.data?.code, "artifact_nonconforming", created.text);
  for (const artifact of created.value?.artifacts ?? created.error?.data?.artifacts ?? []) assert.equal(Object.hasOwn(artifact, "legacy"), false);
});

test("clause 4: a legacy-marks folder that an earlier build wrote changes no count", async (context) => {
  const marks = { id: "legacy-0123456789abcdef", type: "requirements", artifacts: [{ path: OLD, scope: null }], by: { name: "Ada", email: "ada@example.invalid", checkout: "x" }, at: "2026-11-16T10:00:00.000Z" };
  const { root, attention } = await served(context);
  await mkdir(path.join(root, ".prism/legacy-marks"), { recursive: true });
  await writeFile(path.join(root, ".prism/legacy-marks", `${marks.id}.json`), JSON.stringify(marks));
  const [requirements] = (await attention()).formats;
  assert.equal(requirements.count, 2, "the old mark hides nothing");
  assert.deepEqual(requirements.artifacts.map((artifact) => artifact.path), [OLD, "docs/requirements/old-b.md"]);
});

test("clause 5: each listed requirement and decision carries its format findings, and a conforming one carries null", async (context) => {
  const { root, index } = await served(context);
  const call = await mcp(context, root);
  const expected = entryOf(await checked(call, [OLD]), OLD);
  const entries = (await index()).index;
  const old = entries.find((entry) => entry.ref === OLD);
  assert.ok(old, `the index lists ${OLD}`);
  assert.deepEqual(old.format, { rules: [...new Set(expected.findings.map((finding) => finding.rule))].sort(), findings: expected.findings });
  assert.ok(entries.find((entry) => entry.ref === PLAIN)?.format?.rules.includes("adr.sections"));
  assert.equal(entries.find((entry) => entry.ref === PATHS.requirements)?.format, null, "a conforming requirement carries no findings");
  assert.equal(entries.find((entry) => entry.ref === PATHS.adr)?.format, null);
});
