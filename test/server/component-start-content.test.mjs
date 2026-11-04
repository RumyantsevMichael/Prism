import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { THREE, componentProject, planAndAccept, read, update, write } from "./fixtures/components.mjs";

// The start content a slice with a component records, and how verification reports the changes that leave its component.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-start-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verificationBrief } = await import("../../dist/server/workflow/verification.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

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
