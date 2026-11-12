import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, eventually, isolateGit, notes, ok, remoteFile, server, syncedWorkspace, text, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 24 and 25 of the workspace-artifacts design: artifact writes sync like records, and a concurrent change is kept aside and reported.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";
const LOCATION = "artifacts/requirements/billing.md";
const BASE = "# Billing\n\nFirst sentence.\nSecond sentence.\nThird sentence.\n";

// Every file a sync saved under a store's sync folder, as paths below its conflicts folder.
async function savedCopies(store) {
  const folder = path.join(store, ".prism-sync", "conflicts");
  const found = [];
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(folder, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else found.push(path.join(folder, child));
    }
  };
  await visit("");
  return found;
}

// Machine a writes the base version, and machine b reads it after its store pulled it.
async function shared(context) {
  const machines = await syncedWorkspace(context);
  const onA = await server(context, machines.a, await checkout(machines.a, "api"));
  const written = await writeArtifact(onA, FILE, BASE);
  await eventually(() => remoteFile(machines.remote, LOCATION) === BASE.trimEnd(), 30000, "the base version reaching the remote");
  const onB = await server(context, machines.b, await checkout(machines.b, "web"));
  await eventually(async () => {
    const response = await onB.call("get_artifact", { path: FILE });
    return !response.error && response.result.structuredContent?.version === written.version;
  }, 30000, "machine b pulling the base version");
  return { machines, onA, onB, version: written.version };
}

test("clause 24: an artifact write reaches the store's remote without another call", async (context) => {
  const machines = await syncedWorkspace(context);
  const prism = await server(context, machines.a, await checkout(machines.a, "api"));
  await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n\nA draft.\n");
  await eventually(() => remoteFile(machines.remote, "artifacts/plans/reports/slice.md") === "# Reports\n\nA draft.", 30000, "the draft reaching the remote");
});

test("clause 25: changes to different lines of one artifact on two machines both survive", async (context) => {
  const { machines, onA, onB, version } = await shared(context);
  ok(await onA.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: version, edits: [{ oldText: "First sentence.", newText: "First sentence from a." }] }] }));
  ok(await onB.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: version, edits: [{ oldText: "Third sentence.", newText: "Third sentence from b." }] }] }));
  const merged = "# Billing\n\nFirst sentence from a.\nSecond sentence.\nThird sentence from b.";
  await eventually(() => remoteFile(machines.remote, LOCATION) === merged, 45000, "both edits reaching the remote");
  assert.deepEqual(await savedCopies(machines.storeA), []);
  assert.deepEqual(await savedCopies(machines.storeB), []);
});

test("clause 25: a line changed differently on two machines keeps the upstream artifact, saves the local bytes, and names both in the next result", async (context) => {
  const { machines, onA, onB, version } = await shared(context);
  ok(await onA.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: version, edits: [{ oldText: "Second sentence.", newText: "Second sentence as a wrote it." }] }] }));
  const upstream = BASE.replace("Second sentence.", "Second sentence as a wrote it.");
  await eventually(() => remoteFile(machines.remote, LOCATION) === upstream.trimEnd(), 30000, "machine a's edit reaching the remote");
  // Machine b last fetched when it read the base version, so it edits that version before it pulls machine a's.
  ok(await onB.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: version, edits: [{ oldText: "Second sentence.", newText: "Second sentence as b wrote it." }] }] }));
  const local = BASE.replace("Second sentence.", "Second sentence as b wrote it.");
  const [saved] = await eventually(async () => { const copies = await savedCopies(machines.storeB); return copies.length ? copies : null; }, 45000, "machine b's sync saving its version");
  assert.equal(await text(saved), local, "the saved copy holds machine b's bytes");
  assert.equal(await text(path.join(machines.storeB, LOCATION)), upstream, "machine b's store keeps the upstream artifact");
  assert.equal(remoteFile(machines.remote, LOCATION), upstream.trimEnd(), "the remote keeps machine a's version");
  const next = await onB.call("get_artifact", { path: FILE });
  assert.equal(ok(next).content, upstream);
  const reported = notes(next);
  assert.ok(reported.includes(FILE), "the next result names the artifact's path");
  assert.match(reported, /workspace/, "the next result names the artifact's scope");
  assert.ok(reported.includes(saved), "the next result names the saved copy");
});
