import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { artifactConfig, checkout, commitFiles, exists, git, isolateGit, ok, refused, remoteFile, server, syncedWorkspace, text, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 1-18, 20, and 21 of the workspace-artifacts design: agents read, list, and write store artifacts by path and scope.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const workspaceScope = { kind: "workspace", label: "workspace" };

test("clauses 1, 3, and 8: each configured kind maps to its folder of the workspace scope, and a read returns the file with its version", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const files = {
    "docs/requirements/billing.md": ["requirements", "requirements/billing.md"],
    "docs/ADRs/payments/ledger.md": ["adrs", "adrs/payments/ledger.md"],
    "docs/plans/reports/slice.md": ["plans", "plans/reports/slice.md"],
    "docs/Glossary.md": ["glossary", "glossary.md"],
    "docs/roadmap.md": ["roadmap", "roadmap.md"]
  };
  for (const [file, [kind, location]] of Object.entries(files)) {
    const content = `# ${file}\n\nOne line.\n`;
    const written = await writeArtifact(prism, file, content);
    assert.deepEqual(written, { path: file, scope: workspaceScope, version: version(content) });
    assert.equal(await text(path.join(place.store, "artifacts", location)), content, `${file} is stored at artifacts/${location}`);
    assert.equal(await exists(path.join(api, file)), false, `${file} is not written into the checkout`);
    const read = ok(await prism.call("get_artifact", { path: file }));
    assert.deepEqual(read, { path: file, scope: workspaceScope, kind, version: version(content), bytes: Buffer.byteLength(content), totalLines: 3, offset: 1, content, nextOffset: null });
  }
});

test("clause 1: the longest configured path names the kind, and a key set to n/a names none", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { paths: ["- Requirements: specs", "- Plans: specs/plans", "- ADRs: n/a"] });
  const prism = await server(context, place, api);
  await writeArtifact(prism, "specs/plans/reports/slice.md", "# Plan\n");
  await writeArtifact(prism, "specs/billing.md", "# Billing\n");
  assert.equal(await text(path.join(place.store, "artifacts", "plans", "reports", "slice.md")), "# Plan\n");
  assert.equal(await text(path.join(place.store, "artifacts", "requirements", "billing.md")), "# Billing\n");
  assert.equal(ok(await prism.call("get_artifact", { path: "specs/plans/reports/slice.md" })).kind, "plans");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/ADRs/ledger.md", content: "# Ledger\n", expectedVersion: null }] }), "not_an_artifact");
});

test("clauses 2, 4, and 7: repository and component scopes have folders of their own, and an unknown component or scope is refused", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { components: ["- billing: packages/billing"] });
  const prism = await server(context, place, api);
  const repositoryEntry = await writeArtifact(prism, "docs/requirements/api.md", "# API\n", { scope: "repository" });
  assert.deepEqual(repositoryEntry.scope, { kind: "repository", repository: "api", label: "api" });
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "requirements", "api.md")), "# API\n");
  const componentEntry = await writeArtifact(prism, "docs/requirements/totals.md", "# Totals\n", { scope: "component", component: "billing" });
  assert.deepEqual(componentEntry.scope, { kind: "component", repository: "api", component: "billing", label: "api/billing" });
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "components", "billing", "requirements", "totals.md")), "# Totals\n");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/web.md", content: "# Web\n", expectedVersion: null, scope: "component", component: "web" }] }), "component_unknown");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/web.md", content: "# Web\n", expectedVersion: null, scope: "galaxy" }] }), "scope_invalid");
  assert.equal(await exists(path.join(place.store, "artifacts", "requirements", "web.md")), false);
});

test("clause 2: a repository name that is a Windows device name is refused before anything is written, and a registration under one holds no remote", async (context) => {
  const place = await workspace(context);
  const portable = (name) => /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name);
  for (const name of ["aux", "nul", "com1", "lpt9"]) {
    // The checkout's folder and remote carry the name too, so a proposal derived from them must still be portable.
    const prism = await server(context, place, await checkout(place, name));
    for (const response of [
      await prism.call("get_artifact", {}),
      await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/api.md", content: "# API\n", expectedVersion: null, scope: "repository" }] }),
      await prism.call("get_roadmap", {})
    ]) {
      const error = refused(response, "repository_name_invalid");
      assert.ok(portable(error.data.proposed), `${name}: the proposal ${error.data.proposed} is a portable name`);
    }
    assert.equal(await exists(path.join(place.store, "repositories", `${name}.json`)), false, `${name} is not registered`);
  }
  assert.equal(await exists(path.join(place.store, "artifacts")), false, "no artifact folder is written");

  // A registration that the store already holds under such a name, as an earlier version wrote it, refuses its checkout and lets it move to the proposed name.
  await mkdir(path.join(place.store, "repositories"), { recursive: true });
  await writeFile(path.join(place.store, "repositories", "con.json"), `${JSON.stringify({ schemaVersion: 1, name: "con", remotes: ["https://github.com/acme/con.git"], root: null, registeredAt: "2026-11-01T00:00:00.000Z" }, null, 2)}\n`);
  const con = await checkout(place, "con");
  const error = refused(await (await server(context, place, con)).call("get_artifact", {}), "repository_name_invalid");
  const proposed = error.data.proposed;
  assert.ok(portable(proposed), `the proposal ${proposed} is a portable name`);
  await commitFiles(con, { ".prism/workflow.md": artifactConfig({ repository: proposed }) }, "rename the repository");
  const renamed = await server(context, place, con);
  const entry = await writeArtifact(renamed, "docs/requirements/con.md", "# Con\n", { scope: "repository" });
  assert.deepEqual(entry.scope, { kind: "repository", repository: proposed, label: proposed });
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", proposed, "requirements", "con.md")), "# Con\n");
  assert.ok(await exists(path.join(place.store, "repositories", `${proposed}.json`)), "the proposed name registers");
});

test("clause 2: no update creates a component folder whose name is a Windows device name, while one the store already holds stays usable", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { components: ["- aux: src/aux", "- com1: src/com1", "- nul: src/nul", "- billing: src/billing"] });
  const prism = await server(context, place, api);
  const components = path.join(place.store, "artifacts", "repositories", "api", "components");
  const nameRefused = (response, component) => {
    const error = refused(response, "component_name_invalid");
    assert.equal(error.data.component, component);
    return error;
  };
  for (const component of ["aux", "com1", "nul"]) {
    nameRefused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/plans/x/slice.md", content: "# X\n", expectedVersion: null, scope: "component", component }] }), component);
  }
  const moving = await writeArtifact(prism, "docs/plans/y/slice.md", "# Y\n", { scope: "repository" });
  nameRefused(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/plans/y/slice.md", expectedVersion: moving.version, scope: "component", component: "aux" }] }), "aux");
  nameRefused(await prism.call("update_artifact", { operations: [
    { op: "write", path: "docs/plans/z/slice.md", content: "# Z\n", expectedVersion: null, scope: "component", component: "billing" },
    { op: "write", path: "docs/plans/x/slice.md", content: "# X\n", expectedVersion: null, scope: "component", component: "nul" }
  ] }), "nul");
  assert.equal(await exists(components), false, "a refused update creates no component folder");
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "plans", "y", "slice.md")), "# Y\n");
  await writeArtifact(prism, "docs/plans/z/slice.md", "# Z\n", { scope: "component", component: "billing" });
  assert.deepEqual(await readdir(components), ["billing"]);

  // A component folder of such a name that the store already holds, as an earlier version wrote it, stays seen, and its artifacts can be moved out.
  const held = path.join(components, "aux", "plans", "old");
  await mkdir(held, { recursive: true });
  await writeFile(path.join(held, "a.md"), "# A\n");
  await writeFile(path.join(held, "b.md"), "# B\n");
  const auxScope = { kind: "component", repository: "api", component: "aux", label: "api/aux" };
  const listed = ok(await prism.call("get_artifact", { path: "docs/plans/old" })).artifacts;
  assert.deepEqual(listed.map((entry) => [entry.path, entry.scope]), [["docs/plans/old/a.md", auxScope], ["docs/plans/old/b.md", auxScope]]);
  nameRefused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/plans/old/c.md", content: "# C\n", expectedVersion: null }] }), "aux");
  assert.equal(await exists(path.join(held, "c.md")), false);
  const a = ok(await prism.call("get_artifact", { path: "docs/plans/old/a.md" }));
  assert.deepEqual([a.scope, a.content], [auxScope, "# A\n"]);
  const b = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: "docs/plans/old/b.md", expectedVersion: version("# B\n"), edits: [{ oldText: "# B", newText: "# B, edited" }] }] })).artifacts[0];
  assert.equal(await text(path.join(held, "b.md")), "# B, edited\n");
  ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/plans/old/a.md", expectedVersion: a.version, scope: "repository" }] }));
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "plans", "old", "a.md")), "# A\n");
  assert.equal(await exists(path.join(held, "a.md")), false);
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/plans/old/b.md", expectedVersion: b.version }] }));
  assert.equal(await exists(path.join(held, "b.md")), false);
});

test("clauses 5 and 10: a checkout lists the workspace's artifacts and its own repository's, sorted and labeled, without other repositories' ones", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { components: ["- billing: packages/billing"] });
  const web = await checkout(place, "web");
  const apiServer = await server(context, place, api);
  const webServer = await server(context, place, web);
  await writeArtifact(apiServer, "docs/requirements/shared.md", "# Shared\n");
  await writeArtifact(apiServer, "docs/requirements/api.md", "# API\n", { scope: "repository" });
  await writeArtifact(apiServer, "docs/requirements/billing.md", "# Billing\n", { scope: "component", component: "billing" });
  await writeArtifact(apiServer, "docs/plans/reports/slice.md", "# Reports\n");
  await writeArtifact(webServer, "docs/requirements/web.md", "# Web\n", { scope: "repository" });

  const listed = ok(await apiServer.call("get_artifact", {}));
  assert.deepEqual(listed.artifacts.map((entry) => [entry.path, entry.scope.label]), [
    ["docs/plans/reports/slice.md", "workspace"],
    ["docs/requirements/api.md", "api"],
    ["docs/requirements/billing.md", "api/billing"],
    ["docs/requirements/shared.md", "workspace"]
  ]);
  const shared = listed.artifacts.find((entry) => entry.path === "docs/requirements/shared.md");
  assert.equal(shared.kind, "requirements");
  assert.equal(shared.version, version("# Shared\n"));
  assert.equal(shared.bytes, 9);
  assert.equal("content" in shared, false, "a listing holds no content");
  assert.equal(listed.truncated ?? false, false);

  const folder = ok(await webServer.call("get_artifact", { path: "docs/requirements" }));
  assert.deepEqual(folder.artifacts.map((entry) => [entry.path, entry.scope.label]), [["docs/requirements/shared.md", "workspace"], ["docs/requirements/web.md", "web"]]);
  refused(await webServer.call("get_artifact", { path: "docs/requirements/api.md" }), "artifact_not_found");
});

test("clause 6: a path that two seen scopes hold needs a scope, which picks one", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  // Two machines can create one path in two scopes before either syncs, so the store ends up holding both.
  await mkdir(path.join(place.store, "artifacts", "repositories", "api", "requirements"), { recursive: true });
  await writeFile(path.join(place.store, "artifacts", "requirements", "dup.md"), "# Workspace copy\n");
  await writeFile(path.join(place.store, "artifacts", "repositories", "api", "requirements", "dup.md"), "# Repository copy\n");
  const error = refused(await prism.call("get_artifact", { path: "docs/requirements/dup.md" }), "artifact_ambiguous");
  assert.deepEqual([...error.data.scopes].sort(), ["api", "workspace"]);
  refused(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/requirements/dup.md", expectedVersion: version("# Workspace copy\n") }] }), "artifact_ambiguous");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/dup.md", scope: "repository" })).content, "# Repository copy\n");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/dup.md", scope: "workspace" })).content, "# Workspace copy\n");
});

test("clause 9: a long file is read in pages of whole lines, which join to its text", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const many = Array.from({ length: 3000 }, (_, index) => `Line ${index + 1}.\n`).join("");
  await writeArtifact(prism, "docs/plans/reports/long.md", many);
  const first = ok(await prism.call("get_artifact", { path: "docs/plans/reports/long.md" }));
  assert.equal(first.totalLines, 3000);
  assert.equal(first.offset, 1);
  assert.equal(first.nextOffset, 2001);
  assert.equal(first.content.split("\n").length - 1, 2000);
  const second = ok(await prism.call("get_artifact", { path: "docs/plans/reports/long.md", offset: 2001 }));
  assert.equal(second.nextOffset, null);
  assert.equal(first.content + second.content, many);
  const limited = ok(await prism.call("get_artifact", { path: "docs/plans/reports/long.md", offset: 10, limit: 5 }));
  assert.equal(limited.content, "Line 10.\nLine 11.\nLine 12.\nLine 13.\nLine 14.\n");
  assert.equal(limited.nextOffset, 15);

  const wide = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(996)}\n`).join("");
  await writeArtifact(prism, "docs/plans/reports/wide.md", wide);
  const pages = [];
  for (let offset = 1; offset !== null;) {
    const page = ok(await prism.call("get_artifact", { path: "docs/plans/reports/wide.md", offset }));
    assert.ok(Buffer.byteLength(page.content) <= 64 * 1024, "a page holds at most 64 KiB");
    assert.ok(page.content.endsWith("\n"), "a page ends at a line end");
    pages.push(page.content);
    offset = page.nextOffset;
  }
  assert.ok(pages.length >= 2);
  assert.equal(pages.join(""), wide);

  const huge = `${"y".repeat(70 * 1024)}\nshort\n`;
  await writeArtifact(prism, "docs/plans/reports/huge.md", huge);
  const single = ok(await prism.call("get_artifact", { path: "docs/plans/reports/huge.md" }));
  assert.equal(single.content, `${"y".repeat(70 * 1024)}\n`, "a page holds at least one line");
  assert.equal(single.nextOffset, 2);
});

test("clause 11: an unknown path and a file that is not text are refused", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  refused(await prism.call("get_artifact", { path: "docs/requirements/missing.md" }), "artifact_not_found");
  await writeFile(path.join(place.store, "artifacts", "requirements", "binary.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  refused(await prism.call("get_artifact", { path: "docs/requirements/binary.md" }), "artifact_not_text");
});

test("clauses 12, 13, and 15: writes, edits, removals, and scope moves check the version last read", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const file = "docs/requirements/billing.md";
  const original = "# Billing\n\nFirst sentence.\nSecond sentence.\n";
  const created = await writeArtifact(prism, file, original);
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: "# Again\n", expectedVersion: null }] }), "version_conflict");
  const stale = refused(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: "# Stale\n", expectedVersion: version("# Other\n") }] }), "version_conflict");
  assert.equal(stale.data.version, created.version);

  const edited = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: file, expectedVersion: created.version, edits: [
    { oldText: "First sentence.", newText: "First sentence, edited." },
    { oldText: "edited.\nSecond", newText: "edited twice.\nSecond" }
  ] }] })).artifacts[0];
  const expected = "# Billing\n\nFirst sentence, edited twice.\nSecond sentence.\n";
  assert.equal(edited.version, version(expected), "each edit applies to the text that earlier edits left");
  assert.equal(ok(await prism.call("get_artifact", { path: file })).content, expected);
  const notApplied = refused(await prism.call("update_artifact", { operations: [{ op: "edit", path: file, expectedVersion: edited.version, edits: [{ oldText: "sentence", newText: "line" }] }] }), "edit_not_applied");
  assert.equal(notApplied.data.edit, 0, "text that occurs twice is not applied");
  refused(await prism.call("update_artifact", { operations: [{ op: "edit", path: file, expectedVersion: edited.version, edits: [{ oldText: "Second sentence.", newText: "Two." }, { oldText: "absent", newText: "x" }] }] }), "edit_not_applied");
  assert.equal(ok(await prism.call("get_artifact", { path: file })).content, expected, "a refused edit changes nothing");

  const moved = ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: file, expectedVersion: edited.version, scope: "repository" }] })).artifacts[0];
  assert.deepEqual(moved, { path: file, scope: { kind: "repository", repository: "api", label: "api" }, version: edited.version });
  assert.equal(await exists(path.join(place.store, "artifacts", "requirements", "billing.md")), false);
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "requirements", "billing.md")), expected);

  const removed = ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: file, expectedVersion: edited.version }] })).artifacts[0];
  assert.deepEqual(removed, { path: file, scope: { kind: "repository", repository: "api", label: "api" }, removed: true });
  assert.equal(await exists(path.join(place.store, "artifacts", "repositories", "api", "requirements", "billing.md")), false);
  refused(await prism.call("get_artifact", { path: file }), "artifact_not_found");
});

test("clause 14: a new artifact takes its folder's scope, and a path another seen scope holds cannot be created", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n", { scope: "repository" });
  const beside = await writeArtifact(prism, "docs/plans/reports/download/slice.md", "# Download\n");
  assert.equal(beside.scope.label, "api", "a file inside a folder that one scope holds takes that scope");
  const elsewhere = await writeArtifact(prism, "docs/plans/billing/slice.md", "# Billing\n");
  assert.equal(elsewhere.scope.label, "workspace", "a file without such a folder takes the workspace scope");

  await writeArtifact(prism, "docs/requirements/shared.md", "# Shared\n");
  const taken = refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/shared.md", content: "# Mine\n", expectedVersion: null, scope: "repository" }] }), "artifact_exists");
  assert.equal(taken.data.scope.label, "workspace");
  assert.equal(await exists(path.join(place.store, "artifacts", "repositories", "api", "requirements", "shared.md")), false);
});

test("clauses 16 and 17: content above 1 MiB is refused, and a refused update changes no file", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/plans/reports/big.md", content: "z".repeat(1024 * 1024 + 1), expectedVersion: null }] }), "artifact_too_large");
  const kept = await writeArtifact(prism, "docs/requirements/kept.md", "# Kept\n");
  refused(await prism.call("update_artifact", { operations: [
    { op: "write", path: "docs/requirements/new.md", content: "# New\n", expectedVersion: null },
    { op: "write", path: "docs/requirements/kept.md", content: "# Changed\n", expectedVersion: kept.version },
    { op: "remove", path: "docs/requirements/kept.md", expectedVersion: version("# Wrong\n") }
  ] }), "version_conflict");
  assert.equal(await exists(path.join(place.store, "artifacts", "requirements", "new.md")), false);
  assert.equal(await text(path.join(place.store, "artifacts", "requirements", "kept.md")), "# Kept\n");
  assert.deepEqual((await readdir(path.join(place.store, "artifacts", "requirements"))).sort(), ["kept.md"]);
});

test("clause 9: a read's text is the stored bytes decoded exactly, with a byte order mark and carriage returns, so writing it back and editing it keep them", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  const file = "docs/requirements/marked.md";
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Marked\r\nLine one.\r\nLine two.\r\n")]);
  await writeFile(path.join(place.store, "artifacts", "requirements", "marked.md"), bytes);
  const read = ok(await prism.call("get_artifact", { path: file }));
  assert.equal(read.content, "﻿# Marked\r\nLine one.\r\nLine two.\r\n");
  assert.equal(read.version, version(bytes));
  assert.equal(read.bytes, bytes.length);
  assert.equal(read.totalLines, 3);
  const pages = [];
  for (let offset = 1; offset !== null;) {
    const page = ok(await prism.call("get_artifact", { path: file, offset, limit: 1 }));
    pages.push(page.content);
    offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.from(pages.join(""), "utf8"), bytes, "the pages join to the stored bytes");
  const rewritten = ok(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: pages.join(""), expectedVersion: read.version }] })).artifacts[0];
  assert.equal(rewritten.version, read.version, "writing the text back stores the same bytes");
  assert.deepEqual(await readFile(path.join(place.store, "artifacts", "requirements", "marked.md")), bytes);
  const edited = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: file, expectedVersion: read.version, edits: [{ oldText: "Line one.", newText: "Edited." }] }] })).artifacts[0];
  const stored = await readFile(path.join(place.store, "artifacts", "requirements", "marked.md"));
  assert.deepEqual(stored, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Marked\r\nEdited.\r\nLine two.\r\n")]), "an edit changes only the text it replaces");
  assert.equal(edited.version, version(stored));
});

test("clause 11: a symbolic link or special file in the store is never followed or opened, listings leave it out, and every read and operation of it is refused with invalid_path", { skip: process.platform === "win32" }, async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const first = await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  const outside = await mkdtemp(path.join(place.parent, "outside-"));
  await writeFile(path.join(outside, "secret.md"), "# Secret\n");
  const folder = path.join(place.store, "artifacts", "requirements");
  await symlink(outside, path.join(folder, "linked"));
  await symlink(path.join(outside, "secret.md"), path.join(folder, "file-link.md"));
  execFileSync("mkfifo", [path.join(folder, "pipe.md")]);
  // A pipe blocks whoever opens it until a writer comes, so every call must answer without waiting for one.
  const prompt = async (call) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the call did not answer within 5 seconds")), 5000); });
    try { return await Promise.race([call, late]); } finally { clearTimeout(timer); }
  };
  const secret = version("# Secret\n");
  for (const [file, current] of [["docs/requirements/linked/secret.md", secret], ["docs/requirements/file-link.md", secret], ["docs/requirements/pipe.md", version("")]]) {
    refused(await prompt(prism.call("get_artifact", { path: file })), "invalid_path");
    for (const operation of [
      { op: "write", path: file, content: "# Changed\n", expectedVersion: current },
      { op: "write", path: file, content: "# Changed\n", expectedVersion: null },
      { op: "edit", path: file, expectedVersion: current, edits: [{ oldText: "Secret", newText: "Changed" }] },
      { op: "remove", path: file, expectedVersion: current },
      { op: "move_scope", path: file, expectedVersion: current, scope: "repository" }
    ]) refused(await prompt(prism.call("update_artifact", { operations: [operation] })), "invalid_path");
  }
  refused(await prompt(prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/linked/new.md", content: "# New\n", expectedVersion: null }] })), "invalid_path");
  assert.deepEqual(await readdir(outside), ["secret.md"], "nothing was written through the link");
  assert.equal(await text(path.join(outside, "secret.md")), "# Secret\n");
  assert.deepEqual(ok(await prompt(prism.call("get_artifact", { path: "docs/requirements" }))).artifacts.map((entry) => [entry.path, entry.version]), [["docs/requirements/first.md", first.version]], "a listing leaves out links and special files");
  assert.deepEqual(ok(await prompt(prism.call("get_artifact", {}))).artifacts.map((entry) => entry.path), ["docs/requirements/first.md"]);
  await prompt(writeArtifact(prism, "docs/requirements/next.md", "# Next\n"));
  assert.equal(await text(path.join(folder, "next.md")), "# Next\n", "a later update is not held behind the pipe");
});

test("clause 13: store sync replaces no artifact between an update's version checks and its last write, so an upstream change never vanishes under the update", async (context) => {
  // Store sync runs in the background of a server; here the test runs it on demand, while the checkout's server, whose path store has no Store sync line, never syncs.
  const { syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const file = "docs/requirements/billing.md";
  const location = "artifacts/requirements/billing.md";
  // A sync started while an update writes reaches its own writes only by chance, so the race runs in several fresh workspaces.
  for (let round = 1; round <= 3; round += 1) {
    const place = await syncedWorkspace(context);
    const machine = { ...place.a, sync: undefined };
    const prism = await server(context, machine, await checkout(machine, "api"));
    const base = await writeArtifact(prism, file, "# Billing\n\nThe base sentence.\n");
    assert.equal((await syncRecordStore(place.storeA)).state, "ok");
    assert.equal(remoteFile(place.remote, location), "# Billing\n\nThe base sentence.");
    // Another machine changes the same line upstream.
    git(place.storeB, "pull", "-q");
    await writeFile(path.join(place.storeB, location), "# Billing\n\nThe upstream sentence.\n");
    git(place.storeB, "add", "-A");
    git(place.storeB, "commit", "-q", "-m", "change the artifact upstream");
    git(place.storeB, "push", "-q");

    // A long update: many large new artifacts, then the artifact that changed upstream, written over the base version it read.
    const large = Array.from({ length: 49 }, (_, index) => ({ op: "write", path: `docs/plans/bulk/part-${String(index).padStart(2, "0")}.md`, content: `${String(index).padStart(2, "0")}${"z".repeat(1024 * 1024 - 8)}\n`, expectedVersion: null }));
    const update = prism.call("update_artifact", { operations: [...large, { op: "write", path: file, content: "# Billing\n\nThe local sentence.\n", expectedVersion: base.version }] });
    // Once any new artifact is in the store, the update has checked every version, and a sync runs while it writes the rest.
    const bulk = path.join(place.storeA, "artifacts", "plans", "bulk");
    const deadline = Date.now() + 60000;
    while (!(await readdir(bulk).catch(() => [])).some((name) => name.endsWith(".md"))) {
      assert.ok(Date.now() < deadline, "the update wrote no artifact within 60 seconds");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await syncRecordStore(place.storeA);
    ok(await update);
    assert.equal(await text(path.join(place.storeA, location)), "# Billing\n\nThe local sentence.\n", `round ${round}: the update wrote its change`);
    // The local change and the upstream one changed one line concurrently, so the store keeps the upstream text rather than publishing the update's write over it.
    await syncRecordStore(place.storeA);
    assert.equal(remoteFile(place.remote, location), "# Billing\n\nThe upstream sentence.", `round ${round}: the upstream change survives`);
  }
});

test("clause 13: an update's changes reach the store's history together, so no store commit holds part of one update", async (context) => {
  // As above, the test runs store sync on demand while the checkout's server never syncs.
  const { syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const before = "artifacts/requirements/billing.md";
  const after = "artifacts/repositories/api/requirements/billing.md";
  const parts = Array.from({ length: 49 }, (_, index) => `artifacts/plans/bulk/part-${String(index).padStart(2, "0")}.md`);
  // What one commit holds of the update: none of it, with the moved artifact still at its first location, or all of it.
  const holds = (store, commit) => {
    const files = new Set(git(store, "ls-tree", "-r", "--name-only", commit, "artifacts").split("\n").filter(Boolean));
    const present = parts.filter((file) => files.has(file)).length;
    return `${present} parts, ${[before, after].filter((file) => files.has(file)).join(" and ") || "no billing"}`;
  };
  const none = `0 parts, ${before}`;
  const whole = `49 parts, ${after}`;
  for (let round = 1; round <= 2; round += 1) {
    const place = await syncedWorkspace(context);
    const machine = { ...place.a, sync: undefined };
    const prism = await server(context, machine, await checkout(machine, "api"));
    const moving = await writeArtifact(prism, "docs/requirements/billing.md", "# Billing\n");
    assert.equal((await syncRecordStore(place.storeA)).state, "ok");
    const base = git(place.storeA, "rev-parse", "HEAD");
    assert.equal(holds(place.storeA, base), none);

    // A long update: many large new artifacts and a move of the stored one, which removes one location and writes another.
    const large = parts.map((file, index) => ({ op: "write", path: `docs/${file.slice("artifacts/".length)}`, content: `${String(index).padStart(2, "0")}${"z".repeat(1024 * 1024 - 8)}\n`, expectedVersion: null }));
    const update = prism.call("update_artifact", { operations: [...large, { op: "move_scope", path: "docs/requirements/billing.md", expectedVersion: moving.version, scope: "repository" }] });
    // Once any new artifact is in the store, the update is writing, and a sync runs while it writes the rest.
    const bulk = path.join(place.storeA, "artifacts", "plans", "bulk");
    const deadline = Date.now() + 60000;
    while (!(await readdir(bulk).catch(() => [])).some((name) => name.endsWith(".md"))) {
      assert.ok(Date.now() < deadline, "the update wrote no artifact within 60 seconds");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await syncRecordStore(place.storeA);
    ok(await update);
    assert.equal((await syncRecordStore(place.storeA)).state, "ok");
    const commits = git(place.storeA, "rev-list", `${base}..HEAD`).split("\n").filter(Boolean);
    assert.ok(commits.length > 0, `round ${round}: the update was committed`);
    for (const commit of commits) assert.ok([none, whole].includes(holds(place.storeA, commit)), `round ${round}: commit ${commit} holds ${holds(place.storeA, commit)}, part of the update`);
    assert.equal(holds(place.storeA, "HEAD"), whole, `round ${round}: the store's history ends with the whole update`);
    assert.equal(holds(place.remote, "main"), whole, `round ${round}: the remote holds the whole update`);
  }
});

test("clause 14: an update never creates a path that collides in letter case with one the checkout sees, and a pair the store already holds stays usable by each path", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const plan = await writeArtifact(prism, "docs/plans/x/Plan.md", "# Plan\n");
  const conflict = (response, other) => {
    const error = refused(response, "artifact_name_conflict");
    assert.equal(error.data.path, other, "data.path names the path it collides with");
    return error;
  };
  const create = (file, extra = {}) => prism.call("update_artifact", { operations: [{ op: "write", path: file, content: `# ${file}\n`, expectedVersion: null, ...extra }] });
  conflict(await create("docs/plans/x/plan.md"), "docs/plans/x/Plan.md");
  conflict(await create("docs/plans/x/PLAN.md", { scope: "repository" }), "docs/plans/x/Plan.md");
  conflict(await create("docs/plans/X/notes.md"), "docs/plans/x/Plan.md");
  conflict(await create("docs/plans/X/notes.md", { scope: "repository" }), "docs/plans/x/Plan.md");
  assert.deepEqual(await readdir(path.join(place.store, "artifacts", "plans")), ["x"], "the store's files are unchanged");
  assert.deepEqual(await readdir(path.join(place.store, "artifacts", "plans", "x")), ["Plan.md"]);
  assert.equal(await exists(path.join(place.store, "artifacts", "repositories")), false);
  // Names that differ in more than letter case, and a folder in its own letter case, collide with nothing.
  await writeArtifact(prism, "docs/plans/x/plan-2.md", "# Plan 2\n");
  await writeArtifact(prism, "docs/plans/x/notes.md", "# Notes\n");
  await writeArtifact(prism, "docs/requirements/plan.md", "# Another kind\n");

  // Two writes of one update collide with each other, and neither is written.
  const pair = refused(await prism.call("update_artifact", { operations: [
    { op: "write", path: "docs/plans/y/Notes.md", content: "# A\n", expectedVersion: null },
    { op: "write", path: "docs/plans/y/notes.md", content: "# B\n", expectedVersion: null }
  ] }), "artifact_name_conflict");
  assert.ok(["docs/plans/y/Notes.md", "docs/plans/y/notes.md"].includes(pair.data.path));
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "y")), false);

  // A path held before the update counts even when the update removes it, so a rename that changes only letter case takes two updates.
  conflict(await prism.call("update_artifact", { operations: [
    { op: "remove", path: "docs/plans/x/Plan.md", expectedVersion: plan.version },
    { op: "write", path: "docs/plans/x/plan.md", content: "# Plan\n", expectedVersion: null }
  ] }), "docs/plans/x/Plan.md");
  assert.equal(await text(path.join(place.store, "artifacts", "plans", "x", "Plan.md")), "# Plan\n");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/plans/x/Plan.md", expectedVersion: plan.version }] }));
  assert.equal((await writeArtifact(prism, "docs/plans/x/plan.md", "# Plan\n")).version, plan.version);
  assert.deepEqual((await readdir(path.join(place.store, "artifacts", "plans", "x"))).sort(), ["notes.md", "plan-2.md", "plan.md"]);

  // Two machines that created one name in two letter cases before either synced leave the store holding both.
  const repositoryCopy = await writeArtifact(prism, "docs/requirements/Totals.md", "# Totals of the repository\n", { scope: "repository" });
  await writeFile(path.join(place.store, "artifacts", "requirements", "totals.md"), "# Totals of the workspace\n");
  const workspaceVersion = version("# Totals of the workspace\n");
  const totals = (listing) => listing.artifacts.filter((entry) => /totals/i.test(entry.path)).map((entry) => [entry.path, entry.scope.label, entry.version]);
  assert.deepEqual(totals(ok(await prism.call("get_artifact", { path: "docs/requirements" }))), [
    ["docs/requirements/Totals.md", "api", repositoryCopy.version],
    ["docs/requirements/totals.md", "workspace", workspaceVersion]
  ], "a listing shows both paths");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/Totals.md" })).content, "# Totals of the repository\n");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/totals.md" })).content, "# Totals of the workspace\n");
  const editedWorkspace = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: "docs/requirements/totals.md", expectedVersion: workspaceVersion, edits: [{ oldText: "workspace", newText: "whole workspace" }] }] })).artifacts[0];
  const writtenRepository = ok(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/Totals.md", content: "# Totals, rewritten\n", expectedVersion: repositoryCopy.version }] })).artifacts[0];
  assert.equal(await text(path.join(place.store, "artifacts", "requirements", "totals.md")), "# Totals of the whole workspace\n");
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "requirements", "Totals.md")), "# Totals, rewritten\n");
  conflict(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/requirements/Totals.md", expectedVersion: writtenRepository.version, scope: "workspace" }] }), "docs/requirements/totals.md");
  const third = refused(await create("docs/requirements/TOTALS.md"), "artifact_name_conflict");
  assert.ok(["docs/requirements/Totals.md", "docs/requirements/totals.md"].includes(third.data.path));
  // Removing one path resolves the pair, after which the other moves freely.
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/requirements/totals.md", expectedVersion: editedWorkspace.version }] }));
  const moved = ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/requirements/Totals.md", expectedVersion: writtenRepository.version, scope: "workspace" }] })).artifacts[0];
  assert.equal(moved.scope.label, "workspace");
  assert.equal(await text(path.join(place.store, "artifacts", "requirements", "Totals.md")), "# Totals, rewritten\n");
});

test("clause 16: a created or moved artifact's location holds at most 120 characters, and a longer stored one stays usable", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  // "plans/" and "long/" take 11 characters of the location, so a 109-character name makes it 120.
  const named = (length) => `docs/plans/long/${"x".repeat(length - 3)}.md`;
  const location = (file, scope = "") => `${scope}${file.replace(/^docs\//, "")}`;
  const tooLong = (response, expected) => {
    const error = refused(response, "artifact_path_too_long");
    assert.equal(error.data.location, expected);
    assert.equal(error.data.limit, 120);
    return error;
  };
  const fits = await writeArtifact(prism, named(109), "# Fits\n");
  assert.equal(location(named(109)).length, 120);
  assert.equal(await text(path.join(place.store, "artifacts", location(named(109)))), "# Fits\n");
  tooLong(await prism.call("update_artifact", { operations: [{ op: "write", path: named(110), content: "# Long\n", expectedVersion: null }] }), location(named(110)));
  // The limit holds for the location in the scope the artifact would take, whose folder adds to it.
  tooLong(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/plans/long/other.md", content: "# Fits\n", expectedVersion: null }, { op: "write", path: named(100), content: "# Long here\n", expectedVersion: null, scope: "repository" }] }), location(named(100), "repositories/api/"));
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "long", "other.md")), false, "a refused update changes no file");
  tooLong(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: named(109), expectedVersion: fits.version, scope: "repository" }] }), location(named(109), "repositories/api/"));
  await writeArtifact(prism, "docs/plans/deep/slice.md", "# Deep\n", { scope: "repository" });
  const inFolder = `docs/plans/deep/${"y".repeat(100)}.md`;
  tooLong(await prism.call("update_artifact", { operations: [{ op: "write", path: inFolder, content: "# Deep file\n", expectedVersion: null }] }), location(inFolder, "repositories/api/"));
  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => entry.path), ["docs/plans/deep/slice.md", named(109)]);

  // A longer location that the store already holds, as another tool may have left it, is listed and used by its path.
  const stored = named(130);
  await writeFile(path.join(place.store, "artifacts", location(stored)), "# Stored long\n");
  const listed = ok(await prism.call("get_artifact", { path: "docs/plans/long" })).artifacts.map((entry) => entry.path);
  assert.deepEqual(listed, [named(109), stored].sort());
  const read = ok(await prism.call("get_artifact", { path: stored }));
  assert.equal(read.content, "# Stored long\n");
  const written = ok(await prism.call("update_artifact", { operations: [{ op: "write", path: stored, content: "# Stored long, changed\n", expectedVersion: read.version }] })).artifacts[0];
  const edited = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: stored, expectedVersion: written.version, edits: [{ oldText: "changed", newText: "edited" }] }] })).artifacts[0];
  assert.equal(await text(path.join(place.store, "artifacts", location(stored))), "# Stored long, edited\n");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: stored, expectedVersion: edited.version }] }));
  assert.equal(await exists(path.join(place.store, "artifacts", location(stored))), false);
});

test("clause 17: a write whose location is a folder of artifacts, lies below a stored file, or lies below another write of the update is refused with invalid_path before any file changes", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const slice = await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n");
  const attempts = [
    [{ op: "write", path: "docs/requirements/new.md", content: "# New\n", expectedVersion: null }, { op: "write", path: "docs/plans/reports", content: "# Folder\n", expectedVersion: null }],
    [{ op: "write", path: "docs/plans/a", content: "# A\n", expectedVersion: null }, { op: "write", path: "docs/plans/a/b.md", content: "# B\n", expectedVersion: null }],
    [{ op: "write", path: "docs/plans/a/b.md", content: "# B\n", expectedVersion: null }, { op: "write", path: "docs/plans/a", content: "# A\n", expectedVersion: null }],
    [{ op: "write", path: "docs/requirements/new.md", content: "# New\n", expectedVersion: null }, { op: "write", path: "docs/plans/reports/slice.md/notes.md", content: "# Notes\n", expectedVersion: null }]
  ];
  for (const operations of attempts) {
    refused(await prism.call("update_artifact", { operations }), "invalid_path");
    assert.equal(await exists(path.join(place.store, "artifacts", "requirements")), false, "the other write did not land");
    assert.equal(await exists(path.join(place.store, "artifacts", "plans", "a")), false, "neither write landed");
    assert.equal(await text(path.join(place.store, "artifacts", "plans", "reports", "slice.md")), "# Reports\n");
  }
  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => [entry.path, entry.version]), [["docs/plans/reports/slice.md", slice.version]]);
});

test("clause 18: executable artifacts and other project files are not artifact paths and stay in the checkout", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { "docs/Features/download.feature": "Feature: Download\n", "docs/user-guide/start.md": "# Start\n" } });
  const prism = await server(context, place, api);
  for (const file of ["docs/Features/download.feature", "docs/user-guide/start.md", "test/acceptance.test.mjs", "src/index.mjs", "README.md", "../outside.md", "/etc/hosts", "docs/requirements/../../README.md"]) {
    const read = refused(await prism.call("get_artifact", { path: file }), "not_an_artifact");
    assert.match(read.message, /checkout/i, `${file}: the message says the file stays in the checkout`);
    refused(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: "x\n", expectedVersion: null }] }), "not_an_artifact");
  }
  assert.equal(await text(path.join(api, "docs", "Features", "download.feature")), "Feature: Download\n");
  assert.equal(await text(path.join(api, "README.md")), "# api\n");
  assert.equal(await exists(path.join(place.store, "artifacts")), false, "nothing reached the store");
});

// The artifact name form: every name below a configured folder begins with an ASCII letter or digit, holds only ASCII letters, digits, ".", "_", and "-", does not end in "." or ".lock", and is no Windows device name.
// Each malformed path inside a configured folder is listed with the first name that breaks the form.
const malformedPaths = [
  ["docs/plans/y/.git/HEAD", ".git"], ["docs/plans/y/.git", ".git"], ["docs/plans/y/.GIT/config", ".GIT"], ["docs/plans/y/.git./HEAD", ".git."], ["docs/plans/y/.git /HEAD", ".git "],
  ["docs/plans/y/git~1/HEAD", "git~1"], ["docs/plans/y/GIT~1/HEAD", "GIT~1"], ["docs/plans/y/.g‌it/HEAD", ".g‌it"], ["docs/plans/y/﻿.git/HEAD", "﻿.git"], ["docs/plans/y/.git‮/HEAD", ".git‮"],
  ["docs/plans/.gitignore", ".gitignore"], ["docs/plans/y/.gitattributes", ".gitattributes"], ["docs/requirements/.gitmodules", ".gitmodules"], ["docs/ADRs/.GitIgnore", ".GitIgnore"], ["docs/plans/y/.gitkeep", ".gitkeep"],
  ["docs/requirements/first.md.lock", "first.md.lock"], ["docs/requirements/first.md.LOCK", "first.md.LOCK"], ["docs/plans/a.lock/slice.md", "a.lock"],
  ["docs/plans/x/.slice.md.123.abc.tmp", ".slice.md.123.abc.tmp"], ["docs/plans/x/.notes.TMP", ".notes.TMP"], ["docs/plans/ok/.hidden/notes.md", ".hidden"],
  ["docs/plans/my notes.md", "my notes.md"], ["docs/requirements/résumé.md", "résumé.md"], ["docs/plans/y/a​b.md", "a​b.md"], ["docs/plans/_drafts/x.md", "_drafts"],
  ["docs/plans/y/-rf.md", "-rf.md"], ["docs/plans/y/a~b.md", "a~b.md"], ["docs/plans/y/a:b.md", "a:b.md"], ["docs/ADRs/payments/ledger$.md", "ledger$.md"],
  ["docs/plans/x/aux.md", "aux.md"], ["docs/plans/x/NUL.txt", "NUL.txt"], ["docs/plans/x/con", "con"], ["docs/plans/x/PRN", "PRN"], ["docs/plans/Com1/slice.md", "Com1"], ["docs/plans/x/com0.md", "com0.md"],
  ["docs/plans/x/COM9.md", "COM9.md"], ["docs/plans/x/lpt0", "lpt0"], ["docs/plans/x/Lpt9.tar.gz", "Lpt9.tar.gz"], ["docs/requirements/nul.d/x.md", "nul.d"],
  ["docs/plans/x/notes.", "notes."], ["docs/plans/y./slice.md", "y."], ["docs/requirements/a..", "a.."], ["docs/plans/x/aux./b.md", "aux."]
];

function refusedAsMalformed(response, file, name) {
  const error = refused(response, "artifact_name_invalid");
  assert.equal(error.data.invalidName, name, `${JSON.stringify(file)}: data.invalidName holds the first malformed name`);
  for (const part of [/ASCII/, /letter/i, /digit/i, /\.lock/, /device/i]) assert.match(error.message, part, `${JSON.stringify(file)}: the message states the allowed name form`);
  assert.doesNotMatch(error.message, /checkout/i, `${JSON.stringify(file)}: the message does not send the file to the checkout`);
  return error;
}

test("clauses 1 and 18: only a path whose names follow the artifact name form is an artifact path, a malformed one is refused with the form, and none reaches the store's Git", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const kept = [
    "docs/plans/digit/slice.md", "docs/plans/my.git/slice.md", "docs/plans/y/notes.tmp", "docs/plans/y/lock.md", "docs/plans/y/file.lockfile", "docs/plans/y/gitignore",
    "docs/requirements/locks.md", "docs/plans/Report_2/v1.0-draft.md", "docs/plans/9lives/x...y", "docs/ADRs/0001-Use-Git.md", "docs/Glossary.md", "docs/roadmap.md",
    "docs/plans/x/auxiliary.md", "docs/plans/x/console", "docs/plans/x/com10.md", "docs/plans/x/lpt.md", "docs/plans/x/nul-results.md", "docs/plans/x/my.con.md", "docs/plans/x/x.aux"
  ];
  for (const file of kept) await writeArtifact(prism, file, `# ${file}\n`);
  for (const [file, name] of malformedPaths) {
    refusedAsMalformed(await prism.call("get_artifact", { path: file }), file, name);
    refusedAsMalformed(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: "*\n", expectedVersion: null }] }), file, name);
  }
  refusedAsMalformed(await prism.call("get_artifact", { path: "docs/plans/_drafts" }), "docs/plans/_drafts", "_drafts");
  // One malformed name refuses the whole update, so the artifact beside it is not written either.
  refusedAsMalformed(await prism.call("update_artifact", { operations: [
    { op: "write", path: "docs/plans/y/extra.md", content: "# Extra\n", expectedVersion: null },
    { op: "write", path: "docs/plans/.gitignore", content: "*\n", expectedVersion: null }
  ] }), "docs/plans/.gitignore", ".gitignore");
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "y", "extra.md")), false);
  // A malformed name outside the configured folders is an ordinary project file, which stays in the checkout.
  for (const file of [".gitignore", "src/.gitattributes", "README.md.lock", "notes/my notes.md"]) {
    assert.match(refused(await prism.call("get_artifact", { path: file }), "not_an_artifact").message, /checkout/i, `${file}: the message says the file stays in the checkout`);
  }

  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => entry.path), [...kept].sort());
  // The store's Git, with the ignore file Prism writes into a store, adds every file Prism wrote, and no rule file of its own changes what it tracks.
  await writeFile(path.join(place.store, ".gitignore"), "*.lock\n.*.tmp\n/.prism-sync/\n");
  git(place.store, "init", "-q", "-b", "main");
  git(place.store, "add", "-A", "--", ".");
  const location = (file) => `artifacts/${file.replace(/^docs\/plans\//, "plans/").replace(/^docs\/requirements\//, "requirements/").replace(/^docs\/ADRs\//, "adrs/").replace(/^docs\/Glossary\.md$/, "glossary.md").replace(/^docs\/roadmap\.md$/, "roadmap.md")}`;
  assert.deepEqual(git(place.store, "ls-files", "--", "artifacts").split("\n").filter(Boolean).sort(), kept.map(location).sort());
});

test("clauses 1 and 18: the configured glossary and roadmap file names follow the artifact name form", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { paths: ["- Plans: docs/plans", "- Glossary: docs/_glossary.md", "- Roadmap: docs/.roadmap.md"] });
  const prism = await server(context, place, api);
  for (const [file, name] of [["docs/_glossary.md", "_glossary.md"], ["docs/.roadmap.md", ".roadmap.md"]]) {
    refusedAsMalformed(await prism.call("get_artifact", { path: file }), file, name);
    refusedAsMalformed(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: "# Glossary\n", expectedVersion: null }] }), file, name);
  }
  assert.equal(await exists(path.join(place.store, "artifacts", "glossary.md")), false);
  assert.equal(await exists(path.join(place.store, "artifacts", "roadmap.md")), false);
});

test("clauses 1 and 18: files with malformed names that the store holds are left out of listings and refused by every operation", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const slice = await writeArtifact(prism, "docs/plans/y/slice.md", "# Slice\n");
  const requirement = await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  // Store sync leaves lock and temporary files beside a store file while it writes, and an older Prism or another tool may have left other names.
  const planted = {
    "plans/y/slice.md.lock": ["docs/plans/y/slice.md.lock", "slice.md.lock"],
    "plans/y/.slice.md.4242.0a1b2c3d.tmp": ["docs/plans/y/.slice.md.4242.0a1b2c3d.tmp", ".slice.md.4242.0a1b2c3d.tmp"],
    "plans/y/.gitattributes": ["docs/plans/y/.gitattributes", ".gitattributes"],
    "plans/y/.git/HEAD": ["docs/plans/y/.git/HEAD", ".git"],
    "plans/y/my notes.md": ["docs/plans/y/my notes.md", "my notes.md"],
    "plans/_drafts/slice.md": ["docs/plans/_drafts/slice.md", "_drafts"],
    "requirements/.gitignore": ["docs/requirements/.gitignore", ".gitignore"],
    "plans/y/aux.md": ["docs/plans/y/aux.md", "aux.md"],
    "plans/y/notes.": ["docs/plans/y/notes.", "notes."],
    "repositories/api/requirements/first.md.lock": ["docs/requirements/first.md.lock", "first.md.lock"]
  };
  for (const location of Object.keys(planted)) {
    await mkdir(path.dirname(path.join(place.store, "artifacts", location)), { recursive: true });
    await writeFile(path.join(place.store, "artifacts", location), "planted\n");
  }
  const expected = [["docs/plans/y/slice.md", slice.version], ["docs/requirements/first.md", requirement.version]];
  const entries = (listing) => listing.artifacts.map((entry) => [entry.path, entry.version]);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", {}))), expected);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", { path: "docs/plans" }))), [expected[0]]);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", { path: "docs/plans/y" }))), [expected[0]]);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", { path: "docs/requirements" }))), [expected[1]]);
  for (const [file, name] of new Map(Object.values(planted))) {
    refusedAsMalformed(await prism.call("get_artifact", { path: file }), file, name);
    refusedAsMalformed(await prism.call("get_artifact", { path: file, scope: "repository" }), file, name);
    for (const operation of [
      { op: "write", path: file, content: "changed\n", expectedVersion: version("planted\n") },
      { op: "edit", path: file, expectedVersion: version("planted\n"), edits: [{ oldText: "planted", newText: "changed" }] },
      { op: "remove", path: file, expectedVersion: version("planted\n") },
      { op: "move_scope", path: file, expectedVersion: version("planted\n"), scope: "repository" }
    ]) refusedAsMalformed(await prism.call("update_artifact", { operations: [operation] }), `${operation.op} ${file}`, name);
  }
  for (const location of Object.keys(planted)) assert.equal(await text(path.join(place.store, "artifacts", location)), "planted\n", `${location} is left as it was`);
});

test("clause 20: a project without a store keeps its artifacts in the checkout and the artifact tools refuse", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { store: null, files: { "docs/requirements/billing.md": "# Billing\n" } });
  const prism = await server(context, place, api);
  refused(await prism.call("get_artifact", { path: "docs/requirements/billing.md" }), "store_not_configured");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/other.md", content: "# Other\n", expectedVersion: null }] }), "store_not_configured");
  assert.equal(await text(path.join(api, "docs", "requirements", "billing.md")), "# Billing\n");
  assert.equal(await exists(path.join(api, "docs", "requirements", "other.md")), false);
});

test("clause 21: an unavailable store or a refused repository name refuses every artifact read and write without using the checkout", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { store: "../missing-store", files: { "docs/requirements/billing.md": "# Billing\n" } });
  const prism = await server(context, place, api);
  const read = refused(await prism.call("get_artifact", { path: "docs/requirements/billing.md" }), "store_unavailable");
  assert.match(read.message, /\.\.\/missing-store/, "the message names the store as configured");
  refused(await prism.call("get_artifact", {}), "store_unavailable");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/other.md", content: "# Other\n", expectedVersion: null }] }), "store_unavailable");
  assert.equal(await exists(path.join(api, "docs", "requirements", "other.md")), false);
  assert.equal(await text(path.join(api, "docs", "requirements", "billing.md")), "# Billing\n");

  const web = await checkout(place, "web");
  await commitFiles(web, { ".prism/workflow.md": "## Paths\n- Plans: docs/plans\n\n## Workspace\n- Store: ../store\n" }, "name no repository");
  const unnamed = await server(context, place, web);
  refused(await unnamed.call("get_artifact", {}), "repository_name_missing");
  refused(await unnamed.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/web.md", content: "# Web\n", expectedVersion: null }] }), "repository_name_missing");
  assert.equal(await exists(path.join(place.store, "artifacts")), false);
});
