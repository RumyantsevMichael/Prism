import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, isolateGit, ok, refused, server, version, writeArtifact } from "./fixtures/workspace-view.mjs";
import { workspace } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 26-33 of the workspace-view design: agents list and read every scope's artifacts, by label or location, and change only their own.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const pick = (entry) => ({ path: entry.path, location: entry.location, label: entry.scope.label });

// Two repositories of one store: api with the default paths and a component, web with requirements under specs and no ADR folder.
async function twoRepositories(context) {
  const where = await workspace(context);
  const api = await server(context, where, await checkout(where, "api", { components: ["- billing: packages/billing"] }));
  const web = await server(context, where, await checkout(where, "web", { paths: ["- Plans: docs/plans", "- Requirements: specs", "- ADRs: n/a"] }));
  await writeArtifact(api, "docs/requirements/shared.md", "# Shared\n");
  await writeArtifact(api, "docs/plans/reports/slice.md", "# API reports\n", { scope: "repository" });
  await writeArtifact(api, "docs/ADRs/ledger.md", "# Ledger\n", { scope: "repository" });
  await writeArtifact(api, "docs/requirements/totals.md", "# Totals\n", { scope: "component", component: "billing" });
  await writeArtifact(web, "docs/plans/reports/slice.md", "# Web reports\n", { scope: "repository" });
  await writeArtifact(web, "specs/pages.md", "# Pages\n", { scope: "repository" });
  return { where, api, web };
}

test("clause 26: a listing from one checkout holds every scope of the store, each entry with its location", async (context) => {
  const { api } = await twoRepositories(context);
  const listed = ok(await api.call("get_artifact", {}));
  assert.deepEqual(listed.artifacts.map(pick), [
    { path: "docs/ADRs/ledger.md", location: "repositories/api/adrs/ledger.md", label: "api" },
    { path: "docs/plans/reports/slice.md", location: "repositories/api/plans/reports/slice.md", label: "api" },
    { path: "docs/plans/reports/slice.md", location: "repositories/web/plans/reports/slice.md", label: "web" },
    { path: "docs/requirements/pages.md", location: "repositories/web/requirements/pages.md", label: "web" },
    { path: "docs/requirements/shared.md", location: "requirements/shared.md", label: "workspace" },
    { path: "docs/requirements/totals.md", location: "repositories/api/components/billing/requirements/totals.md", label: "api/billing" }
  ]);
  const folder = ok(await api.call("get_artifact", { path: "docs/plans" }));
  assert.deepEqual(folder.artifacts.map((entry) => entry.scope.label), ["api", "web"]);
});

test("clause 27: another scope's artifact takes the path that the reading checkout configures, or none", async (context) => {
  const { web } = await twoRepositories(context);
  const listed = ok(await web.call("get_artifact", {})).artifacts.map(pick);
  assert.ok(listed.some((entry) => entry.path === "specs/shared.md" && entry.label === "workspace"), "a workspace requirement maps into web's specs folder");
  assert.ok(listed.some((entry) => entry.path === "specs/totals.md" && entry.label === "api/billing"), "a component requirement maps into web's specs folder");
  assert.deepEqual(listed.at(-1), { path: null, location: "repositories/api/adrs/ledger.md", label: "api" }, "web configures no ADR folder, so the ADR has no path and lists last");
});

test("clause 28: a read with a scope label returns that scope's artifact, and an unknown label names the labels the store holds", async (context) => {
  const { api } = await twoRepositories(context);
  const read = ok(await api.call("get_artifact", { path: "docs/plans/reports/slice.md", label: "web" }));
  assert.equal(read.content, "# Web reports\n");
  assert.equal(read.scope.label, "web");
  assert.equal(read.version, version("# Web reports\n"));
  const unknown = refused(await api.call("get_artifact", { path: "docs/plans/reports/slice.md", label: "mobile" }), "scope_unknown");
  assert.deepEqual(unknown.data.scopes, ["api", "api/billing", "web", "workspace"]);
  refused(await api.call("get_artifact", { path: "docs/plans/reports/slice.md", label: "web", scope: "repository" }), "scope_invalid");
});

test("clause 29: a read by location needs no configured folder, and does not combine with a path", async (context) => {
  const { web } = await twoRepositories(context);
  const read = ok(await web.call("get_artifact", { location: "repositories/api/adrs/ledger.md" }));
  assert.equal(read.content, "# Ledger\n");
  assert.equal(read.location, "repositories/api/adrs/ledger.md");
  assert.equal(read.path, null);
  refused(await web.call("get_artifact", { location: "repositories/api/adrs/ledger.md", path: "docs/plans/reports/slice.md" }), "scope_invalid");
});

test("clause 30: an unlabelled path that several scopes hold is refused with every holding scope", async (context) => {
  const { api } = await twoRepositories(context);
  const error = refused(await api.call("get_artifact", { path: "docs/plans/reports/slice.md" }), "artifact_ambiguous");
  assert.deepEqual(error.data.scopes, ["api", "web"]);
  assert.match(error.message, /label/);
});

test("clause 31: a new artifact takes the writer's own scope, whatever other repositories hold at that path", async (context) => {
  const { api, web } = await twoRepositories(context);
  await writeArtifact(web, "docs/plans/onboarding/slice.md", "# Web onboarding\n", { scope: "repository" });
  const created = await writeArtifact(api, "docs/plans/onboarding/slice.md", "# API onboarding\n");
  assert.equal(created.scope.label, "workspace", "api's own scopes hold no plans/onboarding folder");
  assert.equal(ok(await api.call("get_artifact", { path: "docs/plans/onboarding/slice.md", label: "web" })).content, "# Web onboarding\n", "web's artifact stays as it was");
  const nested = await writeArtifact(api, "docs/plans/reports/notes.md", "# Notes\n");
  assert.equal(nested.scope.label, "api", "api's own scope holds plans/reports");
});

test("clause 32: an agent cannot change an artifact that only another repository's scope holds", async (context) => {
  const { api } = await twoRepositories(context);
  const pages = ok(await api.call("get_artifact", { path: "docs/requirements/pages.md", label: "web" }));
  for (const operation of [
    { op: "edit", path: "docs/requirements/pages.md", expectedVersion: pages.version, edits: [{ oldText: "Pages", newText: "Screens" }] },
    { op: "write", path: "docs/requirements/pages.md", content: "# Screens\n", expectedVersion: pages.version },
    { op: "remove", path: "docs/requirements/pages.md", expectedVersion: pages.version },
    { op: "move_scope", path: "docs/requirements/pages.md", expectedVersion: pages.version, scope: "workspace" },
    { op: "ask_approval", path: "docs/requirements/pages.md", context: "Pages are ready." }
  ]) {
    const error = refused(await api.call("update_artifact", { operations: [operation] }), "scope_not_writable");
    assert.equal(error.data.scope, "web", operation.op);
    assert.match(error.message, /checkout of web/);
  }
  assert.equal(ok(await api.call("get_artifact", { path: "docs/requirements/pages.md", label: "web" })).version, pages.version);
});

test("clause 33: listings answer from an index that a write refreshes, and 20,000 artifacts list within a second", async (context) => {
  const where = await workspace(context);
  const api = await server(context, where, await checkout(where, "api"));
  const first = ok(await api.call("get_artifact", {}));
  assert.ok(!Number.isNaN(Date.parse(first.indexedAt)), "the listing names the time of its index");
  await writeArtifact(api, "docs/requirements/new.md", "# New\n");
  assert.ok(ok(await api.call("get_artifact", {})).artifacts.some((entry) => entry.path === "docs/requirements/new.md"), "a write is listed by the next listing");
  const folder = path.join(where.store, "artifacts", "requirements", "bulk");
  for (let group = 0; group < 100; group += 1) {
    await mkdir(path.join(folder, `g${group}`), { recursive: true });
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(path.join(folder, `g${group}`, `r${index}.md`), `# R ${group} ${index}\n`)));
  }
  await writeArtifact(api, "docs/requirements/trigger.md", "# Trigger\n");
  const built = ok(await api.call("get_artifact", {}));
  assert.equal(built.truncated, true);
  const started = Date.now();
  const listed = ok(await api.call("get_artifact", {}));
  assert.ok(Date.now() - started < 1000, `the listing took ${Date.now() - started} ms`);
  assert.equal(listed.artifacts.length, 2000);
});
