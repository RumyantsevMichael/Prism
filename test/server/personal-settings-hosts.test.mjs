import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { offerPrism } from "../../dist/hooks/offer-prism.mjs";
import { opensAtStart } from "../../dist/server/review/open-at-start.mjs";

// Requirements: docs/requirements/personal-settings.md §2, §4, §5.
// Contract: docs/plans/personal-settings/slice.md clauses 13 to 16; each test names the clauses it checks at the start of its title.
// The session offer, the review browser at start, and the skills follow the person's own settings in every host.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE = "personal-settings.json";

async function temporary(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function project(context, lines = []) {
  const root = await temporary(context, "prism-personal-hosts-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  const interaction = lines.length ? `\n## Interaction\n${lines.map((line) => `- ${line}`).join("\n")}\n` : "";
  await writeFile(path.join(root, ".prism", "workflow.md"), `# Workflow config\n\n## Paths\n- Plans: docs/plans/\n${interaction}`);
  return root;
}

/** An application folder of its own, with the given personal values written in the format of clause 2. */
async function appFolder(context, values = {}) {
  const directory = path.join(await temporary(context, "prism-personal-hosts-app-"), "state");
  if (Object.keys(values).length) {
    await mkdir(directory, { recursive: true });
    const settings = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, source: "chosen", at: "2026-11-19T10:00:00.000Z" }]));
    await writeFile(path.join(directory, FILE), JSON.stringify({ schemaVersion: 1, settings }));
  }
  return directory;
}

const stored = async (directory) => JSON.parse(await readFile(path.join(directory, FILE), "utf8"));

const start = (cwd, environment, extra = {}) => offerPrism({ input: Readable.from([JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd, ...extra })]), environment });
const offered = (output) => Boolean(output?.hookSpecificOutput?.additionalContext);
const desktop = (directory, env = {}) => ({ env: { PRISM_REVIEW_APP_DIR: directory, ...env }, platform: "darwin" });

test("clause 13: the person's sessionOffer decides whether a new conversation is offered Prism, whatever the project records", async (context) => {
  const quiet = await appFolder(context, { sessionOffer: "off" });
  assert.equal(await start(await project(context), { PRISM_REVIEW_APP_DIR: quiet }), null, "off gives no offer");
  const asking = await appFolder(context, { sessionOffer: "ask" });
  assert.equal(offered(await start(await project(context, ["Session offer: off"]), { PRISM_REVIEW_APP_DIR: asking })), true, "the personal ask wins over a committed off");
  assert.equal(await start(await project(context), { PRISM_REVIEW_APP_DIR: asking, PRISM_SESSION_OFFER: "off" }), null, "PRISM_SESSION_OFFER=off still turns it off");
  assert.equal(offered(await start(await project(context), { PRISM_REVIEW_APP_DIR: await appFolder(context) })), true, "the default offers");
});

test("clause 13: a committed Session offer off is adopted by the first session and then applies in a project that records nothing", async (context) => {
  const directory = await appFolder(context);
  assert.equal(await start(await project(context, ["Session offer: off"]), { PRISM_REVIEW_APP_DIR: directory }), null);
  const entry = (await stored(directory)).settings.sessionOffer;
  assert.equal(entry.value, "off");
  assert.equal(entry.source, "adopted");
  assert.equal(await start(await project(context), { PRISM_REVIEW_APP_DIR: directory }), null, "the adopted value is the person's now");
});

test("clause 13: a Codex session start follows the same personal setting", async (context) => {
  const quiet = await appFolder(context, { sessionOffer: "off" });
  const root = await project(context);
  assert.equal(await start(root, { PRISM_REVIEW_APP_DIR: quiet, CODEX_VERSION: "0.147.0" }, { turn_id: "t1" }), null);
  const asking = await appFolder(context, { sessionOffer: "ask" });
  assert.equal(offered(await start(root, { PRISM_REVIEW_APP_DIR: asking, CODEX_VERSION: "0.147.0" }, { turn_id: "t1" })), true);
});

test("clause 14: the review browser opens at start only when the person's reviewBrowser is not internal and reviewBrowserOnStart is on", async (context) => {
  const root = await project(context);
  assert.equal(await opensAtStart(root, desktop(await appFolder(context))), true, "the defaults open it");
  assert.equal(await opensAtStart(root, desktop(await appFolder(context, { reviewBrowserOnStart: "off" }))), false);
  assert.equal(await opensAtStart(root, desktop(await appFolder(context, { reviewBrowser: "internal" }))), false);
  assert.equal(await opensAtStart(root, desktop(await appFolder(context, { reviewBrowser: "external", reviewBrowserOnStart: "on" }))), true);
  const committedOff = await project(context, ["Review browser on start: off", "Review browser: internal"]);
  assert.equal(await opensAtStart(committedOff, desktop(await appFolder(context, { reviewBrowser: "auto", reviewBrowserOnStart: "on" }))), true, "personal values win over committed ones");
  assert.equal(await opensAtStart(root, desktop(await appFolder(context), { PRISM_REVIEW_BROWSER_ON_START: "off" })), false, "the variable still turns it off");
  assert.equal(await opensAtStart(root, { env: { PRISM_REVIEW_APP_DIR: await appFolder(context), CI: "true" }, platform: "darwin" }), false, "a session nobody can see still opens nothing");
});

test("clause 14: a committed Review browser on start off is adopted at the first start", async (context) => {
  const directory = await appFolder(context);
  assert.equal(await opensAtStart(await project(context, ["Review browser on start: off"]), desktop(directory)), false);
  assert.equal((await stored(directory)).settings.reviewBrowserOnStart.value, "off");
  assert.equal(await opensAtStart(await project(context), desktop(directory)), false);
});

test("clause 15: a session start reads the same file the tools write, so a value chosen once applies to the next session of either host", async (context) => {
  const directory = await appFolder(context, { sessionOffer: "off", reviewBrowserOnStart: "off" });
  const root = await project(context);
  assert.equal(await start(root, { PRISM_REVIEW_APP_DIR: directory }), null);
  assert.equal(await start(root, { PRISM_REVIEW_APP_DIR: directory, CODEX_VERSION: "0.147.0" }, { turn_id: "t1" }), null);
  assert.equal(await opensAtStart(root, desktop(directory)), false);
  assert.equal((await readdir(path.join(root, ".prism"))).includes(FILE), false, "nothing is written into the project");
});

async function skillFiles(directory = path.join(ROOT, "skills")) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await skillFiles(target));
    else if (entry.name.endsWith(".md")) files.push(target);
  }
  return files;
}

test("clause 16: skills read and record the person's own settings through Prism's tools and never as configuration lines", async () => {
  for (const file of await skillFiles()) {
    const text = await readFile(file, "utf8");
    const relative = path.relative(ROOT, file);
    assert.doesNotMatch(text, /^\s*-\s*(Interaction style|Review browser|Review browser on start|Session offer):/m, `${relative} writes no personal setting as a configuration line`);
    assert.doesNotMatch(text, /`(Interaction style|Review browser|Session offer)` (setting|is|defaults)/, `${relative} names no personal setting as a configuration key`);
    assert.doesNotMatch(text, /personal-settings\.json/, `${relative} names no storage file`);
  }
  const setup = await readFile(path.join(ROOT, "skills/setup/SKILL.md"), "utf8");
  assert.doesNotMatch(setup, /^## Interaction$/m, "setup's configuration template has no Interaction section");
  assert.match(setup, /update_personal_settings/, "setup records the person's answers with update_personal_settings");
  assert.match(setup, /get_personal_settings/, "setup reads the interaction style with get_personal_settings");
  const workflow = await readFile(path.join(ROOT, "skills/workflow/SKILL.md"), "utf8");
  assert.match(workflow, /get_personal_settings/, "the workflow skill reads the person's settings with get_personal_settings");
  assert.match(workflow, /^\| Personal setting \|/m, "Common terms defines a personal setting");
  assert.match(await readFile(path.join(ROOT, "skills/workflow/references/visual-review.md"), "utf8"), /get_personal_settings/, "visual review reads the review browser setting with get_personal_settings");
});
