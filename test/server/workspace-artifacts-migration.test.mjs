import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, cloneOf, commitFiles, git, exists, isolateGit, notes, ok, requirementFile, server, text, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 26-29 and the moved-file case of clause 31 of the workspace-artifacts design: existing artifacts move into the store once, a checkout's roadmap view leaves only when the store's roadmap record generates the same view, and files with malformed or colliding names stay in the checkout.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const DESCRIPTIVE = {
  "docs/requirements/billing.md": requirementFile("Billing", "Approved", "2026-10-01"),
  "docs/ADRs/payments/ledger.md": "# Ledger\n\nStatus: Accepted\nCreated: 2026-10-01\n\n## Decision\n\nKeep a ledger.\n",
  "docs/ADRs/payments/ledger.puml": "@startuml\ncomponent Ledger\n@enduml\n",
  "docs/plans/reports/slice.md": "# Reports\n\nSee [the ledger](../../ADRs/payments/ledger.md).\n",
  "docs/plans/reports/probes/size.mjs": "console.log(1);\n",
  "docs/Glossary.md": "# Glossary\n"
};
const EXECUTABLE = {
  "docs/Features/download.feature": "Feature: Download\n",
  "docs/user-guide/start.md": "# Start\n"
};
const LOCATIONS = {
  "docs/requirements/billing.md": "requirements/billing.md",
  "docs/ADRs/payments/ledger.md": "adrs/payments/ledger.md",
  "docs/ADRs/payments/ledger.puml": "adrs/payments/ledger.puml",
  "docs/plans/reports/slice.md": "plans/reports/slice.md",
  "docs/plans/reports/probes/size.mjs": "plans/reports/probes/size.mjs",
  "docs/Glossary.md": "glossary.md"
};
const scoped = (store, location) => path.join(store, "artifacts", "repositories", "api", location);

async function ledgerFiles(store) {
  const folder = path.join(store, "artifact-migrations");
  const names = await readdir(folder).catch(() => []);
  return Promise.all(names.sort().map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8"))));
}

test("clauses 26, 29, and 31: the first access moves every descriptive file into the repository's scope, keeps executable files, and reports moves and references", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: {
    ...DESCRIPTIVE, ...EXECUTABLE,
    "AGENTS.md": "# Agents\n\nRead the decisions in docs/ADRs before changing code.\n",
    "README.md": "# api\n\nThe ledger decision:\nsee docs/ADRs/payments/ledger.md.\n"
  } });
  const prism = await server(context, place, api);
  const first = await prism.call("get_artifact", {});
  const listed = ok(first);
  assert.deepEqual(listed.artifacts.map((entry) => entry.path).sort(), Object.keys(DESCRIPTIVE).sort());
  assert.ok(listed.artifacts.every((entry) => entry.scope.label === "api"), "moved files belong to the repository's scope");

  for (const [file, location] of Object.entries(LOCATIONS)) {
    assert.equal(await text(scoped(place.store, location)), DESCRIPTIVE[file], `${file} moved to its location in the repository's scope`);
    assert.equal(await exists(path.join(api, file)), false, `${file} left the checkout`);
  }
  for (const [file, contents] of Object.entries(EXECUTABLE)) assert.equal(await text(path.join(api, file)), contents, `${file} stays in the checkout`);
  assert.equal(await text(path.join(api, "test", "acceptance.test.mjs")), "// frozen acceptance test\n");

  const [ledger] = await ledgerFiles(place.store);
  assert.equal(ledger.repository, "api");
  assert.equal(JSON.stringify(ledger).includes("docs/requirements/billing.md"), true, "the ledger names each move");

  const report = notes(first);
  for (const [file, location] of Object.entries(LOCATIONS)) {
    assert.ok(report.includes(file), `the report names ${file}`);
    assert.ok(report.includes(`repositories/api/${location}`), `the report names the store location of ${file}`);
  }
  assert.match(report, /AGENTS\.md:3\b/, "the report names a tracked file that names a moved folder, with its line");
  assert.match(report, /README\.md:4\b/, "the report names a tracked file that names a moved file, with its line");
  assert.doesNotMatch(report, /download\.feature/);

  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/billing.md" })).status, "Approved", "a moved file's written status is its recorded status");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/ADRs/payments/ledger.md" })).statusMismatch, undefined);
});

test("clauses 27 and 28: another checkout's identical files are removed, differing ones are kept, and a moved path is never moved again", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: DESCRIPTIVE });
  // Two more clones hold the committed files, as checkouts on other machines or stale branches do.
  const second = await cloneOf(api, place.parent, "api-second", { remote: "https://github.com/acme/api.git" });
  const third = await cloneOf(api, place.parent, "api-third", { remote: "https://github.com/acme/api.git" });
  ok(await (await server(context, place, api)).call("get_artifact", {}));
  for (const file of Object.keys(DESCRIPTIVE)) assert.equal(await exists(path.join(api, file)), false);

  const edited = requirementFile("Billing edited", "Approved", "2026-10-01");
  await commitFiles(second, { "docs/requirements/billing.md": edited }, "edit on the second clone");
  const onSecond = await server(context, place, second);
  const access = await onSecond.call("get_artifact", {});
  ok(access);
  const report = notes(access);
  assert.equal(await exists(path.join(second, "docs/ADRs/payments/ledger.md")), false, "an identical file is removed");
  assert.match(report, /docs\/ADRs\/payments\/ledger\.md/, "an identical file is reported as moved");
  assert.equal(await text(path.join(second, "docs/requirements/billing.md")), edited, "a differing file stays");
  assert.equal(await text(scoped(place.store, "requirements/billing.md")), DESCRIPTIVE["docs/requirements/billing.md"], "the store keeps its own copy");
  assert.match(report, /differs/);
  assert.ok(report.includes("repositories/api/requirements/billing.md"), "the report names the store's location");
  assert.ok(report.includes("docs/requirements/billing.md"), "the report names the checkout's location");

  // An artifact removed from the store is not brought back by a checkout that still holds it.
  const glossary = ok(await onSecond.call("get_artifact", { path: "docs/Glossary.md" }));
  ok(await onSecond.call("update_artifact", { operations: [{ op: "remove", path: "docs/Glossary.md", expectedVersion: glossary.version }] }));
  const onThird = await server(context, place, third);
  const later = await onThird.call("get_artifact", {});
  ok(later);
  assert.equal(await text(path.join(third, "docs/Glossary.md")), DESCRIPTIVE["docs/Glossary.md"], "the checkout keeps the file");
  assert.equal(await exists(scoped(place.store, "glossary.md")), false, "the store does not take it back");
  assert.match(notes(later), /removed_in_store/);
  assert.equal(await exists(path.join(third, "docs/requirements/billing.md")), false, "the third clone's identical files are removed");
  assert.equal(version(await text(scoped(place.store, "requirements/billing.md"))), version(DESCRIPTIVE["docs/requirements/billing.md"]));
});

test("clause 28: a checkout's roadmap view is removed when the store's roadmap record generates the same view, and kept when it differs or the store holds no roadmap record", async (context) => {
  const place = await workspace(context);
  // A project without a store keeps its roadmap record and the view generated from it in the checkout, as an existing project does.
  const plain = await checkout(place, "plain", { store: null });
  ok(await (await server(context, place, plain)).call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  const record = await text(path.join(plain, ".prism", "roadmap.json"));
  const view = await text(path.join(plain, "docs", "roadmap.md"));
  assert.ok(record && view, "the project without a store holds the roadmap record and its view");

  const api = await checkout(place, "api", { files: { ".prism/roadmap.json": record, "docs/roadmap.md": view, "docs/plans/reports/slice.md": "# Reports\n" } });
  const onApi = await server(context, place, api);
  const first = await onApi.call("get_artifact", {});
  assert.deepEqual(ok(first).artifacts.map((entry) => [entry.path, entry.scope.label]), [["docs/plans/reports/slice.md", "api"], ["docs/roadmap.md", "workspace"]]);
  assert.equal(await text(path.join(place.store, "artifacts", "roadmap.md")), view, "the store holds the view generated from the moved record");
  assert.equal(await exists(path.join(api, "docs/roadmap.md")), false, "the checkout's identical view is removed");
  assert.equal(await exists(scoped(place.store, "roadmap.md")), false, "no roadmap view enters the repository's scope");
  assert.match(notes(first), /docs\/roadmap\.md/, "the removed view is reported as moved");
  assert.doesNotMatch(notes(first), /view_differs|no_roadmap_record/);
  const [ledger] = await ledgerFiles(place.store);
  assert.ok(JSON.stringify(ledger).includes("docs/roadmap.md"), "the ledger lists the removed view");
  assert.equal(ok(await onApi.call("get_artifact", { path: "docs/roadmap.md" })).content, view, "the roadmap view resolves to the workspace scope alone");

  // The record changes after the move, so a checkout still holding the earlier view holds a stale one.
  ok(await onApi.call("update_roadmap", { expectedRevision: ok(await onApi.call("get_roadmap", {})).revision, operations: [{ op: "add_initiative", id: "billing", title: "Billing", intent: "Billing ships.", band: "Next", requirements: ["r.md§2"] }] }));
  const current = await text(path.join(place.store, "artifacts", "roadmap.md"));
  assert.match(current, /Billing/);
  const edited = `${view}\nA note written by hand.\n`;
  for (const [name, contents] of [["web", view], ["site", edited]]) {
    const root = await checkout(place, name, { files: { "docs/roadmap.md": contents } });
    const access = await (await server(context, place, root)).call("get_artifact", {});
    ok(access);
    assert.equal(await text(path.join(root, "docs/roadmap.md")), contents, `${name}'s differing view stays in the checkout with its bytes`);
    assert.equal(await text(path.join(place.store, "artifacts", "roadmap.md")), current, "the store keeps the view of its record");
    assert.equal(await exists(path.join(place.store, "artifacts", "repositories", name, "roadmap.md")), false);
    const report = notes(access);
    assert.match(report, /view_differs/);
    assert.match(report, /update_roadmap/, "the report says that content the record lacks goes in through update_roadmap");
    assert.ok(report.includes("docs/roadmap.md"), "the report names the checkout path");
    const kept = (await ledgerFiles(place.store)).find((entry) => entry.repository === name);
    assert.ok(JSON.stringify(kept).includes("docs/roadmap.md"), `the ledger lists ${name}'s view as kept`);
  }

  // A store without a roadmap record has no view to compare, so a hand-written roadmap stays.
  const empty = await workspace(context);
  const ops = await checkout(empty, "ops", { files: { "docs/roadmap.md": "# Roadmap\n\nWritten by hand.\n" } });
  const access = await (await server(context, empty, ops)).call("get_artifact", {});
  assert.deepEqual(ok(access).artifacts, []);
  assert.equal(await text(path.join(ops, "docs/roadmap.md")), "# Roadmap\n\nWritten by hand.\n");
  assert.equal(await exists(path.join(empty.store, "artifacts", "roadmap.md")), false);
  assert.equal(await exists(scoped(empty.store, "roadmap.md")), false);
  assert.match(notes(access), /no_roadmap_record/);
  assert.match(notes(access), /update_roadmap/);
  const [kept] = await ledgerFiles(empty.store);
  assert.ok(JSON.stringify(kept).includes("docs/roadmap.md"), "the ledger lists the hand-written roadmap as kept");
});

test("clause 28: a checkout file whose path the workspace scope holds stays in the checkout", async (context) => {
  const place = await workspace(context);
  const web = await checkout(place, "web");
  const onWeb = await server(context, place, web);
  await writeArtifact(onWeb, "docs/requirements/shared.md", "# Shared for the workspace\n");
  const api = await checkout(place, "api", { files: { "docs/requirements/shared.md": "# Shared in api\n" } });
  const onApi = await server(context, place, api);
  const access = await onApi.call("get_artifact", { path: "docs/requirements/shared.md" });
  assert.equal(ok(access).content, "# Shared for the workspace\n");
  assert.equal(await text(path.join(api, "docs/requirements/shared.md")), "# Shared in api\n");
  assert.equal(await exists(scoped(place.store, "requirements/shared.md")), false);
  assert.match(notes(access), /workspace_holds/);
});

test("clause 28: a checkout file whose path breaks the artifact name form stays in the checkout and is reported as name_invalid", async (context) => {
  const place = await workspace(context);
  const malformed = {
    "docs/plans/reports/.DS_Store": "finder\n",
    "docs/plans/reports/my notes.md": "# Notes\n",
    "docs/plans/_drafts/slice.md": "# Draft\n",
    "docs/requirements/.gitignore": "*.tmp\n",
    "docs/requirements/résumé.md": "# Resume\n",
    "docs/ADRs/payments/ledger.md.lock": "locked\n",
    "docs/plans/reports/aux.md": "# Device name\n",
    "docs/plans/reports/notes.": "# Trailing dot\n"
  };
  const api = await checkout(place, "api", { files: { "docs/plans/reports/slice.md": "# Reports\n", ...malformed } });
  const prism = await server(context, place, api);
  const access = await prism.call("get_artifact", {});
  assert.deepEqual(ok(access).artifacts.map((entry) => entry.path), ["docs/plans/reports/slice.md"]);
  assert.equal(await text(scoped(place.store, "plans/reports/slice.md")), "# Reports\n", "a well-formed file beside them still moves");
  assert.equal(await exists(path.join(api, "docs/plans/reports/slice.md")), false);

  const report = notes(access);
  assert.match(report, /name_invalid/);
  const [ledger] = await ledgerFiles(place.store);
  for (const [file, contents] of Object.entries(malformed)) {
    assert.equal(await text(path.join(api, file)), contents, `${file} stays in the checkout with its bytes`);
    assert.ok(report.includes(file), `the report names ${file}`);
    assert.ok(JSON.stringify(ledger).includes(JSON.stringify(file).slice(1, -1)), `the ledger lists ${file} as kept`);
  }
  const stored = await readdir(path.join(place.store, "artifacts"), { recursive: true });
  assert.deepEqual(stored.filter((entry) => /\.DS_Store|my notes|_drafts|\.gitignore|résum|\.lock$|aux\.md|notes\.$/.test(entry)), [], "no malformed name reached the store");
});

test("clause 28: a checkout file whose path collides in letter case with a stored path or another checkout file stays in the checkout and is reported as name_conflict", async (context) => {
  const place = await workspace(context);
  const web = await checkout(place, "web");
  await writeArtifact(await server(context, place, web), "docs/requirements/Shared.md", "# Shared for the workspace\n");
  const colliding = {
    "docs/requirements/shared.md": "# Shared in api\n",
    "docs/plans/reports/Notes.md": "# Notes in one case\n",
    "docs/plans/reports/notes.md": "# Notes in another case\n"
  };
  const api = await checkout(place, "api", { files: { "docs/plans/reports/slice.md": "# Reports\n", ...colliding } });
  const prism = await server(context, place, api);
  const access = await prism.call("get_artifact", {});
  assert.deepEqual(ok(access).artifacts.map((entry) => [entry.path, entry.scope.label]), [["docs/plans/reports/slice.md", "api"], ["docs/requirements/Shared.md", "workspace"]]);
  assert.equal(await text(scoped(place.store, "plans/reports/slice.md")), "# Reports\n", "a file beside them that collides with nothing still moves");
  assert.equal(await exists(path.join(api, "docs/plans/reports/slice.md")), false);
  assert.equal(await text(path.join(place.store, "artifacts", "requirements", "Shared.md")), "# Shared for the workspace\n");

  const report = notes(access);
  assert.match(report, /name_conflict/);
  assert.ok(report.includes("docs/requirements/Shared.md"), "the report names the stored path a checkout file collides with");
  const ledger = (await ledgerFiles(place.store)).find((entry) => entry.repository === "api");
  for (const [file, contents] of Object.entries(colliding)) {
    assert.equal(await text(path.join(api, file)), contents, `${file} stays in the checkout with its bytes`);
    assert.ok(report.includes(file), `the report names ${file}`);
    assert.ok(JSON.stringify(ledger).includes(file), `the ledger lists ${file} as kept`);
  }
  const stored = await readdir(path.join(place.store, "artifacts"), { recursive: true });
  assert.deepEqual(stored.filter((entry) => /notes\.md$|shared\.md$/i.test(entry)), ["requirements/Shared.md"], "no colliding path reached the store");
});

test("clause 28: a checkout file whose location in the repository's scope would hold more than 120 characters stays in the checkout and is reported as path_too_long", async (context) => {
  const place = await workspace(context);
  // "repositories/api/plans/reports/" takes 31 characters of the location, so an 89-character name makes it 120.
  const fits = `docs/plans/reports/${"f".repeat(86)}.md`;
  const long = `docs/plans/reports/${"l".repeat(87)}.md`;
  const api = await checkout(place, "api", { files: { [fits]: "# Fits\n", [long]: "# Long\n" } });
  const prism = await server(context, place, api);
  const access = await prism.call("get_artifact", {});
  assert.deepEqual(ok(access).artifacts.map((entry) => entry.path), [fits]);
  assert.equal(await text(scoped(place.store, fits.replace(/^docs\//, ""))), "# Fits\n", "a file whose location holds 120 characters moves");
  assert.equal(await exists(path.join(api, fits)), false);
  assert.equal(await text(path.join(api, long)), "# Long\n", "the longer file stays in the checkout with its bytes");
  assert.equal(await exists(scoped(place.store, long.replace(/^docs\//, ""))), false);
  const report = notes(access);
  assert.match(report, /path_too_long/);
  assert.ok(report.includes(long), "the report names the checkout path");
  assert.ok(report.includes(`repositories/api/${long.replace(/^docs\//, "")}`), "the report names the location it would take");
  const [ledger] = await ledgerFiles(place.store);
  assert.ok(JSON.stringify(ledger).includes(long), "the ledger lists the file as kept");
});
