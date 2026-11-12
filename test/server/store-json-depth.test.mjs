import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSON_DEPTH_MAX, parseStoreJson } from "../../dist/server/workflow/store-json.mjs";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { browserRequest, checkout, git, isolateGit, ok, requirementFile, reviewBrowser, server, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// A store sync brings files that no Prism checked, so every reader of the store's JSON goes through one bounded reader,
// and no value nested deeper than Prism writes makes a tool call or a review page request exhaust the call stack.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = "docs/requirements/billing.md";
const LOCATION = "requirements/billing.md";
const DEPTH = 200000;
const nested = `${"[".repeat(DEPTH)}${"]".repeat(DEPTH)}`;

test("the bounded reader refuses a value nested deeper than the limit as malformed JSON and reads every other value as JSON.parse does", () => {
  const at = (depth) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
  assert.doesNotThrow(() => parseStoreJson(at(JSON_DEPTH_MAX)));
  assert.throws(() => parseStoreJson(at(JSON_DEPTH_MAX + 1)), SyntaxError);
  assert.throws(() => parseStoreJson(Buffer.from(`{"a":${nested}}`)), SyntaxError);
  assert.throws(() => parseStoreJson("{"), SyntaxError);
  assert.deepEqual(parseStoreJson(Buffer.from('{"a":[1,{"b":null}]}')), { a: [1, { b: null }] });
});

test("no server module parses JSON except through the bounded reader", async () => {
  const found = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "public") await walk(target); continue; }
      if (!/\.m?[jt]s$/.test(entry.name) || target.endsWith(path.join("workflow", "store-json.mjs"))) continue;
      const lines = (await readFile(target, "utf8")).split("\n");
      lines.forEach((line, index) => { if (/JSON\.parse\b/.test(line)) found.push(`${path.relative(ROOT, target)}:${index + 1}`); });
    }
  };
  for (const folder of ["workflow", "review", "conservation"]) await walk(path.join(ROOT, "src/server", folder));
  assert.deepEqual(found, [], "every JSON read of the workflow, review, and conservation modules goes through parseStoreJson");
});

// Each record kind that a store holds, as its store-relative path, and what the planted file holds: the file Prism wrote with a deep value added, or a deep value alone.
const comment = { location: LOCATION, version: version("v"), line: 1, text: "planted", author: { name: "Grace", host: "h" }, at: "2026-11-07T00:00:00.000Z", entry: "1".repeat(32), by: { name: "Grace", email: null, checkout: "acme/web" }, via: "review-app" };
const KINDS = [
  ["roadmap.json"],
  ["initiatives/reports/initiative.json"],
  ["initiatives/reports/state.json"],
  ["initiatives/reports/claims/reports.json"],
  ["initiatives/reports/slices/reports/review.json"],
  ["initiatives/reports/slices/reports/change-map.json"],
  ["initiatives/reports/slices/reports/design-view.json"],
  ["initiatives/reports/slices/reports/frozen-tests.json"],
  ["initiatives/reports/slices/reports/runs/run-1.json"],
  [`artifact-status/${LOCATION}/status.json`],
  [`artifact-status/${LOCATION}/status.json`, (text) => text.replace(/"context":"[^"]*"/, `"context":${nested}`)],
  [`artifact-status/${LOCATION}/status.json`, (text) => text.replace(/"question":"[^"]*"/, `"question":"Approve?","asked":${nested}`)],
  [`artifact-comments/${LOCATION}/2026-11-07T00-00-00-000Z-00000000.json`, () => JSON.stringify(comment).replace('"text":"planted"', `"text":"planted","more":${nested}`)],
  [`artifact-identity/${LOCATION}`],
  ["migrations/2026-11-01T00-00-00-000Z-0123abcd.json"],
  ["repositories/api.json"]
];

const added = (text) => text === null || !text.trim().startsWith("{") ? `{"deep":${nested}}` : text.replace("{", `{"deep":${nested},`);

test("a store record of any kind that holds a value nested deep makes no tool call or review page request exhaust the call stack", { timeout: 600000 }, async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { "docs/plans/foo/slice.md": "# Foo\n" } });
  git(api, "config", "user.name", "Ada");
  const prism = await server(context, place, api);
  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve?", context: "ctx" }] }));
  const review = await reviewBrowser(context, api);
  const overflowed = (value) => /Maximum call stack|RangeError|too much recursion/.test(JSON.stringify(value) ?? "");
  let written = 0;
  for (const [relative, plant = added] of KINDS) {
    const target = path.join(place.store, ...relative.split("/"));
    const before = await readFile(target, "utf8").catch(() => null);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${plant(before)}\n`);
    // The review app shares results for a second, so each planted file is read afresh.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const calls = [
      ["get_roadmap", {}],
      ["get_initiative", { initiative: "reports" }],
      ["get_coordination_state", { initiative: "reports" }],
      ["get_review", { initiative: "reports", slice: "reports" }],
      ["get_change_map", { initiative: "reports", slice: "reports" }],
      ["get_artifact", { path: FILE }],
      ["get_artifact", {}],
      ["list_reviewable_artifacts", {}],
      ["update_artifact", { operations: [{ op: "write", path: `docs/plans/written-${written += 1}/slice.md`, content: "# Written\n", expectedVersion: null }] }]
    ];
    for (const [tool, input] of calls) {
      const response = await prism.call(tool, input);
      assert.ok(!overflowed(response), `${tool} with ${relative} deep: ${JSON.stringify(response).slice(0, 300)}`);
    }
    for (const route of ["/api/index", "/api/entity?ref=attention", "/api/entity?ref=initiative%3Areports", `/api/artifact?path=${encodeURIComponent(FILE)}`, "/api/artifact?path=.prism%2Finitiatives%2Freports%2Finitiative.json", "/api/projects"]) {
      const response = await browserRequest(review, route);
      assert.equal(typeof response.status, "number", `${route} with ${relative} deep answers`);
      assert.ok(!overflowed(response.body), `${route} with ${relative} deep: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
    }
    if (before === null) await rm(target, { force: true });
    else await writeFile(target, before);
  }
});

// A ledger of an earlier move is read while the checkout tracks a file under its artifact paths that waits to move, as a fresh clone of a repository that still holds docs/plans does.
test("an artifact-move ledger that a sync brings with values nested deep, or that are no text, makes no tool call fail", { timeout: 300000 }, async (context) => {
  for (const ledger of [
    `{"repository":"api","moved":[{"from":"docs/plans/foo/slice.md","to":${nested}}],"kept":[{"path":"docs/plans/foo/slice.md","reason":${nested}}]}`,
    '{"repository":"api","moved":[{"from":{"toString":1},"to":"x"}],"kept":[{"path":"docs/plans/foo/slice.md","reason":{"toString":1}}]}'
  ]) {
    const place = await workspace(context);
    const api = await checkout(place, "api", { files: { "docs/plans/foo/slice.md": "# Foo\n" } });
    await mkdir(path.join(place.store, "artifact-migrations"), { recursive: true });
    await writeFile(path.join(place.store, "artifact-migrations", "2026-11-01T00-00-00-000Z-0123abcd.json"), `${ledger}\n`);
    const prism = await server(context, place, api);
    for (const [tool, input] of [["get_artifact", { path: "docs/plans/foo/slice.md" }], ["get_artifact", {}], ["get_roadmap", {}], ["update_artifact", { operations: [{ op: "write", path: "docs/plans/bar/slice.md", content: "# Bar\n", expectedVersion: null }] }]]) {
      const response = await prism.call(tool, input);
      assert.equal(response.error, undefined, `${tool}: ${JSON.stringify(response.error)}`);
    }
  }
});
