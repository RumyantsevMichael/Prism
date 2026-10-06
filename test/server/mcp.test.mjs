import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHostSessionFactRecord, writeHostSessionFacts } from "../../dist/server/session/host-session-facts.mjs";
import { REPOSITORY_CONTEXT_INPUT_LIMITS } from "../../dist/server/repository-intelligence/repository-intelligence.mjs";
import { createSessionTraceEvent } from "../../dist/server/session/session-trace.mjs";
import { appendSessionTraceEvent } from "../../dist/server/session/session-trace-store.mjs";

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

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
  const env = { ...process.env, PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)), PRISM_REVIEW_CERT_DIR: path.join(cwd, ".prism-review-cert"), ...environment };
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

async function codeNibStub(context, commit, projectRoot) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-codenib-stub-"));
  const executable = path.join(directory, "codenib-stub");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = `#!/usr/bin/env node
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
const repositoryCommit = ${JSON.stringify(commit)};
const repositoryRoot = ${JSON.stringify(projectRoot)};
const responses = {
  get_manifest: { repo: { path: repositoryRoot, commit: repositoryCommit, source_fingerprint: "fixture-source" }, runtime: { loaded_views: ["bm25", "vector", "symbol_graph"], source_read: { verified: true } } },
  search_context: { plan: { stages: [{ engine: "sparse" }, { engine: "dense" }], graph: null }, source: { commit: repositoryCommit, source_fingerprint: "fixture-source" }, results: [{ node_id: "entry", node_name: "entry", type: "function", file: "src/entry.mjs", start_line: 1, end_line: 5, score: 1, content: "entry" }] },
  dependency_subgraph: { root: "entry", nodes: [{ name: "support", file: "src/support.mjs", line: 2, kind: "function", depth: 1 }], edges: [] },
  read_source: { content: "export function entry() {}\\n", source: { commit: repositoryCommit, source_fingerprint: "fixture-source", verified: true } }
};
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const response = request.params?.name === "read_source" ? { ...responses.read_source, file: request.params.arguments.file_path, start_line: request.params.arguments.start_line, end_line: request.params.arguments.end_line } : responses[request.params?.name];
  const value = request.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "codenib", version: "0.2.3" } } : { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }) + "\\n");
});
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return executable;
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
  assert.equal(tools.list_repository_intelligence_providers.annotations.readOnlyHint, true);
  assert.deepEqual(tools.list_repository_intelligence_providers.inputSchema.required, ["projectRoot"]);
  assert.equal(tools.plan_repository_context.annotations.readOnlyHint, false);
  assert.equal(tools.plan_repository_context.annotations.openWorldHint, true);
  assert.deepEqual(tools.plan_repository_context.inputSchema.required, ["projectRoot", "task"]);
  assert.deepEqual(tools.plan_repository_context.inputSchema.properties.provider.enum, ["auto", "native", "codegraph", "codenib"]);
  assert.deepEqual(tools.plan_repository_context.inputSchema.properties.budget.enum, ["fast", "balanced", "thorough"]);
  assert.equal(tools.plan_repository_context.inputSchema.properties.task.maxLength, REPOSITORY_CONTEXT_INPUT_LIMITS.taskCharacters);
  assert.equal(tools.plan_repository_context.inputSchema.properties.hints.additionalProperties, false);
  for (const hint of Object.values(tools.plan_repository_context.inputSchema.properties.hints.properties)) {
    assert.equal(hint.maxItems, REPOSITORY_CONTEXT_INPUT_LIMITS.hintsPerKind);
    assert.equal(hint.items.maxLength, REPOSITORY_CONTEXT_INPUT_LIMITS.hintCharacters);
  }
  assert.equal(tools.evaluate_repository_fit.annotations.readOnlyHint, true);
  assert.deepEqual(tools.evaluate_repository_fit.inputSchema.required, ["session", "costs", "tokenEstimate"]);
  assert.equal(tools.resolve_session_capacity.annotations.readOnlyHint, true);
  assert.deepEqual(tools.resolve_session_capacity.inputSchema.required, ["session"]);
  assert.equal(tools.summarize_session_consumption.annotations.readOnlyHint, true);
  assert.deepEqual(tools.summarize_session_consumption.inputSchema.required, ["projectRoot", "correlationKey", "dataDirectory"]);
  assert.equal(tools.summarize_session_consumption.inputSchema.properties.correlationKey.pattern, "^[a-f0-9]{64}$");
  assert.equal(tools.summarize_session_consumption.inputSchema.properties.dataDirectory.type, "string");
  assert.equal(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[0].additionalProperties, false);
  assert.equal(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[0].properties.capacityOverrides.additionalProperties, false);
  assert.deepEqual(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[1].properties.mode, { const: "active" });
  assert.deepEqual(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[1].required, ["mode", "correlationKey", "dataDirectory"]);
  assert.equal(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[1].properties.correlationKey.pattern, "^[a-f0-9]{64}$");
  assert.equal(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[1].properties.dataDirectory.type, "string");
  assert.deepEqual(
    tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[1].properties.capacityOverrides.required,
    ["contextWindowTokens", "compactionThresholdTokens"]
  );
  assert.deepEqual(tools.evaluate_repository_fit.inputSchema.properties.session.oneOf[1].properties.compactionScope, {
    const: "total",
    description: "Explicitly attest that the supplied capacity threshold counts total session tokens."
  });
  assert.equal(tools.evaluate_repository_fit.inputSchema.properties.costs.additionalProperties, false);
  assert.equal(tools.evaluate_repository_fit.inputSchema.properties.tokenEstimate.additionalProperties, false);
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
  assert.equal(tools.set_workflow_recording.annotations.readOnlyHint, false);
  assert.equal(tools.read_workflow_decisions.annotations.readOnlyHint, true);
  assert.equal(tools.record_workflow_decision.annotations.readOnlyHint, false);
  assert.equal(tools.checkpoint_pause.annotations.readOnlyHint, false);
});

test("records native null estimates and explicit provider failures after opt-in", async (context) => {
  const root = await projectFixture(context, "decision-mcp", "artifact.md");
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-decision-mcp-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const mcp = mcpProcess(context, root, root);
  await initialize(mcp);
  const enabled = await callTool(mcp, 2, "set_workflow_recording", { projectRoot: root, dataDirectory, enabled: true });
  assert.equal(enabled.result.structuredContent.enabled, true);
  const plan = await callTool(mcp, 3, "plan_repository_context", { projectRoot: root, dataDirectory, provider: "native", task: "Inspect artifact.", hints: { files: ["docs/artifact.md"] } });
  assert.equal(plan.result.structuredContent.tokenEstimate.expected, null);
  assert.ok(plan.result.structuredContent.observedSource.approximateTokens > 0);
  const failed = await callTool(mcp, 4, "plan_repository_context", { projectRoot: root, dataDirectory, provider: "codegraph", task: "Inspect artifact." });
  assert.ok(failed.error);
  const history = await callTool(mcp, 5, "read_workflow_decisions", { projectRoot: root, dataDirectory });
  const records = history.result.structuredContent.records;
  assert.equal(records.length, 2);
  assert.equal(records[0].selectedProvider, "native");
  assert.equal(records[0].estimate.expected, null);
  assert.ok(records[0].reasonCodes.length > 0);
  assert.equal(records[1].requestedProvider, "codegraph");
  assert.equal(records[1].outcome, "FAILURE");
});

test("checkpoints a pause and records its recovery evidence through MCP", async (context) => {
  const root = await projectFixture(context, "pause-mcp", "artifact.md");
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-pause-mcp-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const mcp = mcpProcess(context, root, root);
  await initialize(mcp);
  const statePath = "docs/plans/example/state.json";
  const recoveryPath = "docs/plans/example/child/recovery.md";
  const current = await callTool(mcp, 2, "update_coordination_state", { projectRoot: root, statePath, expectedRevision: null,
    changes: { activeOperations: [{ slice: "child", activity: "design", workers: ["worker"], workspace: "/work" }].map(entry => ({ op: "start", entry })) } });
  await callTool(mcp, 3, "set_workflow_recording", { projectRoot: root, dataDirectory, enabled: true });
  const paused = await callTool(mcp, 4, "checkpoint_pause", { projectRoot: root, statePath, expectedRevision: current.result.structuredContent.revision,
    activeSlice: "child", recoveryPath, recoveryContent: "Current recovery.\n", changes: { next: ["Continue child"] }, dataDirectory });
  assert.equal(paused.result.structuredContent.pausedSlice, "child");
  assert.equal(paused.result.structuredContent.decisionRecording.status, "recorded");
  const history = await callTool(mcp, 5, "read_workflow_decisions", { projectRoot: root, dataDirectory, statePath, recoveryPaths: [recoveryPath] });
  assert.equal(history.result.structuredContent.records.at(-1).kind, "pause");
  assert.equal(history.result.structuredContent.recovery[0].status, "historical");
});

test("requires structured diagram and review checkpoints through MCP", async (context) => {
  const root = await projectFixture(context, "checkpoint-mcp", "artifact.md");
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-checkpoint-mcp-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const mcp = mcpProcess(context, root, root);
  await initialize(mcp);
  await callTool(mcp, 2, "set_workflow_recording", { projectRoot: root, dataDirectory, enabled: true });
  const missing = await callTool(mcp, 3, "record_workflow_decision", { projectRoot: root, dataDirectory,
    decision: { kind: "design_fit", outcome: "FIT", readability: "unreadable" } });
  assert.ok(missing.error);
  const fit = await callTool(mcp, 4, "record_workflow_decision", { projectRoot: root, dataDirectory,
    decision: { kind: "design_fit", outcome: "SPLIT", readability: "unreadable", splitAssessment: "split", counts: { elements: 50, links: 84, notes: 17 } } });
  assert.equal(fit.result.structuredContent.status, "recorded");
  const review = await callTool(mcp, 5, "record_workflow_decision", { projectRoot: root, dataDirectory,
    decision: { kind: "review", outcome: "FINDINGS", reviewPhase: "design_audit", findingIds: ["F-004"], dispositions: ["open"] } });
  assert.equal(review.result.structuredContent.status, "recorded");
  const history = await callTool(mcp, 6, "read_workflow_decisions", { projectRoot: root, dataDirectory });
  assert.deepEqual(history.result.structuredContent.records.map((item) => item.kind), ["design_fit", "review"]);
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

test("plans repository context through the CodeNib sidecar", async (context) => {
  const root = await projectFixture(context, "repository-context", "artifact.md");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "entry.mjs"), "export function entry() {\n  return true;\n}\n\n// entry behavior\n");
  await writeFile(path.join(root, "src", "support.mjs"), "// support\nexport function support() {}\n");
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=Prism Test", "-c", "user.email=prism@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const { stdout: commitOutput } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  const command = await codeNibStub(context, commitOutput.trim(), root);
  const mcp = mcpProcess(context, root, root, { PRISM_CODENIB_COMMAND: command });

  await initialize(mcp);
  const response = await callTool(mcp, 2, "plan_repository_context", {
    projectRoot: root,
    provider: "codenib",
    task: "Change the entry behavior.",
    hints: { symbols: ["entry"] },
    budget: "balanced",
    searchHits: 4,
    graphNodes: 4
  });

  assert.match(response.result.structuredContent.commit, /^[a-f0-9]{40,64}$/);
  assert.match(response.result.structuredContent.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(response.result.structuredContent.provider.name, "native+codenib");
  assert.deepEqual(response.result.structuredContent.provider.contributors.map(({ id }) => id), ["native", "codenib"]);
  assert.deepEqual(response.result.structuredContent.mustRead.map(({ file }) => file), ["src/entry.mjs"]);
  assert.deepEqual(response.result.structuredContent.likelyRead.map(({ file }) => file), ["src/support.mjs"]);
  assert.match(response.result.content[0].text, /Token estimate:/);
});

test("lists repository intelligence providers without starting the review server", async (context) => {
  const root = await projectFixture(context, "repository-provider-list", "artifact.md");
  const mcp = mcpProcess(context, root, root, { PRISM_CODENIB_COMMAND: "prism-codenib-command-does-not-exist" });

  await initialize(mcp);
  const response = await callTool(mcp, 2, "list_repository_intelligence_providers", { projectRoot: root });

  assert.deepEqual(response.result.structuredContent.providers.map(({ id }) => id), ["codegraph", "codenib", "native"]);
  for (const provider of response.result.structuredContent.providers) {
    assert.equal(typeof provider.version, "string");
    assert.equal(typeof provider.capabilities, "object");
  }
  assert.equal(response.result.structuredContent.providers.find(({ id }) => id === "native").status, "available");
  const codenib = response.result.structuredContent.providers.find(({ id }) => id === "codenib");
  assert.equal(codenib.diagnosticCode, "not-installed");
  assert.equal(codenib.capabilities.semanticSearch, true);
  assert.match(response.result.content[0].text, /native: available/);
  await assert.rejects(access(path.join(root, ".prism-review-cert")), (caught) => caught.code === "ENOENT");
});

test("plans repository context with the native baseline when no external provider is selected", async (context) => {
  const root = await projectFixture(context, "repository-native", "artifact.md");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "entry.mjs"), "export function entry() {\n  return true;\n}\n");
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const response = await callTool(mcp, 2, "plan_repository_context", {
    projectRoot: root,
    provider: "native",
    task: "Change entry.",
    hints: { symbols: ["entry"] }
  });

  assert.equal(response.result.structuredContent.provider.name, "native");
  assert.deepEqual(response.result.structuredContent.provider.selection, { requested: "native", selected: "native" });
  assert.deepEqual(response.result.structuredContent.mustRead.map(({ file }) => file), ["src/entry.mjs"]);
  assert.equal(response.result.structuredContent.tokenEstimate.expected, null);
  await assert.rejects(access(path.join(root, ".prism-review-cert")), (caught) => caught.code === "ENOENT");
});

test("evaluates repository fit without starting the review server", async (context) => {
  const root = await projectFixture(context, "repository-fit", "artifact.md");
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const response = await callTool(mcp, 2, "evaluate_repository_fit", {
    session: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol"
    },
    costs: {
      baseSessionContextTokens: 20000,
      featureDesignContextTokens: 10000,
      implementationReserveTokens: 90000
    },
    tokenEstimate: { lower: 140000, expected: 145000, upper: 150000 }
  });

  assert.equal(response.result.structuredContent.status, "SUPPORTED");
  assert.equal(response.result.structuredContent.fit, "SPLIT");
  assert.equal(response.result.structuredContent.repositoryReadBudgetTokens, 124800);
  assert.match(response.result.content[0].text, /Repository fit: SPLIT/);
  await assert.rejects(access(path.join(root, ".prism-review-cert")), (caught) => caught.code === "ENOENT");
});

test("resolves explicit session capacity without starting the review server", async (context) => {
  const root = await projectFixture(context, "session-capacity", "artifact.md");
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const response = await callTool(mcp, 2, "resolve_session_capacity", {
    session: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol"
    }
  });

  assert.equal(response.result.structuredContent.status, "SUPPORTED");
  assert.equal(response.result.structuredContent.capacity.compactionThresholdTokens, 244800);
  assert.match(response.result.content[0].text, /Session capacity: SUPPORTED/);
  await assert.rejects(access(path.join(root, ".prism-review-cert")), (caught) => caught.code === "ENOENT");
});

test("evaluates repository fit from same-session host facts and rejects invalid raw active input", async (context) => {
  const root = await projectFixture(context, "active-repository-fit", "artifact.md");
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-active-facts-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const sessionId = "active-thread";
  const record = createHostSessionFactRecord({
    sessionId,
    projectRoot: await realpath(root),
    observedAt: new Date().toISOString(),
    status: "SUPPORTED",
    host: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol"
    },
    capacityOverrides: {
      contextWindowTokens: 272000,
      compactionThresholdTokens: 244800
    },
    compactionScope: "total",
    sources: {
      harness: "codex-adapter",
      harnessVersion: "transcript.session_meta.cli_version",
      provider: "transcript.session_meta.model_provider",
      model: "hook.model",
      contextWindowTokens: "hook.model_context_window",
      compactionThresholdTokens: "hook.model_auto_compact_token_limit",
      compactionScope: "hook.model_auto_compact_token_limit_scope"
    }
  });
  await writeHostSessionFacts(record, { dataDirectory });
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const fitArguments = {
    projectRoot: root,
    session: { mode: "active", correlationKey: record.sessionDigest, dataDirectory },
    costs: {
      baseSessionContextTokens: 20000,
      featureDesignContextTokens: 10000,
      implementationReserveTokens: 90000
    },
    tokenEstimate: { lower: 90000, expected: 100000, upper: 120000 }
  };
  const response = await callTool(mcp, 2, "evaluate_repository_fit", fitArguments);

  assert.equal(response.result.structuredContent.status, "SUPPORTED");
  assert.equal(response.result.structuredContent.fit, "FIT");
  assert.equal(response.result.structuredContent.session.model, "gpt-5.6-sol");
  assert.equal(response.result.structuredContent.sessionProvenance.source, "active-host-session");

  const invalidCases = [
    {
      argumentsValue: {
        ...fitArguments,
        session: { ...fitArguments.session, capacityOverrides: null }
      },
      message: /capacityOverrides must be an object/
    },
    {
      argumentsValue: {
        ...fitArguments,
        session: { ...fitArguments.session, compactionScope: null }
      },
      message: /compactionScope must be total/
    },
    {
      argumentsValue: {
        ...fitArguments,
        session: { ...fitArguments.session, unexpected: true }
      },
      message: /session contains an unknown property/
    },
    {
      argumentsValue: { ...fitArguments, unexpected: true },
      message: /arguments contains an unknown property/
    },
    {
      argumentsValue: { ...fitArguments, projectRoot: null },
      message: /projectRoot argument must be an absolute path/
    }
  ];
  for (const [index, invalidCase] of invalidCases.entries()) {
    const invalidResponse = await callTool(mcp, index + 3, "evaluate_repository_fit", invalidCase.argumentsValue);
    assert.match(invalidResponse.error.message, invalidCase.message);
    assert.equal(invalidResponse.result, undefined);
  }
});

test("fails closed when active session facts are absent", async (context) => {
  const root = await projectFixture(context, "missing-active-facts", "artifact.md");
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-missing-active-facts-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const response = await callTool(mcp, 2, "resolve_session_capacity", {
    projectRoot: root,
    session: { mode: "active", correlationKey: "a".repeat(64), dataDirectory }
  });

  assert.equal(response.result.structuredContent.status, "UNSUPPORTED");
  assert.equal(response.result.structuredContent.reasonCode, "NO_SESSION_FACTS");
  assert.match(response.result.content[0].text, /Reason code: NO_SESSION_FACTS/);
});

test("rejects partial active capacity overrides before reading host facts", async (context) => {
  const root = await projectFixture(context, "partial-active-capacity", "artifact.md");
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-partial-active-capacity-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const mcp = mcpProcess(context, root, root, { PLUGIN_DATA: dataDirectory });

  await initialize(mcp);
  const response = await callTool(mcp, 2, "resolve_session_capacity", {
    projectRoot: root,
    session: {
      mode: "active",
      correlationKey: "a".repeat(64),
      dataDirectory,
      capacityOverrides: { contextWindowTokens: 120000 }
    }
  });

  assert.match(response.error.message, /compactionThresholdTokens is required/);
  assert.equal(response.result, undefined);
});

test("summarizes consumption only for the same active session", async (context) => {
  const root = await projectFixture(context, "session-consumption", "artifact.md");
  const canonicalRoot = await realpath(root);
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "prism-session-consumption-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const sessionId = "consumption-thread";
  const events = [
    createSessionTraceEvent({
      sessionId,
      projectRoot: canonicalRoot,
      eventId: "start",
      eventType: "session_start",
      occurredAt: "2026-09-19T12:00:00.000Z",
      coverage: "exact",
      provenance: { collector: "test", hostEvent: "Custom" }
    }),
    createSessionTraceEvent({
      sessionId,
      projectRoot: canonicalRoot,
      eventId: "read",
      eventType: "source_read",
      occurredAt: "2026-09-19T12:00:01.000Z",
      sourceLocation: { path: "server/example.mjs", startLine: 1, endLine: 10 },
      counts: { renderedTokens: 80 },
      provenance: { collector: "test", hostEvent: "Custom" }
    })
  ];
  for (const event of events) {
    await appendSessionTraceEvent(event, { dataDirectory });
  }
  const mcp = mcpProcess(context, root, root, { PLUGIN_DATA: dataDirectory });

  await initialize(mcp);
  const supported = await callTool(mcp, 2, "summarize_session_consumption", {
    projectRoot: root,
    correlationKey: events[0].sessionDigest,
    dataDirectory
  });
  assert.equal(supported.result.structuredContent.status, "SUPPORTED");
  assert.equal(supported.result.structuredContent.coverage, "exact");
  assert.equal(supported.result.structuredContent.preEdit.renderedTokens, 80);
  assert.match(supported.result.content[0].text, /Rendered tokens: 80/);

  const other = await callTool(mcp, 3, "summarize_session_consumption", {
    projectRoot: root,
    correlationKey: "b".repeat(64),
    dataDirectory
  });
  assert.equal(other.result.structuredContent.status, "UNSUPPORTED");
  assert.equal(other.result.structuredContent.reasonCode, "NO_SESSION_TRACE");
});

test("rejects invalid repository fit input without a classification", async (context) => {
  const root = await projectFixture(context, "invalid-repository-fit", "artifact.md");
  const mcp = mcpProcess(context, root, root);

  await initialize(mcp);
  const response = await callTool(mcp, 2, "evaluate_repository_fit", {
    session: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol"
    },
    costs: {
      baseSessionContextTokens: 20000,
      featureDesignContextTokens: 10000,
      implementationReserveTokens: -1
    },
    tokenEstimate: { lower: 1, expected: 2, upper: 3 }
  });

  assert.match(response.error.message, /nonnegative integer/);
  assert.equal(response.result, undefined);
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

test("native semantic MCP discovery is passive and search exposes bounded structured results and stable errors", async context => {
  const root = await projectFixture(context, "prism-semantic-mcp", "retry.md");
  await writeFile(path.join(root, "docs/retry.md"), "Retry transient network failures.\n");
  const mcp = mcpProcess(context, root);
  await initialize(mcp);
  mcp.send({ id: 2, method: "tools/list" });
  const listed = (await mcp.next()).result.tools;
  const search = listed.find(tool => tool.name === "search_repository_concepts");
  assert.equal(search.inputSchema.properties.limit.maximum, 50);
  assert.equal(search.inputSchema.properties.filters.additionalProperties, false);
  assert.equal(search.annotations.readOnlyHint, false);
  assert.equal(search.annotations.openWorldHint, true);
  assert.equal(listed.find(tool => tool.name === "get_repository_intelligence_status").annotations.readOnlyHint, true);
  mcp.send({ id: 3, method: "tools/call", params: { name: "discover_repository_intelligence", arguments: { projectRoot: root } } });
  assert.equal((await mcp.next()).result.structuredContent.status, "unprepared");
  mcp.send({ id: 4, method: "tools/call", params: { name: "search_repository_concepts", arguments: { projectRoot: root, query: "network failures", filters: { paths: ["docs"], domains: ["documentation"] } } } });
  const result = (await mcp.next()).result;
  assert.equal(result.structuredContent.status, "degraded");
  assert.equal(result.structuredContent.results[0].file, "docs/retry.md");
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  mcp.send({ id: 5, method: "tools/call", params: { name: "search_repository_concepts", arguments: { projectRoot: root, query: "retry", expectedSnapshot: "0".repeat(64) } } });
  assert.equal((await mcp.next()).error.data.code, "stale_snapshot");
  mcp.send({ id: 6, method: "tools/call", params: { name: "search_repository_concepts", arguments: { projectRoot: root, query: "retry", limit: 51 } } });
  assert.equal((await mcp.next()).error.data.code, "validation_failed");
  mcp.send({ id: 7, method: "tools/call", params: { name: "get_repository_intelligence_status", arguments: { projectRoot: root, waitMs: 30001 } } });
  assert.equal((await mcp.next()).error.data.code, "validation_failed");
  mcp.send({ id: 8, method: "tools/call", params: { name: "search_repository_concepts", arguments: { projectRoot: "relative/path", query: "retry" } } });
  assert.equal((await mcp.next()).error.data.code, "invalid_path");
});
