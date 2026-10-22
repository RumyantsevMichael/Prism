import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ConservationStore } from "../../dist/server/conservation/conservation-store.mjs";
import { createReviewAppClient, launchReviewApp } from "../../dist/server/review/review-app-client.mjs";
import { startReviewApp } from "../../dist/server/review/review-app-server.mjs";
import { createReviewServerPool, startStandaloneReview } from "../../dist/server/review/review-server-pool.mjs";
import { withFileLock } from "../../dist/server/workflow/artifact-store.mjs";

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../bin/prism", import.meta.url));
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

// Collects the named events of one viewer stream, so a test can wait for an event without parsing chunk boundaries.
async function viewerEvents(context, url) {
  const events = [];
  const stream = http.get(new URL("api/events", url));
  context.after(() => stream.destroy());
  const response = await new Promise((resolve) => stream.once("response", resolve));
  let buffer = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data) });
    }
  });
  return events;
}

async function gateProject(context, name, gates) {
  const root = await project(context, name);
  await mkdir(path.join(root, "docs", "plans", "work"), { recursive: true });
  const pending = Array.from({ length: gates }, (_, index) => ({ id: `gate-${String(index).padStart(8, "0")}`, kind: "decision", question: `Question ${index}?`, artifacts: [], askedAt: "2026-10-17T00:00:00Z" }));
  await writeFile(path.join(root, "docs", "plans", "work", "state.json"), JSON.stringify({ schemaVersion: 1, settings: {}, active: [], pending, next: [], evidence: [] }));
  return root;
}

test("presenting a project that no tab shows notifies the open tab instead of opening a browser", async (context) => {
  const directory = await appDirectory(context);
  const first = await project(context, "shown");
  const second = await project(context, "hidden");
  const opened = [];
  const sessions = pool(context, { app: { directory, openBrowser: (url) => { opened.push(url); return true; } } });
  const shown = await sessions.get(first, "task-a");
  const hidden = await sessions.get(second, "task-b");
  const shownUrl = await shown.reviewUrl([]);
  const events = await viewerEvents(context, shownUrl);
  await eventually(() => events.some((event) => event.name === "session"));
  const before = await shown.getSession();
  const presented = await hidden.open(["docs/hidden.md"]);
  assert.equal(presented.opened, false, "a tab is already open, so no second browser tab opens");
  assert.deepEqual(opened, []);
  const notice = await eventually(() => events.find((event) => event.name === "notice"));
  assert.equal(notice.data.projectRoot, second);
  assert.equal(notice.data.name, path.basename(second));
  assert.equal(notice.data.url, presented.url, "the notice links to the presenting project's review");
  assert.deepEqual(await shown.getSession(), before, "the tab's project and tabs stay as they were");
  assert.equal(events.filter((event) => event.name === "notice").length, 1);
  await hidden.reviewUrl(["docs/hidden.md"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(events.filter((event) => event.name === "notice").length, 1, "reading a review URL sends no notice");
});

test("the review page lists live and recent projects with their open gates", async (context) => {
  const directory = await appDirectory(context);
  const busy = await gateProject(context, "busy", 2);
  const quiet = await gateProject(context, "quiet", 0);
  const sessions = pool(context, { app: { directory } });
  const busyUrl = await (await sessions.get(busy, "task-a")).reviewUrl([]);
  const discovery = await readDiscovery(directory);
  const lease = randomBytes(8).toString("hex");
  assert.equal((await control(discovery, `projects/${lease}`, { method: "PUT", body: { projectRoot: quiet } })).status, 200);
  assert.equal((await control(discovery, `projects/${lease}`, { method: "DELETE" })).status, 200);

  const response = await request(new URL("api/projects", busyUrl));
  assert.equal(response.status, 200);
  const listing = JSON.parse(response.body);
  const busyEntry = listing.projects.find((entry) => entry.projectRoot === busy);
  const quietEntry = listing.projects.find((entry) => entry.projectRoot === quiet);
  assert.equal(listing.current, busyEntry.id);
  assert.deepEqual([busyEntry.live, busyEntry.gates, busyEntry.name], [true, 2, path.basename(busy)]);
  assert.deepEqual(busyEntry.workspace, { repository: path.basename(busy), worktree: null, branch: null, detached: false });
  assert.deepEqual([quietEntry.live, quietEntry.gates], [false, 0], "a project without a live lease stays listed as recent");
  assert.ok(listing.projects.indexOf(busyEntry) < listing.projects.indexOf(quietEntry), "live projects come first");
  assert.ok(!response.body.includes(discovery.controlToken));
  const switched = JSON.parse((await request(new URL("api/index", quietEntry.url))).body);
  assert.equal(switched.projectRoot, quiet, "each entry links to that project's review context");
});

test("the project list keeps at most 20 recent projects", async (context) => {
  const directory = await appDirectory(context);
  const current = await project(context, "current");
  const currentUrl = await (await pool(context, { app: { directory } }).get(current, "task")).reviewUrl([]);
  const discovery = await readDiscovery(directory);
  const recent = [];
  for (let index = 0; index < 22; index += 1) {
    const root = await project(context, `recent${index}`);
    const lease = randomBytes(8).toString("hex");
    await control(discovery, `projects/${lease}`, { method: "PUT", body: { projectRoot: root } });
    await control(discovery, `projects/${lease}`, { method: "DELETE" });
    recent.push(root);
  }
  const listed = JSON.parse((await request(new URL("api/projects", currentUrl))).body).projects.map((entry) => entry.projectRoot);
  assert.equal(listed.length, 21, "the live project and the 20 most recent others");
  assert.equal(listed[0], current);
  assert.deepEqual(listed.slice(1), recent.slice(2).reverse(), "the least recently used projects are dropped");
  const persisted = JSON.parse(await readFile(path.join(directory, "review-app-projects.json"), "utf8")).projects;
  assert.deepEqual(persisted, [...recent.slice(2).reverse(), current], "the file keeps the projects most recent first, and the live project registered first is the least recent");
});

test("a restarted app restores the recent projects in recency order", async (context) => {
  const directory = await appDirectory(context);
  const roots = [await project(context, "older"), await project(context, "middle"), await project(context, "newer")];
  const touch = async (root) => {
    const discovery = await readDiscovery(directory);
    const lease = randomBytes(8).toString("hex");
    await control(discovery, `projects/${lease}`, { method: "PUT", body: { projectRoot: root } });
    await control(discovery, `projects/${lease}`, { method: "DELETE" });
  };
  const first = await project(context, "first");
  const firstSession = pool(context, { app: { directory } });
  await (await firstSession.get(first, "task-a")).reviewUrl([]);
  for (const root of roots) await touch(root);
  await touch(roots[0]);
  // Closing the first session ends its lease, so no renewal can make its project most recent after the restart.
  await firstSession.close();
  await shutdownApp(directory);
  const current = await project(context, "restarted");
  const url = await (await pool(context, { app: { directory } }).get(current, "task-b")).reviewUrl([]);
  const listed = JSON.parse((await request(new URL("api/projects", url))).body).projects.map((entry) => entry.projectRoot);
  assert.deepEqual(listed.filter((root) => roots.includes(root) || root === first), [roots[0], roots[2], roots[1], first], "renewing an existing project makes it most recent, and a restart keeps that order");
  // Eighteen newer projects make 22 recent ones, so the limit drops the two least recent from before the restart.
  for (let index = 0; index < 18; index += 1) await touch(await project(context, `later${index}`));
  const trimmed = JSON.parse((await request(new URL("api/projects", url))).body).projects.map((entry) => entry.projectRoot);
  assert.deepEqual(trimmed.filter((root) => roots.includes(root) || root === first), [roots[0], roots[2]], "the restored order decides which projects the limit drops");
});

test("a presentation refused while the first tab is still loading reaches that tab when it connects", async (context) => {
  const directory = await appDirectory(context);
  const first = await project(context, "loading");
  const second = await project(context, "waiting");
  const opened = [];
  const sessions = pool(context, { app: { directory, openBrowser: (url) => { opened.push(url); return true; } } });
  const loading = await sessions.get(first, "task-a");
  const waiting = await sessions.get(second, "task-b");
  const granted = await loading.open([]);
  const refused = await waiting.open(["docs/waiting.md"]);
  assert.equal(granted.opened, true);
  assert.equal(refused.opened, false, "one browser open at a time, app-wide");
  // The granted project presenting again before its tab connects does not displace the other project's notice.
  assert.equal((await loading.open(["docs/loading.md"])).opened, false);
  assert.deepEqual(opened, [granted.url]);
  const events = await viewerEvents(context, granted.url);
  const notice = await eventually(() => events.find((event) => event.name === "notice"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(events.filter((event) => event.name === "notice").map((event) => event.data.projectRoot), [second], "the tab gets the other project's notice and never its own");
  assert.equal(notice.data.url, refused.url);
  assert.equal(events[0].name, "session", "the kept notice follows the tab's first session event");
  const later = await viewerEvents(context, granted.url);
  await eventually(() => later.some((event) => event.name === "session"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!later.some((event) => event.name === "notice"), "a delivered notice is not sent again on a reload or reconnect");
});

async function noNotice(context, url) {
  const events = await viewerEvents(context, url);
  await eventually(() => events.some((event) => event.name === "session"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  return !events.some((event) => event.name === "notice");
}

test("a review shown in its own project's tab is not kept for a later tab of another project", async (context) => {
  const directory = await appDirectory(context);
  const seen = await project(context, "seen");
  const other = await project(context, "other");
  const sessions = pool(context, { app: { directory, openBrowser: () => true } });
  const seenReview = await sessions.get(seen, "task-a");
  const otherUrl = await (await sessions.get(other, "task-b")).reviewUrl([]);
  const seenEvents = await viewerEvents(context, await seenReview.reviewUrl([]));
  await eventually(() => seenEvents.some((event) => event.name === "session"));
  assert.equal((await seenReview.open(["docs/seen.md"])).opened, false, "the project's own tab shows the review");
  assert.ok(await noNotice(context, otherUrl), "switching to another project brings back no notice for a review already seen");
});

test("a granted browser open leaves no pending notice", async (context) => {
  const directory = await appDirectory(context);
  const opening = await project(context, "opening");
  const other = await project(context, "other");
  const sessions = pool(context, { app: { directory, openBrowser: () => true } });
  const openingReview = await sessions.get(opening, "task-a");
  const otherUrl = await (await sessions.get(other, "task-b")).reviewUrl([]);
  assert.equal((await openingReview.open(["docs/opening.md"])).opened, true);
  assert.ok(await noNotice(context, otherUrl), "the opened browser shows that review, so no other tab is told about it");
});

async function registerRecent(directory, root) {
  const discovery = await readDiscovery(directory);
  const lease = randomBytes(8).toString("hex");
  await control(discovery, `projects/${lease}`, { method: "PUT", body: { projectRoot: root } });
  await control(discovery, `projects/${lease}`, { method: "DELETE" });
}

test("the recent limit never drops a project that a tab watches", async (context) => {
  const directory = await appDirectory(context);
  const current = await project(context, "anchor");
  const currentUrl = await (await pool(context, { app: { directory } }).get(current, "task")).reviewUrl([]);
  const watched = await project(context, "watched");
  await registerRecent(directory, watched);
  const listing = JSON.parse((await request(new URL("api/projects", currentUrl))).body);
  const events = await viewerEvents(context, listing.projects.find((entry) => entry.projectRoot === watched).url);
  await eventually(() => events.some((event) => event.name === "session"));
  for (let index = 0; index < 21; index += 1) await registerRecent(directory, await project(context, `crowd${index}`));
  const listed = JSON.parse((await request(new URL("api/projects", currentUrl))).body).projects.map((entry) => entry.projectRoot);
  assert.ok(listed.includes(watched), "the watched project stays although it is the least recent");
});

test("a project whose folder is gone is listed with an unknown gate count", async (context) => {
  const directory = await appDirectory(context);
  const current = await project(context, "readable");
  const currentUrl = await (await pool(context, { app: { directory } }).get(current, "task")).reviewUrl([]);
  const gone = await gateProject(context, "gone", 1);
  await registerRecent(directory, gone);
  await rm(gone, { recursive: true, force: true });
  const entry = JSON.parse((await request(new URL("api/projects", currentUrl))).body).projects.find((item) => item.projectRoot === gone);
  assert.equal(entry.gates, null);
});

test("a project whose records cannot be read is listed with an unknown gate count", async (context) => {
  const directory = await appDirectory(context);
  const current = await project(context, "intact");
  const currentUrl = await (await pool(context, { app: { directory } }).get(current, "task")).reviewUrl([]);
  const broken = await project(context, "broken");
  // A file where the plans folder belongs makes the project's records unreadable.
  await writeFile(path.join(broken, "docs", "plans"), "not a folder\n");
  await registerRecent(directory, broken);
  const entry = JSON.parse((await request(new URL("api/projects", currentUrl))).body).projects.find((item) => item.projectRoot === broken);
  assert.equal(entry.gates, null);
});

test("a notice that reached a tab is not kept for a later tab", async (context) => {
  const directory = await appDirectory(context);
  const watching = await project(context, "watching");
  const presenting = await project(context, "presenting");
  const later = await project(context, "later");
  const sessions = pool(context, { app: { directory, openBrowser: () => true } });
  const watchingUrl = await (await sessions.get(watching, "task-a")).reviewUrl([]);
  const presenter = await sessions.get(presenting, "task-b");
  const laterUrl = await (await sessions.get(later, "task-c")).reviewUrl([]);
  const watchingEvents = await viewerEvents(context, watchingUrl);
  await eventually(() => watchingEvents.some((event) => event.name === "session"));
  assert.equal((await presenter.open(["docs/presenting.md"])).opened, false, "a tab is open on another project");
  await eventually(() => watchingEvents.some((event) => event.name === "notice"));
  assert.ok(await noNotice(context, laterUrl), "the notice reached the open tab, so a later tab is not told again");
});

test("a tab that connects to the presenting project drops its pending notice instead of receiving it", async (context) => {
  const directory = await appDirectory(context);
  const opening = await project(context, "opening");
  const waiting = await project(context, "waiting");
  const sessions = pool(context, { app: { directory, openBrowser: () => true } });
  const opener = await sessions.get(opening, "task-a");
  const waiter = await sessions.get(waiting, "task-b");
  const granted = await opener.open([]);
  assert.equal(granted.opened, true);
  const refused = await waiter.open(["docs/waiting.md"]);
  assert.equal(refused.opened, false);
  assert.ok(await noNotice(context, refused.url), "the presenting project's own tab shows the review, not a notice about it");
  assert.ok(await noNotice(context, granted.url), "that tab dropped the pending notice, so the other project's tab is not told either");
});

test("a pending notice expires", async (context) => {
  const directory = await appDirectory(context);
  const app = await startReviewApp({ directory, noticeMs: 200 });
  context.after(() => app.close());
  const first = await project(context, "expiring");
  const second = await project(context, "expired");
  const discovery = await readDiscovery(directory);
  const present = async (root) => JSON.parse((await control(discovery, "present", { method: "POST", body: { projectRoot: root, open: true } })).body);
  const granted = await present(first);
  assert.equal(granted.open, true);
  assert.equal((await present(second)).open, false, "the second presentation is kept as a pending notice");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(await noNotice(context, granted.url), "a tab that connects after the notice expired gets none");
});

test("the served review page carries the project switcher and the notice banner", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "page");
  const url = await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]);
  const page = (await request(url)).body;
  assert.match(page, /id="project-switcher"/);
  assert.match(page, /id="project-menu"/);
  assert.match(page, /id="notice"/);
  const client = (await request(new URL("review.js", url))).body;
  assert.match(client, /\.\/api\/projects/);
  assert.match(client, /addEventListener\("notice"/);
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
  await eventually(async () => (await listed())?.live === true, 30000);
  const discovery = await readDiscovery(directory);
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const page = JSON.parse((await request(`http://127.0.0.1:${discovery.port}/session/${discovery.viewerToken}/p/${id}/api/projects`)).body);
  assert.equal(page.projects.find((entry) => entry.projectRoot === root)?.live, true, "the review page lists the project before any tool call");
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  await eventually(async () => (await listed())?.live === false, 30000);
});

test("an MCP server in a host that names no project lists it from its first Prism tool call", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "codex");
  const env = { ...process.env, PRISM_REVIEW_APP_DIR: directory, PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) };
  delete env.PRISM_REVIEW_APP;
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  readline.createInterface({ input: child.stdout }).on("line", () => {});
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_roadmap", arguments: { projectRoot: root } } })}\n`);
  const listed = async () => {
    const response = await control(await readDiscovery(directory), "projects");
    return JSON.parse(response.body).projects.find((entry) => entry.projectRoot === root);
  };
  await eventually(async () => (await listed())?.live === true, 30000);
});

test("a session whose shared app cannot start stops launching it", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "nolaunch");
  let launches = 0;
  const client = createReviewAppClient({ directory, launch: () => { launches += 1; return null; }, startTimeoutMs: 300 });
  context.after(() => client.close());
  context.mock.timers.enable({ apis: ["setInterval"] });
  await assert.rejects(client.register(root), { reachable: false });
  assert.equal(launches, 1);
  context.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 1, "a failed registration leaves no lease renewal behind");
});

test("a session that falls back after the app goes away stops renewing its lease", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "later-fallback");
  let launches = 0;
  const launch = (options) => (launches += 1) === 1 ? launchReviewApp(options) : null;
  context.mock.timers.enable({ apis: ["setInterval"] });
  const review = await pool(context, { app: { directory, launch, startTimeoutMs: 1000 } }).get(root, "task");
  assert.ok(new URL(await review.reviewUrl([])).pathname.includes("/p/"));
  await shutdownApp(directory);
  await eventually(async () => !(await stat(path.join(directory, "review-app.lock")).catch(() => null)));
  assert.ok(!new URL(await review.reviewUrl([])).pathname.includes("/p/"), "the session now serves its own review server");
  const afterFallback = launches;
  context.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(launches, afterFallback, "no lease renewal launches an app for a project served by its own server");
});

test("a listener that trickles bytes on the discovered port cannot hold a session past the start deadline", async (context) => {
  const directory = await appDirectory(context);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await project(context, "trickle");
  const timers = new Set();
  const listener = http.createServer((incoming, outgoing) => {
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    const timer = setInterval(() => outgoing.write(" "), 100);
    timers.add(timer);
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await writeFile(path.join(directory, "review-app.json"), JSON.stringify({ protocol: 1, port, controlToken: "a".repeat(32), viewerToken: "b".repeat(32), pid: 999999 }), { mode: 0o600 });
  try {
    const started = Date.now();
    const review = await pool(context, { app: { directory, launch: () => null } }).get(root, "task");
    const url = new URL(await review.reviewUrl([]));
    assert.ok(Date.now() - started < 8000, "the session falls back within the start deadline");
    assert.notEqual(Number(url.port), port);
  } finally {
    // The shared cleanup would wait on this listener too, so it goes first.
    await rm(path.join(directory, "review-app.json"), { force: true });
    for (const timer of timers) clearInterval(timer);
    listener.closeAllConnections();
    listener.close();
  }
});

test("the review URL follows the app after it is replaced on a new port", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "moved");
  const review = await pool(context, { app: { directory } }).get(root, "task");
  const before = new URL(await review.reviewUrl([]));
  await shutdownApp(directory);
  await eventually(async () => !(await stat(path.join(directory, "review-app.lock")).catch(() => null)));
  const after = new URL(await review.reviewUrl([]));
  assert.ok(after.pathname.includes("/p/"), "the session is still served by the shared app");
  assert.notEqual(after.href, before.href);
  assert.equal(JSON.parse((await request(new URL("api/index", after))).body).projectRoot, root);
});

test("a successor ignores a handoff that is older than the lock lifetime", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "stale-handoff");
  await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]);
  const first = await readDiscovery(directory);
  await control(first, "shutdown", { method: "POST", body: { handoff: true } });
  await eventually(async () => !(await stat(path.join(directory, "review-app.lock")).catch(() => null)));
  const handedOff = await readDiscovery(directory);
  assert.equal(handedOff.handoff, true);
  await writeFile(path.join(directory, "review-app.json"), JSON.stringify({ ...handedOff, handedOffAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }), { mode: 0o600 });
  await (await pool(context, { app: { directory } }).get(root, "task")).reviewUrl([]);
  const second = await readDiscovery(directory);
  assert.notEqual(second.viewerToken, first.viewerToken, "an old handoff never hands out its viewer credential again");
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
        await writeFile(path.join(directory, "review-app.json"), JSON.stringify({ ...JSON.parse(await readFile(path.join(directory, "review-app.json"), "utf8")), handoff: true, handedOffAt: new Date().toISOString() }), { mode: 0o600 });
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
  assert.equal((await request(new URL("api/projects", url))).status, 404, "a session server has no project list, so its page keeps a plain label");
});

// A standalone review whose held server, if any, closes with the test.
async function standalone(context, options) {
  const result = await startStandaloneReview(options);
  context.after(() => result.held?.close());
  return result;
}

test("prism review presents through the shared app, opens the browser, and holds no server", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "command");
  const opened = [];
  const result = await standalone(context, { projectRoot: root, artifactPath: "docs/command.md", env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: (url) => { opened.push(url); return true; } });
  assert.equal(result.held, null, "the command returns instead of serving the review");
  assert.equal(result.opened, true);
  assert.deepEqual(opened, [result.url]);
  const url = new URL(result.url);
  assert.equal(Number(url.port), (await readDiscovery(directory)).port, "the review is served by the shared app");
  assert.equal(url.searchParams.get("artifact"), "docs/command.md");
  const listing = JSON.parse((await request(new URL("api/projects", url))).body);
  const entry = listing.projects.find((candidate) => candidate.projectRoot === root);
  assert.equal(entry.live, false, "the command ends its lease, so the project is listed as recent");
});

test("prism review opens no browser while a review tab is connected", async (context) => {
  const directory = await appDirectory(context);
  const shown = await project(context, "watched");
  const other = await project(context, "other");
  const opened = [];
  const options = { env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: (url) => { opened.push(url); return true; } };
  const first = await standalone(context, { ...options, projectRoot: shown });
  const events = await viewerEvents(context, first.url);
  await eventually(() => events.some((event) => event.name === "session"));
  const second = await standalone(context, { ...options, projectRoot: other });
  assert.equal(second.opened, false);
  assert.equal(second.held, null);
  assert.equal(opened.length, 1, "only the first command opened a browser");
  const notice = await eventually(() => events.find((event) => event.name === "notice"));
  assert.equal(notice.data.projectRoot, other);
});

test("prism review reports an artifact the app refuses without starting its own server", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "refused");
  const opened = [];
  let started = 0;
  await assert.rejects(
    startStandaloneReview({ projectRoot: root, artifactPath: "docs/missing.md", env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: (url) => { opened.push(url); return true; }, start: () => { started += 1; throw new Error("no fallback expected"); } }),
    /not available for review: docs\/missing\.md/
  );
  assert.deepEqual(opened, []);
  assert.equal(started, 0);
});

test("prism review serves the review itself when the app is off or cannot start", async (context) => {
  const directory = await appDirectory(context);
  const blocked = path.join(await mkdtemp(path.join(os.tmpdir(), "prism-app-blocked-")), "not-a-directory");
  await writeFile(blocked, "");
  context.after(() => rm(path.dirname(blocked), { recursive: true, force: true }));
  const root = await project(context, "standalone");
  for (const env of [{ PRISM_REVIEW_APP: "off", PRISM_REVIEW_APP_DIR: directory }, { PRISM_REVIEW_APP_DIR: blocked }]) {
    const result = await standalone(context, { projectRoot: root, env, openBrowser: () => true });
    assert.ok(result.held, "the command keeps its own server running");
    const url = new URL(result.url);
    assert.ok(!url.pathname.includes("/p/"), "the review comes from a single-project session server");
    assert.equal(JSON.parse((await request(new URL("api/index", url))).body).projectRoot, root);
  }
  await assert.rejects(readDiscovery(directory), { code: "ENOENT" }, "the off switch starts no app");
});

test("the prism review command exits after presenting through a running app", async (context) => {
  const directory = await appDirectory(context);
  const watched = await project(context, "running");
  const root = await project(context, "cli");
  const review = await pool(context, { app: { directory } }).get(watched, "task");
  const events = await viewerEvents(context, await review.reviewUrl([]));
  await eventually(() => events.some((event) => event.name === "session"));
  const before = await readDiscovery(directory);
  const child = spawn(process.execPath, [CLI_PATH, "review"], { cwd: root, env: { ...process.env, PRISM_REVIEW_APP_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still running"), 20000);
    child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(code, 0, "the command does not hold the terminal");
  const url = new URL(stdout.trim());
  assert.equal(Number(url.port), before.port);
  assert.equal((await readDiscovery(directory)).pid, before.pid, "the command reused the running app");
  await eventually(() => events.find((event) => event.name === "notice" && event.data.projectRoot === root));
});

test("the app serves each project's evidence from the store its sessions report, also to a later command and after a restart", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "evidence");
  const storeDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-app-store-")));
  context.after(() => rm(storeDirectory, { recursive: true, force: true }));
  const id = await new ConservationStore(storeDirectory).put(root, { schemaVersion: 1, kind: "migration", project: root, artifactPath: "docs/evidence.md", revision: "a".repeat(64), lines: ["evidence"] });
  const evidenceAt = async (url) => {
    const response = await request(new URL(`api/evidence?id=${id}`, url));
    return response.status === 200 ? JSON.parse(response.body).record.project : response.status;
  };
  const review = await pool(context, { app: { directory, evidenceDirectory: storeDirectory } }).get(root, "task");
  assert.equal(await evidenceAt(await review.reviewUrl([])), root, "the page reads the session's store, not the app's own");
  const options = { projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: () => true };
  assert.equal(await evidenceAt((await standalone(context, options)).url), root, "a command without host data keeps the reported store");
  await shutdownApp(directory);
  assert.equal(await evidenceAt((await standalone(context, options)).url), root, "a restarted app keeps the reported store");
  const discovery = await readDiscovery(directory);
  const lease = randomBytes(8).toString("hex");
  assert.equal((await control(discovery, `projects/${lease}`, { method: "PUT", body: { projectRoot: root, evidenceDirectory: "relative/store" } })).status, 400);
});

test("the app shows a build that a session reports from its own index storage, also after a restart", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "indexing");
  const intelligenceDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-app-intelligence-")));
  context.after(() => rm(intelligenceDirectory, { recursive: true, force: true }));
  const storage = path.join(intelligenceDirectory, "projects", createHash("sha256").update(root).digest("hex"));
  await mkdir(storage, { recursive: true });
  const at = new Date().toISOString();
  await writeFile(path.join(storage, `progress-${process.pid}.json`), JSON.stringify({ schemaVersion: 1, pid: process.pid, preparationId: "p", state: "preparing",
    startedAt: at, updatedAt: at, progress: { phase: "embedding", current: 8, total: 32 }, diagnostics: [] }));
  const review = await pool(context, { app: { directory, intelligenceDirectory } }).get(root, "task");
  const url = await review.reviewUrl([]);
  const indexing = async (page) => JSON.parse((await request(new URL("api/indexing", page))).body);
  assert.deepEqual((await indexing(url)).progress, { phase: "embedding", current: 8, total: 32 });
  const listing = JSON.parse((await request(new URL("api/projects", url))).body);
  assert.equal(listing.projects.find((entry) => entry.projectRoot === root).indexing, "preparing");
  await shutdownApp(directory);
  const restarted = (await standalone(context, { projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: () => true })).url;
  assert.equal((await indexing(restarted)).state, "preparing", "a restarted app keeps the reported index storage");
  const discovery = await readDiscovery(directory);
  const lease = randomBytes(8).toString("hex");
  assert.equal((await control(discovery, `projects/${lease}`, { method: "PUT", body: { projectRoot: root, intelligenceDirectory: "relative/storage" } })).status, 400);
});

test("the app reads a project's evidence from every store that sessions of different hosts report", async (context) => {
  const directory = await appDirectory(context);
  const root = await project(context, "hosts");
  const evidence = [];
  for (const host of ["claude", "codex"]) {
    const storeDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), `prism-app-${host}-`)));
    context.after(() => rm(storeDirectory, { recursive: true, force: true }));
    const id = await new ConservationStore(storeDirectory).put(root, { schemaVersion: 1, kind: "migration", project: root, artifactPath: "docs/hosts.md", revision: "b".repeat(64), lines: [host] });
    evidence.push({ storeDirectory, id, host });
  }
  for (const { storeDirectory } of evidence) await pool(context, { app: { directory, evidenceDirectory: storeDirectory } }).get(root, "task");
  const url = (await standalone(context, { projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: () => true })).url;
  for (const { id, host } of evidence) {
    const response = await request(new URL(`api/evidence?id=${id}`, url));
    assert.equal(response.status, 200, `the ${host} session's evidence stays readable`);
    assert.deepEqual(JSON.parse(response.body).record.lines, [host]);
  }
  assert.equal((await request(new URL(`api/evidence?id=${"0".repeat(64)}`, url))).status, 400, "evidence that no store holds is still refused");
});

test("the app records a gate answer in the most recently reported store", async (context) => {
  const directory = await appDirectory(context);
  const root = await gateProject(context, "answers", 1);
  const stores = [];
  for (const host of ["older", "newer"]) {
    const storeDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), `prism-app-${host}-`)));
    context.after(() => rm(storeDirectory, { recursive: true, force: true }));
    await pool(context, { app: { directory, evidenceDirectory: storeDirectory } }).get(root, "task");
    stores.push(storeDirectory);
  }
  const url = (await standalone(context, { projectRoot: root, env: { PRISM_REVIEW_APP_DIR: directory }, openBrowser: () => true })).url;
  const body = JSON.stringify({ initiative: "work", id: "gate-00000000", choice: null, note: "Answered from the page." });
  const answered = await request(new URL("api/gates/answer", url), { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(answered.status, 200, answered.body);
  const contents = await Promise.all(stores.map((store) => readdir(store)));
  assert.deepEqual(contents.map((entries) => entries.length > 0), [false, true], "only the newest reported store holds the answer's project records");
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
