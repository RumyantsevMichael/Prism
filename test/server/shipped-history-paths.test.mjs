import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { earlierShippedProject, recordFile } from "./fixtures/shipped-work.mjs";

// A slice key or a recorded document path comes from a record the shared store may hold, so neither leads a read or a mark outside the plans folder.

async function outsideFile(context, root) {
  const outside = `${root}-outside`;
  await mkdir(outside, { recursive: true });
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "slice.md"), "# Outside\n");
  return { outside, relative: `docs/plans/reports/../../../../${path.basename(root)}-outside/slice.md` };
}

test("a slice key outside the slug pattern names no document and the file it points at stays unchanged", async (context) => {
  const setup = await earlierShippedProject(context);
  const record = JSON.parse(await readFile(recordFile(setup.root, "reports"), "utf8"));
  record.slices[`../../../../${path.basename(setup.root)}-outside`] = { ...record.slices.download };
  await writeFile(recordFile(setup.root, "reports"), JSON.stringify(record, null, 2));
  const { outside } = await outsideFile(context, setup.root);
  const read = await setup.call("get_initiative", { initiative: "reports" });
  const history = read.value.shippedHistory;
  assert.equal(await readFile(path.join(outside, "slice.md"), "utf8"), "# Outside\n");
  assert.deepEqual(history.documents, setup.documents);
  assert.deepEqual(history.marked, setup.documents);
  assert.ok(!JSON.stringify(history).includes("outside"));
});

test("a recorded document path outside the plans folder is neither read nor reported", async (context) => {
  const setup = await earlierShippedProject(context);
  const { relative } = await outsideFile(context, setup.root);
  const roadmapPath = path.join(setup.root, ".prism/roadmap.json");
  const roadmap = JSON.parse(await readFile(roadmapPath, "utf8"));
  roadmap.initiatives[0].decision = { ...roadmap.initiatives[0].decision, documents: [{ path: relative, sha256: "0".repeat(64) }, { path: "/etc/hostname", sha256: "0".repeat(64) }], documentsRecordedAt: roadmap.initiatives[0].decision.at, documentsFrom: "ship" };
  await writeFile(roadmapPath, `${JSON.stringify(roadmap, null, 2)}\n`);
  const read = await setup.call("get_initiative", { initiative: "reports" });
  const history = read.value.shippedHistory;
  assert.deepEqual(history.documents, []);
  assert.deepEqual(history.changedAfterShip.map((item) => item.path), setup.documents);
  assert.ok(history.changedAfterShip.every((item) => item.change === "added"));
});
