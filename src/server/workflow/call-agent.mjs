import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { claimHolder } from "./slice-claims.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Which agent of a host session made a Prism tool call.
// Codex names the calling thread in each call's turn metadata; Claude Code sends only the tool use id, so its PreToolUse hook records the sub-agent of each tool use here first.
// The records live in Prism's private app directory, which every server process and hook of the session reads.
const DIRECTORY = "call-agents";
export const CALL_AGENT_TTL_MS = 24 * 60 * 60000;
export const MAIN_AGENT = "main";
const current = new AsyncLocalStorage();

export function callAgentDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}

const recordFile = (directory, session, toolUseId) => path.join(directory, `${createHash("sha256").update(`${session}\0${toolUseId}`, "utf8").digest("hex").slice(0, 32)}.json`);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

async function removeExpired(directory, now) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > CALL_AGENT_TTL_MS) await rm(file, { force: true }).catch(() => {});
  }
}

/** Record the sub-agent of one Claude Code tool use, by session and tool use id; a main agent's tool use, which names no agent, records nothing. */
export async function recordCallAgent({ session, toolUseId, agentId, directory = callAgentDirectory(), now = Date.now() }) {
  if (!text(session) || !text(toolUseId) || !text(agentId)) return false;
  await prepareDirectory(directory);
  await removeExpired(directory, now);
  const file = recordFile(directory, session, text(toolUseId));
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ agentId: text(agentId), at: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

async function recordedAgent(session, toolUseId, directory, now) {
  try {
    const file = recordFile(directory, session, toolUseId);
    const info = await stat(file);
    if (now - info.mtimeMs > CALL_AGENT_TTL_MS) return null;
    return text(parseStoreJson(await readFile(file, "utf8"))?.agentId);
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

/**
 * The agent of a call within its session: a Codex sub-agent thread, a Claude Code sub-agent that the hook recorded, or the session's main agent.
 * Run inside the call's session, so the hook's record is looked up under the same holder that claims use.
 */
export async function callAgent(meta, { session = claimHolder(), directory = callAgentDirectory(), now = Date.now() } = {}) {
  const turn = turnMetadata(meta);
  const thread = text(turn?.thread_id) ?? text(meta?.threadId);
  if (turn && thread && (text(turn.parent_thread_id) || turn.thread_source === "subagent")) return `thread:${thread}`;
  if (turn || text(meta?.threadId)) return MAIN_AGENT;
  const toolUseId = text(meta?.["claudecode/toolUseId"]);
  const agentId = toolUseId ? await recordedAgent(session, toolUseId, directory, now) : null;
  return agentId ? `agent:${agentId}` : MAIN_AGENT;
}

/** Run one tool call as its agent, so every step of the call reads the same agent. */
export const withCallAgent = (agent, run) => current.run(agent, run);
export const currentCallAgent = () => current.getStore() ?? MAIN_AGENT;
