import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { artifactConfig, checkout, closeServers, commitFiles, eventually, exists, git, isolateGit, ok, refused, server, text, version, writeArtifact } from "./workspace-artifacts.mjs";

// The review app started in the test process, the checkouts it serves, and Git remotes that HTTPS and SSH spellings reach through insteadOf.
// A test file calls isolateGit before anything else, so every Git command and every Prism server shares one private Git configuration.
export { artifactConfig, checkout, closeServers, commitFiles, eventually, exists, git, isolateGit, ok, refused, server, text, version, writeArtifact };

export const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
/** The managed clone folder name of a store identity, and the workspace id of a store identity or of a checkout without a store. */
export const storeFolderId = (identity) => sha16(identity);
export const workspaceId = (identity) => sha16(`store:${identity}`);
export const projectWorkspaceId = (root) => sha16(`project:${root}`);
/** The Git blob hash of some bytes, as git hash-object gives it. */
export const blobOf = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(bytes)}\0`), Buffer.from(bytes)])).digest("hex");

/** A folder for one test with the Prism application folder app inside it, removed after every server and sync has stopped. */
export async function place(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-workspace-view-")));
  context.after(async () => {
    await closeServers();
    (await import("../../../dist/server/workflow/record-store-sync.mjs")).cancelRecordSyncs();
    await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { parent, app: path.join(parent, "app"), sync: "on" };
}

/** Make Git reach target whenever a command names url, as a Git host or an SSH host alias would, replacing any earlier target of url. */
export function alias(url, target) {
  let listed = "";
  try { listed = git(os.tmpdir(), "config", "--global", "--get-regexp", "^url\\..*\\.insteadof$"); } catch { /* No alias is set yet. */ }
  for (const line of listed.split("\n").filter(Boolean)) {
    const separator = line.lastIndexOf(" ");
    if (line.slice(separator + 1) === url) git(os.tmpdir(), "config", "--global", "--fixed-value", "--unset-all", line.slice(0, separator), url);
  }
  git(os.tmpdir(), "config", "--global", "--add", `url.${target}.insteadOf`, url);
}

/**
 * A bare repository at <parent>/<name> whose main branch holds files, or no commit when files is null; branches maps other branch names to their own files on top of main.
 * Its upload-pack serves filtered clones, as Git hosts do.
 */
export async function bareRemote(parent, name, { files = { "README.md": "Prism store\n" }, branches = {} } = {}) {
  const bare = path.join(parent, name);
  git(parent, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "uploadpack.allowFilter", "true");
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  if (files === null) return bare;
  const work = path.join(parent, `${name}.work`);
  git(parent, "clone", "-q", bare, work);
  git(work, "checkout", "-q", "-b", "main");
  await commitFiles(work, files, "main files");
  git(work, "push", "-q", "-u", "origin", "main");
  for (const [branch, own] of Object.entries(branches)) {
    git(work, "checkout", "-q", "-b", branch, "main");
    await commitFiles(work, own, `${branch} files`);
    git(work, "push", "-q", "origin", branch);
  }
  git(work, "checkout", "-q", "main");
  return bare;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const mac = (key, value) => createHmac("sha256", key).update(value).digest("hex");

/** One HTTP request: { status, headers, body, json }, with json the parsed body or null. */
export function request(url, { method = "GET", headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method, headers: { ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* A page or plain text stays text. */ }
        resolve({ status: response.statusCode, headers: response.headers, body: text, json });
      });
    });
    outgoing.once("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

/**
 * The review app in this process with the place's application folder: app, the started app; viewer, its viewer prefix URL without a trailing slash;
 * get, post, put, and del, requests below the viewer prefix that carry the write session once grant() took one; control(route, options), a signed control request;
 * register(root), a session's lease on a checkout; and grant(), which takes a write grant for the app's root and exchanges it for a write session.
 */
export async function startApp(context, where, options = {}) {
  process.env.PRISM_REVIEW_APP_DIR = where.app;
  const { startReviewApp } = await import("../../../dist/server/review/review-app-server.mjs");
  const app = await startReviewApp({ directory: where.app, ...options });
  context.after(() => app.close());
  const discovery = JSON.parse(await readFile(path.join(where.app, "review-app.json"), "utf8"));
  const viewer = app.viewerUrl.replace(/\/$/, "");
  const state = { headers: {} };
  const below = (route) => `${viewer}${route.startsWith("/") ? route : `/${route}`}`;
  const control = async (route, { method = "GET", body } = {}) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const nonce = randomBytes(16).toString("hex");
    const header = `${nonce}.${mac(discovery.controlToken, `${method}\n/control/${route}\n${nonce}\n${sha256(payload)}`)}`;
    return request(`http://127.0.0.1:${discovery.port}/control/${route}`, { method, headers: { "X-Prism-Control": header }, body: payload || undefined });
  };
  const handle = {
    app, viewer, discovery, control,
    get: (route, headers = {}) => request(below(route), { headers: { ...state.headers, ...headers } }),
    post: (route, body, headers = {}) => request(below(route), { method: "POST", body, headers: { ...state.headers, ...headers } }),
    put: (route, body, headers = {}) => request(below(route), { method: "PUT", body, headers: { ...state.headers, ...headers } }),
    del: (route, headers = {}) => request(below(route), { method: "DELETE", body: {}, headers: { ...state.headers, ...headers } }),
    async register(root, lease = `lease-${randomBytes(4).toString("hex")}`) {
      const answer = await control(`projects/${lease}`, { method: "PUT", body: { projectRoot: root } });
      assert.equal(answer.status, 200, answer.body);
      return answer.json;
    },
    async grant() {
      const presented = await control("present", { method: "POST", body: { open: true, acceptsGrant: true } });
      assert.equal(presented.status, 200, presented.body);
      assert.ok(presented.json.writeGrant, `the root present carries a write grant: ${presented.body}`);
      const exchanged = await request(below("/api/write-session"), { method: "POST", body: { grant: presented.json.writeGrant } });
      assert.equal(exchanged.status, 200, exchanged.body);
      state.headers = { "X-Prism-Write": exchanged.json.token };
      return state.headers;
    },
    async workspaces() {
      const listed = await handle.get("/api/workspaces");
      assert.equal(listed.status, 200, listed.body);
      return listed.json.workspaces;
    }
  };
  return handle;
}

/**
 * A store remote reached by the HTTPS URL https://example.invalid/<owner>/<name>.git, where owner is the test's own folder name, so no test reaches another test's remote.
 * It returns { bare, url, identity, owner, name }.
 */
export async function networkStore(where, name = "store", options = {}) {
  const bare = await bareRemote(where.parent, `${name}-remote.git`, options);
  const owner = path.basename(where.parent);
  const url = `https://example.invalid/${owner}/${name}.git`;
  alias(url, bare);
  return { bare, url, identity: `example.invalid/${owner}/${name}`, owner, name };
}

/** A checkout of a new repository that names store as its record store with sync on, registered in the store by one record read. */
export async function storeCheckout(context, where, name, store, options = {}) {
  const root = await checkout(where, name, { store, sync: "on", ...options });
  ok(await (await server(context, where, root)).call("get_roadmap", {}));
  return root;
}

/** Write a store file straight into a bare remote's main branch, as another machine's push would. */
export async function pushToRemote(where, bare, files, message = "another machine") {
  const work = path.join(where.parent, `push-${randomBytes(4).toString("hex")}`);
  git(where.parent, "clone", "-q", bare, work);
  await commitFiles(work, files, message);
  git(work, "push", "-q", "origin", "HEAD:main");
  await rm(work, { recursive: true, force: true });
}

/** Write a JSON file, making its folder. */
export async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}
