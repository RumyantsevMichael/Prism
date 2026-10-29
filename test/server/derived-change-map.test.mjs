import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-derive-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
const { deriveSliceChangeMap, diffUnits } = await import("../../dist/server/conservation/derived-change-map.mjs");
const { getChangeMap, updateChangeMap } = await import("../../dist/server/conservation/change-map.mjs");
const { CHUNKER_VERSION } = await import("../../dist/native-runtime/versions.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const SLICE = "reports";
const node = process.execPath;
const digest = (text) => createHash("sha256").update(text).digest("hex");

// A parser stand-in: every `function name() { ... }` in a .ts file is one code unit.
const runtime = {
  prepare: async (source) => {
    const snapshot = await source.snapshot();
    const units = [];
    for (const file of snapshot.files) {
      if (!file.file.endsWith(".ts")) continue;
      for (const match of file.content.matchAll(/function (\w+)\(\) \{[^}]*\}/g)) {
        units.push({ id: `${file.file}#${match[1]}`, file: file.file, domain: "code", kind: "function", name: match[1], selector: match[1], span: { start: match.index, end: match.index + match[0].length }, sourceHash: file.hash, contentHash: digest(match[0]), isExported: false });
      }
    }
    return { status: "ready", prepared: { modelIdentity: "fixture", index: { chunkerVersion: CHUNKER_VERSION, units, fileCoverage: Object.fromEntries(snapshot.files.map((file) => [file.file, true])), diagnostics: [], tokenCounts: {}, structureCounts: {} } } };
  }
};

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-derive-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${node} check.mjs\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "src", "report.ts"), "function render() { return 1; }\nfunction legacy() { return 2; }\n");
  await writeFile(path.join(root, "src", "notes.txt"), "first\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: SLICE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  return root;
}

async function acceptAndVerify(root) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  const accepted = await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "set_status", slug: SLICE, status: "in-progress" }, { op: "accept_design", slug: SLICE, frozenTests: ["test/acceptance.test.mjs"], review: "none" }] });
  return accepted.record.slices[SLICE].design;
}

async function verify(root) {
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: SLICE });
  if (asked.status !== "approval_needed") return asked;
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  return verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: SLICE, approvalGate: asked.gateId });
}

test("accepting a design keeps a baseline snapshot, and a passing run keeps the verified source", async (context) => {
  const root = await project(context);
  const design = await acceptAndVerify(root);
  assert.match(design.baselineId, /^[0-9a-f]{64}$/);
  const run = await verify(root);
  assert.equal(run.status, "passed");
  assert.match(run.snapshotId, /^[0-9a-f]{64}$/);
});

test("the derived change map lists added, changed, and removed units and changed files without units", async (context) => {
  const root = await project(context);
  await acceptAndVerify(root);
  await writeFile(path.join(root, "src", "report.ts"), "function render() { return 10; }\nfunction sign() { return 3; }\n");
  await writeFile(path.join(root, "src", "notes.txt"), "second\n");
  await writeFile(path.join(root, "src", "extra.ts"), "function helper() { return 4; }\n");
  const run = await verify(root);
  assert.equal(run.status, "passed");

  const result = await deriveSliceChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE }, { runtime });
  assert.equal(result.status, "written");
  const map = await getChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE });
  assert.equal(map.valid, true);
  assert.equal(map.ready, true);
  assert.equal(map.derived.runId, run.id);
  const byLabel = Object.fromEntries(map.concepts.map((entry) => [entry.label, entry]));
  assert.equal(byLabel.render.action, "MODIFY");
  assert.deepEqual(byLabel.render.after, [{ path: "src/report.ts", selector: { type: "symbol", value: "render" } }]);
  assert.equal(byLabel.sign.action, "ADD");
  assert.equal(byLabel.legacy.action, "DELETE");
  assert.equal(byLabel.helper.action, "ADD");
  assert.equal(byLabel["src/notes.txt"].action, "MODIFY");
  assert.equal(byLabel["src/notes.txt"].reason, "Changed: 1 line, 1 before.");
  assert.equal(byLabel["src/report.ts"], undefined, "a file with listed units is not listed itself");
  assert.equal(byLabel["src/extra.ts"], undefined);

  assert.equal((await deriveSliceChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE }, { runtime })).status, "current");
  await assert.rejects(updateChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE, expectedRevision: map.revision, operations: [{ op: "remove", id: byLabel.sign.id }] }), /derived from the slice's verified result/);
});

test("without a parser the derived change map falls back to files", async (context) => {
  const root = await project(context);
  await acceptAndVerify(root);
  await writeFile(path.join(root, "src", "report.ts"), "function render() { return 10; }\n");
  await unlink(path.join(root, "src", "notes.txt"));
  await verify(root);
  const degraded = { prepare: async () => ({ status: "degraded", diagnostics: [{ code: "unsupported_runtime", message: "Test without a parser" }] }) };
  const result = await deriveSliceChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE }, { runtime: degraded });
  assert.equal(result.status, "written");
  assert.equal(result.structured, false);
  const map = await getChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE });
  assert.deepEqual(map.concepts.map((entry) => [entry.label, entry.action]).sort(), [["src/notes.txt", "DELETE"], ["src/report.ts", "MODIFY"]]);
});

test("a change map an agent wrote is never replaced, and a slice without a passing run has none", async (context) => {
  const root = await project(context);
  assert.equal((await deriveSliceChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE }, { runtime })).status, "unavailable");
  await acceptAndVerify(root);
  assert.equal((await deriveSliceChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE }, { runtime })).status, "unavailable");
  await updateChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE, expectedRevision: null, scope: ["src"], operations: [{ op: "insert", entry: { id: "render", kind: "function", label: "render", action: "MODIFY", before: [{ path: "src/report.ts" }], after: [{ path: "src/report.ts" }], reason: "Planned by hand." } }] });
  await writeFile(path.join(root, "src", "report.ts"), "function render() { return 10; }\n");
  await verify(root);
  const result = await deriveSliceChangeMap({ projectRoot: root, initiative: INITIATIVE, slice: SLICE }, { runtime });
  assert.equal(result.status, "skipped");
  const document = JSON.parse(await readFile(path.join(root, ".prism", "initiatives", INITIATIVE, "slices", SLICE, "change-map.json"), "utf8"));
  assert.equal(document.concepts[0].reason, "Planned by hand.");
});

test("a change inside a changed container is listed once", () => {
  const unit = (key, file, kind, start, end, hash) => ({ key, file, kind, selector: key, start, end, hash });
  const before = { units: [unit("f", "a.ts", "file", 0, 100, "1"), unit("Class", "a.ts", "class", 0, 90, "c1"), unit("method", "a.ts", "method", 10, 40, "m1"), unit("gone", "a.ts", "function", 91, 99, "g")] };
  const after = { units: [unit("f", "a.ts", "file", 0, 120, "2"), unit("Class", "a.ts", "class", 0, 110, "c2"), unit("method", "a.ts", "method", 10, 50, "m2"), unit("Fresh", "a.ts", "class", 111, 119, "n"), unit("inner", "a.ts", "method", 112, 118, "i")] };
  assert.deepEqual(diffUnits(before, after).map((change) => [change.action, (change.after ?? change.before).key]).sort(), [["ADD", "Fresh"], ["DELETE", "gone"], ["MODIFY", "method"]]);
});
