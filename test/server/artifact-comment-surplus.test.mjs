import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkout, closeServers, git, isolateGit, notes, requirementFile, server, version } from "./fixtures/workspace-artifacts.mjs";

// A comment folder holds at most 1000 comments, so where this machine's comments would take a merged folder past that, a sync saves the rest and names each one as a comment
// on a file that already holds the comments a file may hold, also when the comment reached the disk after the sync read the folder, and no folder on disk holds more than a reader takes.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { syncRecordStore, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { withFileLock } = await import("../../dist/server/workflow/artifact-store.mjs");

const LIMIT = 1000;
const FILE = "docs/requirements/billing.md";
const LOCATION = "requirements/billing.md";
const FOLDER = `artifact-comments/${LOCATION}`;
const timeOf = (number) => new Date(Date.UTC(2026, 10, 7) + number * 1000).toISOString();
const commentPath = (number) => `${FOLDER}/${timeOf(number).replace(/[:.]/g, "-")}-${number.toString(16).padStart(8, "0")}.json`;
const commentLine = (number, text = `Comment ${number}.`) => `${JSON.stringify({
  location: LOCATION, version: version("v"), line: 3, text, author: { name: "Grace", host: "laptop" },
  at: timeOf(number), entry: number.toString(16).padStart(32, "0"), by: { name: "Grace", email: null, checkout: "acme/web" }, via: "review-app"
})}\n`;

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
}
function push(root, message, first = false) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  git(root, "push", "-q", ...(first ? ["-u"] : []), "origin", "main");
}
// Two clones of one bare remote, a and b, whose first commit holds a requirement and 999 comments on it; a then pushes the thousandth.
async function storesAtTheLimit(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-surplus-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  const remote = path.join(parent, "remote.git");
  git(parent, "clone", "-q", remote, "a");
  const a = path.join(parent, "a");
  git(a, "checkout", "-q", "-b", "main");
  const files = { "README.md": "Prism store\n", [`artifacts/${LOCATION}`]: requirementFile("Billing"), [`artifact-identity/${LOCATION}`]: `${JSON.stringify({ id: "0123456789abcdef0123456789abcdef" })}\n` };
  for (let number = 1; number < LIMIT; number += 1) files[commentPath(number)] = commentLine(number);
  await put(a, files);
  push(a, "init", true);
  git(parent, "clone", "-q", remote, "b");
  await put(a, { [commentPath(LIMIT)]: commentLine(LIMIT, "From the upstream.") });
  push(a, "the thousandth comment");
  return { remote, a, b: path.join(parent, "b") };
}
const onDisk = async (store) => (await readdir(path.join(store, ...FOLDER.split("/")))).length;
const atHead = (store) => git(store, "ls-tree", "--name-only", "HEAD", `${FOLDER}/`).split("\n").filter(Boolean);
const savedCopy = (store, synced, file) => {
  const conflict = (synced.conflicts ?? []).find((entry) => entry.path === file);
  return conflict?.savedAs ? path.join(store, ...conflict.savedAs.split("/")) : null;
};
// The notes of the first two tool results of a Prism server started after a sync, on a checkout of repository api that uses the store.
async function laterNotes(context, store) {
  const parent = path.dirname(store);
  const machine = { parent, storeSetting: `../${path.basename(store)}`, app: path.join(parent, `app-${path.basename(store)}`), sync: "on" };
  const prism = await server(context, machine, await checkout(machine, "api"));
  const said = [notes(await prism.call("get_artifact", {})), notes(await prism.call("get_artifact", {}))];
  await closeServers();
  return said;
}
const occurrences = (text, part) => text.split(part).length - 1;

test("a comment that the folder's bound leaves out of a merge is named as one on a file that already holds 1000 comments, once, quoting only a comment of the exact form", { timeout: 240000 }, async (context) => {
  const { remote, b } = await storesAtTheLimit(context);
  // This machine added a comment of the form Prism writes and a damaged file named like a comment, both past the bound once the upstream's thousandth arrives.
  const own = commentPath(LIMIT + 1);
  const damaged = commentPath(LIMIT + 2);
  await put(b, { [own]: commentLine(LIMIT + 1, "From this machine."), [damaged]: "{\"text\":\"Not a comment.\"}\n" });
  const synced = await syncRecordStoreNow(b);
  assert.equal(synced.state, "conflicts", synced.message);
  assert.equal(atHead(b).length, LIMIT, "the merged folder holds 1000 comments");
  assert.equal(git(remote, "ls-tree", "--name-only", "main", `${FOLDER}/`).split("\n").filter(Boolean).length, LIMIT, "and so does the remote");
  assert.ok(await onDisk(b) <= LIMIT, "and the folder on disk holds no more");
  const [ownCopy, damagedCopy] = [savedCopy(b, synced, own), savedCopy(b, synced, damaged)];
  assert.ok(ownCopy && damagedCopy, `both are saved: ${JSON.stringify(synced.conflicts)}`);
  const [first, second] = await laterNotes(context, b);
  assert.match(first, /already holds the 1000 comments that a file may hold/, "the note says that the file already holds the comments a file may hold");
  assert.doesNotMatch(first, /no longer holds the artifact/, "and does not call the artifact removed");
  assert.ok(first.includes(`${FILE} in scope workspace`), "it names the file and its scope");
  assert.equal(occurrences(first, ownCopy), 1, "it names the comment once");
  assert.equal(occurrences(first, damagedCopy), 1, "and the damaged file once");
  assert.ok(first.includes("a comment on line 3: \"From this machine.\""), "it quotes the comment of the exact form");
  assert.equal(first.includes("Not a comment."), false, "and no bytes of the other file");
  assert.equal(second.includes(ownCopy), false, "a later result does not name it again");
});

for (const [how, race] of [
  ["while the sync fetches", async (b) => syncRecordStore(b, { beforeApply: () => put(b, { [commentPath(LIMIT + 1)]: commentLine(LIMIT + 1, "Written meanwhile.") }) })],
  ["before a sync that finds an update holding the artifact lock", async (b) => {
    await put(b, { [commentPath(LIMIT + 1)]: commentLine(LIMIT + 1, "Written meanwhile.") });
    let release;
    const held = withFileLock(path.join(b, "artifacts"), () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const head = git(b, "rev-parse", "HEAD");
    // The sync that finds the lock busy commits, merges, and pushes nothing and ends as skipped, so the comment stays on disk for the next sync, which merges it.
    const busy = await syncRecordStore(b);
    release();
    await held;
    assert.equal(busy.state, "skipped", JSON.stringify(busy));
    assert.equal(git(b, "rev-parse", "HEAD"), head);
    return syncRecordStoreNow(b);
  }]
]) {
  test(`a comment written ${how}, which no commit of the sync holds, is saved and named rather than left past the folder's bound on disk`, { timeout: 240000 }, async (context) => {
    const { b } = await storesAtTheLimit(context);
    const synced = await race(b);
    const own = commentPath(LIMIT + 1);
    assert.ok(await onDisk(b) <= LIMIT, `the folder on disk holds at most ${LIMIT} entries: ${await onDisk(b)}`);
    assert.ok(atHead(b).includes(commentPath(LIMIT)), "the upstream's comment stays");
    const copy = savedCopy(b, synced, own);
    assert.ok(copy, `the comment is saved: ${JSON.stringify(synced.conflicts)}`);
    const again = await syncRecordStoreNow(b);
    assert.equal(again.withheld, undefined, `a later sync withholds nothing: ${again.message}`);
    const [first] = await laterNotes(context, b);
    assert.match(first, /already holds the 1000 comments that a file may hold/);
    assert.equal(occurrences(first, copy), 1, "the next result names it once");
    assert.ok(first.includes("\"Written meanwhile.\""), "quoting it");
  });
}

test("a local comment folder past the bound names a fix that works for the comment files it withholds", { timeout: 240000 }, async (context) => {
  const { b } = await storesAtTheLimit(context);
  git(b, "pull", "-q", "--ff-only");
  // A comment file put there by hand takes the folder past the bound.
  await put(b, { [commentPath(LIMIT + 1)]: commentLine(LIMIT + 1, "By hand.") });
  const synced = await syncRecordStoreNow(b);
  assert.deepEqual((synced.withheld ?? []).map((entry) => entry.path), [commentPath(LIMIT + 1)]);
  assert.match(synced.message, /Move each comment file that the sync did not commit out of its comment folder/);
  assert.doesNotMatch(synced.message, /Rename, shorten, or fix/, "and no fix that a comment file past the bound cannot take");
});
