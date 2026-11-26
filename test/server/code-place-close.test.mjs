import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bareRemote, isolateGit } from "./fixtures/workspace-view.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// Closing the review app ends its Git work first: a workspace's fetch timer and the code clones answer their close only once the fetch under way has ended,
// and the clones start no fetch after it, so no Git process of a closed app still holds a file or folder that its caller removes next, which Windows refuses with EBUSY.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { createCodeClones } = await import("../../dist/server/review/code-clones.mjs");
const { watchWorkspace } = await import("../../dist/server/review/workspace-sync.mjs");

// A smart-HTTP Git server over the bare repositories in root that holds each request while held is set, until release is called, and counts the requests it took.
async function heldServer(context, root) {
  const state = { requests: 0, held: false, waiting: [] };
  const server = http.createServer((request, response) => {
    state.requests += 1;
    const answer = () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const child = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "", HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "", GIT_PROTOCOL: request.headers["git-protocol"] ?? "", REMOTE_ADDR: "127.0.0.1" } });
      request.pipe(child.stdin);
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.on("close", () => {
        const output = Buffer.concat(chunks);
        const end = output.indexOf("\r\n\r\n");
        const headers = {};
        let status = 200;
        for (const line of output.subarray(0, end).toString("latin1").split("\r\n")) {
          const [name, ...value] = line.split(":");
          if (name.toLowerCase() === "status") status = Number.parseInt(value.join(":"), 10);
          else headers[name] = value.join(":").trim();
        }
        response.writeHead(status, headers);
        response.end(output.subarray(end + 4));
      });
    };
    if (state.held) state.waiting.push(answer);
    else answer();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    hold() { state.held = true; },
    release() {
      state.held = false;
      for (const answer of state.waiting.splice(0)) answer();
    }
  };
}

test("closing the code clones waits for the fetch under way to end, and no fetch starts after it", async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-code-close-")));
  context.after(() => rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await bareRemote(parent, "repo.git", { files: { "src/total.js": "export const total = 1;\n" } });
  const remote = await heldServer(context, parent);
  const code = await createCodeClones({ directory: path.join(parent, "app") });
  assert.equal((await code.enable("w1", "api", `${remote.url}/repo.git`)).state, "on");
  remote.hold();
  const before = remote.state.requests;
  const order = [];
  const fetched = code.fetchAll("w1").then(() => order.push("fetch"));
  assert.ok(await settled(() => remote.state.waiting.length > 0), "the fetch reached the remote, which holds it");
  const closed = code.close().then(() => order.push("close"));
  await pause(300, "closing must not end while the fetch it waits for is held, which no event can show");
  assert.deepEqual(order, [], "close has not answered while the fetch runs");
  remote.release();
  await Promise.all([fetched, closed]);
  assert.deepEqual(order, ["fetch", "close"], "close answers only after the fetch ended");
  const counted = remote.state.requests;
  assert.ok(counted > before);
  assert.equal(await code.fetchAll("w1"), false, "a closed clone set fetches nothing");
  assert.equal(remote.state.requests, counted, "no request reached the remote after close");
});

test("stopping a workspace's fetch timer answers once the fetch under way has ended", async () => {
  let release;
  const order = [];
  const sync = () => new Promise((resolve) => { release = () => resolve({ state: "ok" }); });
  const watch = watchWorkspace({ base: async () => "/clone", label: () => "store", intervalMs: 10000, sync, fetchCode: async () => { order.push("code"); } });
  watch.viewers(1);
  assert.ok(await settled(() => typeof release === "function"), "the first page starts a fetch");
  const stopped = watch.stop().then(() => order.push("stopped"));
  await pause(100, "stopping must not end while the held sync runs, which no event can show");
  assert.deepEqual(order, []);
  release();
  await stopped;
  assert.deepEqual(order, ["code", "stopped"], "stop answers after the sync and the code fetch that follows it");
});
