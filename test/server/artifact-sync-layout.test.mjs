import assert from "node:assert/strict";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, exists, isolateGit, ok, remoteFile, server, syncedWorkspace, text, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Store sync of artifacts whose layout differs between two machines: a file on one side and a folder on the other, and a folder that a file manager kept alive.
// Each checkout's server leaves sync off, and the test syncs each machine's store on demand, so every step runs in a known order.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { syncRecordStoreNow: syncRecordStore, takeSavedConflicts } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { locationArtifact } = await import("../../dist/server/workflow/artifact-paths.mjs");

async function machines(context) {
  const place = await syncedWorkspace(context);
  const a = { ...place.a, sync: undefined }, b = { ...place.b, sync: undefined };
  const onA = await server(context, a, await checkout(a, "api"));
  const onB = await server(context, b, await checkout(b, "web"));
  return { place, onA, onB };
}

// Every file a sync saved in a store, as paths below its stamp folder, with their text.
async function saved(store) {
  const folder = path.join(store, ".prism-sync", "conflicts");
  const found = {};
  for (const stamp of await readdir(folder).catch(() => [])) {
    const visit = async (relative) => {
      for (const entry of await readdir(path.join(folder, stamp, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(child);
        else found[child] = await text(path.join(folder, stamp, child));
      }
    };
    await visit("");
  }
  return found;
}

for (const [upstreamShape, localShape] of [["file", "folder"], ["folder", "file"]]) {
  test(`a ${upstreamShape} upstream where this machine made a ${localShape} keeps the upstream one, saves the local files, and syncs cleanly afterwards`, async (context) => {
    const { place, onA, onB } = await machines(context);
    const write = (prism, shape) => shape === "file" ? writeArtifact(prism, "docs/plans/a", "# A as a file\n") : writeArtifact(prism, "docs/plans/a/b.md", "# B inside a folder\n");
    await write(onA, upstreamShape);
    assert.equal((await syncRecordStore(place.storeA)).state, "ok");
    await write(onB, localShape);
    const merged = await syncRecordStore(place.storeB);
    assert.equal(merged.state, "conflicts", merged.message);
    const upstreamFile = upstreamShape === "file" ? "artifacts/plans/a" : "artifacts/plans/a/b.md";
    const localFile = localShape === "file" ? "artifacts/plans/a" : "artifacts/plans/a/b.md";
    assert.deepEqual(merged.conflicts.map((conflict) => conflict.path), [localFile]);
    assert.equal(await text(path.join(place.storeB, upstreamFile)), upstreamShape === "file" ? "# A as a file\n" : "# B inside a folder\n");
    assert.deepEqual(await saved(place.storeB), { [localFile]: localShape === "file" ? "# A as a file\n" : "# B inside a folder\n" });
    assert.equal(remoteFile(place.remote, upstreamFile), upstreamShape === "file" ? "# A as a file" : "# B inside a folder");
    // No path Git moved aside is left in the store or its history.
    assert.deepEqual((await readdir(path.join(place.storeB, "artifacts", "plans"))).filter((name) => name.includes("~")), []);
    assert.equal((await syncRecordStore(place.storeB)).state, "ok");
    assert.equal((await syncRecordStore(place.storeA)).state, "ok");
    const listed = ok(await onB.call("get_artifact", { path: "docs/plans" })).artifacts.map((entry) => entry.path);
    assert.deepEqual(listed, [upstreamShape === "file" ? "docs/plans/a" : "docs/plans/a/b.md"]);
  });
}

test("a sync that removes the last artifact of a folder holding only Finder's .DS_Store removes the folder, so a folder in another letter case is made anew", async (context) => {
  const { place, onA } = await machines(context);
  const first = await writeArtifact(onA, "docs/plans/X/a.md", "# In upper case\n");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  assert.equal(await text(path.join(place.storeB, "artifacts/plans/X/a.md")), "# In upper case\n");
  await writeFile(path.join(place.storeB, "artifacts/plans/X/.DS_Store"), "finder");
  ok(await onA.call("update_artifact", { operations: [{ op: "remove", path: "docs/plans/X/a.md", expectedVersion: first.version }] }));
  await writeArtifact(onA, "docs/plans/x/b.md", "# In lower case\n");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  assert.equal(await exists(path.join(place.storeB, "artifacts/plans/X")), false);
  assert.equal(await text(path.join(place.storeB, "artifacts/plans/x/b.md")), "# In lower case\n");
});

test("a saved artifact is reported once by its store and location, and a location names its scope and kind", async (context) => {
  const { place, onA, onB } = await machines(context);
  const base = await writeArtifact(onA, "docs/plans/c/slice.md", "# C\n\nOne line.\n");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  ok(await onA.call("update_artifact", { operations: [{ op: "edit", path: "docs/plans/c/slice.md", expectedVersion: base.version, edits: [{ oldText: "One line.", newText: "One line from a." }] }] }));
  ok(await onB.call("update_artifact", { operations: [{ op: "edit", path: "docs/plans/c/slice.md", expectedVersion: base.version, edits: [{ oldText: "One line.", newText: "One line from b." }] }] }));
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "conflicts");
  const taken = (await takeSavedConflicts()).filter((item) => item.store === place.storeB);
  assert.deepEqual(taken.map(({ location }) => location), ["plans/c/slice.md"]);
  assert.equal(await text(taken[0].savedAs), "# C\n\nOne line from b.\n");
  assert.deepEqual((await takeSavedConflicts()).filter((item) => item.store === place.storeB), []);
  assert.deepEqual(locationArtifact("plans/c/slice.md"), { scope: { kind: "workspace", label: "workspace" }, kind: "plans", rest: "c/slice.md" });
  assert.deepEqual(locationArtifact("repositories/api/components/core/adrs/x.md"), { scope: { kind: "component", repository: "api", component: "core", label: "api/core" }, kind: "adrs", rest: "x.md" });
  assert.deepEqual(locationArtifact("repositories/api/glossary.md"), { scope: { kind: "repository", repository: "api", label: "api" }, kind: "glossary", rest: null });
  assert.equal(locationArtifact("repositories/api/roadmap.md"), null);
  assert.equal(locationArtifact("plans"), null);
});
