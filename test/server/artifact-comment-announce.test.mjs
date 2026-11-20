import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startReviewApp } from "../../dist/server/review/review-app-server.mjs";
import { startStandaloneReview } from "../../dist/server/review/review-server-pool.mjs";
import { actionOf, apply, listing, writeHeaders } from "./fixtures/review-actions.mjs";
import { checkout, git, isolateGit, ok, requirementFile, server, version, workspace } from "./fixtures/workspace-artifacts.mjs";

// An applied comment reaches the open tabs of every other checkout that sees its artifact, and each of those checkouts reads only the one comment file it delivers,
// whatever number of comments the store's other artifacts hold.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const ARTIFACTS = 40;
const PER = 25;
const location = (index) => `requirements/f${index}.md`;
const nameOf = (at, suffix) => `${at.replace(/[:.]/g, "-")}-${suffix.toString(16).padStart(8, "0")}.json`;

// Collects the named events of a viewer stream, as a connected tab receives them.
function viewerEvents(context, url, name) {
  const seen = [];
  const request = http.get(url, (response) => {
    context.after(() => response.destroy());
    let buffer = "";
    response.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^event: (.+)$/m.exec(block)?.[1] === name) seen.push(JSON.parse(/^data: (.+)$/m.exec(block)[1]));
      }
    });
  });
  request.on("error", () => {});
  return seen;
}

test("one comment with another checkout's tab open opens about one comment file for that checkout, not every comment of every artifact", { timeout: 240000 }, async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const web = await checkout(place, "web");
  const prism = await server(context, place, api);
  for (let start = 0; start < ARTIFACTS; start += 50) {
    const operations = Array.from({ length: Math.min(50, ARTIFACTS - start) }, (_, offset) => ({ op: "write", path: `docs/${location(start + offset)}`, content: requirementFile(`F${start + offset}`), expectedVersion: null }));
    ok(await prism.call("update_artifact", { operations }));
  }
  // Every artifact already holds comments that a sync brought, none of which this process has read.
  for (let index = 0; index < ARTIFACTS; index += 1) {
    const folder = path.join(place.store, "artifact-comments", ...location(index).split("/"));
    await mkdir(folder, { recursive: true });
    for (let number = 0; number < PER; number += 1) {
      const at = new Date(Date.UTC(2026, 10, 7) + number * 1000).toISOString();
      const value = { location: location(index), version: version("v"), line: 1, text: `Planted ${number}.`, author: { name: "Grace", host: "laptop" }, at, entry: (index * 1000 + number + 1).toString(16).padStart(32, "0"), by: { name: "Grace", email: null, checkout: "acme/web" }, via: "review-app" };
      await writeFile(path.join(folder, nameOf(at, number)), `${JSON.stringify(value)}\n`);
    }
  }
  const parent = await mkdtemp(path.join(os.tmpdir(), "prism-announce-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "review-app");
  // The review app runs in this process, so the test counts the comment files it opens.
  const app = await startReviewApp({ directory });
  context.after(() => app.close());
  const env = { ...process.env, PRISM_REVIEW_APP_DIR: directory };
  const opened = [];
  const openBrowser = (url) => { opened.push(url); return true; };
  const baseOf = (url) => /^(.*\/[pw]\/[0-9a-f]{16})/.exec(new URL(url).href)[1];
  const apiBase = baseOf((await startStandaloneReview({ projectRoot: api, env, openBrowser })).url);
  const headers = await writeHeaders(apiBase, opened.at(-1));
  const webBase = baseOf((await startStandaloneReview({ projectRoot: web, env, openBrowser })).url);
  const onWeb = viewerEvents(context, `${webBase}/api/events`, "action");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const target = `artifact:workspace:docs/${location(0)}`;
  const action = actionOf(await listing(apiBase, target, headers), "artifact.comment");
  const original = fs.open;
  const opens = [];
  fs.open = (file, ...rest) => { if (String(file).includes(`${path.sep}artifact-comments${path.sep}`)) opens.push(String(file)); return original(file, ...rest); };
  syncBuiltinESMExports();
  let applied;
  try {
    applied = await apply(apiBase, { action: "artifact.comment", target, input: { line: "1", text: "Mine." }, revision: action.revision }, headers);
    assert.equal(applied.status, 200, applied.text);
    for (const started = Date.now(); !onWeb.length && Date.now() - started < 8000;) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    fs.open = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(onWeb.map((event) => [event.id, event.action, event.target, event.artifact.path, event.artifact.scope.label, event.after.text]),
    [[applied.json.applied.id, "artifact.comment", target, `docs/${location(0)}`, "workspace", "Mine."]], "the other checkout's tab receives the comment as its own recent changes list it");
  // The applying checkout writes the comment through a temporary file, and the other checkout reads back that one file; none of the planted comments is opened.
  const planted = opens.filter((file) => !path.basename(file).startsWith(".") && !path.basename(file).startsWith(applied.json.applied.at.replace(/[:.]/g, "-")));
  assert.deepEqual(planted, [], "no planted comment file is opened");
  assert.ok(opens.length <= 4, `the comment opens about one file for each checkout, not the ${ARTIFACTS * PER} the store holds: ${opens.length}`);
});
