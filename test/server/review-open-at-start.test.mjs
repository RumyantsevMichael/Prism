import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { opensAtStart } from "../../dist/server/review/open-at-start.mjs";
import { olderVersion } from "../../dist/server/review/review-app-discovery.mjs";

async function project(context, interaction) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-open-at-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  if (interaction !== undefined) {
    await mkdir(path.join(root, ".prism"));
    await writeFile(path.join(root, ".prism", "workflow.md"), `# Workflow config\n\n## Interaction\n${interaction}\n`);
  }
  return root;
}

const desktop = { env: {}, platform: "darwin" };

test("a desktop session opens the review browser at start by default", async (context) => {
  assert.equal(await opensAtStart(await project(context), desktop), true);
  assert.equal(await opensAtStart(await project(context, "- Review browser: auto"), desktop), true);
  assert.equal(await opensAtStart(await project(context, "- Review browser: external\n- Review browser on start: open"), desktop), true);
});

test("a project or user that turned it off, or chose the internal browser, opens nothing at start", async (context) => {
  assert.equal(await opensAtStart(await project(context, "- Review browser on start: off"), desktop), false);
  assert.equal(await opensAtStart(await project(context, "- Review browser: internal"), desktop), false);
  assert.equal(await opensAtStart(await project(context), { env: { PRISM_REVIEW_BROWSER_ON_START: "off" }, platform: "darwin" }), false);
});

test("sessions where nobody can see a window open nothing at start", async (context) => {
  const root = await project(context);
  assert.equal(await opensAtStart(root, { env: { CLAUDE_CODE_REMOTE: "true" }, platform: "darwin" }), false);
  assert.equal(await opensAtStart(root, { env: { CI: "true" }, platform: "win32" }), false);
  assert.equal(await opensAtStart(root, { env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, platform: "darwin" }), false);
  assert.equal(await opensAtStart(root, { env: {}, platform: "linux" }), false);
  assert.equal(await opensAtStart(root, { env: { DISPLAY: ":0" }, platform: "linux" }), true);
});

test("only a readable older release counts as older", () => {
  assert.equal(olderVersion("0.12.0", "0.13.0"), true);
  assert.equal(olderVersion("0.9.9", "0.10.0"), true);
  assert.equal(olderVersion("1.0.0", "0.13.0"), false);
  assert.equal(olderVersion("0.13.0", "0.13.0"), false);
  assert.equal(olderVersion(null, "0.13.0"), false);
  assert.equal(olderVersion("0.12.0", null), false);
});
