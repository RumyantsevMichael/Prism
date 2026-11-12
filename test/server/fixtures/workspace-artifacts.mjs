import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { closeServers, cloneOf, git, notes, prismServer, repository } from "./repository-checkouts.mjs";

// Checkouts of repositories that share one record store holding their descriptive artifacts, each driven by a real Prism server.
export { closeServers, cloneOf, git, notes };

/** Give Git a private home, configuration, and identity before any checkout is made, as the other store tests do. */
export async function isolateGit() {
  const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-artifacts-env-")));
  await writeFile(path.join(environment, "gitconfig"), "");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
  Object.assign(process.env, {
    HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
    GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
  });
  delete process.env.CLAUDE_PLUGIN_DATA;
  return environment;
}

export const exists = (target) => access(target).then(() => true, () => false);
export const version = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const today = () => new Date().toISOString().slice(0, 10);

/** The structured result of a tool call that must succeed. */
export function ok(response) {
  assert.equal(response.error, undefined, response.error?.message);
  assert.notEqual(response.result?.isError, true, response.result?.content?.[0]?.text);
  return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
}

/** The JSON-RPC error of a tool call that must be refused with code. */
export function refused(response, code) {
  assert.ok(response.error, `expected ${code}, got ${JSON.stringify(response.result?.structuredContent ?? response.result)}`);
  assert.equal(response.error.data?.code, code, response.error.message);
  return response.error;
}

/** A parent folder for one test, with a store folder beside the checkouts, removed after every server has stopped. */
export async function workspace(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-artifacts-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true }); });
  await mkdir(path.join(parent, "store"), { recursive: true });
  return { parent, store: await realpath(path.join(parent, "store")), app: path.join(parent, "app") };
}

/**
 * Two machines whose stores are clones of one bare remote with sync on, each with its own Prism application folder.
 * Checkouts on machine a name the store ../store-a, and those on machine b ../store-b.
 */
export async function syncedWorkspace(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-artifacts-sync-")));
  // A review browser in this process schedules store syncs of its own, which can still write a saved copy under .prism-sync while the folder is removed,
  // so its pending syncs are cancelled and the removal retries a folder that a running one just wrote into, rather than fail the test after its assertions passed.
  context.after(async () => {
    await closeServers();
    (await import("../../../dist/server/workflow/record-store-sync.mjs")).cancelRecordSyncs();
    await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  git(parent, "init", "-q", "--bare", "-b", "main", "store-remote.git");
  const remote = path.join(parent, "store-remote.git");
  git(parent, "clone", "-q", remote, "store-a");
  const storeA = path.join(parent, "store-a");
  git(storeA, "checkout", "-q", "-b", "main");
  await writeFile(path.join(storeA, "README.md"), "Prism store\n");
  git(storeA, "add", ".");
  git(storeA, "commit", "-q", "-m", "init");
  git(storeA, "push", "-q", "-u", "origin", "main");
  git(parent, "clone", "-q", remote, "store-b");
  return {
    parent, remote, storeA, storeB: path.join(parent, "store-b"),
    a: { parent, store: storeA, storeSetting: "../store-a", app: path.join(parent, "app-a"), sync: "on" },
    b: { parent, store: path.join(parent, "store-b"), storeSetting: "../store-b", app: path.join(parent, "app-b"), sync: "on" }
  };
}

/** The bytes of a file on the remote's main branch, or null. */
export function remoteFile(remote, file) {
  try { return git(remote, "show", `main:${file}`); } catch { return null; }
}

/** Wait until check returns a truthy value, polling every 250 ms for at most timeoutMs. */
export async function eventually(check, timeoutMs = 30000, label = "the condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${label} did not hold within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The workflow configuration of a checkout: the default paths unless paths gives `## Paths` lines, a store and repository name unless store is null,
 * an optional Store sync line, and an optional `## Components` block.
 */
export function artifactConfig({ store = "../store", repository: name, sync, paths = ["- Plans: docs/plans"], components = null } = {}) {
  const workspaceLines = store === null ? [] : [`- Store: ${store}`, ...(name ? [`- Repository: ${name}`] : []), ...(sync ? [`- Store sync: ${sync}`] : [])];
  return [
    "## Paths", ...paths, "",
    "## Stack", `- Test command: ${process.execPath} check.mjs`, "",
    ...(workspaceLines.length ? ["## Workspace", ...workspaceLines, ""] : []),
    ...(components ? ["## Components", ...components, ""] : [])
  ].join("\n");
}

/** Write files into a checkout and commit them. */
export async function commitFiles(root, files, message = "add files") {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

/**
 * A checkout of a new repository named name with its own remote, configured by artifactConfig, holding files committed after the configuration.
 * machine is a workspace or one machine of a synced workspace.
 */
export async function checkout(machine, name, { files = {}, store, ...options } = {}) {
  const root = await repository(machine.parent, name, { remote: `https://github.com/acme/${name}.git` });
  const setting = store === undefined ? machine.storeSetting ?? "../store" : store;
  await commitFiles(root, { ".prism/workflow.md": artifactConfig({ repository: name, sync: machine.sync, ...options, store: setting }), ...files }, "configure Prism");
  return root;
}

/** A Prism server for a checkout, with the machine's Prism application folder. */
export function server(context, machine, root, options = {}) {
  return prismServer(context, root, { appFolder: machine.app, ...options });
}

/** Write one artifact through update_artifact and return its result entry. */
export async function writeArtifact(prism, file, content, { expectedVersion = null, scope, component } = {}) {
  const operation = { op: "write", path: file, content, expectedVersion, ...(scope ? { scope } : {}), ...(component ? { component } : {}) };
  return ok(await prism.call("update_artifact", { operations: [operation] })).artifacts[0];
}

/** A requirement file in the format write-requirements defines, with one requirement. */
export function requirementFile(title, status = "Draft", approved = "n/a") {
  return `# ${title}\n\nStatus: ${status}\nCreated: 2026-11-07\nApproved: ${approved}\n\n## Problem\n\nSomething is missing.\n\n<a id="1"></a>\n## 1. Do the thing\n\nRequirement: The system shall do the thing.\n`;
}

/** An ADR file in the format write-adr defines. */
export function adrFile(title, status = "Proposed") {
  return `# ${title}\n\nStatus: ${status}\nCreated: 2026-11-07\n\n## Decision\n\nThe system MUST do the thing.\n`;
}

/** Start the review browser of a checkout in this process and stop it after the test. */
// The review page that Prism opens holds a write session, which an answer needs, so the browser takes the one-time grant of the opened URL's fragment.
export async function reviewBrowser(context, root) {
  const { startReviewServer } = await import("../../../dist/server/review/review-server.mjs");
  const opened = [];
  const review = await startReviewServer({ projectRoot: root, openBrowser: async (url) => { opened.push(url); return true; } });
  context.after(() => review.close());
  await review.open([]);
  assert.ok(opened.length, "Prism opened the review page");
  const grant = new URLSearchParams(new URL(opened.at(-1)).hash.slice(1)).get("write");
  assert.ok(grant, "the opened URL carries a write grant in its fragment");
  const exchanged = await browserRequest(review, "/api/write-session", { method: "POST", body: { grant } });
  assert.equal(exchanged.status, 200, `the write session exchange failed: ${JSON.stringify(exchanged.body)}`);
  assert.equal(typeof exchanged.body.token, "string", "the exchange returns a write session token");
  review.writeHeaders = { "X-Prism-Write": exchanged.body.token };
  return review;
}

/** Request headers that take a review browser's write session away, as a tab that Prism did not open sends. */
export const READ_ONLY = Object.freeze({ "X-Prism-Write": "" });

/**
 * Answer a gate as the review page does, through the review app's actions: list the gate.answer action of the gate's target and apply it against the revision the listing shows.
 * An initiative's gate is the target gate:<initiative>/<id>, and a requirement's or ADR's approval gate is approval:<id>.
 * It returns the apply response, or the listing response when the listing refuses.
 */
export async function answerGate(review, { initiative = null, id, choice = null, note = null }, { headers = {} } = {}) {
  const target = initiative ? `gate:${initiative}/${id}` : `approval:${id}`;
  const listed = await browserRequest(review, `/api/actions?target=${encodeURIComponent(target)}`, { headers });
  if (listed.status !== 200) return listed;
  const action = listed.body.actions.find((item) => item.id === "gate.answer");
  assert.ok(action, `the target ${target} lists the gate.answer action`);
  const input = { ...(choice === null ? {} : { choice }), ...(note === null ? {} : { note }) };
  return browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "gate.answer", target, input, revision: action.revision }, headers });
}

/** One request to a review browser, with its write session when it holds one: { status, body }, with JSON bodies parsed. */
export function browserRequest(review, route, { method = "GET", body, headers = {} } = {}) {
  const url = new URL(`${review.baseUrl}${route}`);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const request = http.request(url, { method, headers: { ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...(review.writeHeaders ?? {}), ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* A plain-text answer stays text. */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** Read a file of a store or checkout as text, or null. */
export const text = (target) => readFile(target, "utf8").catch(() => null);
