import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/design-views.md §1, §5, §6.
// Contract: docs/plans/design-views/slice.md clause 12.
// An API specification view is an OpenAPI or AsyncAPI document in JSON, in the plan folder or in the checkout, counted by its operations.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-api-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n";
const ok = { responses: { 200: { description: "ok" } } };
const openapi = (paths) => ({ openapi: "3.1.0", info: { title: "Reports", version: "1" }, paths });
const OPENAPI = openapi({ "/reports/{id}": { get: ok, delete: ok, parameters: [] }, "/downloads": { get: ok, summary: "Downloads" } });
const ASYNCAPI = { asyncapi: "3.0.0", info: { title: "Report events", version: "1" }, channels: { downloads: { address: "downloads" } }, operations: { sendDownload: { action: "send", channel: { $ref: "#/channels/downloads" } }, receiveDownload: { action: "receive", channel: { $ref: "#/channels/downloads" } } } };
const ASYNCAPI2 = { asyncapi: "2.6.0", info: { title: "Report events", version: "1" }, channels: { downloads: { publish: { message: {} }, subscribe: { message: {} } }, audits: { subscribe: { message: {} } } } };

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-api-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/download.test.mjs", "// downloads write the report\n");
  await write(root, `${PLANS}/slice.md`, CONTRACT);
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  return root;
}

async function proposeApi(root, file, content) {
  if (content !== null) await write(root, file.includes("/") ? file : `${PLANS}/${file}`, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n- \`${file}\` api (§1): Which operations does the report API offer?\n`);
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  const request = [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/download.test.mjs"], review: "none" }] }];
  return initiativeAcknowledgement(await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: request }), request);
}

const listed = (result, file) => result.views.find((item) => item.path === file);

test("clause 12: OpenAPI 3 and AsyncAPI 2 and 3 documents in JSON are accepted and counted by their operations", async (context) => {
  const root = await project(context);
  assert.deepEqual(listed(await proposeApi(root, "reports.json", OPENAPI), `${PLANS}/reports.json`), { path: `${PLANS}/reports.json`, kind: "api", elements: 3, relations: 0 });
  assert.equal(listed(await proposeApi(root, "reports.json", { ...OPENAPI, openapi: "3.0.3" }), `${PLANS}/reports.json`).elements, 3);
  assert.equal(listed(await proposeApi(root, "reports.json", ASYNCAPI), `${PLANS}/reports.json`).elements, 2);
  assert.equal(listed(await proposeApi(root, "reports.json", ASYNCAPI2), `${PLANS}/reports.json`).elements, 3);
});

test("clause 12: an API view may be the executable contract in the checkout", async (context) => {
  const root = await project(context);
  const result = await proposeApi(root, "contracts/reports.openapi.json", OPENAPI);
  assert.equal(listed(result, "contracts/reports.openapi.json").elements, 3);
  await assert.rejects(proposeApi(root, "contracts/missing.json", null), (error) => error.code === "view_problems" && /contracts\/missing\.json/.test(error.message) && /does not exist/.test(error.message));
});

test("clause 12: an API view that is not JSON, or not an OpenAPI 3 or AsyncAPI document, is refused, naming the view and the problem", async (context) => {
  const root = await project(context);
  const cases = [
    ["openapi: 3.1.0\ninfo:\n  title: Reports\n", /reports\.json does not parse/],
    ["{\"openapi\": \"3.1.0\", \"info\": {", /reports\.json does not parse/],
    [{ swagger: "2.0", info: { title: "Reports", version: "1" }, paths: {} }, /reports\.json is not an OpenAPI 3 or AsyncAPI 2 or 3 document/],
    [{ openapi: "3.1.0", paths: {} }, /reports\.json is not an OpenAPI 3 or AsyncAPI 2 or 3 document/],
    [["openapi"], /reports\.json is not an OpenAPI 3 or AsyncAPI 2 or 3 document/]
  ];
  const failures = [];
  for (const [content, pattern] of cases) {
    try { await proposeApi(root, "reports.json", content); failures.push(`${pattern}: accepted`); }
    catch (error) { if (error.code !== "view_problems" || !pattern.test(error.message)) failures.push(`${pattern}: ${error.code} ${error.message}`); }
  }
  assert.deepEqual(failures, []);
});

test("clause 12: an API view of more than 30 operations is refused", async (context) => {
  const root = await project(context);
  const paths = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`/r${index}`, { get: ok }]));
  await assert.rejects(proposeApi(root, "reports.json", openapi(paths)), (error) => error.code === "view_problems" && error.message.includes(`${PLANS}/reports.json shows 31 operations, more than 30 for an api view`));
});
