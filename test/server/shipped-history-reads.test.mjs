import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { addEntries, earlierShippedProject, finished, finishedProject, readText, ship, shippedProject } from "./fixtures/shipped-work.mjs";

// Ship marks slice documents as history, and every read of a shipped initiative, also one that shipped earlier, says so.
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const original = (title) => `# ${title}\n\n## Outcome\n\n${title} works.\n`;
const mark = (initiative, date) => `> Shipped history: initiative \`${initiative}\` shipped on ${date}, so this document records finished work.\n> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.\n`;
const marked = (title, initiative, date) => `# ${title}\n\n${mark(initiative, date)}\n## Outcome\n\n${title} works.\n`;
const message = (initiative, date) => `Initiative ${initiative} shipped on ${date} and its state is history: take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite this initiative only as history.`;
const decisionOf = async (call, id) => (await call("get_roadmap")).value.record.initiatives.find((item) => item.id === id).decision;
const DOCUMENTS = ["docs/plans/reports/audit/slice.md", "docs/plans/reports/download/slice.md", "docs/plans/reports/slice.md"];

test("§5 get_initiative, get_coordination_state, and get_review of a shipped initiative report shipped history", async (context) => {
  const { call, shippedAt } = await shippedProject(context);
  await addEntries(call, [{ id: "later" }]);
  for (const [name, args] of [["get_initiative", {}], ["get_coordination_state", {}], ["get_review", { slice: "download" }]]) {
    const read = await call(name, { initiative: "reports", ...args });
    assert.equal(read.error, null, name);
    assert.equal(read.value.shippedHistory?.initiative, "reports", name);
    assert.equal(read.value.shippedHistory.shippedAt, shippedAt, name);
    assert.ok(Array.isArray(read.value.shippedHistory.documents), name);
    assert.ok(Array.isArray(read.value.shippedHistory.changedAfterShip), name);
  }
  const unshipped = await call("get_initiative", { initiative: "later" });
  assert.equal(Object.hasOwn(unshipped.value, "shippedHistory"), false, "an initiative that has not shipped carries no field");
  assert.equal(Object.hasOwn((await call("get_coordination_state", { initiative: "later" })).value, "shippedHistory"), false);
});

test("§5 a shipped initiative without an initiative record still reports shipped history", async (context) => {
  const { call, shippedAt } = await earlierShippedProject(context, "reports", finished(), { record: false, documents: false });
  const read = await call("get_initiative", { initiative: "reports" });
  assert.equal(read.value.exists, false);
  assert.equal(read.value.shippedHistory.shippedAt, shippedAt);
  assert.deepEqual(read.value.shippedHistory.documents, []);
  assert.deepEqual(read.value.shippedHistory.changedAfterShip, []);
  assert.equal((await call("get_coordination_state", { initiative: "reports" })).value.shippedHistory.shippedAt, shippedAt);
});

test("§6 the message says the state is history, and get_coordination_state shows it in its text", async (context) => {
  const { call, shippedAt } = await shippedProject(context);
  const date = shippedAt.slice(0, 10);
  assert.equal((await call("get_initiative", { initiative: "reports" })).value.shippedHistory.message, message("reports", date));
  const state = await call("get_coordination_state", { initiative: "reports" });
  assert.equal(state.value.shippedHistory.message, message("reports", date));
  assert.ok(state.text.split("\n").includes(message("reports", date)), "the text content carries the message as a line");
});

test("§7 documents lists the recorded slice documents in path order", async (context) => {
  const { call } = await shippedProject(context);
  assert.deepEqual((await call("get_initiative", { initiative: "reports" })).value.shippedHistory.documents, DOCUMENTS);
});

test("§8 changedAfterShip names changed, removed, and added slice documents and ignores the history mark", async (context) => {
  const setup = await finishedProject(context);
  await rm(path.join(setup.root, "docs/plans/reports/audit/slice.md"));
  const shipped = await ship(setup.call, "reports");
  assert.equal(shipped.error, null);
  const date = shipped.value.record.initiatives[0].decision.at.slice(0, 10);
  let read = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(read.value.shippedHistory.changedAfterShip, [], "nothing differs right after ship");
  assert.deepEqual(read.value.shippedHistory.documents, ["docs/plans/reports/download/slice.md", "docs/plans/reports/slice.md"]);
  // The mark alone is not a change, so a copy without it, as on a branch before the ship commit, is the shipped content.
  await writeFile(path.join(setup.root, "docs/plans/reports/slice.md"), original("Reports"));
  read = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(read.value.shippedHistory.changedAfterShip, []);
  await writeFile(path.join(setup.root, "docs/plans/reports/download/slice.md"), `${marked("Download reports", "reports", date)}A later edit.\n`);
  await rm(path.join(setup.root, "docs/plans/reports/slice.md"));
  await mkdir(path.join(setup.root, "docs/plans/reports/audit"), { recursive: true });
  await writeFile(path.join(setup.root, "docs/plans/reports/audit/slice.md"), original("Audit downloads"));
  read = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(read.value.shippedHistory.changedAfterShip, [
    { path: "docs/plans/reports/audit/slice.md", change: "added" },
    { path: "docs/plans/reports/download/slice.md", change: "changed" },
    { path: "docs/plans/reports/slice.md", change: "removed" }
  ]);
  assert.deepEqual((await setup.call("get_review", { initiative: "reports", slice: "audit" })).value.shippedHistory.changedAfterShip.map((item) => item.change), ["added", "changed", "removed"]);
});

test("§9 get_roadmap returns the recorded documents with their content digests without the mark", async (context) => {
  const { call } = await shippedProject(context);
  const decision = await decisionOf(call, "reports");
  assert.equal(decision.documentsFrom, "ship");
  assert.ok(!Number.isNaN(Date.parse(decision.documentsRecordedAt)));
  assert.deepEqual(decision.documents, [
    { path: "docs/plans/reports/audit/slice.md", sha256: sha256(original("Audit downloads")) },
    { path: "docs/plans/reports/download/slice.md", sha256: sha256(original("Download reports")) },
    { path: "docs/plans/reports/slice.md", sha256: sha256(original("Reports")) }
  ]);
});

test("§10 ship marks every slice document, lists the marks, and reports a document it cannot read", async (context) => {
  const setup = await finishedProject(context);
  await rm(path.join(setup.root, "docs/plans/reports/audit/slice.md"));
  await mkdir(path.join(setup.root, "docs/plans/reports/audit/slice.md"));
  const shipped = await ship(setup.call, "reports");
  assert.equal(shipped.error, null, "ship succeeds although a document cannot be marked");
  const date = shipped.value.record.initiatives[0].decision.at.slice(0, 10);
  assert.deepEqual(shipped.value.historyMarks, ["docs/plans/reports/download/slice.md", "docs/plans/reports/slice.md"]);
  assert.deepEqual(shipped.value.historyMarkProblems.map((item) => item.path), ["docs/plans/reports/audit/slice.md"]);
  assert.equal(typeof shipped.value.historyMarkProblems[0].reason, "string");
  assert.equal(await readText(setup.root, "docs/plans/reports/slice.md"), marked("Reports", "reports", date));
  assert.equal(await readText(setup.root, "docs/plans/reports/download/slice.md"), marked("Download reports", "reports", date));
});

test("§11 the mark sits under the title, and a document that holds one is not marked again", async (context) => {
  const setup = await earlierShippedProject(context);
  const date = setup.shippedAt.slice(0, 10);
  await writeFile(path.join(setup.root, "docs/plans/reports/download/slice.md"), marked("Download reports", "reports", date));
  await writeFile(path.join(setup.root, "docs/plans/reports/slice.md"), "Notes without a title.\n");
  const read = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(read.value.shippedHistory.marked, ["docs/plans/reports/audit/slice.md", "docs/plans/reports/slice.md"]);
  assert.equal(await readText(setup.root, "docs/plans/reports/download/slice.md"), marked("Download reports", "reports", date), "an existing mark stays single");
  assert.equal(await readText(setup.root, "docs/plans/reports/audit/slice.md"), marked("Audit downloads", "reports", date));
  assert.equal(await readText(setup.root, "docs/plans/reports/slice.md"), `${mark("reports", date)}\nNotes without a title.\n`, "without a title the mark goes first");
  const decision = await decisionOf(setup.call, "reports");
  assert.equal(decision.documents.find((item) => item.path === "docs/plans/reports/slice.md").sha256, sha256("Notes without a title.\n"));
  assert.equal(decision.documents.find((item) => item.path === "docs/plans/reports/download/slice.md").sha256, sha256(original("Download reports")));
});

test("§12 the first read of an initiative shipped earlier records its documents, marks them, and asks to commit them", async (context) => {
  const setup = await earlierShippedProject(context);
  const date = setup.shippedAt.slice(0, 10);
  const first = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(first.value.shippedHistory.marked, DOCUMENTS);
  assert.deepEqual(first.value.shippedHistory.documents, DOCUMENTS);
  assert.ok(first.result.content.some((item) => /commit/i.test(item.text ?? "") && item.text.includes("docs/plans/reports/slice.md")), "a text line asks to commit the marks");
  for (const [file, title] of [["docs/plans/reports/slice.md", "Reports"], ["docs/plans/reports/download/slice.md", "Download reports"], ["docs/plans/reports/audit/slice.md", "Audit downloads"]]) {
    assert.equal(await readText(setup.root, file), marked(title, "reports", date));
  }
  const decision = await decisionOf(setup.call, "reports");
  assert.equal(decision.documentsFrom, "first-read");
  assert.equal(decision.at, setup.shippedAt, "the ship time stays as recorded");
  assert.equal(decision.documents.length, 3);
  const second = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(second.value.shippedHistory.marked ?? [], [], "a later read marks nothing");
  assert.deepEqual(second.value.shippedHistory.changedAfterShip, []);
});

test("§12 a read through get_roadmap or get_coordination_state also records an earlier ship", async (context) => {
  const setup = await earlierShippedProject(context);
  await setup.call("get_roadmap");
  assert.equal((await decisionOf(setup.call, "reports")).documentsFrom, "first-read");
  const other = await earlierShippedProject(context);
  const state = await other.call("get_coordination_state", { initiative: "reports" });
  assert.deepEqual(state.value.shippedHistory.marked, DOCUMENTS);
});

test("§12 an earlier ship without slice documents in this checkout records nothing", async (context) => {
  const setup = await earlierShippedProject(context, "reports", finished(), { documents: false });
  const read = await setup.call("get_initiative", { initiative: "reports" });
  assert.deepEqual(read.value.shippedHistory.documents, []);
  assert.deepEqual(read.value.shippedHistory.changedAfterShip, []);
  assert.equal(Object.hasOwn(await decisionOf(setup.call, "reports"), "documents"), false);
});
