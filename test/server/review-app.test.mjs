import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchReviewApp } from "../../dist/server/review/review-app-client.mjs";
import { createReviewServerPool } from "../../dist/server/review/review-server-pool.mjs";
import { withFileLock } from "../../dist/server/workflow/artifact-store.mjs";

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const POSIX = process.platform !== "win32";

async function project(context, name) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `prism-app-${name}-`)));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", `${name}.md`), `# ${name}\n`);
  return root;
}

// The app creates its own directory, so tests hand it a path that does not exist yet.
async function appDirectory(context) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "prism-app-state-"));
  const directory = path.join(parent, "prism");
  context.after(async () => {
    await shutdownApp(directory);
    await rm(parent, { recursive: true, force: true });
  });
  return directory;
}

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

async function readDiscovery(directory) {
  return JSON.parse(await readFile(path.join(directory, "review-app.json"), "utf8"));
}

// An independent implementation of the contract's signing rules, so the tests check the contract rather than the client.
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const mac = (key, text) => createHmac("sha256", key).update(text).digest("hex");

function signature(controlToken, method, route, text, nonce = randomBytes(16).toString("hex")) {
  return { nonce, header: `${nonce}.${mac(controlToken, `${method}\n${route}\n${nonce}\n${sha256(text)}`)}` };
}

function proof(controlToken, nonce, text) {
  return mac(controlToken, `${nonce}\n${sha256(text)}`);
}

async function control(discovery, route, { method = "GET", body, headers = {}, key = discovery.controlToken } = {}) {
  const text = body ? JSON.stringify(body) : "";
  const signed = signature(key, method, `/control/${route}`, text);
  const response = await request(`http://127.0.0.1:${discovery.port}/control/${route}`, {
    method,
    headers: { "X-Prism-Control": signed.header, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: text || undefined
  });
  return { ...response, proven: response.headers["x-prism-proof"] === proof(discovery.controlToken, signed.nonce, response.body) };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function eventually(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
    }
    if (Date.now() > deadline) throw new Error("The condition did not hold in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Stops every app a test started, through the shutdown route and then through the lock owner's pid, even when the test failed first.
async function shutdownApp(directory) {
  try {
    await control(await readDiscovery(directory), "shutdown", { method: "POST", body: { handoff: false } });
  } catch {
  }
  try {
    const owner = JSON.parse(await readFile(path.join(directory, "review-app.lock"), "utf8"));
    if (owner.pid !== process.pid && alive(owner.pid)) process.kill(owner.pid);
    // Windows cannot delete the directory while the app still holds its lock file open.
    await eventually(() => !alive(owner.pid), 5000);
  } catch {
  }
}

function pool(context, options) {
  const value = createReviewServerPool(options);
  context.after(() => value.close());
  return value;
}

test("two sessions in different projects share one review app on one port", async (context) => {
  const directory = await appDirectory(context);
  const first = await project(context, "first");
  const second = await project(context, "second");
  const sessionA = pool(context, { app: { directory } });
  const sessionB = pool(context, { app: { directory } });

  const urlA = new URL(await (await sessionA.get(first, "task-a")).reviewUrl([]));
  const urlB = new URL(await (await sessionB.get(second, "task-b")).reviewUrl([]));

  assert.equal(urlA.host, urlB.host, "both projects are served from one app");
  assert.notEqual(urlA.pathname, urlB.pathname, "each project has its own URL segment");
  const indexA = JSON.parse((await request(new URL("api/index", urlA))).body);
  const indexB = JSON.parse((await request(new URL("api/index", urlB))).body);
  assert.equal(indexA.projectRoot, first);
  assert.equal(indexB.projectRoot, second);
  assert.ok(indexA.artifacts.includes("docs/first.md"));
  assert.ok(!indexA.artifacts.includes("docs/second.md"));

  const discovery = await readDiscovery(directory);
  assert.equal(discovery.port, Number(urlA.port));
  assert.ok(!urlA.href.includes(discovery.controlToken), "the control credential never appears in a browser URL");
  if (POSIX) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "review-app.json"))).mode & 0o777, 0o600);
  }
});

test("concurrent starts leave one review app", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "race");
  const children = [];
  const launch = (options) => {
    const child = launchReviewApp(options);
    children.push(child);
    return child;
  };
  const [urlA, urlB] = await Promise.all([
    pool(context, { app: { directory, launch } }).get(root, "task-a").then((review) => review.reviewUrl([])),
    pool(context, { app: { directory, launch } }).get(root, "task-b").then((review) => review.reviewUrl([]))
  ]);
  assert.equal(new URL(urlA).host, new URL(urlB).host);
  await eventually(() => children.filter((child) => alive(child.pid)).length === 1, 8000);
  // The losing starter must not leave the winner undiscoverable, so the file is read only after the race settles.
  const discovery = await eventually(() => readDiscovery(directory), 8000);
  assert.ok(alive(discovery.pid), "the app named by the discovery file is the one still running");
  assert.equal((await control(discovery, "health")).status, 200);
});

test("concurrent starts from a lock whose owner is dead leave one discoverable app", async (context) => {
  const directory = await appDirectory(context);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => exited.once("exit", resolve));
  await writeFile(path.join(directory, "review-app.lock"), JSON.stringify({ pid: exited.pid, token: "abandoned", renewable: true, at: new Date().toISOString() }), { mode: 0o600 });
  const root = await project(context, "abandoned");
  const children = [];
  const launch = (options) => {
    const child = launchReviewApp(options);
    children.push(child);
    return child;
  };
  const urls = await Promise.all(["task-a", "task-b"].map((task) => pool(context, { app: { directory, launch } }).get(root, task).then((review) => review.reviewUrl([]))));
  assert.ok(urls.every((url) => new URL(url).pathname.includes("/p/")), "both sessions use the shared app instead of falling back");
  await eventually(() => children.filter((child) => alive(child.pid)).length === 1, 8000);
  const discovery = await eventually(() => readDiscovery(directory), 8000);
  assert.ok(alive(discovery.pid));
  assert.equal((await control(discovery, "health")).status, 200);
});

test("a session never sends the control credential to a listener that cannot prove it", async (context) => {
  const directory = await appDirectory(context);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await project(context, "impostor");
  const controlToken = randomBytes(24).toString("base64url");
  const seen = [];
  const impostor = http.createServer((incoming, outgoing) => {
    seen.push(JSON.stringify(incoming.headers));
    incoming.resume();
    incoming.on("end", () => outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ protocol: 1, url: "http://127.0.0.1:1/look-alike", open: true })));
  });
  await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { impostor.closeAllConnections(); impostor.close(resolve); }));
  const { port } = impostor.address();
  // A stale discovery file from a crashed app names a port that another listener now holds.
  const staleViewerToken = randomBytes(24).toString("base64url");
  await writeFile(path.join(directory, "review-app.json"), JSON.stringify({ protocol: 1, port, controlToken, viewerToken: staleViewerToken, pid: 999999 }), { mode: 0o600 });
  const url = new URL(await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]));
  assert.notEqual(Number(url.port), port, "the session does not hand out a URL from the impostor");
  assert.ok(seen.every((headers) => !headers.includes(controlToken)), "the credential never reaches the impostor");
  assert.ok(!url.href.includes(staleViewerToken), "a viewer credential that tabs may have sent to the impostor is not served again");
  assert.equal(JSON.parse((await request(new URL("api/index", url))).body).projectRoot, root);
});

test("control routes refuse requests without the control credential or from a browser origin", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "guarded");
  await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]);
  const { port, controlToken } = await readDiscovery(directory);
  const body = JSON.stringify({ projectRoot: os.tmpdir() });
  const missing = await request(`http://127.0.0.1:${port}/control/projects/lease-1`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
  assert.equal(missing.status, 403);
  const discovery = await readDiscovery(directory);
  const fromPage = await control(discovery, "projects/lease-1", { method: "PUT", body: { projectRoot: os.tmpdir() }, headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(fromPage.status, 403);
  const bearer = await request(`http://127.0.0.1:${port}/control/projects/lease-1`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${controlToken}` }, body });
  assert.equal(bearer.status, 403, "the raw credential is not accepted, so it never needs to travel");
  const signed = signature(controlToken, "GET", "/control/health", "");
  const first = await request(`http://127.0.0.1:${port}/control/health`, { headers: { "X-Prism-Control": signed.header } });
  const replayed = await request(`http://127.0.0.1:${port}/control/health`, { headers: { "X-Prism-Control": signed.header } });
  assert.equal(first.status, 200);
  assert.equal(replayed.status, 403, "a replayed signature is refused");
  const present = await request(`http://127.0.0.1:${port}/control/present`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot: root, open: false }) });
  assert.equal(present.status, 403);
  const shutdown = await control(discovery, "shutdown", { method: "POST", body: { handoff: false }, key: "wrong-credential-of-some-length" });
  assert.equal(shutdown.status, 403);
  const health = await control(discovery, "health");
  assert.equal(health.status, 200, "refused requests leave the app running");
  assert.ok(health.proven, "the app proves it knows the control credential");
});

test("the presenting session opens the browser once and the app never does", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "opening");
  const opened = [];
  const review = await pool(context, { app: { directory, openBrowser: (url) => { opened.push(url); return true; } } }).get(root, "task");
  const first = await review.open(["docs/opening.md"]);
  const second = await review.open(["docs/opening.md"]);
  assert.equal(first.opened, true);
  assert.equal(second.opened, false, "the open lease holds back a second browser");
  assert.equal(opened.length, 1);
  assert.equal(opened[0], first.url);
});

test("until the switcher lands, presenting a project no tab shows opens a tab on it", async (context) => {
  const directory = await appDirectory(context);
  const first = await project(context, "shown");
  const second = await project(context, "hidden");
  const opened = [];
  const sessions = pool(context, { app: { directory, openBrowser: (url) => { opened.push(url); return true; } } });
  const shown = await sessions.get(first, "task-a");
  const hidden = await sessions.get(second, "task-b");
  const stream = http.get(new URL("api/events", await shown.reviewUrl([])));
  context.after(() => stream.destroy());
  await new Promise((resolve) => stream.once("response", resolve));
  assert.equal((await shown.open([])).opened, false, "a connected tab on the project needs no browser");
  const presented = await hidden.open(["docs/hidden.md"]);
  assert.equal(presented.opened, true, "the other project's presentation is not hidden behind the first project's tab");
  assert.deepEqual(opened, [presented.url]);
});

test("reading the review URL without tabs leaves the session unchanged", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "readonly");
  const review = await pool(context, { app: { directory } }).get(root, "task");
  await review.setOpenTabs(["docs/readonly.md"]);
  const before = await review.getSession();
  await review.reviewUrl(undefined);
  const after = await review.getSession();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.openTabs, ["docs/readonly.md"]);
});

test("an MCP server lists its project in the app from start until it exits", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "registered");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, PRISM_REVIEW_APP_DIR: directory, PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) };
  delete env.PRISM_REVIEW_APP;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  readline.createInterface({ input: child.stdout }).on("line", () => {});
  const listed = async () => {
    const response = await control(await readDiscovery(directory), "projects");
    return JSON.parse(response.body).projects.find((entry) => entry.projectRoot === root);
  };
  // No initialize request and no tool call: registration rides on the host naming the project at start.
  // Two process starts under a loaded test run can take a while, so the bounds are generous; a pass returns as soon as the state holds.
  assert.equal((await eventually(listed, 30000)).live, true);
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  await eventually(async () => (await listed())?.live === false, 30000);
});

test("a newer session replaces an older review app and keeps its port and viewer credential", async (context) => {
  const directory = await appDirectory(context);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await project(context, "upgrade");
  const shutdowns = [];
  const standInKey = "stand-in-control-credential";
  let stopStandIn;
  const stopped = new Promise((resolve) => { stopStandIn = resolve; });
  const standIn = http.createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const [nonce, signed] = String(incoming.headers["x-prism-control"] ?? "").split(".");
      const reply = (status, body) => outgoing.writeHead(status, { "Content-Type": "application/json", "X-Prism-Proof": proof(standInKey, nonce, body) }).end(body);
      if (!nonce || signed !== signature(standInKey, incoming.method, incoming.url, text, nonce).header.split(".")[1]) {
        outgoing.writeHead(403).end();
      } else if (incoming.url === "/control/health") {
        reply(200, JSON.stringify({ protocol: 0, pid: process.pid }));
      } else if (incoming.url === "/control/shutdown" && incoming.method === "POST") {
        shutdowns.push(JSON.parse(text));
        await writeFile(path.join(directory, "review-app.json"), JSON.stringify({ ...JSON.parse(await readFile(path.join(directory, "review-app.json"), "utf8")), handoff: true }), { mode: 0o600 });
        reply(200, "{}");
        standIn.close(() => stopStandIn());
        standIn.closeAllConnections();
      } else {
        outgoing.writeHead(404).end();
      }
    });
  });
  await new Promise((resolve) => standIn.listen(0, "127.0.0.1", resolve));
  const { port } = standIn.address();
  const viewerToken = "stand-in-viewer-credential";
  // The stand-in implements only the cross-version contract: the discovery file, health, shutdown, and the lock.
  const held = withFileLock(path.join(directory, "review-app"), async () => {
    await writeFile(path.join(directory, "review-app.json"), JSON.stringify({ protocol: 0, port, controlToken: standInKey, viewerToken, pid: process.pid }), { mode: 0o600 });
    await stopped;
  }, undefined, { renew: true });
  await eventually(() => readDiscovery(directory));

  const url = new URL(await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]));
  await held;
  assert.deepEqual(shutdowns, [{ handoff: true }]);
  assert.equal(Number(url.port), port, "the successor serves on the same port");
  assert.ok(url.pathname.startsWith(`/session/${viewerToken}/p/`), "an open tab keeps its viewer credential");
  const discovery = await readDiscovery(directory);
  assert.ok(discovery.protocol >= 1);
  assert.equal(discovery.viewerToken, viewerToken);
  assert.notEqual(discovery.controlToken, standInKey, "the successor never reuses the control credential");
  assert.equal(JSON.parse((await request(new URL("api/index", url))).body).projectRoot, root);
});

test("a session serves its own review server when the shared app cannot start", async (context) => {
  const blocked = path.join(await mkdtemp(path.join(os.tmpdir(), "prism-app-blocked-")), "not-a-directory");
  await writeFile(blocked, "");
  context.after(() => rm(path.dirname(blocked), { recursive: true, force: true }));
  const root = await project(context, "fallback");
  const review = await pool(context, { app: { directory: blocked } }).get(root, "task");
  const url = new URL(await review.reviewUrl([]));
  const index = JSON.parse((await request(new URL("api/index", url))).body);
  assert.equal(index.projectRoot, root);
  assert.ok(!url.pathname.includes("/p/"), "the fallback is a single-project session server");
});

test("a session falls back within the start deadline when a started app never answers", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "silent");
  const started = Date.now();
  const review = await pool(context, { app: { directory, launch: () => null } }).get(root, "task");
  const url = new URL(await review.reviewUrl([]));
  assert.ok(Date.now() - started < 8000, "the fallback waits no longer than the start deadline");
  assert.ok(!url.pathname.includes("/p/"));
  assert.equal(await review.reviewUrl([]), url.href, "the fallback sticks for the session, so the project keeps one URL");
});

test("a session does not trust a state directory that others can read", { skip: !POSIX }, async (context) => {
  const directory = await appDirectory(context);
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o755);
  const root = await project(context, "untrusted");
  const url = new URL(await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]));
  assert.ok(!url.pathname.includes("/p/"));
  await assert.rejects(readFile(path.join(directory, "review-app.json")), { code: "ENOENT" }, "nothing is written to an untrusted directory");
});
