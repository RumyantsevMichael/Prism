import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/personal-settings.md §3, §4, §5.
// Contract: docs/plans/personal-settings/slice.md clauses 17 and 18; each test names the clauses it checks at the start of its title.
// The review app reads and changes the person's own settings for the settings screen through one route of each project's review.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-personal-screen-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const FILE = "personal-settings.json";
const DEFAULTS = { interactionStyle: "structured", reviewBrowser: "auto", reviewBrowserOnStart: "on", sessionOffer: "ask" };
const ALL_DEFAULT = { interactionStyle: "default", reviewBrowser: "default", reviewBrowserOnStart: "default", sessionOffer: "default" };

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function appDirectory(context) {
  const directory = path.join(await temporary(context, "prism-personal-screen-app-"), "state");
  const previous = process.env.PRISM_REVIEW_APP_DIR;
  process.env.PRISM_REVIEW_APP_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.PRISM_REVIEW_APP_DIR;
    else process.env.PRISM_REVIEW_APP_DIR = previous;
  });
  return directory;
}

async function project(context, lines = []) {
  const root = await temporary(context, "prism-personal-screen-project-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  const interaction = lines.length ? `\n## Interaction\n${lines.map((line) => `- ${line}`).join("\n")}\n` : "";
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans/\n${interaction}`);
  return root;
}

async function serve(context, root) {
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(() => review.close());
  return review.baseUrl.replace(/\/$/, "");
}

const route = (base) => `${base}/api/personal-settings`;
const get = async (base) => {
  const response = await fetch(route(base));
  return { status: response.status, body: await response.json() };
};
const put = async (base, body, headers = { "Content-Type": "application/json" }) => {
  const response = await fetch(route(base), { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, body: json };
};

test("clause 17: GET answers the person's settings for the review's project, adopting what the project records", async (context) => {
  const directory = await appDirectory(context);
  const plain = await serve(context, await project(context));
  assert.deepEqual(await get(plain), { status: 200, body: { settings: DEFAULTS, sources: ALL_DEFAULT, adopted: [], problem: null } });
  const root = await project(context, ["Review browser: external"]);
  const base = await serve(context, root);
  const answer = await get(base);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.settings, { ...DEFAULTS, reviewBrowser: "external" });
  assert.equal(answer.body.sources.reviewBrowser, "adopted");
  assert.deepEqual(answer.body.adopted, ["reviewBrowser"]);
  const entry = JSON.parse(await readFile(path.join(directory, FILE), "utf8")).settings.reviewBrowser;
  assert.equal(entry.from, root);
  assert.equal((await get(plain)).body.settings.reviewBrowser, "external", "every project's review shows the same personal value");
});

test("clause 18: a PUT from the page saves the given settings as chosen and answers the new settings", async (context) => {
  const directory = await appDirectory(context);
  const base = await serve(context, await project(context, ["Session offer: off"]));
  const answer = await put(base, { interactionStyle: "plain-text", sessionOffer: "ask" });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.settings, { ...DEFAULTS, interactionStyle: "plain-text" });
  assert.equal(answer.body.sources.interactionStyle, "chosen");
  assert.equal(answer.body.sources.sessionOffer, "chosen");
  const value = JSON.parse(await readFile(path.join(directory, FILE), "utf8"));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.settings.interactionStyle.source, "chosen");
  assert.equal(value.settings.sessionOffer.value, "ask");
  assert.deepEqual((await get(base)).body.settings, answer.body.settings, "a later GET reads the saved values");
});

test("clause 18: a PUT that is not the page's own JSON is refused with 403 and saves nothing", async (context) => {
  const directory = await appDirectory(context);
  const base = await serve(context, await project(context));
  assert.equal((await put(base, { sessionOffer: "off" }, { "Content-Type": "text/plain" })).status, 403);
  assert.equal((await put(base, { sessionOffer: "off" }, { "Content-Type": "application/json", Origin: "http://elsewhere.example" })).status, 403);
  assert.equal(await readFile(path.join(directory, FILE), "utf8").catch(() => null), null);
});

test("clause 18: an invalid change is refused with 400 invalid_setting naming the setting, and a body that is no JSON object too", async (context) => {
  await appDirectory(context);
  const base = await serve(context, await project(context));
  for (const [body, setting] of [[{ reviewBrowser: "chrome" }, "reviewBrowser"], [{ colour: "blue" }, "colour"], [{}, null], ["{ not json", null], ["[]", null]]) {
    const answer = await put(base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body?.code, "invalid_setting", JSON.stringify(body));
    assert.equal(answer.body?.setting ?? null, setting, JSON.stringify(body));
    assert.ok(answer.body?.message);
  }
  assert.deepEqual((await get(base)).body.settings, DEFAULTS);
});

test("clauses 17, 18: a file Prism cannot read is reported by GET and a PUT is refused with 409, leaving the file as it is", async (context) => {
  const directory = await appDirectory(context);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, FILE), "{ broken");
  const base = await serve(context, await project(context, ["Interaction style: plain-text"]));
  const answer = await get(base);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.problem?.code, "settings_unreadable");
  assert.equal(answer.body.settings.interactionStyle, "plain-text");
  assert.equal(answer.body.sources.interactionStyle, "repository");
  const refused = await put(base, { sessionOffer: "off" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.code, "settings_unreadable");
  assert.ok(refused.body?.message);
  await writeFile(path.join(directory, FILE), JSON.stringify({ schemaVersion: 3, settings: {} }));
  assert.equal((await put(base, { sessionOffer: "off" })).body?.code, "settings_unsupported");
  assert.equal(await readFile(path.join(directory, FILE), "utf8"), JSON.stringify({ schemaVersion: 3, settings: {} }));
});
