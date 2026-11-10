import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { appliedArtifactActions } from "../../dist/server/workflow/store-artifacts.mjs";
import { checkout, git, isolateGit, ok, requirementFile, server, version, workspace } from "./fixtures/workspace-artifacts.mjs";

// Attention lists the newest comments of every artifact the checkout sees on each poll, so its cost is the folders' kept listings and a bounded number of comment files,
// whatever number of comment folders the store holds.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const ARTIFACTS = 300;
const PER = 3;
const LATEST = 20;
const location = (index) => `requirements/f${index}.md`;
const comment = (index, number) => ({
  location: location(index), version: version("v"), line: 1, text: `Comment ${number} on f${index}.`, author: { name: "Grace", host: "laptop" },
  at: `2026-11-07T00:00:${String(number).padStart(2, "0")}.000Z`, entry: (index * 100 + number).toString(16).padStart(32, "0"), by: { name: "Grace", email: null, checkout: "acme/web" }, via: "review-app"
});

// Count the comment files that the process opens while action runs, through the module that every reader opens files with.
async function commentOpens(action) {
  const original = fs.open;
  const opened = [];
  fs.open = (target, ...rest) => { if (String(target).includes(`${path.sep}artifact-comments${path.sep}`)) opened.push(String(target)); return original(target, ...rest); };
  syncBuiltinESMExports();
  try { return { result: await action(), opened }; }
  finally { fs.open = original; syncBuiltinESMExports(); }
}

test("a second read of Attention's recent changes over more than 256 comment folders reads only the comment files it lists", { timeout: 240000 }, async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  for (let start = 0; start < ARTIFACTS; start += 50) {
    const operations = Array.from({ length: Math.min(50, ARTIFACTS - start) }, (_, offset) => ({ op: "write", path: `docs/${location(start + offset)}`, content: requirementFile(`F${start + offset}`), expectedVersion: null }));
    ok(await prism.call("update_artifact", { operations }));
  }
  for (let index = 0; index < ARTIFACTS; index += 1) {
    const folder = path.join(place.store, "artifact-comments", ...location(index).split("/"));
    await mkdir(folder, { recursive: true });
    for (let number = 1; number <= PER; number += 1) await writeFile(path.join(folder, `2026-11-07T00-00-${String(number).padStart(2, "0")}-000Z-${(index * 100 + number).toString(16).padStart(8, "0")}.json`), `${JSON.stringify(comment(index, number))}\n`);
  }
  // A file changed within a second of a listing may share its stamp with a later change on a coarse clock, so the first read waits that long, as a poll after a sync does.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const first = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
  assert.equal(first.result.filter((entry) => entry.action === "artifact.comment").length, LATEST, "the newest comments of all folders are listed");
  assert.ok(first.opened.length >= ARTIFACTS * PER, "the first read lists every folder's comments");
  for (const wait of [0, 6000]) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const again = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
    assert.deepEqual(again.result.map((entry) => entry.id).sort(), first.result.map((entry) => entry.id).sort(), "the second read lists the same entries");
    assert.ok(again.opened.length <= LATEST, `after ${wait} ms the second read opens only the ${LATEST} comment files it lists: ${again.opened.length}`);
  }
});
