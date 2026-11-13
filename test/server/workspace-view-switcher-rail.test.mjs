import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit, networkStore, place, startApp, storeCheckout, workspaceId } from "./fixtures/workspace-view.mjs";

// Contract clauses 1-4 of the switcher-places-rail fix: the workspace switcher's pages and acceptance tests follow the places rail.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));
const RAIL = /<prism-rail id="rail" label="Places"/;

async function storeWorkspace(context) {
  const where = await place(context);
  const store = await networkStore(where);
  const api = await storeCheckout(context, where, "api", store.url);
  const prism = await startApp(context, where);
  await prism.register(api);
  return { store, prism };
}

test("clause 1: a workspace page holds the places rail and no nav-places element", async (context) => {
  const { store, prism } = await storeWorkspace(context);
  const page = await prism.get(`/w/${workspaceId(store.identity)}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, RAIL);
  assert.doesNotMatch(page.body, /nav-places/);
});

test("clause 2: the no-workspace page holds the places rail and no nav-places element", async (context) => {
  const where = await place(context);
  const empty = await startApp(context, where);
  const page = await empty.get("/");
  assert.equal(page.status, 200);
  assert.match(page.body, RAIL);
  assert.doesNotMatch(page.body, /nav-places/);
});

test("clause 3: the workspace page holds the places rail and the kit guard reports nothing", async (context) => {
  const { store, prism } = await storeWorkspace(context);
  const page = await prism.get(`/w/${workspaceId(store.identity)}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, RAIL);
  const guard = await new Promise((resolve) => execFile(process.execPath, [path.join(REPOSITORY, "scripts", "review-kit", "kit-guard.mjs")], { cwd: REPOSITORY }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
  assert.equal(guard.code, 0, guard.stdout);
  assert.equal(guard.stdout.trim(), "");
});

test("clause 4: the switcher's acceptance tests check the places rail for clauses 8, 10, and 61 and name no nav-places element", async () => {
  const source = await readFile(path.join(REPOSITORY, "test", "server", "workspace-view-switcher.test.mjs"), "utf8");
  assert.doesNotMatch(source, /nav-places/);
  for (const clause of ["clause 8:", "clause 10:", "clause 61:"]) {
    const start = source.indexOf(`test("${clause}`);
    assert.ok(start >= 0, `the suite keeps its ${clause} test`);
    const end = source.indexOf("\ntest(", start + 1);
    const body = source.slice(start, end < 0 ? undefined : end);
    assert.ok(body.includes('/<prism-rail id="rail" label="Places"/'), `the ${clause} test matches the places rail`);
  }
});
