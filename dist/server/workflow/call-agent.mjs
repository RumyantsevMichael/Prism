// Generated from src/server/workflow/call-agent.mts by scripts/native-build/compile.mjs.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { claimHolder } from "./slice-claims.mjs";
import { parseStoreJson } from "./store-json.mjs";
const DIRECTORY = "call-agents";
const CALL_AGENT_TTL_MS = 24 * 60 * 6e4;
const MAIN_AGENT = "main";
const current = new AsyncLocalStorage();
function callAgentDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}
const recordFile = (directory, session, toolUseId) => path.join(directory, `${createHash("sha256").update(`${session}\0${toolUseId}`, "utf8").digest("hex").slice(0, 32)}.json`);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
async function removeExpired(directory, now) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > CALL_AGENT_TTL_MS) await rm(file, { force: true }).catch(() => {
    });
  }
}
async function recordCallAgent({ session, toolUseId, agentId, directory = callAgentDirectory(), now = Date.now() }) {
  if (!text(session) || !text(toolUseId)) return false;
  await prepareDirectory(directory);
  await removeExpired(directory, now);
  const file = recordFile(directory, session, text(toolUseId));
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ agentId: text(agentId), at: new Date(now).toISOString() })}
`, { mode: 384 });
  await rename(temporary, file);
  return true;
}
async function recordedUse(session, toolUseId, directory, now) {
  try {
    const file = recordFile(directory, session, toolUseId);
    const info = await stat(file);
    if (now - info.mtimeMs > CALL_AGENT_TTL_MS) return null;
    const record = parseStoreJson(await readFile(file, "utf8"));
    return record && typeof record === "object" ? { agentId: text(record.agentId) } : null;
  } catch {
    return null;
  }
}
function turnMetadata(meta) {
  const value = meta?.["x-codex-turn-metadata"];
  if (typeof value !== "string") return value && typeof value === "object" ? value : null;
  try {
    const parsed = parseStoreJson(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
async function callAgent(meta, { session = claimHolder(), directory = callAgentDirectory(), now = Date.now() } = {}) {
  const turn = turnMetadata(meta);
  const thread = text(turn?.thread_id) ?? text(meta?.threadId);
  if (turn && thread && (text(turn.parent_thread_id) || turn.thread_source === "subagent")) return `thread:${thread}`;
  if (turn || text(meta?.threadId)) return MAIN_AGENT;
  const toolUseId = text(meta?.["claudecode/toolUseId"]);
  const agentId = toolUseId ? (await recordedUse(session, toolUseId, directory, now))?.agentId : null;
  return agentId ? `agent:${agentId}` : MAIN_AGENT;
}
async function callAgentRole(meta, { session = claimHolder(), directory = callAgentDirectory(), now = Date.now() } = {}) {
  const turn = turnMetadata(meta);
  if (turn) {
    if (text(turn.parent_thread_id) || turn.thread_source === "subagent") return "subagent";
    return text(turn.thread_id) ? "main" : "unknown";
  }
  if (text(meta?.threadId)) return "unknown";
  const toolUseId = text(meta?.["claudecode/toolUseId"]);
  const use = toolUseId ? await recordedUse(session, toolUseId, directory, now) : null;
  if (!use) return "unknown";
  return use.agentId ? "subagent" : "main";
}
const withCallAgent = (agent, run) => current.run(agent, run);
const currentCallAgent = () => current.getStore() ?? MAIN_AGENT;
export {
  CALL_AGENT_TTL_MS,
  MAIN_AGENT,
  callAgent,
  callAgentDirectory,
  callAgentRole,
  currentCallAgent,
  recordCallAgent,
  withCallAgent
};
