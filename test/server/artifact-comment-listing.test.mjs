import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, isolateGit, ok, requirementFile, server, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// A sync can bring any number of comment files, and every open review page reads a file's comments on each poll,
// so a read of one page of comments reads only that page's files while the folder is unchanged, and a change to the folder is listed at the next read.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";
const LOCATION = "requirements/billing.md";
const COUNT = 300;

const commentFile = (index) => {
  const at = new Date(Date.UTC(2026, 10, 7) + index * 1000).toISOString();
  const name = `${at.replace(/[:.]/g, "-")}-${index.toString(16).padStart(8, "0")}.json`;
  const value = { location: LOCATION, version: version("v"), line: 1, text: `Comment ${index}.`, author: { name: "Grace", host: "h" }, at, entry: index.toString(16).padStart(32, "0"), by: { name: "Grace", email: null, checkout: "acme/web" }, via: "review-app" };
  return { name, bytes: `${JSON.stringify(value)}\n` };
};

test("a page of comments reads only its own files while the comment folder is unchanged, and a new or changed file shows at the next read that meets it", { timeout: 120000 }, async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const folder = path.join(place.store, "artifact-comments", ...LOCATION.split("/"));
  await mkdir(folder, { recursive: true });
  for (let index = 1; index <= COUNT; index += 1) { const { name, bytes } = commentFile(index); await writeFile(path.join(folder, name), bytes); }
  // A listing taken within a second of a change is never reused, as a coarse clock could give a later change the same stamp.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const read = async (commentOffset = 1) => ok(await prism.call("get_artifact", { path: FILE, commentOffset }));

  const first = await read();
  assert.equal(first.totalComments, COUNT);
  assert.deepEqual(first.comments.map((comment) => comment.text), Array.from({ length: 20 }, (_, index) => `Comment ${index + 1}.`));

  // A file far past the first page is damaged in place, which leaves the folder's own stamp as it was: the next read of the first page reads none of the other pages' files.
  const names = (await readdir(folder)).sort();
  await writeFile(path.join(folder, names.at(-1)), "damaged\n");
  assert.equal((await read()).totalComments, COUNT, "the first page reads only its own files");

  // The page that holds the damaged file reads it, finds it changed, and lists the folder again.
  const last = await read(COUNT - 19);
  assert.equal(last.totalComments, COUNT - 1);
  assert.deepEqual(last.comments.map((comment) => comment.text), Array.from({ length: 19 }, (_, index) => `Comment ${COUNT - 19 + index}.`));
  assert.equal(last.nextCommentOffset, null);

  // A comment that arrives changes the folder, so the next read counts it.
  const arrived = commentFile(COUNT + 1);
  await writeFile(path.join(folder, arrived.name), arrived.bytes);
  const after = await read(COUNT - 1);
  assert.equal(after.totalComments, COUNT);
  assert.deepEqual(after.comments.map((comment) => comment.text), [`Comment ${COUNT - 1}.`, `Comment ${COUNT + 1}.`]);
  // A removed one goes at the next read too.
  await rm(path.join(folder, names[0]));
  const removed = await read();
  assert.equal(removed.totalComments, COUNT - 1);
  assert.equal(removed.comments[0].text, "Comment 2.");
});
