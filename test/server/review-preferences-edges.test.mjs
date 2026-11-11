import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Contract: docs/plans/review-app-ui-kit/slice.md clause 15.
// A key that only an ordinary object inherits is still another key, and a media type matches whatever its case.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-preferences-edges-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
// Every registered preference is stored, so a check of two of them compares against the defaults of the rest.
const { DEFAULT_PREFERENCES } = await import("../../dist/server/review/public/kit/preference-registry.js");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function serve(context) {
  const previous = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = path.join(await temporary(context, "prism-preferences-edges-app-"), "state");
  context.after(() => {
    if (previous === undefined) delete process.env.PRISM_REVIEW_APP_DIR;
    else process.env.PRISM_REVIEW_APP_DIR = previous;
  });
  const root = await temporary(context, "prism-preferences-edges-project-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(() => review.close());
  return review.baseUrl.replace(/\/$/, "");
}

const put = async (base, body, contentType = "application/json") => {
  const response = await fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": contentType }, body });
  return { status: response.status, type: response.headers.get("content-type") ?? "", text: await response.text() };
};
const stored = async (base) => (await fetch(`${base}/api/preferences`)).json();

test("a key inherited from Object.prototype answers invalid_preference as JSON and stores nothing", async (context) => {
  const base = await serve(context);
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const answer = await put(base, `{"${key}":"dark"}`);
    assert.equal(answer.status, 400, `${key} answers 400`);
    assert.match(answer.type, /^application\/json/, `${key} answers JSON`);
    assert.equal(JSON.parse(answer.text).code, "invalid_preference", `${key} names invalid_preference`);
  }
  assert.deepEqual(await stored(base), { ...DEFAULT_PREFERENCES, theme: "system", density: "compact" });
});

test("the JSON content type matches in any case and with parameters, and nothing else passes", async (context) => {
  const base = await serve(context);
  assert.equal((await put(base, "{\"density\":\"comfortable\"}", "Application/JSON")).status, 200);
  assert.equal((await put(base, "{\"theme\":\"dark\"}", "APPLICATION/JSON; Charset=UTF-8")).status, 200);
  for (const type of ["text/plain", "application/jsonx", "application/json-patch+json"]) assert.equal((await put(base, "{\"theme\":\"light\"}", type)).status, 403, `${type} answers 403`);
  assert.deepEqual(await stored(base), { ...DEFAULT_PREFERENCES, theme: "dark", density: "comfortable" });
});
