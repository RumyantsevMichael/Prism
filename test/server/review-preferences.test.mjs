import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/review-app-ui-kit.md §3, §5.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 13, 14, 15, and 16.
// The theme and density choices are kept by the review app for the user, so they survive another port and are shared by every project.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-preferences-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function appDirectory(context) {
  const directory = path.join(await temporary(context, "prism-preferences-app-"), "state");
  const previous = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.PRISM_REVIEW_APP_DIR;
    else process.env.PRISM_REVIEW_APP_DIR = previous;
  });
  return directory;
}

async function project(context) {
  const root = await temporary(context, "prism-preferences-project-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  return root;
}

async function serve(context, root) {
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  let open = true;
  const close = async () => {
    if (open) {
      open = false;
      await review.close();
    }
  };
  context.after(close);
  const base = review.baseUrl.replace(/\/$/, "");
  return { base, port: new URL(base).port, close };
}

const read = async (base) => {
  const response = await fetch(`${base}/api/preferences`);
  return { status: response.status, body: await response.json() };
};
const put = async (base, body, headers = { "Content-Type": "application/json" }) => {
  const response = await fetch(`${base}/api/preferences`, { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  return { status: response.status, body: json };
};

test("clause 13: without a stored choice the preferences are the system theme and compact density", async (context) => {
  await appDirectory(context);
  const { base } = await serve(context, await project(context));
  assert.deepEqual(await read(base), { status: 200, body: { theme: "system", density: "compact" } });
});

test("clause 14: a PUT stores the given choice, keeps the other one, and answers with both", async (context) => {
  const directory = await appDirectory(context);
  const { base } = await serve(context, await project(context));
  assert.deepEqual(await put(base, { theme: "dark" }), { status: 200, body: { theme: "dark", density: "compact" } });
  assert.deepEqual(await put(base, { density: "comfortable" }), { status: 200, body: { theme: "dark", density: "comfortable" } });
  assert.deepEqual(await put(base, { theme: "light", density: "compact" }), { status: 200, body: { theme: "light", density: "compact" } });
  assert.deepEqual(await read(base), { status: 200, body: { theme: "light", density: "compact" } });
  const stored = JSON.parse(await readFile(path.join(directory, "review-preferences.json"), "utf8"));
  assert.equal(stored.theme, "light");
  assert.equal(stored.density, "compact");
});

test("clause 15: an invalid PUT answers invalid_preference and stores nothing", async (context) => {
  await appDirectory(context);
  const { base } = await serve(context, await project(context));
  await put(base, { theme: "dark", density: "comfortable" });
  for (const body of ["not json", "[]", "\"dark\"", "null", {}, { theme: "blue" }, { density: "cozy" }, { colour: "dark" }, { theme: "dark", extra: true }, { theme: 1 }]) {
    const answer = await put(base, body);
    assert.equal(answer.status, 400, `${JSON.stringify(body)} answers 400`);
    assert.equal(answer.body?.code, "invalid_preference", `${JSON.stringify(body)} names invalid_preference`);
    assert.equal(typeof answer.body?.message, "string");
  }
  assert.deepEqual((await read(base)).body, { theme: "dark", density: "comfortable" });
});

test("clause 15: a PUT without a JSON content type or from another origin answers 403", async (context) => {
  await appDirectory(context);
  const { base } = await serve(context, await project(context));
  assert.equal((await put(base, { theme: "dark" }, { "Content-Type": "text/plain" })).status, 403);
  assert.equal((await put(base, { theme: "dark" }, { "Content-Type": "application/json", Origin: "http://attacker.example" })).status, 403);
  assert.deepEqual((await read(base)).body, { theme: "system", density: "compact" });
});

test("clause 13: an unreadable or invalid stored value reads as its default", async (context) => {
  const directory = await appDirectory(context);
  const { base } = await serve(context, await project(context));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "review-preferences.json"), "{ broken");
  assert.deepEqual((await read(base)).body, { theme: "system", density: "compact" });
  await writeFile(path.join(directory, "review-preferences.json"), JSON.stringify({ theme: "blue", density: "comfortable" }));
  assert.deepEqual((await read(base)).body, { theme: "system", density: "comfortable" });
  await writeFile(path.join(directory, "review-preferences.json"), JSON.stringify({ theme: "dark", density: 7 }));
  assert.deepEqual((await read(base)).body, { theme: "dark", density: "compact" });
});

test("clause 16: the choice survives a restart on another port and is shared by every project", async (context) => {
  await appDirectory(context);
  const first = await serve(context, await project(context));
  await put(first.base, { theme: "dark", density: "comfortable" });
  // The second server starts while the first holds its port, so it binds another one.
  const second = await serve(context, await project(context));
  await first.close();
  assert.notEqual(second.port, first.port);
  assert.deepEqual((await read(second.base)).body, { theme: "dark", density: "comfortable" });
  const third = await serve(context, await project(context));
  await put(third.base, { theme: "light" });
  assert.deepEqual((await read(second.base)).body, { theme: "light", density: "comfortable" });
});
