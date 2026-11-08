import assert from "node:assert/strict";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, eventually, isolateGit, notes, ok, remoteFile, server, syncedWorkspace, text, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Store sync of an artifact that one machine moved, to another scope or by a removal and a write of similar text, while the other machine changed it.
// A move merges as a removal and an addition, so each path keeps the upstream file and saves the local one, and no machine's bytes are lost.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { syncRecordStoreNow: syncRecordStore, takeSavedConflicts } = await import("../../dist/server/workflow/record-store-sync.mjs");

const BASE = "# Foo\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.\n";
const FILE = "docs/plans/foo/slice.md";
const WORKSPACE = "artifacts/plans/foo/slice.md";

// Machine a's checkout is repository api, and machine b's is web; each server leaves sync off unless asked, and the test syncs each store on demand.
async function machines(context, sync) {
  const place = await syncedWorkspace(context);
  const a = { ...place.a, sync }, b = { ...place.b, sync };
  const onA = await server(context, a, await checkout(a, "api"));
  const onB = await server(context, b, await checkout(b, "web"));
  return { place, onA, onB };
}

// Every file under a folder, as paths below it, with their text.
async function files(folder) {
  const found = {};
  const visit = async (relative) => {
    for (const entry of await readdir(path.join(folder, relative), { withFileTypes: true }).catch(() => [])) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else found[child] = await text(path.join(folder, child));
    }
  };
  await visit("");
  return found;
}

const saved = (store) => files(path.join(store, ".prism-sync", "conflicts"));
const edit = (prism, version, from, to, file = FILE) => prism.call("update_artifact", { operations: [{ op: "edit", path: file, expectedVersion: version, edits: [{ oldText: from, newText: to }] }] }).then(ok).then((result) => result.artifacts[0]);
const moveScope = (prism, version, file = FILE) => prism.call("update_artifact", { operations: [{ op: "move_scope", path: file, expectedVersion: version, scope: "repository" }] }).then(ok).then((result) => result.artifacts[0]);

async function shared(context, sync) {
  const found = await machines(context, sync);
  const first = await writeArtifact(found.onA, FILE, BASE);
  assert.equal((await syncRecordStore(found.place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(found.place.storeB)).state, "ok");
  return { ...found, version: first.version };
}

test("an upstream move to another scope with an edit of a line this machine also edited keeps the moved artifact and saves this machine's version", async (context) => {
  const { place, onA, onB, version } = await shared(context);
  await edit(onA, (await moveScope(onA, version)).version, "Line two.", "Line two from a.");
  await edit(onB, version, "Line two.", "Line two from b.");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  const merged = await syncRecordStore(place.storeB);
  assert.equal(merged.state, "conflicts", merged.message);
  const upstream = BASE.replace("Line two.", "Line two from a.");
  const local = BASE.replace("Line two.", "Line two from b.");
  assert.deepEqual(await files(path.join(place.storeB, "artifacts")), { "repositories/api/plans/foo/slice.md": upstream });
  const stamps = Object.entries(await saved(place.storeB));
  assert.deepEqual(stamps.map(([file, bytes]) => [file.split("/").slice(1).join("/"), bytes]), [[WORKSPACE, local]]);
  assert.deepEqual(merged.conflicts.map(({ path: file, savedAs }) => [file, savedAs?.endsWith(WORKSPACE)]), [[WORKSPACE, true]]);
  const taken = (await takeSavedConflicts()).filter((item) => item.store === place.storeB);
  assert.deepEqual(taken.map(({ location }) => location), ["plans/foo/slice.md"]);
  assert.equal(await text(taken[0].savedAs), local);
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  assert.equal(remoteFile(place.remote, "artifacts/repositories/api/plans/foo/slice.md"), upstream.trimEnd());
  assert.equal(remoteFile(place.remote, WORKSPACE), null);
});

test("a local move to another scope with an edit of a line the upstream also edited keeps the upstream artifact where it was and the moved one beside it", async (context) => {
  const { place, onA, onB, version } = await shared(context);
  await edit(onA, version, "Line two.", "Line two from a.");
  await edit(onB, (await moveScope(onB, version)).version, "Line two.", "Line two from b.");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  const merged = await syncRecordStore(place.storeB);
  assert.equal(merged.state, "conflicts", merged.message);
  const upstream = BASE.replace("Line two.", "Line two from a.");
  const local = BASE.replace("Line two.", "Line two from b.");
  // The local side removed the workspace copy, so nothing of it is saved; its moved copy stays and reaches the remote.
  assert.deepEqual(merged.conflicts, [{ path: WORKSPACE, savedAs: null }]);
  assert.deepEqual(await files(path.join(place.storeB, "artifacts")), { "plans/foo/slice.md": upstream, "repositories/web/plans/foo/slice.md": local });
  assert.equal(remoteFile(place.remote, WORKSPACE), upstream.trimEnd());
  assert.equal(remoteFile(place.remote, "artifacts/repositories/web/plans/foo/slice.md"), local.trimEnd());
  const listed = ok(await onB.call("get_artifact", { path: "docs/plans" })).artifacts.map((entry) => `${entry.path}@${entry.scope.label}`).sort();
  assert.deepEqual(listed, ["docs/plans/foo/slice.md@web", "docs/plans/foo/slice.md@workspace"]);
});

test("an upstream move of a plan folder to another scope keeps a file this machine added to the folder", async (context) => {
  const { place, onA, onB, version } = await shared(context);
  const diagram = await writeArtifact(onA, "docs/plans/foo/overview.puml", "@startuml\nA -> B\n@enduml\n");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  ok(await onA.call("update_artifact", { operations: [
    { op: "move_scope", path: FILE, expectedVersion: version, scope: "repository" },
    { op: "move_scope", path: "docs/plans/foo/overview.puml", expectedVersion: diagram.version, scope: "repository" }
  ] }));
  await writeArtifact(onB, "docs/plans/foo/notes.md", "# Notes b wrote\n");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  const merged = await syncRecordStore(place.storeB);
  assert.equal(merged.state, "ok", merged.message);
  assert.deepEqual(await files(path.join(place.storeB, "artifacts")), {
    "plans/foo/notes.md": "# Notes b wrote\n",
    "repositories/api/plans/foo/overview.puml": "@startuml\nA -> B\n@enduml\n",
    "repositories/api/plans/foo/slice.md": BASE
  });
  assert.equal(remoteFile(place.remote, "artifacts/plans/foo/notes.md"), "# Notes b wrote");
});

test("an upstream removal and a write of similar text at another path, against a local edit, keeps the upstream's new path and saves the local edit", async (context) => {
  const { place, onA, onB, version } = await shared(context);
  const moved = BASE.replace("Line five.", "Line five, moved.");
  ok(await onA.call("update_artifact", { operations: [
    { op: "remove", path: FILE, expectedVersion: version },
    { op: "write", path: "docs/plans/bar/slice.md", content: moved, expectedVersion: null }
  ] }));
  await edit(onB, version, "Line two.", "Line two from b.");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  const merged = await syncRecordStore(place.storeB);
  assert.equal(merged.state, "conflicts", merged.message);
  assert.deepEqual(await files(path.join(place.storeB, "artifacts")), { "plans/bar/slice.md": moved });
  assert.deepEqual(Object.values(await saved(place.storeB)), [BASE.replace("Line two.", "Line two from b.")]);
  assert.deepEqual((await takeSavedConflicts()).filter((item) => item.store === place.storeB).map(({ location }) => location), ["plans/foo/slice.md"]);
});

test("edits to different lines of an artifact still merge, and a file both machines changed to the same bytes needs no saving", async (context) => {
  const { place, onA, onB, version } = await shared(context);
  const second = await writeArtifact(onA, "docs/plans/foo/same.md", "# Same\n");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  await edit(onA, version, "Line one.", "Line one from a.");
  await edit(onA, second.version, "# Same", "# Same, edited", "docs/plans/foo/same.md");
  await edit(onB, version, "Line five.", "Line five from b.");
  await edit(onB, second.version, "# Same", "# Same, edited", "docs/plans/foo/same.md");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  const merged = await syncRecordStore(place.storeB);
  assert.equal(merged.state, "ok", merged.message);
  assert.equal(remoteFile(place.remote, WORKSPACE), BASE.replace("Line one.", "Line one from a.").replace("Line five.", "Line five from b.").trimEnd());
  assert.equal(remoteFile(place.remote, "artifacts/plans/foo/same.md"), "# Same, edited");
  assert.deepEqual(await saved(place.storeB), {});
});

test("with sync on, the next tool result names an artifact whose local edit lost to an upstream move to another scope", async (context) => {
  const { place, onA, onB } = await machines(context, "on");
  const first = await writeArtifact(onA, FILE, BASE);
  await eventually(() => remoteFile(place.remote, WORKSPACE) === BASE.trimEnd(), 30000, "the base version reaching the remote");
  await eventually(async () => {
    const response = await onB.call("get_artifact", { path: FILE });
    return !response.error && response.result.structuredContent?.version === first.version;
  }, 30000, "machine b pulling the base version");
  await edit(onA, (await moveScope(onA, first.version)).version, "Line two.", "Line two from a.");
  const upstream = BASE.replace("Line two.", "Line two from a.");
  await eventually(() => remoteFile(place.remote, "artifacts/repositories/api/plans/foo/slice.md") === upstream.trimEnd() && remoteFile(place.remote, WORKSPACE) === null, 30000, "machine a's move reaching the remote");
  await edit(onB, first.version, "Line two.", "Line two from b.");
  const local = BASE.replace("Line two.", "Line two from b.");
  const copies = await eventually(async () => { const found = Object.entries(await saved(place.storeB)); return found.length ? found : null; }, 45000, "machine b's sync saving its version");
  assert.deepEqual(copies.map(([, bytes]) => bytes), [local]);
  const savedAs = path.join(place.storeB, ".prism-sync", "conflicts", copies[0][0]);
  const reported = notes(await onB.call("get_artifact", { path: "docs/plans" }));
  assert.ok(reported.includes(FILE), "the next result names the artifact's path");
  assert.match(reported, /workspace/, "the next result names the artifact's scope");
  assert.ok(reported.includes(savedAs), "the next result names the saved copy");
});

test("a saved version that a stopped sync never named is named by the next tool result of a server started later, once, and no server names it again", async (context) => {
  const { place, onB } = await machines(context, "on");
  // A sync of a server that has since stopped saved machine b's version a minute ago, before this server started, and wrote no status.
  const stamp = new Date(Date.now() - 60000).toISOString().replace(/[:.]/g, "-");
  const savedAs = path.join(place.storeB, ".prism-sync", "conflicts", stamp, ...WORKSPACE.split("/"));
  const notice = path.join(place.storeB, ".prism-sync", "notices", stamp);
  await mkdir(path.dirname(savedAs), { recursive: true });
  await writeFile(savedAs, BASE);
  await mkdir(path.dirname(notice), { recursive: true });
  await writeFile(notice, "{}\n");
  const reported = notes(await onB.call("get_artifact", { path: "docs/plans" }));
  assert.ok(reported.includes(FILE) && reported.includes(savedAs), reported);
  // The server clears the notice once the result is written, so it is gone soon after the result arrives.
  await eventually(async () => !(await access(notice).then(() => true, () => false)), 5000, "the tool result that carried it clearing its notice");
  assert.equal(notes(await onB.call("get_artifact", { path: "docs/plans" })), "", "the next result names it no more");
  const later = await server(context, place.b, await checkout(place.b, "admin"));
  assert.equal(notes(await later.call("get_artifact", { path: "docs/plans" })).includes(savedAs), false, "a server started later names it no more");
});
