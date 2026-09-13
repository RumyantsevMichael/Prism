import readline from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { listArtifacts, startReviewServer } from "./review-server.mjs";
import { readCoordinationState, updateCoordinationState, validateCoordinationState } from "./state.mjs";

const reviewServers = new Map();
const taskRoots = new Map();
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

function refreshIdleTimeout(projectRoot, binding) {
  clearTimeout(binding.idleTimeout);
  const idleTimeout = setTimeout(async () => {
    if (binding.idleTimeout !== idleTimeout || reviewServers.get(projectRoot) !== binding) {
      return;
    }
    try {
      const review = await binding.review;
      if (review.viewerCount() > 0) {
        refreshIdleTimeout(projectRoot, binding);
        return;
      }
      reviewServers.delete(projectRoot);
      for (const [task, boundRoot] of taskRoots) {
        if (boundRoot === projectRoot) {
          taskRoots.delete(task);
        }
      }
      await review.close();
    } catch {
    }
  }, REVIEW_SERVER_IDLE_MS);
  binding.idleTimeout = idleTimeout;
  idleTimeout.unref();
}

async function server(argumentsValue, metadata) {
  const id = taskId(metadata);
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const boundRoot = taskRoots.get(id);
  if (boundRoot && boundRoot !== projectRoot) {
    throw new Error(`This task is already bound to project root: ${boundRoot}`);
  }
  taskRoots.set(id, projectRoot);
  const existing = reviewServers.get(projectRoot);
  if (existing) {
    refreshIdleTimeout(projectRoot, existing);
    return existing.review;
  }
  const review = startReviewServer({ projectRoot });
  const binding = { projectRoot, review };
  reviewServers.set(projectRoot, binding);
  refreshIdleTimeout(projectRoot, binding);
  try {
    return await review;
  } catch (error) {
    clearTimeout(binding.idleTimeout);
    if (reviewServers.get(projectRoot) === binding) {
      reviewServers.delete(projectRoot);
    }
    if (taskRoots.get(id) === projectRoot) {
      taskRoots.delete(id);
    }
    throw error;
  }
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function requestedTabs(argumentsValue) {
  const hasArtifact = Object.hasOwn(argumentsValue, "artifact");
  const hasArtifacts = Object.hasOwn(argumentsValue, "artifacts");
  if (hasArtifact && hasArtifacts) {
    throw new Error("Use either artifact or artifacts, not both.");
  }
  if (hasArtifacts) {
    return argumentsValue.artifacts;
  }
  return hasArtifact ? argumentsValue.artifact : undefined;
}

function reviewContent(url, review) {
  const trustInstructions = review.trustInstructions ? `\n${review.trustInstructions}` : "";
  return `Human review URL: ${url}${trustInstructions}`;
}

function stateContent(result) {
  const validity = result.valid ? "valid" : "invalid";
  const revision = result.revision ?? "none";
  return `Coordination state ${validity}: ${result.statePath}\nRevision: ${revision}`;
}

function reviewSessionContent(review) {
  return review.getSession();
}

function failure(id, code, message, data) {
  const response = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) {
    response.error.data = data;
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function stateErrorData(error) {
  if (error?.name !== "CoordinationStateError") {
    return undefined;
  }
  const data = { code: error.code };
  for (const key of ["errors", "warnings", "current", "validation"]) {
    if (error[key] !== undefined) {
      data[key] = error[key];
    }
  }
  return data;
}

const tools = [
  {
    name: "get_review_url",
    description: "Start or update the local Prism HTTPS review server and return a human review URL only. Use artifacts to select the shared persistent tabs. This tool does not open a browser or return rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "One project-relative artifact path. Use artifacts for multiple tabs." },
        artifacts: { type: "array", items: { type: "string" }, description: "Project-relative artifact paths to open as persistent tabs. An empty array closes all tabs." }
      },
      required: ["projectRoot"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "present_review",
    description: "Open or update one local Prism HTTPS review page in the system browser for the human. Use artifacts to select the shared persistent tabs. Repeated calls update connected viewer pages without opening another tab. Omit artifact to show the complete artifact tree when artifacts is also omitted. The tool returns no rendered image data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        artifact: { type: "string", description: "One project-relative artifact path. Use artifacts for multiple tabs." },
        artifacts: { type: "array", items: { type: "string" }, description: "Project-relative artifact paths to open as persistent tabs. An empty array closes all tabs." }
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
  },
  {
    name: "get_coordination_state",
    description: "Read the initiative coordination state from state.json. Use this tool instead of reading and parsing the file manually. The statePath must be relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        statePath: { type: "string", description: "The project-relative path to the initiative state.json file." }
      },
      required: ["projectRoot", "statePath"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "validate_coordination_state",
    description: "Validate an initiative state.json file without changing it. Use this tool before recovery or when a state update reports invalid data.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        statePath: { type: "string", description: "The project-relative path to the initiative state.json file." }
      },
      required: ["projectRoot", "statePath"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_coordination_state",
    description: "Apply a validated atomic update to an initiative state.json file. Read the current state first and pass its revision as expectedRevision. Do not edit state.json directly when this tool is available.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "The absolute path to the active project root." },
        statePath: { type: "string", description: "The project-relative path to the initiative state.json file." },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "null" }], description: "The revision returned by get_coordination_state, or null when creating a missing state file." },
        changes: {
          type: "object",
          description: "Managed fields to replace in one atomic update. Settings merge with existing settings, while arrays replace their current values.",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            settings: {
              type: "object",
              additionalProperties: false,
              properties: {
                autonomy: { type: "string", enum: ["conservative", "broad"] },
                commit: { type: "string", enum: ["on", "off"] },
                push: { type: "string", enum: ["on", "off"] },
                continuation: { type: "string", enum: ["auto", "stepwise"] },
                models: {
                  oneOf: [
                    { type: "string", enum: ["defaults", "host defaults"] },
                    {
                      type: "object",
                      required: ["delivery", "review", "securityReview"],
                      additionalProperties: false,
                      properties: {
                        delivery: { type: "string", minLength: 1 },
                        review: { type: "string", minLength: 1 },
                        securityReview: { type: "string", minLength: 1 }
                      }
                    }
                  ]
                }
              }
            },
            active: {
              type: "array",
              items: {
                type: "object",
                required: ["slice", "activity", "workers", "workspace"],
                additionalProperties: false,
                properties: {
                  slice: { type: "string", minLength: 1 },
                  activity: { type: "string", minLength: 1 },
                  workers: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                  workspace: { type: "string", minLength: 1 },
                  reviewLanes: { type: "array" },
                  findingsPath: { type: "string", minLength: 1 }
                }
              }
            },
            pending: { type: "array", items: { type: "string", minLength: 1 } },
            next: { type: "array", items: { type: "string", minLength: 1 } },
            evidence: { type: "array", items: { type: "string", minLength: 1 } }
          }
        }
      },
      required: ["projectRoot", "statePath", "expectedRevision", "changes"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

const stateTools = new Set(["get_coordination_state", "validate_coordination_state", "update_coordination_state"]);

async function callStateTool(name, argumentsValue) {
  const projectRoot = await requestedProjectRoot(argumentsValue);
  const input = { ...argumentsValue, projectRoot };
  let resultValue;
  if (name === "get_coordination_state") {
    resultValue = await readCoordinationState(input);
  } else if (name === "validate_coordination_state") {
    resultValue = await validateCoordinationState(input);
  } else if (name === "update_coordination_state") {
    resultValue = await updateCoordinationState(input);
  } else {
    throw new Error(`Unknown state tool: ${name}`);
  }
  return { content: [{ type: "text", text: stateContent(resultValue) }], structuredContent: resultValue };
}

async function callTool(name, argumentsValue = {}, metadata) {
  if (stateTools.has(name)) {
    return callStateTool(name, argumentsValue);
  }
  const review = await server(argumentsValue, metadata);
  if (name === "get_review_url") {
    const tabs = requestedTabs(argumentsValue);
    if (tabs !== undefined) {
      await review.setOpenTabs(tabs);
    }
    const url = review.reviewUrl(tabs);
    return { content: [{ type: "text", text: reviewContent(url, review) }], structuredContent: { url, ...reviewSessionContent(review), certificatePath: review.certificatePath, trustInstructions: review.trustInstructions } };
  }
  if (name === "present_review") {
    const opened = await review.open(requestedTabs(argumentsValue));
    return { content: [{ type: "text", text: reviewContent(opened.url, review) }], structuredContent: { ...opened, ...reviewSessionContent(review), certificatePath: review.certificatePath, trustInstructions: review.trustInstructions } };
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
      failure(request.id, -32603, error.message, stateErrorData(error));
    }
  }
});

input.on("close", async () => {
  for (const binding of reviewServers.values()) {
    clearTimeout(binding.idleTimeout);
  }
  const reviews = await Promise.allSettled([...reviewServers.values()].map(({ review }) => review));
  await Promise.allSettled(reviews.filter(({ status }) => status === "fulfilled").map(({ value }) => value.close()));
  reviewServers.clear();
  taskRoots.clear();
});
