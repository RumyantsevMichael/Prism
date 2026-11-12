import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, isolateGit, ok, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Every store artifact keeps an identity at artifact-identity/<location>: a create writes a new one, an edit or a write keeps it, a move to another scope carries it, and a removal removes it.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/plans/foo/slice.md";
const LOCATION = "plans/foo/slice.md";
const MOVED = "repositories/api/plans/foo/slice.md";
const IDENTITY = /^\{"id":"[0-9a-f]{32}"\}\n$/;
const given = (location) => createHash("sha256").update(location, "utf8").digest("hex").slice(0, 32);
const identityAt = (store, location) => readFile(path.join(store, "artifact-identity", ...location.split("/")), "utf8").catch(() => null);

async function project(context) {
  const place = await workspace(context);
  const prism = await server(context, place, await checkout(place, "api"));
  return { place, prism };
}

test("an artifact keeps its identity through edits and writes, takes it along to another scope, and loses it when removed", async (context) => {
  const { place, prism } = await project(context);
  const created = await writeArtifact(prism, FILE, "# Foo\n");
  const first = await identityAt(place.store, LOCATION);
  assert.match(first ?? "", IDENTITY, "a create writes one line of JSON holding a new id");
  const edited = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: created.version, edits: [{ oldText: "# Foo", newText: "# Foo, edited" }] }] })).artifacts[0];
  const written = await writeArtifact(prism, FILE, "# Foo, written\n", { expectedVersion: edited.version });
  assert.equal(await identityAt(place.store, LOCATION), first, "an edit and a write keep it");
  const moved = ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: written.version, scope: "repository" }] })).artifacts[0];
  assert.equal(await identityAt(place.store, MOVED), first, "a move to another scope takes it along");
  assert.equal(await identityAt(place.store, LOCATION), null, "and leaves none at the old location");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: FILE, expectedVersion: moved.version }] }));
  assert.equal(await identityAt(place.store, MOVED), null, "a removal removes it");
  await writeArtifact(prism, FILE, "# Foo, again\n", { scope: "repository" });
  const again = await identityAt(place.store, MOVED);
  assert.match(again ?? "", IDENTITY);
  assert.notEqual(again, first, "a file written later at the path has an identity of its own");
});

test("a create replaces an identity file that a removed artifact left, and a move of an artifact whose identity is missing, damaged, or copied writes the identity its location gives", async (context) => {
  const { place, prism } = await project(context);
  // A file someone left at the identity location of a path that holds no artifact.
  await mkdir(path.join(place.store, "artifact-identity", "plans", "foo"), { recursive: true });
  await writeFile(path.join(place.store, "artifact-identity", ...LOCATION.split("/")), `${JSON.stringify({ id: "0123456789abcdef0123456789abcdef" })}\n`);
  const created = await writeArtifact(prism, FILE, "# Foo\n");
  assert.notEqual(await identityAt(place.store, LOCATION), `${JSON.stringify({ id: "0123456789abcdef0123456789abcdef" })}\n`, "the create writes a new id in its place");

  // Another artifact's identity file copied by hand, so neither keeps the shared id.
  const other = await writeArtifact(prism, "docs/plans/bar/slice.md", "# Bar\n");
  await writeFile(path.join(place.store, "artifact-identity", "plans", "bar", "slice.md"), await identityAt(place.store, LOCATION));
  ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: created.version, scope: "repository" }] }));
  assert.equal(await identityAt(place.store, MOVED), `${JSON.stringify({ id: given(LOCATION) })}\n`, "a copied id gives way to the one the location gives");

  for (const [label, bytes] of [["missing", null], ["damaged", "{\"id\": \"01"], ["too large", `${JSON.stringify({ id: given("x"), pad: "a".repeat(1024) })}\n`]]) {
    const name = label.replace(" ", "-");
    const file = `docs/plans/${name}/slice.md`;
    const written = await writeArtifact(prism, file, `# ${label}\n`);
    const target = path.join(place.store, "artifact-identity", "plans", name, "slice.md");
    if (bytes === null) await rm(target, { force: true }); else await writeFile(target, bytes);
    ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: file, expectedVersion: written.version, scope: "repository" }] }));
    assert.equal(await identityAt(place.store, `repositories/api/plans/${name}/slice.md`), `${JSON.stringify({ id: given(`plans/${name}/slice.md`) })}\n`, `${label}: the move writes the identity the old location gives`);
    assert.equal(await identityAt(place.store, `plans/${name}/slice.md`), null, `${label}: and leaves nothing at the old location`);
  }
  assert.ok(other.version);
});

test("no two locations of a tree keep one identity, also where identity files chain one location's given identity onto the next", async () => {
  const { uniqueIdentities } = await import("../../dist/server/workflow/artifact-paths.mjs");
  const [a, b, c, d] = ["requirements/a.md", "requirements/b.md", "requirements/c.md", "requirements/d.md"];
  const written = new Map([[b, given(a)], [c, given(b)], [d, given(c)]]);
  const ids = uniqueIdentities([a, b, c, d], written);
  assert.deepEqual([...ids.values()], [given(a), given(b), given(c), given(d)], "each location ends with the identity its own location gives");
  const copied = "0123456789abcdef0123456789abcdef";
  const two = uniqueIdentities([a, b, c], new Map([[a, copied], [b, copied], [c, "fedcba9876543210fedcba9876543210"]]));
  assert.deepEqual([two.get(a), two.get(b), two.get(c)], [given(a), given(b), "fedcba9876543210fedcba9876543210"], "an id two files hold is neither's, and an id one file holds stays");
});
