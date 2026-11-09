import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { answerGate, browserRequest, checkout, git, isolateGit, ok, requirementFile, reviewBrowser, server, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 39-42 of the workspace-artifacts design: people review artifact changes against the accepted version and comment through the store.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";
const COMMENTS = (store) => path.join(store, "artifact-comments", "requirements", "billing.md");

async function project(context, { named = true } = {}) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  if (named) git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  return { place, api, prism, review };
}

const artifactView = async (review, file = FILE) => (await browserRequest(review, `/api/artifact?path=${encodeURIComponent(file)}`)).body;
const comment = (review, body, headers) => browserRequest(review, "/api/artifact/comments", { method: "POST", body, headers });

test("clause 39: an artifact is shown against its accepted version, or as added when it has none", async (context) => {
  const { prism, review } = await project(context);
  const draft = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const fresh = await artifactView(review);
  assert.equal(fresh.artifact.scope.label, "workspace");
  assert.equal(fresh.artifact.version, draft.version);
  assert.equal(fresh.artifact.accepted, null);
  assert.equal(fresh.artifact.changed, true, "a never-accepted artifact is shown whole as added");
  assert.deepEqual(fresh.artifact.comments, []);

  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  const answered = await answerGate(review, { id: asked.artifacts[0].gate, choice: "approve" });
  assert.equal(answered.status, 200);
  const approved = ok(await prism.call("get_artifact", { path: FILE }));
  const same = await artifactView(review);
  assert.equal(same.artifact.changed, false);
  assert.equal(same.artifact.accepted.version, approved.version);

  ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: approved.version, edits: [{ oldText: "do the thing.", newText: "do the thing twice." }] }] }));
  const changed = await artifactView(review);
  assert.equal(changed.artifact.changed, true);
  assert.equal(changed.artifact.accepted.version, approved.version);
  assert.equal(changed.artifact.accepted.content, approved.content);
  assert.notEqual(changed.artifact.version, approved.version);
});

test("clause 40: a comment from the review page is stored in the store, one file per comment, with its author, host, version, and time", async (context) => {
  const { place, prism, review } = await project(context);
  const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const posted = await comment(review, { path: FILE, scope: "workspace", version: written.version, line: 12, text: "Which currency?" });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.path, FILE);
  assert.equal(posted.body.version, written.version);
  assert.equal(posted.body.line, 12);
  assert.equal(posted.body.text, "Which currency?");
  assert.deepEqual(posted.body.author, { name: "Ada Reviewer", host: os.hostname() });
  assert.ok(Date.parse(posted.body.at) > Date.now() - 600000);
  const files = (await readdir(COMMENTS(place.store))).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  const stored = JSON.parse(await readFile(path.join(COMMENTS(place.store), files[0]), "utf8"));
  assert.equal(stored.text, "Which currency?");
  assert.equal(stored.version, written.version);
  assert.equal(stored.location, "requirements/billing.md");
  assert.equal((await comment(review, { path: FILE, scope: "workspace", version: written.version, line: 1, text: "Second." })).status, 201);
  assert.equal((await readdir(COMMENTS(place.store))).filter((name) => name.endsWith(".json")).length, 2, "each comment is a file of its own");
});

test("clause 41: a comment is refused unless it is JSON from the page, names a seen artifact, has text of 1 to 4000 characters, and Git names its author", async (context) => {
  const { prism, review } = await project(context);
  const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const body = { path: FILE, scope: "workspace", version: written.version, line: 1, text: "Fine." };
  assert.equal((await comment(review, JSON.stringify(body), { "Content-Type": "text/plain" })).status, 403);
  assert.equal((await comment(review, body, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await comment(review, { ...body, path: "docs/requirements/missing.md" })).status, 404);
  assert.equal((await comment(review, { ...body, path: "README.md" })).status, 404);
  assert.equal((await comment(review, { ...body, text: "   " })).status, 400);
  assert.equal((await comment(review, { ...body, text: "x".repeat(4001) })).status, 400);
  assert.equal((await comment(review, { ...body, text: "x".repeat(4000) })).status, 201);

  const anonymous = await project(context, { named: false });
  const other = await writeArtifact(anonymous.prism, FILE, requirementFile("Billing"));
  const refusedComment = await comment(anonymous.review, { ...body, version: other.version });
  assert.equal(refusedComment.status, 409);
  assert.equal(refusedComment.body.code, "author_unknown");
});

test("clause 42: every reader gets an artifact's comments oldest first, including those a sync brought from another machine", async (context) => {
  const { place, prism, review } = await project(context);
  const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
  assert.equal((await comment(review, { path: FILE, scope: "workspace", version: written.version, line: 3, text: "First here." })).status, 201);
  // A comment written on another machine arrives as a file of its own when the store syncs.
  await mkdir(COMMENTS(place.store), { recursive: true });
  await writeFile(path.join(COMMENTS(place.store), "2026-11-07T00-00-00-000Z-0a1b2c3d.json"), `${JSON.stringify({ location: "requirements/billing.md", version: version("older"), line: 1, text: "Earlier, elsewhere.", author: { name: "Grace", host: "laptop" }, at: "2026-11-07T00:00:00.000Z" })}\n`);
  const shown = await artifactView(review);
  assert.deepEqual(shown.artifact.comments.map((item) => item.text), ["Earlier, elsewhere.", "First here."]);
  assert.deepEqual(shown.artifact.comments[0].author, { name: "Grace", host: "laptop" });
  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.deepEqual(read.comments.map((item) => item.text), ["Earlier, elsewhere.", "First here."]);
  assert.equal(read.comments[1].version, written.version);
});
