import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DECLARATION, INITIATIVE, THREE, command, componentProject, planAndAccept, plannedSlice, read, refusal, slicePlan, update, workflow } from "./fixtures/components.mjs";
import { prismServer } from "./fixtures/repository-checkouts.mjs";

// Requirements: docs/requirements/components.md §3-§14.
// Contract: docs/plans/components/component-slices/slice.md clauses 1-15 and 36-38.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-declarations-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const billing = (changes = THREE[0].changes, tests = THREE[0].tests, component = "billing") => ({ slug: "billing-totals", component, requirement: "r.md#1", changes, tests });
const rest = THREE.slice(1);
const components = (record) => Object.fromEntries(Object.entries(record.slices).filter(([, slice]) => slice.component !== undefined).map(([slug, slice]) => [slug, slice.component]));

// Propose a plan whose first slice is the given one and whose other slices are the usual shared and web slices.
async function propose(root, first, others = rest) {
  for (const slice of [first, ...others]) await plannedSlice(root, slice.slug, slice.changes);
  return update(root, [{ op: "propose_design", slug: INITIATIVE, operations: slicePlan([first, ...others]) }]);
}

const withComponents = (lines) => workflow({ components: ["## Components", ...lines, ""].join("\n") });

// A project whose root slice holds only r.md#1, so a plan of one slice covers it.
const solo = (context, config = workflow()) => componentProject(context, { config, requirements: ["r.md#1"] });

test("clause 1: components are read from top-level items with nested test commands and dependencies, ignoring prose and label case and notes", async (context) => {
  const config = workflow({ components: DECLARATION.replace("## Components\n", "## Components\nThe packages below each test on their own.\n\n") });
  const root = await componentProject(context, { config });
  const accepted = await planAndAccept(root, THREE);
  assert.deepEqual(components(accepted.record), { "billing-totals": "root/billing", "shared-values": "root/shared", "web-pages": "root/web" });
  const unknown = await solo(context, withComponents(["- billing: packages/billing", "  - Owner: payments"]));
  const error = await refusal(propose(unknown, billing(), []), "component_invalid");
  assert.equal(error.entry, "  - Owner: payments");
  const orphan = await solo(context, withComponents([`  - Test command: ${command("billing")}`, "- billing: packages/billing"]));
  assert.equal((await refusal(propose(orphan, billing(), []), "component_invalid")).entry, `  - Test command: ${command("billing")}`);
});

test("clause 2: a component name follows the repository name rule", async (context) => {
  for (const line of ["- Billing: packages/billing", "- -billing: packages/billing", "- billing-: packages/billing", "- bill ing: packages/billing", `- a${"b".repeat(63)}c: packages/billing`]) {
    const root = await solo(context, withComponents([line]));
    const error = await refusal(propose(root, billing(), []), "component_invalid");
    assert.equal(error.entry, line);
  }
  const longest = `a${"b".repeat(62)}c`;
  const root = await solo(context, withComponents([`- ${longest}: packages/billing`]));
  const accepted = await planAndAccept(root, [billing(undefined, undefined, longest)]);
  assert.equal(accepted.record.slices["billing-totals"].component, `root/${longest}`);
});

test("clause 3: a folder is a normalized project-relative path, and a declared folder need not exist yet", async (context) => {
  for (const folder of ["", ".", "/srv/billing", "packages\\billing", "c:/billing", "packages//billing", "packages/./billing", "packages/../billing", "../billing"]) {
    const line = `- billing: ${folder}`.trimEnd();
    const root = await solo(context, withComponents([line]));
    const error = await refusal(propose(root, billing(), []), "component_invalid");
    assert.equal(error.entry, line, `folder ${JSON.stringify(folder)}`);
  }
  const root = await solo(context, withComponents(["- billing: packages/billing/", "- later: packages/later"]));
  const proposed = await propose(root, billing(), []);
  assert.ok(proposed.record.proposals[INITIATIVE], "a trailing slash and a folder that does not exist yet are accepted");
});

test("clause 4: any slice may change a file under a shared path, and an invalid shared path is refused", async (context) => {
  const root = await componentProject(context);
  const accepted = await planAndAccept(root, [billing(["change `packages/billing/index.mjs`, `package-lock.json`, `config/shared/base.json`: `total` (§1)"]), ...rest]);
  assert.equal(accepted.record.slices["billing-totals"].component, "root/billing");
  const near = await componentProject(context);
  const error = await refusal(propose(near, billing(["change `package-lock.json.bak`, `config/shared-extra.json`: backups (§1)"])), "component_boundary");
  assert.deepEqual(error.paths, ["config/shared-extra.json", "package-lock.json.bak"], "a shared path covers itself and what lies inside it, not names that only start with it");
  const invalid = await solo(context, withComponents(["- billing: packages/billing", "- Shared paths: bun.lock, ../outside.lock"]));
  assert.equal((await refusal(propose(invalid, billing(), []), "component_invalid")).entry, "- Shared paths: bun.lock, ../outside.lock");
});

test("clause 5: the root component is named root without a store and after the Repository name with one", async (context) => {
  const plain = await componentProject(context);
  const rootSlice = { slug: "billing-totals", component: "root", requirement: "r.md#1", changes: ["change `README.md`: the overview (§1)"], tests: ["test/root.test.mjs"] };
  const accepted = await planAndAccept(plain, [rootSlice, ...rest]);
  assert.equal(accepted.record.slices["billing-totals"].component, "root/root");

  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-components-store-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const store = path.join(parent, "store");
  await mkdir(store);
  // A project folder sits directly in the temporary folder, so the store is one folder up from it.
  const named = await componentProject(context, { config: workflow({ workspace: [`- Store: ../${path.relative(await realpath(os.tmpdir()), store)}`, "- Repository: api"] }) });
  const error = await refusal(propose(named, { ...rootSlice, component: "root" }), "component_unknown");
  assert.deepEqual(error.components, ["api/api", "api/billing", "api/shared", "api/web", "api/docs"]);
  const proposed = await propose(named, { ...rootSlice, component: "api" });
  assert.ok(proposed.record.proposals[INITIATIVE]);
});

test("clause 6: the root component holds every undeclared file, and a declared component may depend on it", async (context) => {
  const root = await solo(context, withComponents(["- billing: packages/billing", "  - Depends on: root"]));
  const rootSlice = { slug: "billing-totals", component: "root", requirement: "r.md#1", changes: ["change `README.md`, `apps/web/index.mjs`, `packages/shared/index.mjs`: undeclared files (§1)"], tests: ["test/root.test.mjs"] };
  const accepted = await planAndAccept(root, [rootSlice]);
  assert.equal(accepted.record.slices["billing-totals"].component, "root/root");
  const crossing = await solo(context, withComponents(["- billing: packages/billing", "  - Depends on: root"]));
  const error = await refusal(propose(crossing, { ...rootSlice, changes: ["change `packages/billing/index.mjs`: billing (§1)"] }, []), "component_boundary");
  assert.deepEqual(error.paths, ["packages/billing/index.mjs"]);
});

test("clauses 7 and 12: a repository without components is one root component, recorded on every slice that names none", async (context) => {
  for (const components of [null, "## Components\nNo packages are declared yet.\n"]) {
    const root = await componentProject(context, { config: workflow({ components }) });
    const accepted = await planAndAccept(root, THREE.map(({ component, ...slice }) => slice));
    assert.deepEqual(Object.values(accepted.record.slices).filter((slice) => slice.parent !== null).map((slice) => slice.component), ["root/root", "root/root", "root/root"]);
    const other = await solo(context, workflow({ components }));
    const error = await refusal(propose(other, billing(), []), "component_unknown");
    assert.equal(error.slice, "billing-totals");
    assert.equal(error.component, "billing");
    assert.deepEqual(error.components, ["root/root"]);
  }
});

test("clause 8: a file belongs to the component whose folder holds it, not to one whose folder only starts its name", async (context) => {
  const root = await componentProject(context, { config: withComponents(["- billing: packages/billing", "- billing-extra: packages/billing-extra", "- Shared paths: packages/billing/generated"]), files: { "packages/billing-extra/a.mjs": "export {};\n" }, requirements: ["r.md#1"] });
  const error = await refusal(propose(root, billing(["change `packages/billing/index.mjs`, `packages/billing-extra/a.mjs`: totals (§1)"]), []), "component_boundary");
  assert.deepEqual(error.paths, ["packages/billing-extra/a.mjs"]);
  const shared = await solo(context, withComponents(["- billing: packages/billing", "- shared: packages/shared", "- Shared paths: packages/billing/generated"]));
  const accepted = await planAndAccept(shared, [{ ...rest[0], changes: ["add `packages/shared/index.mjs`, `packages/billing/generated/types.mjs`: generated types (§2)"], requirement: "r.md#1" }]);
  assert.equal(accepted.record.slices["shared-values"].component, "root/shared", "a shared path inside a component lets another component's slice change it");
});

test("clause 9: invalid declarations refuse the operations that read components with JSON-RPC error data, and leave other operations working", async (context) => {
  const cases = [
    [["- billing: packages/billing", "- payments: packages/billing/"], "component_overlap", { components: [{ name: "billing", folder: "packages/billing" }, { name: "payments", folder: "packages/billing" }] }],
    [["- billing: packages", "- shared: packages/shared"], "component_overlap", { components: [{ name: "billing", folder: "packages" }, { name: "shared", folder: "packages/shared" }] }],
    [["- billing: packages/billing", "  - Depends on: ledger"], "component_dependency_unknown", { component: "billing", dependency: "ledger" }],
    [["- billing: packages/billing", "  - Depends on: web", "- shared: packages/shared", "  - Depends on: billing", "- web: apps/web", "  - Depends on: shared"], "component_cycle", { cycle: ["billing", "web", "shared", "billing"] }],
    [["- billing: packages/billing", "- billing: packages/billing-two"], "component_invalid", { entry: "- billing: packages/billing-two" }],
    [["- root: packages/root"], "component_invalid", { entry: "- root: packages/root" }]
  ];
  for (const [lines, code, fields] of cases) {
    const root = await solo(context, withComponents(lines));
    const error = await refusal(propose(root, billing(), []), code);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(error[key], value, `${code}.${key}`);
    const current = await read(root);
    assert.equal(current.valid, true, "get_initiative reads no components");
    assert.equal(current.record.proposals, undefined, "nothing was proposed");
    await update(root, [{ op: "update_slice", slug: INITIATIVE, outcome: "Work keeps going." }]);
  }
  const root = await solo(context, withComponents(cases[2][0]));
  await plannedSlice(root, "billing-totals", THREE[0].changes);
  const server = await prismServer(context, root);
  const created = (await server.call("get_initiative", { initiative: INITIATIVE })).result.structuredContent;
  assert.equal((await server.call("update_initiative", { initiative: INITIATIVE, expectedRevision: created.revision, operations: [{ op: "claim", slug: INITIATIVE }] })).error, undefined);
  const current = (await server.call("get_initiative", { initiative: INITIATIVE })).result.structuredContent;
  const response = await server.call("update_initiative", { initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "propose_design", slug: INITIATIVE, operations: slicePlan([billing()]) }] });
  assert.ok(response.error, "the proposal is refused");
  assert.equal(response.error.data.code, "component_dependency_unknown");
  assert.equal(response.error.data.component, "billing");
  assert.equal(response.error.data.dependency, "ledger");
  assert.match(response.error.message, /ledger/);
});

test("clause 10: the first problem in the order of the kinds, then in declaration order, is the one reported", async (context) => {
  const lines = ["- billing: packages", "- shared: packages/shared", "  - Depends on: ledger", "- Web: apps/web", "- docs: ../docs"];
  const root = await solo(context, withComponents(lines));
  assert.equal((await refusal(propose(root, billing(), []), "component_invalid")).entry, "- Web: apps/web");
  const second = await solo(context, withComponents(lines.slice(0, 3)));
  assert.equal((await refusal(propose(second, billing(), []), "component_overlap")).components[0].name, "billing");
  const third = await solo(context, withComponents(["- billing: packages/billing", "  - Depends on: ledger, web", "- web: apps/web", "  - Depends on: billing"]));
  const error = await refusal(propose(third, billing(), []), "component_dependency_unknown");
  assert.equal(error.dependency, "ledger");
});

test("clause 11: an accepted design records its component, a new design replaces it, and a slice from before components has none", async (context) => {
  const root = await componentProject(context, { config: withComponents(["- billing: packages/billing", "- shared: packages/shared", "- Shared paths: package-lock.json"]), requirements: ["r.md#1", "r.md#2"] });
  const accepted = await planAndAccept(root, [billing(["change `package-lock.json`: lockfile (§1)"]), rest[0]]);
  assert.equal(accepted.record.slices["billing-totals"].component, "root/billing");
  const read1 = await read(root);
  assert.equal(read1.record.slices["billing-totals"].component, "root/billing");
  assert.equal(read1.record.slices[INITIATIVE].component, undefined, "a split scope records no component");
  await writeFile(path.join(root, "packages/shared/test/other.test.mjs"), "// another shared test\n");
  const again = await update(root, [{ op: "accept_design", slug: "billing-totals", frozenTests: ["packages/shared/test/other.test.mjs"], review: "none", component: "shared" }]);
  assert.equal(again.record.slices["billing-totals"].component, "root/shared", "a new design replaces the component");

  const recordFile = path.join(root, read1.recordPath);
  const raw = JSON.parse(await readFile(recordFile, "utf8"));
  delete raw.slices["shared-values"].component;
  await writeFile(recordFile, `${JSON.stringify(raw, null, 2)}\n`);
  const legacy = await read(root);
  assert.equal(legacy.valid, true);
  assert.equal(Object.hasOwn(legacy.record.slices["shared-values"], "component"), false);
});

test("clause 13: a repository with components refuses a slice that names no component or an unknown one, listing its components", async (context) => {
  const root = await componentProject(context);
  const missing = await refusal(propose(root, { ...billing(), component: undefined }), "component_unknown");
  assert.equal(missing.slice, "billing-totals");
  assert.equal(missing.component, null);
  assert.deepEqual(missing.components, ["root/root", "root/billing", "root/shared", "root/web", "root/docs"]);
  const unknown = await refusal(propose(root, billing(undefined, undefined, "ledger")), "component_unknown");
  assert.equal(unknown.component, "ledger");
  const direct = await refusal(update(root, [{ op: "split", parent: INITIATIVE, children: [{ slug: "solo", title: "Solo", requirements: ["r.md#1", "r.md#2", "r.md#3"] }] }, { op: "accept_design", slug: "solo", frozenTests: ["test/root.test.mjs"], review: "none" }]), "component_unknown");
  assert.equal(direct.slice, "solo");
});

test("clause 14: a slice whose planned changes or frozen tests leave its component is refused with each crossing path, while Prism's own files are not checked", async (context) => {
  const root = await componentProject(context);
  const error = await refusal(propose(root, billing(["change `packages/billing/index.mjs`, `packages/shared/index.mjs`: totals (§1)", "remove `apps/web/index.mjs`: old page (§1)", "change `packages/shared/index.mjs`: again (§1)"], ["packages/billing/test/billing.test.mjs", "test/root.test.mjs"])), "component_boundary");
  assert.equal(error.slice, "billing-totals");
  assert.equal(error.component, "root/billing");
  assert.deepEqual(error.paths, ["apps/web/index.mjs", "packages/shared/index.mjs", "test/root.test.mjs"]);
  const own = await componentProject(context);
  const accepted = await planAndAccept(own, [billing(["change `packages/billing/index.mjs`: totals (§1)", "change `.prism/workflow.md`: declare billing (§1)", "add `docs/plans/work/notes.md`: notes (§1)", "change `docs/roadmap.md`: roadmap (§1)"]), ...rest]);
  assert.equal(accepted.record.slices["billing-totals"].component, "root/billing");
});

test("clause 15: a scope spans components, and a proposal with one refused slice is refused whole before it is recorded", async (context) => {
  const root = await componentProject(context);
  const accepted = await planAndAccept(root, THREE);
  assert.deepEqual(components(accepted.record), { "billing-totals": "root/billing", "shared-values": "root/shared", "web-pages": "root/web" });
  const refused = await componentProject(context);
  await refusal(propose(refused, billing(), [rest[0], { ...rest[1], changes: ["change `packages/billing/index.mjs`: web reaches into billing (§3)"] }]), "component_boundary");
  const current = await read(refused);
  assert.equal(current.record.proposals, undefined);
  assert.equal(current.record.slices["billing-totals"], undefined);
  await plannedSlice(refused, "web-pages", rest[1].changes);
  await update(refused, [{ op: "propose_design", slug: INITIATIVE, operations: slicePlan(THREE) }]);
  await writeFile(path.join(refused, ".prism/workflow.md"), withComponents(["- billing: packages/billing", "- shared: packages/shared"]));
  const atAcceptance = await refusal(update(refused, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]), "component_unknown");
  assert.equal(atAcceptance.component, "web", "acceptance checks the components again");
});

// A path store beside the project, named relative to it, for a configuration that names its repository.
async function storeLines(context, repository) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-components-store-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(path.join(parent, "store"));
  return [`- Store: ../${path.relative(await realpath(os.tmpdir()), path.join(parent, "store"))}`, `- Repository: ${repository}`];
}

test("clause 36: a component is identified as <repository>/<component>, given bare or qualified, and never as another repository's", async (context) => {
  const root = await componentProject(context, { config: workflow({ workspace: await storeLines(context, "api") }) });
  const accepted = await planAndAccept(root, [{ ...THREE[0], component: "api/billing" }, THREE[1], { ...THREE[2], component: "api/web" }]);
  assert.deepEqual(components(accepted.record), { "billing-totals": "api/billing", "shared-values": "api/shared", "web-pages": "api/web" });
  assert.equal((await read(root)).record.slices["shared-values"].component, "api/shared", "get_initiative returns the identity");
  const other = await componentProject(context, { config: workflow({ workspace: await storeLines(context, "api") }) });
  const error = await refusal(propose(other, { ...THREE[0], component: "portal/billing" }), "component_unknown");
  assert.equal(error.component, "portal/billing");
  assert.deepEqual(error.components, ["api/api", "api/billing", "api/shared", "api/web", "api/docs"]);
  const crossing = await refusal(propose(other, billing(["change `apps/web/index.mjs`: page (§1)"])), "component_boundary");
  assert.equal(crossing.component, "api/billing");
});

test("clause 37: a dependency on another repository's component is checked only for its form and never takes part in a cycle", async (context) => {
  const accepted = await solo(context, withComponents(["- billing: packages/billing", "  - Depends on: shared, portal/site, root/shared", "- shared: packages/shared", "  - Depends on: portal/billing"]));
  const proposed = await propose(accepted, billing(), []);
  assert.ok(proposed.record.proposals[INITIATIVE], "dependencies on another repository's components are accepted");
  for (const [entry, code, field] of [
    ["  - Depends on: portal/Site", "component_invalid", "entry"],
    ["  - Depends on: portal/site/extra", "component_invalid", "entry"],
    ["  - Depends on: /site", "component_invalid", "entry"],
    ["  - Depends on: root/ledger", "component_dependency_unknown", "dependency"]
  ]) {
    const root = await solo(context, withComponents(["- billing: packages/billing", entry]));
    const error = await refusal(propose(root, billing(), []), code);
    assert.equal(error[field], field === "entry" ? entry : "root/ledger");
  }
});

test("clause 38: a Repository line without a store names the repository's components, and an invalid one is refused where components are read", async (context) => {
  const named = await componentProject(context, { config: workflow({ workspace: ["- Repository: web-app"] }) });
  const accepted = await planAndAccept(named, THREE);
  assert.deepEqual(components(accepted.record), { "billing-totals": "web-app/billing", "shared-values": "web-app/shared", "web-pages": "web-app/web" });
  const invalid = await solo(context, workflow({ workspace: ["- Repository: Web App"] }));
  const error = await refusal(propose(invalid, billing(), []), "component_invalid");
  assert.equal(error.entry, "- Repository: Web App");
  assert.equal((await read(invalid)).valid, true, "record operations still ignore the line");
});
