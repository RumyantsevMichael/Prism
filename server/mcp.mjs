import readline from "node:readline";
import { readFile } from "node:fs/promises";
import { listArtifacts, startReviewServer } from "./review-server.mjs";

let reviewServer;
const pluginManifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));

async function server() {
  reviewServer ??= await startReviewServer({ projectRoot: process.env.CLAUDE_PROJECT_DIR ?? process.cwd() });
  return reviewServer;
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
      properties: { artifact: { type: "string", description: "A project-relative artifact path." } },
      additionalProperties: false
    }
  },
  {
    name: "present_review",
    description: "Open the local Prism review page for the human. The tool returns no rendered image data.",
    inputSchema: {
      type: "object",
      properties: { artifact: { type: "string", description: "A project-relative artifact path." } },
      additionalProperties: false
    }
  },
  {
    name: "list_reviewable_artifacts",
    description: "List reviewable Prism source artifacts. This tool reads file names only and returns no image data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

async function callTool(name, argumentsValue = {}) {
  const review = await server();
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
      result(request.id, await callTool(request.params?.name, request.params?.arguments));
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
  if (reviewServer) {
    await reviewServer.close();
  }
});
