import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, commitFiles, exists, git, isolateGit, ok, refused, server, text, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

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

// Names the store's Git reads, or that Prism's own lock and temporary files take beside store files, inside configured folders.
const reservedPaths = [
  "docs/plans/y/.git/HEAD", "docs/plans/y/.git", "docs/plans/y/.GIT/config", "docs/plans/y/.git./HEAD", "docs/plans/y/.git /HEAD",
  "docs/plans/y/git~1/HEAD", "docs/plans/y/GIT~1/HEAD", "docs/plans/y/.g\u200cit/HEAD", "docs/plans/y/\ufeff.git/HEAD", "docs/plans/y/.git\u202e/HEAD",
  "docs/plans/.gitignore", "docs/plans/y/.gitattributes", "docs/requirements/.gitmodules", "docs/ADRs/.GitIgnore", "docs/plans/y/.gitkeep",
  "docs/requirements/first.md.lock", "docs/requirements/first.md.LOCK", "docs/plans/x/.slice.md.123.abc.tmp", "docs/plans/x/.notes.TMP"
];

function refusedAsReserved(response, file) {
  const error = refused(response, "not_an_artifact");
  assert.match(error.message, /reserve/i, `${JSON.stringify(file)}: the message says the store reserves the name`);
  assert.doesNotMatch(error.message, /checkout/i, `${JSON.stringify(file)}: the message does not send the file to the checkout`);
  return error;
}

test("clauses 1 and 18: a reserved name inside a configured folder is no artifact path, is refused as reserved, and never reaches the store's Git", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const kept = ["docs/plans/digit/slice.md", "docs/plans/my.git/slice.md", "docs/plans/y/notes.tmp", "docs/plans/y/lock.md", "docs/requirements/locks.md"];
  for (const file of kept) await writeArtifact(prism, file, `# ${file}\n`);
  for (const file of reservedPaths) {
    refusedAsReserved(await prism.call("get_artifact", { path: file }), file);
    refusedAsReserved(await prism.call("update_artifact", { operations: [{ op: "write", path: file, content: "*\n", expectedVersion: null }] }), file);
  }
  // One reserved name refuses the whole update, so the artifact beside it is not written either.
  refusedAsReserved(await prism.call("update_artifact", { operations: [
    { op: "write", path: "docs/plans/y/extra.md", content: "# Extra\n", expectedVersion: null },
    { op: "write", path: "docs/plans/.gitignore", content: "*\n", expectedVersion: null }
  ] }), "docs/plans/.gitignore");
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "y", "extra.md")), false);
  // A reserved name outside the configured folders is an ordinary project file, which stays in the checkout.
  for (const file of [".gitignore", "src/.gitattributes", "README.md.lock"]) {
    assert.match(refused(await prism.call("get_artifact", { path: file }), "not_an_artifact").message, /checkout/i, `${file}: the message says the file stays in the checkout`);
  }

  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => entry.path), [...kept].sort());
  // The store's Git adds every file Prism wrote, and no rule file of its own changes what it tracks.
  git(place.store, "init", "-q", "-b", "main");
  git(place.store, "add", "-A", "--", ".");
  assert.deepEqual(git(place.store, "ls-files", "--", "artifacts").split("\n").sort(), ["artifacts/plans/digit/slice.md", "artifacts/plans/my.git/slice.md", "artifacts/plans/y/lock.md", "artifacts/plans/y/notes.tmp", "artifacts/requirements/locks.md"]);
});

test("clauses 1 and 18: files with reserved names that the store holds are left out of listings and refused by every operation", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const slice = await writeArtifact(prism, "docs/plans/y/slice.md", "# Slice\n");
  const requirement = await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  // Store sync leaves lock and temporary files beside a store file while it writes, and an older Prism or another tool may have left Git files.
  const planted = {
    "plans/y/slice.md.lock": "docs/plans/y/slice.md.lock",
    "plans/y/.slice.md.4242.0a1b2c3d.tmp": "docs/plans/y/.slice.md.4242.0a1b2c3d.tmp",
    "plans/y/.gitattributes": "docs/plans/y/.gitattributes",
    "plans/y/.git/HEAD": "docs/plans/y/.git/HEAD",
    "requirements/.gitignore": "docs/requirements/.gitignore",
    "repositories/api/requirements/first.md.lock": "docs/requirements/first.md.lock"
  };
  for (const location of Object.keys(planted)) {
    await mkdir(path.dirname(path.join(place.store, "artifacts", location)), { recursive: true });
    await writeFile(path.join(place.store, "artifacts", location), "planted\n");
  }
  const expected = [["docs/plans/y/slice.md", slice.version], ["docs/requirements/first.md", requirement.version]];
  const entries = (listing) => listing.artifacts.map((entry) => [entry.path, entry.version]);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", {}))), expected);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", { path: "docs/plans/y" }))), [expected[0]]);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", { path: "docs/requirements" }))), [expected[1]]);
  for (const file of new Set(Object.values(planted))) {
    refusedAsReserved(await prism.call("get_artifact", { path: file }), file);
    refusedAsReserved(await prism.call("get_artifact", { path: file, scope: "repository" }), file);
    for (const operation of [
      { op: "write", path: file, content: "changed\n", expectedVersion: version("planted\n") },
      { op: "edit", path: file, expectedVersion: version("planted\n"), edits: [{ oldText: "planted", newText: "changed" }] },
      { op: "remove", path: file, expectedVersion: version("planted\n") },
      { op: "move_scope", path: file, expectedVersion: version("planted\n"), scope: "repository" }
    ]) refusedAsReserved(await prism.call("update_artifact", { operations: [operation] }), `${operation.op} ${file}`);
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
