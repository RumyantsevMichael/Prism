import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { attentionWork } from "../../dist/server/workflow/artifact-comments.mjs";
import { appliedArtifactActions } from "../../dist/server/workflow/store-artifacts.mjs";
import { checkout, git, isolateGit, ok, requirementFile, server, version, workspace } from "./fixtures/workspace-artifacts.mjs";

// Attention lists the newest comments of every artifact the checkout sees on each poll, so its cost is the folders' kept listings and a bounded number of comment files,
// whatever number of comment folders and comment files the store holds.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const LATEST = 20;
const location = (index) => `requirements/f${index}.md`;
const entryId = (number) => number.toString(16).padStart(32, "0");
const timeOf = (second) => new Date(Date.UTC(2026, 10, 7) + second * 1000).toISOString();
const comment = (index, number, at) => ({
  location: location(index), version: version("v"), line: 1, text: `Comment ${number} on f${index}.`, author: { name: "Grace", host: "laptop" },
  at, entry: entryId(index * 100 + number), by: { name: "Grace", email: null, checkout: "acme/web" }, via: "review-app"
});
// A comment file's name is its time with ":" and "." as "-", then a suffix.
const nameOf = (at, suffix) => `${at.replace(/[:.]/g, "-")}-${suffix.toString(16).padStart(8, "0")}.json`;
const folderOf = (place, index) => path.join(place.store, "artifact-comments", ...location(index).split("/"));
const comments = (entries) => entries.filter((entry) => entry.action === "artifact.comment");

// Count the comment files that the process opens while action runs, through the module that every reader opens files with.
async function commentOpens(action) {
  const original = fs.open;
  const opened = [];
  fs.open = (target, ...rest) => { if (String(target).includes(`${path.sep}artifact-comments${path.sep}`)) opened.push(String(target)); return original(target, ...rest); };
  syncBuiltinESMExports();
  try { return { result: await action(), opened }; }
  finally { fs.open = original; syncBuiltinESMExports(); }
}

// A checkout that sees count requirements, each written through Prism.
async function artifacts(context, count) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  for (let start = 0; start < count; start += 50) {
    const operations = Array.from({ length: Math.min(50, count - start) }, (_, offset) => ({ op: "write", path: `docs/${location(start + offset)}`, content: requirementFile(`F${start + offset}`), expectedVersion: null }));
    ok(await prism.call("update_artifact", { operations }));
  }
  return { place, api, prism };
}

// A file changed within a second of a read may share its stamp with a later change on a coarse clock, so each test waits that long, as a poll after a sync does.
const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

test("Attention's first read over many comment files opens about as many as it lists, and a second read opens only the ones it lists", { timeout: 240000 }, async (context) => {
  const ARTIFACTS = 300;
  const PER = 3;
  const { place, api } = await artifacts(context, ARTIFACTS);
  // Every comment has a time of its own, the newest PER * ARTIFACTS seconds after the first.
  for (let index = 0; index < ARTIFACTS; index += 1) {
    await mkdir(folderOf(place, index), { recursive: true });
    for (let number = 1; number <= PER; number += 1) {
      const at = timeOf(index * PER + number);
      await writeFile(path.join(folderOf(place, index), nameOf(at, index * 100 + number)), `${JSON.stringify(comment(index, number, at))}\n`);
    }
  }
  await settle();
  const first = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
  const expected = Array.from({ length: LATEST }, (_, offset) => ARTIFACTS * PER - offset).map((serial) => entryId(Math.floor((serial - 1) / PER) * 100 + ((serial - 1) % PER) + 1));
  assert.deepEqual(comments(first.result).map((entry) => entry.id).sort(), expected.sort(), "the newest comments of all folders are listed");
  assert.ok(first.opened.length <= LATEST + 4, `the first read opens about the ${LATEST} comment files it lists, not every folder's: ${first.opened.length}`);
  for (const wait of [0, 6000]) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const again = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
    assert.deepEqual(comments(again.result).map((entry) => entry.id).sort(), expected, "the second read lists the same entries");
    assert.ok(again.opened.length <= LATEST, `after ${wait} ms the second read opens only the ${LATEST} comment files it lists: ${again.opened.length}`);
  }
});

test("Attention reads every comment that shares the last listed time, and lists the newest of them by entry id", { timeout: 240000 }, async (context) => {
  const ARTIFACTS = 30;
  const { place, api } = await artifacts(context, ARTIFACTS);
  const at = timeOf(10);
  // One comment per folder, all at one time, with entry ids that run against the order of the folders and of the file names.
  for (let index = 0; index < ARTIFACTS; index += 1) {
    await mkdir(folderOf(place, index), { recursive: true });
    const value = { ...comment(index, 1, at), entry: entryId(1000 - index) };
    await writeFile(path.join(folderOf(place, index), nameOf(at, index)), `${JSON.stringify(value)}\n`);
  }
  await settle();
  const read = comments(await appliedArtifactActions(api, { latest: LATEST }));
  assert.deepEqual(read.map((entry) => entry.id).sort(), Array.from({ length: LATEST }, (_, index) => entryId(1000 - index)).sort(), "the comments of the last time are chosen by entry id");
});

test("planted files that hold no comment under newer names cost a bounded number of reads per Attention read, and the comments still appear within a few reads", { timeout: 240000 }, async (context) => {
  const ARTIFACTS = 40;
  const PLANTED = 10;
  const { place, api } = await artifacts(context, ARTIFACTS);
  for (let index = 0; index < ARTIFACTS; index += 1) {
    await mkdir(folderOf(place, index), { recursive: true });
    const at = timeOf(index);
    await writeFile(path.join(folderOf(place, index), nameOf(at, index)), `${JSON.stringify(comment(index, 1, at))}\n`);
    // Newer names than every comment, holding damaged bytes, a comment whose time is not its name's, or another location's comment.
    for (let number = 0; number < PLANTED; number += 1) {
      const newer = timeOf(1000 + index * PLANTED + number);
      const bytes = [`damaged ${number}\n`, `${JSON.stringify(comment(index, 2, at))}\n`, `${JSON.stringify({ ...comment(index, 2, newer), location: "requirements/other.md" })}\n`][number % 3];
      await writeFile(path.join(folderOf(place, index), nameOf(newer, 0xf0000000 + number)), bytes);
    }
  }
  await settle();
  const expected = Array.from({ length: LATEST }, (_, offset) => entryId((ARTIFACTS - 1 - offset) * 100 + 1)).sort();
  const reads = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const read = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
    reads.push({ opened: read.opened.length, ids: comments(read.result).map((entry) => entry.id).sort() });
    if (reads.at(-1).ids.join() === expected.join()) break;
  }
  for (const [index, { opened }] of reads.entries()) assert.ok(opened <= LATEST * 5 + 16, `read ${index + 1} opens a bounded number of files: ${opened}`);
  assert.deepEqual(reads.at(-1).ids, expected, `the comments appear: ${JSON.stringify(reads.map(({ opened, ids }) => [opened, ids.length]))}`);
  assert.ok(reads.length <= Math.ceil((ARTIFACTS * PLANTED) / (LATEST * 4)) + 1, `within a few reads: ${reads.length}`);
  // Once the planted files are known, a read opens only the files it lists.
  const known = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
  assert.deepEqual(comments(known.result).map((entry) => entry.id).sort(), expected);
  assert.ok(known.opened.length <= LATEST, `a later read opens only the comments it lists: ${known.opened.length}`);
});

test("a file whose name gives another time than its at is no comment for any reader", { timeout: 120000 }, async (context) => {
  const { place, api, prism } = await artifacts(context, 1);
  const at = timeOf(5);
  await mkdir(folderOf(place, 0), { recursive: true });
  // The same comment under its own time's name, and under the name of a later and an earlier time.
  await writeFile(path.join(folderOf(place, 0), nameOf(at, 1)), `${JSON.stringify({ ...comment(0, 1, at), entry: entryId(1) })}\n`);
  await writeFile(path.join(folderOf(place, 0), nameOf(timeOf(500), 2)), `${JSON.stringify({ ...comment(0, 2, at), entry: entryId(2) })}\n`);
  await writeFile(path.join(folderOf(place, 0), nameOf(timeOf(1), 3)), `${JSON.stringify({ ...comment(0, 3, at), entry: entryId(3) })}\n`);
  await settle();
  const read = ok(await prism.call("get_artifact", { path: `docs/${location(0)}` }));
  assert.equal(read.totalComments, 1, "only the file named by its comment's time is a comment");
  assert.deepEqual(read.comments.map((entry) => entry.entry), [entryId(1)]);
  assert.deepEqual(comments(await appliedArtifactActions(api, { latest: LATEST })).map((entry) => entry.id), [entryId(1)], "Attention leaves the others out");
});

// The names that Attention walked and the items it merged while action ran, so a test shows how a poll's work grows.
async function attentionCost(action) {
  const before = attentionWork();
  const result = await action();
  const after = attentionWork();
  return { result, work: after.walked - before.walked + after.merged - before.merged };
}

test("names dated ahead of the clock or at no real time cost an Attention poll no work, however many a folder holds", { timeout: 240000 }, async (context) => {
  const ARTIFACTS = 30;
  const PLANTED = 400;
  const { place, api } = await artifacts(context, ARTIFACTS);
  for (let index = 0; index < ARTIFACTS; index += 1) {
    await mkdir(folderOf(place, index), { recursive: true });
    const at = timeOf(index);
    await writeFile(path.join(folderOf(place, index), nameOf(at, index)), `${JSON.stringify(comment(index, 1, at))}\n`);
    // Half the planted names lie years after the clock, and half name no real moment; none of them is ever read.
    for (let number = 0; number < PLANTED; number += 1) {
      const name = number % 2 ? nameOf(new Date(Date.UTC(2099, 0, 1) + number * 1000).toISOString(), number) : `2026-02-30T00-00-00-000Z-${number.toString(16).padStart(8, "0")}.json`;
      await writeFile(path.join(folderOf(place, index), name), "planted\n");
    }
  }
  await settle();
  const expected = Array.from({ length: LATEST }, (_, offset) => entryId((ARTIFACTS - 1 - offset) * 100 + 1)).sort();
  for (let poll = 1; poll <= 3; poll += 1) {
    const read = await attentionCost(() => commentOpens(() => appliedArtifactActions(api, { latest: LATEST })));
    assert.deepEqual(comments(read.result.result).map((entry) => entry.id).sort(), expected, `poll ${poll} lists the newest comments`);
    assert.ok(read.result.opened.length <= LATEST, `poll ${poll} opens only the comment files it lists: ${read.result.opened.length}`);
    // Each folder's summary walks its one comment once, and a poll merges about the comments it lists, never the planted names.
    assert.ok(read.work <= 2 * (ARTIFACTS + LATEST), `poll ${poll} walks and merges about the comments, not the ${ARTIFACTS * PLANTED} planted names: ${read.work}`);
  }
});

test("comments that share one time cost an Attention poll work for the comments it lists once they are known, and are listed by entry id", { timeout: 240000 }, async (context) => {
  const ARTIFACTS = 10;
  const TIED = 150;
  const { place, api } = await artifacts(context, ARTIFACTS);
  const at = timeOf(10);
  for (let index = 0; index < ARTIFACTS; index += 1) {
    await mkdir(folderOf(place, index), { recursive: true });
    // Every comment of every folder has one time, and its file name runs against its entry id.
    for (let number = 1; number <= TIED; number += 1) {
      const value = { ...comment(index, number, at), entry: entryId(index * 10000 + number) };
      await writeFile(path.join(folderOf(place, index), nameOf(at, 0xffff - number)), `${JSON.stringify(value)}\n`);
    }
  }
  await settle();
  const expected = Array.from({ length: LATEST }, (_, offset) => entryId((ARTIFACTS - 1) * 10000 + TIED - offset));
  // The first polls learn the files within their read budget, and go on from what the earlier ones learned.
  let polls = 0;
  for (let listed = []; listed.join() !== expected.join(); polls += 1) {
    assert.ok(polls < Math.ceil((ARTIFACTS * TIED) / (LATEST * 4)) + 2, `the tied comments are listed within a few polls: ${polls}`);
    const read = await commentOpens(() => appliedArtifactActions(api, { latest: LATEST }));
    assert.ok(read.opened.length <= LATEST * 5 + 16, `poll ${polls + 1} opens a bounded number of files: ${read.opened.length}`);
    listed = comments(read.result).map((entry) => entry.id);
  }
  // The poll after the last files were learned takes the summaries of their folders again, once.
  await appliedArtifactActions(api, { latest: LATEST });
  for (let poll = 1; poll <= 3; poll += 1) {
    const read = await attentionCost(() => commentOpens(() => appliedArtifactActions(api, { latest: LATEST })));
    assert.deepEqual(comments(read.result.result).map((entry) => entry.id), expected, `poll ${poll} lists the newest tied comments by entry id`);
    assert.ok(read.result.opened.length <= LATEST, `poll ${poll} opens only the comment files it lists: ${read.result.opened.length}`);
    assert.ok(read.work <= 2 * (ARTIFACTS + LATEST), `poll ${poll} merges about the comments it lists, not the ${ARTIFACTS * TIED} tied ones: ${read.work}`);
  }
});
