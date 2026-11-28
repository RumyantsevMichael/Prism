import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { blobOf, eventually, git, isolateGit } from "./fixtures/workspace-view.mjs";
import { STRATEGY, codePlaceWorkspace, commitWork } from "./fixtures/code-place.mjs";

// A kept files or versions answer is keyed on everything of the branch models that it reads, so a push to the default branch alone,
// which moves no shown line's tip, still shows in the next answers of every scope.
const environment = await isolateGit();
const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
// The app and the browser close before their Git settings and data folder go, since Windows refuses to delete a file that a running Git process holds.
test.after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(environment, { recursive: true, force: true });
});

test("kept answers follow a push to the default branch that moves no shown line's tip", { timeout: 600000 }, async () => {
  const workspace = await codePlaceWorkspace(suite);
  const json = async (route) => {
    const got = await workspace.ready(route);
    assert.equal(got.status, 200, `${route}: ${got.body}`);
    return got.json;
  };
  const versions = (scope) => json(`versions?scope=${encodeURIComponent(scope)}&repository=api&path=src%2Fretry%2Fstrategy.ts`);
  const files = (scope) => json(`files?scope=${encodeURIComponent(scope)}&folder=api%2Fsrc%2Fretry`);
  const scopes = ["all", "work:retries/metrics"];
  // Read each answer once, so each is kept before the push.
  for (const scope of scopes) {
    assert.equal((await versions(scope)).bases.find((base) => base.branch === "main")?.blob, blobOf(STRATEGY));
    await files(scope);
  }
  const later = `${STRATEGY.replace(/\n?$/, "\n")}// main grows\n`;
  await writeFile(path.join(workspace.owner.root, "src/retry/strategy.ts"), later);
  await writeFile(path.join(workspace.owner.root, "src/retry/added-on-main.ts"), "export const added = 1;\n");
  git(workspace.owner.root, "add", "-A");
  await commitWork(workspace.owner.root, { title: "main moves" });
  git(workspace.owner.root, "push", "-q", "origin", "main");
  for (const scope of scopes) {
    await eventually(async () => (await versions(scope)).bases.find((base) => base.branch === "main")?.blob === blobOf(later), 60000, `${scope} names main's new blob`);
    await eventually(async () => (await files(scope)).entries.some((entry) => entry.path === "api/src/retry/added-on-main.ts"), 60000, `${scope} lists main's new file`);
  }
});
