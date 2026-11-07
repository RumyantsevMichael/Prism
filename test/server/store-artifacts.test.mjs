import assert from "node:assert/strict";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, exists, isolateGit, ok, refused, server, text, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Edge cases of the store artifact tools beyond the design's acceptance tests: links in the store, reserved names, nested kinds, and the roadmap's scope.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("a symbolic link inside the store's artifacts folder is never followed for a read or a write", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  const outside = path.join(place.parent, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.md"), "# Secret\n");
  await symlink(outside, path.join(place.store, "artifacts", "requirements", "linked"));
  refused(await prism.call("get_artifact", { path: "docs/requirements/linked/secret.md" }), "invalid_path");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/linked/new.md", content: "# New\n", expectedVersion: null }] }), "invalid_path");
  assert.deepEqual(await readdir(outside), ["secret.md"]);
  await symlink(path.join(outside, "secret.md"), path.join(place.store, "artifacts", "requirements", "file-link.md"));
  refused(await prism.call("get_artifact", { path: "docs/requirements/file-link.md" }), "invalid_path");
  const listed = ok(await prism.call("get_artifact", { path: "docs/requirements" }));
  assert.deepEqual(listed.artifacts.map((entry) => entry.path), ["docs/requirements/first.md"], "a listing skips links");
});

test("lock and temporary file names are not artifacts, and a listing hides them", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/first.md.lock", content: "x\n", expectedVersion: null }] }), "not_an_artifact");
  await writeFile(path.join(place.store, "artifacts", "requirements", ".first.md.1.abc.tmp"), "partial");
  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => entry.path), ["docs/requirements/first.md"]);
});

test("a kind folder inside another kind's folder lists each file under the kind of its longest path, and the roadmap stays in the workspace scope", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { paths: ["- Requirements: specs", "- Plans: specs/plans"] });
  const prism = await server(context, place, api);
  await writeArtifact(prism, "specs/plans/reports/slice.md", "# Plan\n");
  await writeArtifact(prism, "specs/billing.md", "# Billing\n");
  // A file another checkout stored under requirements/plans would have the address of a plan here, so this checkout does not see it.
  await mkdir(path.join(place.store, "artifacts", "requirements", "plans"), { recursive: true });
  await writeFile(path.join(place.store, "artifacts", "requirements", "plans", "hidden.md"), "# Hidden\n");
  const listed = ok(await prism.call("get_artifact", { path: "specs" }));
  assert.deepEqual(listed.artifacts.map((entry) => [entry.path, entry.kind]), [["specs/billing.md", "requirements"], ["specs/plans/reports/slice.md", "plans"]]);
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/roadmap.md", content: "# Roadmap\n", expectedVersion: null, scope: "repository" }] }), "scope_invalid");
  await writeArtifact(prism, "docs/roadmap.md", "# Roadmap\n");
  assert.equal(await text(path.join(place.store, "artifacts", "roadmap.md")), "# Roadmap\n");
  refused(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/roadmap.md", expectedVersion: null, scope: "repository" }] }), "scope_invalid");
});

test("a removal leaves no empty folders behind", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const first = await writeArtifact(prism, "docs/plans/reports/deep/slice.md", "# Deep\n");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/plans/reports/deep/slice.md", expectedVersion: first.version }] }));
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "reports")), false);
});
