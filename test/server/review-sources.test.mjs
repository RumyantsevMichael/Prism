import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-review-sources-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    }).once("error", reject);
  });
}

async function project(context, git = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-review-sources-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, content) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  };
  await write(".prism/workflow.md", "## Paths\n- Requirements: docs/requirements/\n");
  await write("docs/requirements/r.md", "# R\n\nStatus: Approved\n");
  await write("src/app.py", "def main():\n    return 1\n");
  await write(".env", "TOKEN=secret\n");
  await write("deploy/server.pem", "-----BEGIN-----\n");
  await write("assets/logo.png", "png");
  await write("big.txt", "x".repeat(600 * 1024));
  await write("blob.dat", Buffer.from([1, 0, 2]));
  await write("build/out.txt", "generated\n");
  await write(".gitignore", "build/\n");
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "src/app.py", ".gitignore", "docs", ".prism"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "start"], { cwd: root });
    await write("src/new.py", "print('draft')\n");
  }
  return root;
}

test("serves tracked and unignored source files read-only without secrets or binaries", async (context) => {
  const projectRoot = await project(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const index = JSON.parse((await get(`${review.baseUrl}/api/index`)).text);
    assert.ok(index.sources.includes("src/app.py"));
    assert.ok(index.sources.includes("src/new.py"));
    for (const hidden of [".env", "deploy/server.pem", "assets/logo.png", "big.txt", "build/out.txt"]) assert.equal(index.sources.includes(hidden), false, hidden);
    const source = JSON.parse((await get(`${review.baseUrl}/api/artifact?path=src%2Fapp.py`)).text);
    assert.deepEqual([source.kind, source.content], ["source", "def main():\n    return 1\n"]);
    for (const hidden of [".env", "deploy/server.pem", "build/out.txt", "big.txt"]) {
      assert.equal((await get(`${review.baseUrl}/api/artifact?path=${encodeURIComponent(hidden)}`)).status, 404, hidden);
    }
    const binary = await get(`${review.baseUrl}/api/artifact?path=blob.dat`);
    assert.equal(binary.status, 400);
    assert.match(binary.text, /binary/);
    assert.equal(JSON.parse((await get(`${review.baseUrl}/api/artifact?path=docs%2Frequirements%2Fr.md`)).text).path, "docs/requirements/r.md");
  } finally {
    await review.close();
  }
});

test("lists no source files outside a git repository", async (context) => {
  const projectRoot = await project(context, false);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    assert.deepEqual(JSON.parse((await get(`${review.baseUrl}/api/index`)).text).sources, []);
    assert.equal((await get(`${review.baseUrl}/api/artifact?path=src%2Fapp.py`)).status, 404);
  } finally {
    await review.close();
  }
});
