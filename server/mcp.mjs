import readline from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { listArtifacts, startReviewServer } from "./review-server.mjs";

const reviewServers = new Map();
const REVIEW_SERVER_IDLE_MS = 30 * 60 * 1000;
const pluginManifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));

function taskId(metadata = {}) {
  return metadata["x-codex-turn-metadata"]?.thread_id ?? metadata.threadId ?? "mcp-process";
}

async function requestedProjectRoot(argumentsValue) {
  const hostProjectRoot = process.env.CLAUDE_PROJECT_DIR;
  const projectRoot = hostProjectRoot ?? argumentsValue.projectRoot;
  if (!projectRoot) {
    throw new Error("The projectRoot argument is required when the host does not provide a project root.");
  }
  if (!path.isAbsolute(projectRoot)) {
    throw new Error("The projectRoot argument must be an absolute path.");
  }
  const resolvedRoot = await realpath(projectRoot);
  if (hostProjectRoot && argumentsValue.projectRoot) {
    if (!path.isAbsolute(argumentsValue.projectRoot)) {
      throw new Error("The projectRoot argument must be an absolute path.");
    }
    const suppliedRoot = await realpath(argumentsValue.projectRoot);
    if (suppliedRoot !== resolvedRoot) {
      throw new Error("The projectRoot argument does not match the host project root.");
    }
  }
  return resolvedRoot;
}

function refreshIdleTimeout(id, binding) {
  clearTimeout(binding.idleTimeout);
  binding.idleTimeout = setTimeout(async () => {
    if (reviewServers.get(id) !== binding) {
      return;
    }
    reviewServers.delete(id);
    try {
      const review = await binding.review;
      await review.close();
    } catch {
    }
  }, REVIEW_SERVER_IDLE_MS);
  binding.idleTimeout.unref();
}

async function server(argumentsValue, metadata) {
  const id = taskId(metadata);
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const existing = reviewServers.get(id);
  if (existing) {
    if (existing.projectRoot !== projectRoot) {
      throw new Error(`This task is already bound to project root: ${existing.projectRoot}`);
    }
    refreshIdleTimeout(id, existing);
    return existing.review;
  }
  const review = startReviewServer({ projectRoot });
  const binding = { projectRoot, review };
  reviewServers.set(id, binding);
  refreshIdleTimeout(id, binding);
  try {
    return await review;
  } catch (error) {
    clearTimeout(binding.idleTimeout);
    reviewServers.delete(id);
    throw error;
  }
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function failure(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const tools = [
  {
    name: "get_review_url",
    description: "Start the local Prism review server and return a human review URL. The tool returns no rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "A project-relative artifact path." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "present_review",
    description: "Open the local Prism review page for the human. The tool returns no rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "A project-relative artifact path." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "list_reviewable_artifacts",
    description: "List reviewable Prism source artifacts. This tool reads file names only and returns no image data.",
    inputSchema: {
      type: "object",
      properties: { projectRoot: { type: "string", description: "The absolute path to the active project root." } },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

async function callTool(name, argumentsValue = {}, metadata) {
  const review = await server(argumentsValue, metadata);
  if (name === "get_review_url") {
    const url = review.reviewUrl(argumentsValue.artifact);
    return { content: [{ type: "text", text: `Human review URL: ${url}` }], structuredContent: { url } };
  }
  if (name === "present_review") {
    const opened = review.open(argumentsValue.artifact);
    return { content: [{ type: "text", text: `Human review URL: ${opened.url}` }], structuredContent: opened };
  }
  if (name === "list_reviewable_artifacts") {
    const artifacts = await listArtifacts(review.projectRoot);
    return { content: [{ type: "text", text: artifacts.join("\n") || "No reviewable artifacts found." }], structuredContent: { artifacts } };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") {
      result(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "prism-review", version: pluginManifest.version }
      });
    } else if (request.method === "tools/list") {
      result(request.id, { tools });
    } else if (request.method === "tools/call") {
      result(request.id, await callTool(request.params?.name, request.params?.arguments, request.params?._meta));
    } else if (request.id !== undefined) {
      failure(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (request?.id !== undefined) {
      failure(request.id, -32603, error.message);
    }
  }
});

input.on("close", async () => {
  for (const binding of reviewServers.values()) {
    clearTimeout(binding.idleTimeout);
  }
  const reviews = await Promise.allSettled([...reviewServers.values()].map(({ review }) => review));
  await Promise.allSettled(reviews.filter(({ status }) => status === "fulfilled").map(({ value }) => value.close()));
});
