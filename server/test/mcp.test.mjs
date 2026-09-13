import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import https from "node:https";
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

function mcpProcess(context, cwd, projectRoot, environment = {}) {
  const env = { ...process.env, PRISM_REVIEW_CERT_DIR: path.join(cwd, ".prism-review-cert"), ...environment };
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

function fetchReview(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, json: async () => JSON.parse(body) });
      });
    });
    request.once("error", reject);
  });
}

async function browserStub(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-browser-stub-"));
  const marker = path.join(directory, "opened");
  const count = path.join(directory, "open-count");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stub = "#!/bin/sh\nprintf opened > \"$PRISM_BROWSER_MARKER\"\nprintf x >> \"$PRISM_BROWSER_COUNT\"\n";
  for (const command of ["open", "xdg-open"]) {
    await writeFile(path.join(directory, command), stub);
    await chmod(path.join(directory, command), 0o755);
  }
  return {
    marker,
    count,
    environment: {
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      PRISM_BROWSER_MARKER: marker,
      PRISM_BROWSER_COUNT: count
    }
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMarker(marker) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const contents = await markerContents(marker);
    if (contents) {
      return contents;
    }
    await delay(20);
  }
  return markerContents(marker);
}

async function markerContents(marker) {
  try {
    return await readFile(marker, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function openEventStream(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      response.setEncoding("utf8");
      let buffer = "";
      const events = [];
      const waiters = [];
      let closed = false;
      const rejectWaiters = (error) => {
        while (waiters.length) {
          waiters.shift().reject(error);
        }
      };
      const deliver = (event) => {
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(event);
        } else {
          events.push(event);
        }
      };
      response.on("data", (chunk) => {
        buffer += chunk;
        let separator;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) {
            deliver({ event: block.match(/^event: (.+)$/m)?.[1] ?? "message", data: JSON.parse(data) });
          }
        }
      });
      response.on("error", (error) => {
        if (!closed) {
          rejectWaiters(error);
        }
      });
      response.on("end", () => {
        if (!closed) {
          rejectWaiters(new Error("The event stream ended."));
        }
      });
      resolve({
        status: response.statusCode,
        headers: response.headers,
        next() {
          if (events.length) {
            return Promise.resolve(events.shift());
          }
          return new Promise((resolveNext, rejectNext) => waiters.push({ resolve: resolveNext, reject: rejectNext }));
        },
        close() {
          closed = true;
          response.destroy();
          request.destroy();
        }
      });
    });
    request.once("error", (error) => {
      if (!request.destroyed) {
        reject(error);
      }
    });
  });
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
  assert.match(tools.get_review_url.description, /URL only/);
  assert.match(tools.get_review_url.description, /does not open a browser/);
  assert.match(tools.present_review.description, /system browser/);
  assert.match(tools.present_review.description, /Omit artifact to show the complete artifact tree/);
  assert.deepEqual(tools.get_review_url.inputSchema.properties.artifacts.items, { type: "string" });
  assert.deepEqual(tools.present_review.inputSchema.properties.artifacts.items, { type: "string" });
  const settings = tools.update_coordination_state.inputSchema.properties.changes.properties.settings.properties;
  assert.deepEqual(settings.autonomy.enum, ["conservative", "broad", "full"]);
  assert.deepEqual(settings.agentFlow.enum, ["mono", "multi"]);
  assert.equal(tools.get_coordination_state.annotations.readOnlyHint, true);
  assert.equal(tools.validate_coordination_state.annotations.readOnlyHint, true);
  assert.equal(tools.update_coordination_state.annotations.readOnlyHint, false);
});

test("updates coordination state without starting the review server", async (context) => {
  const root = await projectFixture(context, "state-mcp", "artifact.md");
  const statePath = "docs/plans/demo/state.json";
  await mkdir(path.join(root, path.dirname(statePath)), { recursive: true });
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const missing = await callTool(mcp, 2, "get_coordination_state", { statePath });
  assert.equal(missing.result.structuredContent.exists, false);
  assert.equal(missing.result.structuredContent.revision, null);

  const created = await callTool(mcp, 3, "update_coordination_state", {
    statePath,
    expectedRevision: null,
    changes: { pending: ["User decision: retention"] }
  });
  assert.equal(created.result.structuredContent.created, true);
  assert.equal(created.result.structuredContent.valid, true);

  const current = await callTool(mcp, 4, "get_coordination_state", { statePath });
  assert.deepEqual(current.result.structuredContent.state.pending, ["User decision: retention"]);
  assert.equal(current.result.structuredContent.revision, created.result.structuredContent.revision);

  const stale = await callTool(mcp, 5, "update_coordination_state", {
    statePath,
    expectedRevision: null,
    changes: { next: ["Retry from the current revision"] }
  });
  assert.equal(stale.error.data.code, "revision_conflict");
  assert.equal(stale.error.data.current.revision, current.result.structuredContent.revision);

  await assert.rejects(access(path.join(root, ".prism-review-cert")), (caught) => caught.code === "ENOENT");
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
  const index = await (await fetchReview(indexUrl)).json();
  assert.equal(index.projectRoot, await realpath(consumerRoot));
  assert.deepEqual(index.artifacts, ["docs/consumer-only.md"]);

  const outsideUrl = new URL(indexUrl);
  outsideUrl.pathname = outsideUrl.pathname.replace(/\/api\/index$/, "/api/artifact");
  outsideUrl.searchParams.set("path", "../outside.md");
  assert.equal((await fetchReview(outsideUrl)).status, 400);

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

test("shares one review server across tasks with the same consumer root", async (context) => {
  const root = await projectFixture(context, "shared-consumer", "first-only.md");
  await writeFile(path.join(root, "docs", "second-only.md"), "# second\n");
  const mcp = mcpProcess(context, root);

  await initialize(mcp);
  const first = await callTool(mcp, 2, "get_review_url", { projectRoot: root, artifact: "docs/first-only.md" }, "first-task");
  const second = await callTool(mcp, 3, "get_review_url", { projectRoot: root, artifact: "docs/second-only.md" }, "second-task");
  const firstUrl = new URL(first.result.structuredContent.url);
  const secondUrl = new URL(second.result.structuredContent.url);
  assert.equal(`${firstUrl.origin}${firstUrl.pathname.replace(/\/review$/, "")}`, `${secondUrl.origin}${secondUrl.pathname.replace(/\/review$/, "")}`);
  assert.deepEqual(second.result.structuredContent.openTabs, ["docs/second-only.md"]);
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

test("returns a review URL without opening a system browser", async (context) => {
  const root = await projectFixture(context, "url-without-browser", "artifact.md");
  const browser = await browserStub(context);
  const mcp = mcpProcess(context, root, undefined, browser.environment);

  await initialize(mcp);
  const review = await callTool(mcp, 2, "get_review_url", { projectRoot: root, artifact: "docs/artifact.md" });

  assert.match(review.result.structuredContent.url, /^https:\/\/127\.0\.0\.1:/);
  await delay(100);
  assert.equal(await markerContents(browser.marker), "");
});

test("selects and updates persistent artifact tabs without opening a browser", async (context) => {
  const root = await projectFixture(context, "tab-selection", "first.md");
  await writeFile(path.join(root, "docs", "second.md"), "# second\n");
  const browser = await browserStub(context);
  const mcp = mcpProcess(context, root, undefined, browser.environment);

  await initialize(mcp);
  const selected = await callTool(mcp, 2, "get_review_url", {
    projectRoot: root,
    artifacts: ["docs/first.md", "docs/second.md"]
  });
  assert.match(selected.result.structuredContent.url, /^https:\/\/127\.0\.0\.1:/);
  assert.deepEqual(selected.result.structuredContent.openTabs, ["docs/first.md", "docs/second.md"]);
  assert.match(selected.result.content[0].text, /Trust the Prism local development authority once/);

  const updated = await callTool(mcp, 3, "get_review_url", { projectRoot: root, artifacts: ["docs/second.md"] });
  assert.deepEqual(updated.result.structuredContent.openTabs, ["docs/second.md"]);
  await delay(100);
  assert.equal(await markerContents(browser.marker), "");
});

test("opens the system browser when it presents a review", async (context) => {
  const root = await projectFixture(context, "present-with-browser", "artifact.md");
  const browser = await browserStub(context);
  const mcp = mcpProcess(context, root, undefined, browser.environment);

  await initialize(mcp);
  const review = await callTool(mcp, 2, "present_review", { projectRoot: root, artifact: "docs/artifact.md" });

  assert.match(review.result.structuredContent.url, /^https:\/\/127\.0\.0\.1:/);
  assert.equal(review.result.structuredContent.opened, true);
  assert.equal(await waitForMarker(browser.marker), "opened");
});

test("does not reopen an existing viewer for repeated presentation calls", async (context) => {
  const root = await projectFixture(context, "idempotent-present", "artifact.md");
  const browser = await browserStub(context);
  const mcp = mcpProcess(context, root, undefined, browser.environment);

  await initialize(mcp);
  const first = await callTool(mcp, 2, "present_review", { projectRoot: root, artifact: "docs/artifact.md" }, "first-task");
  assert.equal(await waitForMarker(browser.marker), "opened");
  const eventsUrl = new URL(first.result.structuredContent.url);
  eventsUrl.pathname = eventsUrl.pathname.replace(/\/review$/, "/api/events");
  eventsUrl.search = "";
  const events = await openEventStream(eventsUrl);
  assert.equal(events.status, 200);
  await events.next();

  const second = await callTool(mcp, 3, "present_review", { projectRoot: root, artifact: "docs/artifact.md" }, "second-task");
  assert.equal(second.result.structuredContent.opened, false);
  assert.equal(await readFile(browser.count, "utf8"), "x");
  events.close();
  await delay(50);
  const third = await callTool(mcp, 4, "present_review", { projectRoot: root, artifact: "docs/artifact.md" }, "third-task");
  assert.equal(third.result.structuredContent.opened, true);
  await delay(50);
  assert.equal(await readFile(browser.count, "utf8"), "xx");
});

test("opens one review page for the complete artifact tree when no artifact is selected", async (context) => {
  const root = await projectFixture(context, "present-all-artifacts", "artifact.md");
  const browser = await browserStub(context);
  const mcp = mcpProcess(context, root, undefined, browser.environment);

  await initialize(mcp);
  const review = await callTool(mcp, 2, "present_review", { projectRoot: root });

  assert.match(review.result.structuredContent.url, /^https:\/\/127\.0\.0\.1:/);
  assert.doesNotMatch(review.result.structuredContent.url, /artifact=/);
  assert.equal(review.result.structuredContent.opened, true);
  assert.equal(await waitForMarker(browser.marker), "opened");
});
