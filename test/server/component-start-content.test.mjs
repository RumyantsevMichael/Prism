import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, THREE, componentProject, git, planAndAccept, read, update, write } from "./fixtures/components.mjs";

// The start content a slice with a component records, and how verification reports the changes that leave its component.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-start-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verificationBrief, verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

// The prefix of a slice's local refs in this checkout, named by the project root's real path.
const checkoutRefs = async (root, slug) => `refs/prism/${INITIATIVE}/${slug}/${createHash("sha256").update(await realpath(root)).digest("hex").slice(0, 16)}/`;

const designOf = async (root, slug) => {
  const current = await read(root);
  return JSON.parse(await readFile(path.join(root, current.recordPath), "utf8")).slices[slug].design;
};

test("a started slice keeps its start content across a new design and drops it when it returns to not-started", async (context) => {
  const root = await componentProject(context);
  await planAndAccept(root, THREE);
  assert.equal((await designOf(root, "billing-totals")).startTree, undefined, "a staged design records no start content");
  await update(root, [{ op: "set_status", slug: "billing-totals", status: "in-progress" }]);
  const started = (await designOf(root, "billing-totals")).startTree;
  assert.match(started, /^[0-9a-f]{40,64}$/);

  await write(root, { "packages/billing/index.mjs": "export const total = 5;\n" });
  await update(root, [{ op: "set_status", slug: "billing-totals", status: "in-progress" }]);
  assert.equal((await designOf(root, "billing-totals")).startTree, started, "a slice already in progress keeps the content it started from");
  await update(root, [{ op: "accept_design", slug: "billing-totals", component: "billing", frozenTests: ["packages/billing/test/billing.test.mjs"], review: "none" }]);
  assert.equal((await designOf(root, "billing-totals")).startTree, started, "a new design of a started slice keeps its start content");

  await write(root, { "packages/billing/index.mjs": "export const total = 1;\n" });
  await update(root, [{ op: "set_status", slug: "billing-totals", status: "not-started" }]);
  assert.equal((await designOf(root, "billing-totals")).startTree, undefined, "a slice back at not-started drops its start content");
});

test("the brief result of a run that left its component keeps the crossing paths, the folder, the component, and the boundary", () => {
  const brief = verificationBrief({ status: "failed", reason: "component_boundary", message: "left", crossing: ["README.md"], crossingCount: 1, folder: "packages/billing", component: "root/billing", boundary: "checked", durationMs: 0, path: "run.json", outputTail: "" });
  assert.deepEqual([brief.crossing, brief.crossingCount, brief.folder, brief.component, brief.boundary], [["README.md"], 1, "packages/billing", "root/billing", "checked"]);
  const legacy = verificationBrief({ status: "passed", folder: "", durationMs: 0, path: "run.json" });
  assert.equal(legacy.folder, "");
  assert.equal(Object.hasOwn(legacy, "component"), false);
  assert.equal(Object.hasOwn(legacy, "boundary"), false);
});

test("a started slice records its start time and declaration, and keeps its start and latest passing content under its refs", async (context) => {
  const root = await componentProject(context);
  await planAndAccept(root, THREE);
  await update(root, [{ op: "set_status", slug: "billing-totals", status: "in-progress" }]);
  const design = await designOf(root, "billing-totals");
  assert.ok(!Number.isNaN(Date.parse(design.startRecordedAt)));
  assert.deepEqual(design.startDeclaration, { root: "root/root", sharedPaths: ["package-lock.json", "config/shared"], components: [{ component: "root/billing", folder: "packages/billing" }, { component: "root/shared", folder: "packages/shared" }, { component: "root/web", folder: "apps/web" }, { component: "root/docs", folder: "handbook" }] });
  const prefix = await checkoutRefs(root, "billing-totals");
  const refs = () => git(root, "for-each-ref", "--format=%(refname) %(objectname)", `refs/prism/${INITIATIVE}/billing-totals/`).split("\n").filter(Boolean);
  assert.deepEqual(refs(), [`${prefix}start ${design.startTree}`]);

  const verify = (extra = {}) => verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "billing-totals", ...extra });
  const asked = await verify();
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  const passed = await verify({ approvalGate: asked.gateId });
  assert.equal(passed.status, "passed", passed.outputTail);
  assert.deepEqual(refs().sort(), [`${prefix}passed ${passed.tree}`, `${prefix}start ${design.startTree}`]);
});

test("a component folder named like a parent folder but inside the project is not outside it", async (context) => {
  const { command, workflow } = await import("./fixtures/components.mjs");
  const root = await componentProject(context, { config: workflow({ components: `## Components\n- dots: ..dots\n  - Test command: ${command("dots", 1)}\n- Shared paths: tests\n` }), files: { "..dots/index.mjs": "export {};\n", "tests/dots.test.mjs": "// frozen dots test\n" }, requirements: ["r.md#1"] });
  await planAndAccept(root, [{ slug: "billing-totals", component: "dots", requirement: "r.md#1", changes: ["change `..dots/index.mjs`: dots (§1)"], tests: ["tests/dots.test.mjs"] }]);
  await update(root, [{ op: "set_status", slug: "billing-totals", status: "in-progress" }]);
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "billing-totals" });
  assert.equal(asked.status, "approval_needed");
  assert.equal(asked.folder, "..dots");
});
