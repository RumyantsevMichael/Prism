import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("../mcp.mjs", import.meta.url));

async function projectFixture(context, name, artifact) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, "docs", artifact), `# ${name}\n`);
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Documents: docs\n");
  return root;
}

function mcpProcess(context, cwd, projectRoot) {
  const env = { ...process.env };
  if (projectRoot) {
    env.CLAUDE_PROJECT_DIR = projectRoot;
  } else {
    delete env.CLAUDE_PROJECT_DIR;
  }
  const child = spawn(process.execPath, [SERVER_PATH], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      messages.push(message);
    }
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  return {
    send(message) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    next() {
      if (messages.length) {
        return Promise.resolve(messages.shift());
      }
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        child.once("exit", (code) => reject(new Error(`MCP server exited with code ${code}: ${stderr}`)));
      });
    }
  };
}

async function initialize(mcp, capabilities = {}) {
  mcp.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities } });
  const response = await mcp.next();
  assert.equal(response.id, 1);
}

async function callTool(mcp, id, name, argumentsValue, threadId) {
  const params = { name, arguments: argumentsValue };
  if (threadId) {
    params._meta = { "x-codex-turn-metadata": { thread_id: threadId } };
  }
  mcp.send({ id, method: "tools/call", params });
  return mcp.next();
}

test("declares the project root and read-only artifact tools", async (context) => {
  const pluginRoot = await projectFixture(context, "plugin-schema", "plugin-only.md");
  const mcp = mcpProcess(context, pluginRoot);

  await initialize(mcp);
  mcp.send({ id: 2, method: "tools/list" });
  const response = await mcp.next();
  const tools = Object.fromEntries(response.result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.list_reviewable_artifacts.inputSchema.required, ["projectRoot"]);
  assert.equal(tools.list_reviewable_artifacts.annotations.readOnlyHint, true);
  assert.equal(tools.get_review_url.annotations.readOnlyHint, true);
});

test("uses the consumer root provided by Claude Code", async (context) => {
  const pluginRoot = await projectFixture(context, "plugin", "plugin-only.md");
  const consumerRoot = await projectFixture(context, "consumer", "consumer-only.md");
  const mcp = mcpProcess(context, pluginRoot, consumerRoot);

  await initialize(mcp);
  const artifacts = await callTool(mcp, 2, "list_reviewable_artifacts", {});
  assert.deepEqual(artifacts.result.structuredContent.artifacts, ["docs/consumer-only.md"]);

  const review = await callTool(mcp, 3, "get_review_url", { artifact: "docs/consumer-only.md" });
  const reviewUrl = new URL(review.result.structuredContent.url);
  const indexUrl = new URL(reviewUrl);
  indexUrl.pathname = indexUrl.pathname.replace(/\/review$/, "/api/index");
  indexUrl.search = "";
  const index = await (await fetch(indexUrl)).json();
  assert.equal(index.projectRoot, await realpath(consumerRoot));
  assert.deepEqual(index.artifacts, ["docs/consumer-only.md"]);

  const outsideUrl = new URL(indexUrl);
  outsideUrl.pathname = outsideUrl.pathname.replace(/\/api\/index$/, "/api/artifact");
  outsideUrl.searchParams.set("path", "../outside.md");
  assert.equal((await fetch(outsideUrl)).status, 400);

  const mismatched = await callTool(mcp, 4, "list_reviewable_artifacts", { projectRoot: pluginRoot });
  assert.match(mismatched.error.message, /does not match the host project root/);
});

test("keeps Codex tasks bound to separate consumer roots", async (context) => {
  const pluginRoot = await projectFixture(context, "codex-plugin", "plugin-only.md");
  const firstRoot = await projectFixture(context, "first-consumer", "first-only.md");
  const secondRoot = await projectFixture(context, "second-consumer", "second-only.md");
  const mcp = mcpProcess(context, pluginRoot);

  await initialize(mcp);
  const first = await callTool(mcp, 2, "list_reviewable_artifacts", { projectRoot: firstRoot }, "first-task");
  assert.deepEqual(first.result.structuredContent.artifacts, ["docs/first-only.md"]);

  const second = await callTool(mcp, 3, "list_reviewable_artifacts", { projectRoot: secondRoot }, "second-task");
  assert.deepEqual(second.result.structuredContent.artifacts, ["docs/second-only.md"]);

  const changed = await callTool(mcp, 4, "list_reviewable_artifacts", { projectRoot: secondRoot }, "first-task");
  assert.equal(changed.error.code, -32603);
  assert.match(changed.error.message, /already bound to project root/);
});

test("requires an absolute project root without a host root", async (context) => {
  const pluginRoot = await projectFixture(context, "missing-root-plugin", "plugin-only.md");
  const mcp = mcpProcess(context, pluginRoot);

  await initialize(mcp);
  const missing = await callTool(mcp, 2, "list_reviewable_artifacts", {}, "missing-root-task");
  assert.match(missing.error.message, /projectRoot argument is required/);

  const relative = await callTool(mcp, 3, "list_reviewable_artifacts", { projectRoot: "relative/project" }, "relative-root-task");
  assert.match(relative.error.message, /must be an absolute path/);
});
