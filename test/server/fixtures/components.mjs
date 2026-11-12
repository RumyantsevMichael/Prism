import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writePlanFile } from "./plan-files.mjs";
import { defer } from "./teardown.mjs";

// Projects that declare components, for the acceptance tests of components.md.
// A test file sets PLUGIN_DATA before it uses these helpers, because Prism modules read their data folder when they load,
// so every Prism module is imported here only inside a helper, never when this file loads.

export const INITIATIVE = "work";
export const PLANS = `docs/plans/${INITIATIVE}`;
export const node = process.execPath;

/**
 * A test command that runs check.mjs at the project root from a folder `depth` levels below it, naming the component.
 * check.mjs appends { name, cwd } to the file named by COMPONENT_LOG, outside the project, and exits with FAIL_<name>, or 0.
 */
export const command = (name, depth = 2) => `${node} ${depth ? `${"../".repeat(depth)}` : ""}check.mjs ${name}`;

const CHECK = [
  'import { appendFileSync } from "node:fs";',
  "const name = process.argv[2] ?? \"root\";",
  "if (process.env.COMPONENT_LOG) appendFileSync(process.env.COMPONENT_LOG, `${JSON.stringify({ name, cwd: process.cwd() })}\\n`);",
  "process.exit(Number(process.env[`FAIL_${name}`] ?? 0));",
  ""
].join("\n");

/** The declaration used by most tests: billing depends on shared, web on billing, and docs on nothing, with one shared lockfile and one shared folder. */
export const DECLARATION = [
  "## Components",
  "- billing: packages/billing",
  `  - Test command: ${command("billing")}`,
  "  - Depends on: shared",
  "- shared: packages/shared/",
  `  - Test command: ${command("shared")}`,
  "- web: apps/web",
  "  - Depends on: billing",
  "- docs: handbook",
  `  - test command (runs in the folder): ${command("docs", 1)}`,
  "- shared paths: package-lock.json, config/shared/",
  ""
].join("\n");

/** A workflow configuration with Plans, an optional Stack test command, optional Components lines, and optional Workspace lines. */
export function workflow({ components = DECLARATION, stack = command("root", 0), workspace = null } = {}) {
  return [
    "## Paths",
    "- Plans: docs/plans",
    "",
    ...(stack === null ? [] : ["## Stack", `- Test command: ${stack}`, ""]),
    ...(components === null ? [] : [components]),
    ...(workspace === null ? [] : ["## Workspace", ...workspace, ""])
  ].join("\n");
}

const FILES = {
  "check.mjs": CHECK,
  "package-lock.json": "{}\n",
  "config/shared/base.json": "{}\n",
  "README.md": "# Project\n",
  "packages/billing/index.mjs": "export const total = 1;\n",
  "packages/billing/test/billing.test.mjs": "// frozen billing test\n",
  "packages/shared/index.mjs": "export const shared = 1;\n",
  "packages/shared/test/shared.test.mjs": "// frozen shared test\n",
  "apps/web/index.mjs": "export const web = 1;\n",
  "apps/web/test/web.test.mjs": "// frozen web test\n",
  "handbook/guide.md": "# Guide\n",
  "test/root.test.mjs": "// frozen root test\n"
};

export const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Prism Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();

/** Commit everything in the work tree. */
export function commitAll(root, message = "change") {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

/** Write files, given as { path: text }, relative to the project root. */
export async function write(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
}

/**
 * A Git project with the given workflow configuration and the FILES above, committed, and the root slice of the work initiative,
 * whose slice.md holds a three-clause Contract that planned slices cite. Returns its real path.
 */
export async function componentProject(context, { config = workflow(), files = {}, requirements = ["r.md#1", "r.md#2", "r.md#3"] } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-components-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  await write(root, { ...FILES, ...files, ".prism/workflow.md": config });
  git(root, "init", "-q", "-b", "main");
  // With a record store, Prism reads plan files only there.
  await writePlanFile(root, `${PLANS}/slice.md`, "# Work\n\n## Contract\n1. Billing totals.\n2. Shared values.\n3. Web pages.\n");
  commitAll(root, "start");
  const { updateInitiative } = await import("../../../dist/server/workflow/initiative.mjs");
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Work", requirements }] });
  return root;
}

/** Write a planned slice's slice.md with the given Changes lines. */
export async function plannedSlice(root, slug, changes) {
  await writePlanFile(root, `${PLANS}/${slug}/slice.md`, `# ${slug}\n\n## Changes\n${changes.map((line) => `- ${line}`).join("\n")}\n`);
}

/** Apply update_initiative operations at the current revision. */
export async function update(root, operations) {
  const { getInitiative, updateInitiative } = await import("../../../dist/server/workflow/initiative.mjs");
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

/** The initiative as get_initiative returns it. */
export async function read(root) {
  const { getInitiative } = await import("../../../dist/server/workflow/initiative.mjs");
  return getInitiative({ projectRoot: root, initiative: INITIATIVE });
}

/** One planned slice per entry, { slug, component, changes, tests, requirement }, under the root scope, as a slice plan. */
export function slicePlan(slices) {
  return [
    { op: "split", parent: INITIATIVE, children: slices.map((slice) => ({ slug: slice.slug, title: slice.slug, requirements: [slice.requirement] })) },
    ...slices.map((slice) => ({ op: "accept_design", slug: slice.slug, frozenTests: slice.tests, review: "none", ...(slice.component === undefined ? {} : { component: slice.component }) }))
  ];
}

/** Propose a slice plan for the root scope and accept it, writing each planned slice's slice.md first. */
export async function planAndAccept(root, slices) {
  for (const slice of slices) await plannedSlice(root, slice.slug, slice.changes);
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: slicePlan(slices) }]);
  return update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
}

/** The usual three-slice plan: billing, shared, and web, each changing its own index and freezing its own test. */
export const THREE = [
  { slug: "billing-totals", component: "billing", requirement: "r.md#1", changes: ["change `packages/billing/index.mjs`: `total` (§1)"], tests: ["packages/billing/test/billing.test.mjs"] },
  { slug: "shared-values", component: "shared", requirement: "r.md#2", changes: ["change `packages/shared/index.mjs`: `shared` (§2)"], tests: ["packages/shared/test/shared.test.mjs"] },
  { slug: "web-pages", component: "web", requirement: "r.md#3", changes: ["change `apps/web/index.mjs`: `web` (§3)"], tests: ["apps/web/test/web.test.mjs"] }
];

/** Expect a promise to reject with an error of the given code, and return the error. */
export async function refusal(promise, code) {
  try { await promise; }
  catch (error) {
    if (error?.code !== code) throw new Error(`expected ${code}, got ${error?.code}: ${error?.message}`);
    return error;
  }
  throw new Error(`expected ${code}, but the operation succeeded`);
}

/** A file outside the project where check.mjs logs each run's component and working folder, set as COMPONENT_LOG for this test. */
export async function runLog(context) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-components-log-")));
  const file = path.join(folder, "runs.jsonl");
  const previous = process.env.COMPONENT_LOG;
  process.env.COMPONENT_LOG = file;
  defer(context, async () => {
    if (previous === undefined) delete process.env.COMPONENT_LOG; else process.env.COMPONENT_LOG = previous;
    await rm(folder, { recursive: true, force: true });
  });
  return async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Set FAIL_<name> for this test so that component's check exits 1. */
export function failing(context, name) {
  process.env[`FAIL_${name}`] = "1";
  defer(context, () => { delete process.env[`FAIL_${name}`]; });
}
