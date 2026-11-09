import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { earlierShippedProject, finishedProject, mcp, readText, ship } from "./fixtures/shipped-work.mjs";
import { markDocument, unmarkedContent, writeHistoryMarks } from "../../dist/server/workflow/shipped-history.mjs";

// Edge cases of the history mark and of the first read that records an earlier ship.
const DOCUMENTS = ["docs/plans/reports/audit/slice.md", "docs/plans/reports/download/slice.md", "docs/plans/reports/slice.md"];
const mark = (date) => `> Shipped history: initiative \`reports\` shipped on ${date}, so this document records finished work.\n> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.`;

test("a document that is only a heading without a newline takes the mark under the heading and ships with no change", async (context) => {
  assert.equal(markDocument("# Title", "reports", "2026-11-03"), `# Title\n\n${mark("2026-11-03")}`);
  assert.equal(unmarkedContent(markDocument("# Title", "reports", "2026-11-03")), "# Title");
  assert.equal(unmarkedContent(markDocument("# Title\n", "reports", "2026-11-03")), "# Title\n");
  const setup = await finishedProject(context);
  await writeFile(path.join(setup.root, "docs/plans/reports/slice.md"), "# Reports");
  const shipped = await ship(setup.call, "reports");
  assert.equal(shipped.error, null);
  const date = shipped.value.record.initiatives[0].decision.at.slice(0, 10);
  assert.equal(await readText(setup.root, "docs/plans/reports/slice.md"), `# Reports\n\n${mark(date)}`);
  assert.deepEqual((await setup.call("get_initiative", { initiative: "reports" })).value.shippedHistory.changedAfterShip, []);
});

test("a mark never overwrites an edit made after the document was read", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-marks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const read = "# Title\n\nBody.\n";
  const documents = ["edited.md", "removed.md", "marked.md", "kept.md"].map((name) => ({ path: name, content: read, unmarked: read }));
  await writeFile(path.join(root, "edited.md"), "# Title\n\nAn edit.\n");
  await writeFile(path.join(root, "marked.md"), markDocument(read, "reports", "2026-11-03"));
  await writeFile(path.join(root, "kept.md"), read);
  const result = await writeHistoryMarks(root, "reports", { at: "2026-11-03T00:00:00.000Z" }, documents);
  assert.deepEqual(result.marked, ["kept.md"]);
  assert.deepEqual(result.problems.map((problem) => problem.path), ["edited.md", "removed.md"], "a document marked meanwhile is no problem");
  assert.equal(await readFile(path.join(root, "edited.md"), "utf8"), "# Title\n\nAn edit.\n");
  assert.equal(await readFile(path.join(root, "kept.md"), "utf8"), markDocument(read, "reports", "2026-11-03"));
});

test("every read of concurrent first reads lists the recorded documents", async (context) => {
  const { root, call } = await earlierShippedProject(context);
  const calls = [call, ...await Promise.all([1, 2, 3].map(() => mcp(context, root)))];
  const reads = await Promise.all(calls.map((each) => each("get_initiative", { initiative: "reports" })));
  for (const read of reads) {
    assert.deepEqual(read.value.shippedHistory.documents, DOCUMENTS);
    assert.deepEqual(read.value.shippedHistory.changedAfterShip, []);
  }
  assert.deepEqual(reads.flatMap((read) => read.value.shippedHistory.marked ?? []).sort(), DOCUMENTS, "exactly one read marks each document");
});
