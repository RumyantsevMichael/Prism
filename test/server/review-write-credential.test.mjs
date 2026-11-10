import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { INITIATIVE, actionOf, actionProject, apply, listing, post, startActionReview, writeHeaders } from "./fixtures/review-actions.mjs";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-write-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { createReviewServerPool, startStandaloneReview } = await import("../../dist/server/review/review-server-pool.mjs");
const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const READ_ONLY = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";
const GRANT = /^[A-Za-z0-9_-]{43}$/;
const target = `initiative:${INITIATIVE}`;

const grantOf = (url) => new URLSearchParams(new URL(url).hash.slice(1)).get("write");
const withoutFragment = (url) => { const value = new URL(url); value.hash = ""; return value.href; };
const continuation = async (base, headers, value = "stepwise") => {
  const action = actionOf(await listing(base, target, headers), "initiative.continuation");
  return apply(base, { action: "initiative.continuation", target, input: { value }, revision: action.revision }, headers);
};

// Every file under a folder, as text, so a test can show that no file holds a secret.
async function filesUnder(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    found.push({ file, text: await readFile(file, "utf8").catch(() => "") });
  }
  return found;
}

// A viewer stream that stays open until the test ends.
function viewerStream(context, url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      context.after(() => response.destroy());
      response.once("data", () => resolve(response));
    });
    request.once("error", reject);
  });
}

test("the session server refuses changes without a write session and grants one only through the URL Prism opens", async (context) => {
  const { root } = await actionProject(context);
  const { review, base, opened } = await startActionReview(context, root);
  const anonymous = await listing(base, target);
  assert.equal(anonymous.json.writable, false);
  const refused = await continuation(base, {});
  assert.deepEqual([refused.status, refused.json.code, refused.json.message], [403, "write_forbidden", READ_ONLY]);
  const forged = await continuation(base, { "X-Prism-Write": "A".repeat(43) });
  assert.deepEqual([forged.status, forged.json.code], [403, "write_forbidden"]);
  assert.equal((await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.settings.continuation, undefined);
  const shown = review.reviewUrl([]);
  assert.equal(grantOf(shown), null, "the review URL that tools return carries no grant");
  const result = await review.open([]);
  assert.equal(grantOf(result.url), null, "the opened result carries no grant");
  const grant = grantOf(opened.at(-1));
  assert.match(grant, GRANT, "the URL Prism opens carries a grant in its fragment");
  assert.equal(withoutFragment(opened.at(-1)), withoutFragment(result.url));
  const exchanged = await post(base, "api/write-session", { grant });
  assert.equal(exchanged.status, 200, exchanged.text);
  assert.match(exchanged.json.token, GRANT);
  const headers = { "X-Prism-Write": exchanged.json.token };
  assert.equal((await listing(base, target, headers)).json.writable, true);
  const applied = await continuation(base, headers);
  assert.equal(applied.status, 200, applied.text);
  const reused = await post(base, "api/write-session", { grant });
  assert.deepEqual([reused.status, reused.json.code], [403, "grant_refused"], "a grant is valid once");
  for (const body of [{ grant: "B".repeat(43) }, { grant: 7 }, {}]) assert.deepEqual([(await post(base, "api/write-session", body)).json?.code], ["grant_refused"], JSON.stringify(body));
  const foreign = await fetch(`${base}/api/write-session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify({ grant }) });
  assert.equal(foreign.status, 403);
  for (const { text } of await filesUnder(root)) assert.ok(!text.includes(exchanged.json.token) && !text.includes(grant), "no project file holds the grant or the token");
});

test("a write session belongs to the server that issued it", async (context) => {
  const { root } = await actionProject(context);
  const first = await startActionReview(context, root);
  const second = await startActionReview(context, root);
  await first.review.open([]);
  const headers = await writeHeaders(first.base, first.opened.at(-1));
  assert.equal((await continuation(first.base, headers)).status, 200);
  const elsewhere = await continuation(second.base, headers, "auto");
  assert.deepEqual([elsewhere.status, elsewhere.json.code], [403, "write_forbidden"]);
});

test("a presentation opens a writable tab while every connected tab is read-only", async (context) => {
  const { root } = await actionProject(context);
  const { review, base, opened } = await startActionReview(context, root);
  await viewerStream(context, `${base}/api/events`);
  const readOnly = await review.open([]);
  assert.equal(readOnly.opened, true, "a read-only tab does not count as a connected tab");
  const headers = await writeHeaders(base, opened.at(-1));
  await viewerStream(context, `${base}/api/events?write=${encodeURIComponent(headers["X-Prism-Write"])}`);
  const count = opened.length;
  const writable = await review.open([]);
  assert.equal(writable.opened, false, "a writable tab is connected, so no browser opens");
  assert.equal(opened.length, count);
});

// The shared app's project base, the prefix of one project's routes.
const projectBase = (url) => /^(.*\/p\/[0-9a-f]{16})/.exec(new URL(url).href)[1];

async function appDirectory(context) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "prism-write-app-"));
  const directory = path.join(parent, "prism");
  context.after(async () => {
    const discovery = await readFile(path.join(directory, "review-app.json"), "utf8").then(JSON.parse, () => null);
    if (discovery?.pid && discovery.pid !== process.pid) try { process.kill(discovery.pid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The app logs its stop into the folder as it exits, so removal retries a folder that is not yet empty.
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}

// A signed control request, by the review app protocol's signing rules.
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const mac = (key, text) => createHmac("sha256", key).update(text).digest("hex");
function control(discovery, route, body) {
  const text = JSON.stringify(body);
  const nonce = randomBytes(16).toString("hex");
  const header = `${nonce}.${mac(discovery.controlToken, `POST\n/control/${route}\n${nonce}\n${sha256(text)}`)}`;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(`http://127.0.0.1:${discovery.port}/control/${route}`, { method: "POST", headers: { "X-Prism-Control": header, "Content-Type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    outgoing.end(text);
  });
}

async function eventually(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error("The condition did not hold in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("the shared app grants a write session through the presenting process and reveals it in no file or answer", async (context) => {
  const directory = await appDirectory(context);
  const { root } = await actionProject(context);
  const opened = [];
  const result = await startStandaloneReview({ projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: (url) => { opened.push(url); return true; } });
  context.after(() => result.held?.close());
  assert.equal(result.held, null, "the shared app serves the review");
  assert.equal(grantOf(result.url), null, "prism review prints no grant");
  const grant = grantOf(opened.at(-1));
  assert.match(grant, GRANT);
  const base = projectBase(result.url);
  assert.equal((await continuation(base, {})).json.code, "write_forbidden");
  const headers = await writeHeaders(base, opened.at(-1));
  assert.equal((await continuation(base, headers)).status, 200);
  for (const { file, text } of await filesUnder(path.dirname(directory))) {
    assert.ok(!text.includes(headers["X-Prism-Write"]), `${file} does not hold the token`);
    assert.ok(!text.includes(grant), `${file} does not hold the grant`);
  }
  if (process.platform !== "win32") {
    for (const entry of await readdir(directory)) {
      if (process.platform !== "win32" && /write|session/i.test(entry)) assert.equal((await stat(path.join(directory, entry))).mode & 0o077, 0, `${entry} is private to its user`);
    }
  }
  const pool = createReviewServerPool({ app: { directory, openBrowser: () => true } });
  context.after(() => pool.close());
  const reviewUrl = await (await pool.get(root, "task")).reviewUrl([]);
  assert.equal(grantOf(reviewUrl), null);
});

test("a write session of the shared app works on the page of every checkout it serves", async (context) => {
  const directory = await appDirectory(context);
  const { root } = await actionProject(context);
  const { root: other } = await actionProject(context);
  const opened = [];
  const openBrowser = (url) => { opened.push(url); return true; };
  const first = await startStandaloneReview({ projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser });
  const headers = await writeHeaders(projectBase(first.url), opened.at(-1));
  const second = await startStandaloneReview({ projectRoot: other, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser });
  const otherBase = projectBase(second.url);
  assert.notEqual(otherBase, projectBase(first.url));
  const listed = await listing(otherBase, target, headers);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.writable, true, "a tab that switches checkouts keeps its write session");
  assert.equal((await continuation(otherBase, headers)).status, 200);
});

test("a write session survives a handoff of the shared app and ends with a cold restart", async (context) => {
  const directory = await appDirectory(context);
  const { root } = await actionProject(context);
  const opened = [];
  const result = await startStandaloneReview({ projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: (url) => { opened.push(url); return true; } });
  const base = projectBase(result.url);
  const headers = await writeHeaders(base, opened.at(-1));
  assert.equal((await continuation(base, headers)).status, 200);
  const lockGone = () => stat(path.join(directory, "review-app.lock")).then(() => null, () => true);
  const pool = createReviewServerPool({ app: { directory, openBrowser: () => true } });
  context.after(() => pool.close());
  const shutdown = await control(JSON.parse(await readFile(path.join(directory, "review-app.json"), "utf8")), "shutdown", { handoff: true });
  assert.equal(shutdown.status, 200, shutdown.body);
  await eventually(lockGone);
  const successor = await (await pool.get(root, "task")).reviewUrl([]);
  assert.equal(projectBase(successor), base, "the successor reuses the port and viewer credential");
  const kept = await continuation(base, headers, "auto");
  assert.equal(kept.status, 200, `a tab keeps its write session across a handoff: ${kept.text}`);
  const discovery = JSON.parse(await readFile(path.join(directory, "review-app.json"), "utf8"));
  process.kill(discovery.pid);
  await eventually(lockGone);
  const restarted = await (await pool.get(root, "task")).reviewUrl([]);
  const coldBase = projectBase(restarted);
  const refused = await continuation(coldBase, headers);
  assert.deepEqual([refused.status, refused.json.code], [403, "write_forbidden"], "a cold restart accepts no earlier write session");
});

test("MCP review tools return URLs without a grant while the browser they open receives one", { skip: process.platform === "win32" }, async (context) => {
  const { root } = await actionProject(context);
  const stubs = await mkdtemp(path.join(os.tmpdir(), "prism-write-opener-"));
  context.after(() => rm(stubs, { recursive: true, force: true }));
  const record = path.join(stubs, "opened.txt");
  for (const name of ["xdg-open", "open"]) {
    await writeFile(path.join(stubs, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${record}'\n`);
    await chmod(path.join(stubs, name), 0o755);
  }
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_REVIEW_APP_DIR: path.join(root, ".app"), PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)), CLAUDE_PROJECT_DIR: root, PLUGIN_DATA: privateData, DISPLAY: ":0" });
  env.PATH = `${stubs}${path.delimiter}${env.PATH}`;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  const messages = new Map();
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    messages.set(message.id, message);
    waiters.get(message.id)?.(message);
  });
  const call = (id, method, params) => new Promise((resolve) => {
    waiters.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const shown = await call(2, "tools/call", { name: "get_review_url", arguments: { projectRoot: root } });
  const presented = await call(3, "tools/call", { name: "present_review", arguments: { projectRoot: root } });
  for (const response of [shown, presented]) {
    const text = JSON.stringify(response.result);
    assert.doesNotMatch(text, /write=/, "no tool result carries a grant");
  }
  const openedUrl = (await eventually(async () => (await readFile(record, "utf8")).trim())).split("\n").at(-1);
  const grant = grantOf(openedUrl);
  assert.match(grant, GRANT, "the browser Prism opened received a grant");
  const base = /^(.*\/session\/[^/]+)/.exec(openedUrl)[1];
  const headers = await writeHeaders(base, openedUrl);
  assert.equal((await continuation(base, headers)).status, 200);
  assert.doesNotMatch(JSON.stringify([shown.result, presented.result]), new RegExp(headers["X-Prism-Write"]));
});
