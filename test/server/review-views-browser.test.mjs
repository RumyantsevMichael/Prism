import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/design-views.md §7, §8.
// Contract: docs/plans/design-views/slice.md clauses 17, 18, and 19.
// The person at the design gate sees each view of the contract and its slices with its kind, its question, links to its clauses, and the contract's authority.

if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-views-browser-data-")));
delete process.env.CLAUDE_PLUGIN_DATA;
const { launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } = await import("./fixtures/kit-browser.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const OVERVIEW_QUESTION = "How do the download and audit slices fit together?";
const FLOW_QUESTION = "In what order do the client and the server talk?";
const SCREEN_QUESTION = "What does the download screen show?";
const API_QUESTION = "Which operations does the report API offer?";
const AUTHORITY = /the contract decides/i;
const FILES = {
  ".prism/workflow.md": "## Paths\n- Plans: docs/plans\n",
  "test/download.test.mjs": "// downloads write the report\n",
  "test/audit.test.mjs": "// audits list downloads\n",
  [`${PLANS}/slice.md`]: `# Signed reports\n\n## Contract\n1. Downloads write the report.\n2. An unknown id exits 2.\n3. Audits list downloads.\n\n## Views\n- \`overview.puml\` component (§1, §3): ${OVERVIEW_QUESTION}\n`,
  [`${PLANS}/overview.puml`]: "@startuml\npackage download {\n  [cli]\n}\npackage audit {\n  [log]\n}\n[log] ..> [cli] : reads downloads\n@enduml\n",
  [`${PLANS}/download/slice.md`]: `# Download reports\n\n## Views\n- \`flow.puml\` sequence (§1, §2): ${FLOW_QUESTION}\n- \`screen.puml\` wireframe (§1): ${SCREEN_QUESTION}\n- \`api.json\` api (§1): ${API_QUESTION}\n\n## Changes\n- add \`src/report.mjs\`: \`download\` (§1, §2)\n`,
  [`${PLANS}/download/flow.puml`]: "@startuml\nparticipant Client\nparticipant Server\nClient -> Server: download\nServer --> Client: bytes\n@enduml\n",
  [`${PLANS}/download/screen.puml`]: "@startsalt\n{\n  Report id | \"42      \"\n  [Download] | [Cancel]\n}\n@endsalt\n",
  [`${PLANS}/download/api.json`]: `${JSON.stringify({ openapi: "3.1.0", info: { title: "Reports", version: "1" }, paths: { "/reports/{id}": { get: { responses: { 200: { description: "The report" } } } } } }, null, 2)}\n`,
  [`${PLANS}/audit/slice.md`]: "# Audit downloads\n\n## Changes\n- add `src/audit.mjs`: `audit` (§3)\n"
};

async function designedProject(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-views-browser-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] }] });
  const plan = [
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }] },
    { op: "set_dependencies", slug: "audit", dependencies: ["download"] },
    { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
    { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
  ];
  const step = async (operations) => {
    const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
    await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
  };
  await step([{ op: "propose_design", slug: INITIATIVE, operations: plan }]);
  await step([{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  return root;
}

async function viewsTab(page) {
  await page.locator("#artifact").getByRole("tab", { name: /^Views/ }).click();
  return page.locator("#artifact [role=tabpanel]:not([hidden])");
}

test("clause 17: a slice page shows each view of the slice with its kind, question, clause links, drawing or source, and the contract's authority", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await designedProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, `slice:${INITIATIVE}/download`));
  await waitForView(page);
  const panel = await viewsTab(page);
  const flow = panel.getByRole("region", { name: FLOW_QUESTION });
  await flow.locator("svg").first().waitFor();
  assert.match(await flow.innerText(), /sequence/i);
  assert.match(await flow.innerText(), AUTHORITY);
  assert.equal(await flow.getByRole("link", { name: "§1" }).count(), 1);
  assert.equal(await flow.getByRole("link", { name: "§2" }).count(), 1);
  const screen = panel.getByRole("region", { name: SCREEN_QUESTION });
  await screen.locator("svg").first().waitFor();
  assert.match(await screen.innerText(), /wireframe/i);
  const api = panel.getByRole("region", { name: API_QUESTION });
  assert.match(await api.innerText(), /"openapi": "3\.1\.0"/, "an API view shows its source text");
  assert.match(await api.innerText(), AUTHORITY);
  await flow.getByRole("link", { name: "§2" }).click();
  const design = page.locator("#artifact [role=tabpanel]:not([hidden])");
  assert.match(await design.innerText(), /An unknown id exits 2/, "a clause link opens the clause in the contract");
  assert.deepEqual(page.errors, []);
});

test("clause 18: the scope's page shows the contract's views and each planned slice's views under the slice", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await designedProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, `slice:${INITIATIVE}/${INITIATIVE}`));
  await waitForView(page);
  const panel = await viewsTab(page);
  const overview = panel.getByRole("region", { name: OVERVIEW_QUESTION });
  await overview.locator("svg").first().waitFor();
  assert.match(await overview.innerText(), /component/i);
  const slice = panel.getByRole("region", { name: "Download reports" });
  assert.equal(await slice.getByRole("region", { name: FLOW_QUESTION }).count(), 1, "the slice's views sit under its title");
  assert.equal(await slice.getByRole("region", { name: API_QUESTION }).count(), 1);
  assert.deepEqual(page.errors, []);
});

test("clause 19: opening a declared view on its own shows its kind, question, clause links, and the contract's authority", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await designedProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, `${PLANS}/download/flow.puml`));
  await waitForView(page);
  const view = page.locator("#artifact");
  await view.locator("svg").first().waitFor();
  const text = await view.innerText();
  assert.match(text, new RegExp(FLOW_QUESTION.replace(/[?]/g, "\\?")));
  assert.match(text, /sequence/i);
  assert.match(text, AUTHORITY);
  assert.equal(await view.getByRole("link", { name: "§1" }).count(), 1);
  assert.deepEqual(page.errors, []);
});
