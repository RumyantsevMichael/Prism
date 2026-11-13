import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, settle, skip } from "./fixtures/kit-browser.mjs";
import { alias, bareRemote, exists, git, isolateGit, networkStore, place, sha16, startApp, storeCheckout, workspaceId } from "./fixtures/workspace-view.mjs";

// A file the clone holds but does not show, binary or over 512 KiB, answers 404 saying why, and the page says it is not shown rather than gone.
// Code clones fetch a remote that the store's registration names, in the background, so they never prompt for a password,
// and a workspace that leaves the list takes its code content with it.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { createCodeClones } = await import("../../dist/server/review/code-clones.mjs");

const BASIC = `Basic ${Buffer.from("reader:secret").toString("base64")}`;

// A smart-HTTP Git server over the bare repositories in root that answers 401 to every request without the reader's credentials.
async function authServer(context, root) {
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== BASIC) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="code"' });
      response.end();
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    const child = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "", HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "", GIT_PROTOCOL: request.headers["git-protocol"] ?? "", REMOTE_USER: "reader", REMOTE_ADDR: "127.0.0.1" } });
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
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// A prompt program that records each call, set wherever Git or SSH could look for one.
async function loggingPrompt(folder) {
  const log = path.join(folder, "prompts.log");
  const script = path.join(folder, "prompt.sh");
  await writeFile(script, `#!/bin/sh\necho "$1" >> '${log}'\necho prompted\n`);
  await chmod(script, 0o755);
  const saved = { GIT_ASKPASS: process.env.GIT_ASKPASS, SSH_ASKPASS: process.env.SSH_ASKPASS };
  Object.assign(process.env, { GIT_ASKPASS: script, SSH_ASKPASS: script });
  git(os.tmpdir(), "config", "--global", "core.askPass", script);
  return {
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean),
    restore() {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
      git(os.tmpdir(), "config", "--global", "--unset", "core.askPass");
    }
  };
}

async function folders(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-code-prompts-")));
  context.after(() => rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await bareRemote(parent, "repo.git", { files: { "src/total.js": "export const total = 1;\n" } });
  return parent;
}

test("a code clone of a remote that answers 401 never runs a prompt program, on enable or on a later fetch", async (context) => {
  const parent = await folders(context);
  const base = await authServer(context, parent);
  const prompt = await loggingPrompt(parent);
  context.after(() => prompt.restore());
  const code = await createCodeClones({ directory: path.join(parent, "app") });
  const state = await code.enable("w1", "api", `${base}/repo.git`);
  assert.equal(state.state, "unreachable");
  assert.match(state.message, /could not clone the code of api/);
  assert.doesNotMatch(state.message, /https?:\/\//);
  await code.fetchAll("w1");
  assert.equal((await code.state("w1", "api")).state, "unreachable");
  assert.deepEqual(await prompt.calls(), []);
  assert.deepEqual(await readdir(path.join(parent, "app", "code")).catch(() => []), [], "a failed first clone keeps no folder");
});

test("a credential helper that answers without asking still signs a code clone in, also for a file opened later", async (context) => {
  const parent = await folders(context);
  const base = await authServer(context, parent);
  const prompt = await loggingPrompt(parent);
  context.after(() => prompt.restore());
  git(os.tmpdir(), "config", "--global", "credential.helper", "!f() { echo username=reader; echo password=secret; }; f");
  context.after(() => git(os.tmpdir(), "config", "--global", "--unset", "credential.helper"));
  const code = await createCodeClones({ directory: path.join(parent, "app") });
  const state = await code.enable("w1", "api", `${base}/repo.git`);
  assert.equal(state.state, "on", state.message);
  const read = await code.file("w1", "api", { branch: "main", path: "src/total.js" });
  assert.equal(read.content, "export const total = 1;\n");
  assert.deepEqual(await prompt.calls(), []);
});

test("removing an added workspace turns its code content off and deletes its clone", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const remote = await bareRemote(where.parent, "api-code.git", { files: { "src/total.js": "export const total = 1;\n" } });
  alias("https://github.com/acme/api.git", remote);
  await storeCheckout(context, where, "api", store.url);
  const prism = await startApp(context, where);
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const id = workspaceId(store.identity);
  assert.equal((await prism.put(`/w/${id}/api/code/api`, { enabled: true })).json.code.state, "on");
  const clone = path.join(where.app, "code", `${sha16("github.com/acme/api")}.git`);
  assert.equal(await exists(clone), true);
  const malformed = await prism.put(`/w/${id}/api/code/%E0%A4%A`, { enabled: true });
  assert.equal(malformed.status, 400, malformed.body);
  assert.equal(malformed.json.code, "invalid_request");
  assert.equal((await prism.del(`/api/workspaces/${id}`)).status, 200);
  assert.equal((await prism.workspaces()).some((entry) => entry.id === id), false);
  assert.equal(await exists(clone), false);
  const saved = JSON.parse(await readFile(path.join(where.app, "code-content.json"), "utf8"));
  assert.deepEqual(saved.repositories.filter((entry) => entry.workspace === id), []);
});

async function codeOn(context, files) {
  const where = await place(context);
  const store = await networkStore(where);
  alias("https://github.com/acme/api.git", await bareRemote(where.parent, "api-code.git", { files }));
  await storeCheckout(context, where, "api", store.url);
  const prism = await startApp(context, where);
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const id = workspaceId(store.identity);
  assert.equal((await prism.put(`/w/${id}/api/code/api`, { enabled: true })).json.code.state, "on");
  return { prism, id };
}

const SHOWN = { "src/total.js": "export const total = 1;\n", "assets/logo.bin": "PNG\u0000\u0001", "assets/logo.png": "PNG", "assets/big.txt": "x".repeat(600 * 1024) };

test("a code file the clone holds but does not show answers 404 with the reason it is not shown", async (context) => {
  const { prism, id } = await codeOn(context, SHOWN);
  const open = (file) => prism.get(`/w/${id}/api/artifact?ref=${encodeURIComponent(`code:api:${file}`)}`);
  for (const [file, reason] of [["assets/logo.bin", "binary"], ["assets/logo.png", "binary"], ["assets/big.txt", "too_large"]]) {
    const answer = await open(file);
    assert.equal(answer.status, 404, file);
    assert.equal(answer.json.code, "file_not_shown", file);
    assert.equal(answer.json.reason, reason, file);
    const read = await prism.get(`/w/${id}/api/code/file?repository=api&branch=main&path=${encodeURIComponent(file)}`);
    assert.deepEqual([read.status, read.json.code, read.json.reason], [404, "file_not_shown", reason], file);
  }
  const gone = await open("none.js");
  assert.equal(gone.status, 404);
  assert.notEqual(gone.json?.code, "file_not_shown");
});

test("the page says a binary code file is not shown, not that it was moved or deleted", { skip }, async (context) => {
  const { prism, id } = await codeOn(context, SHOWN);
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${prism.viewer}/w/${id}/review?artifact=${encodeURIComponent("code:api:assets/logo.bin")}`);
  await settle(page);
  const text = await page.locator("body").innerText();
  assert.match(text, /This file is not shown/);
  assert.match(text, /binary file/);
  assert.doesNotMatch(text, /moved or deleted/);
});
