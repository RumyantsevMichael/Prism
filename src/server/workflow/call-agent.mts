import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { claimHolder } from "./slice-claims.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Which agent of a host session made a Prism tool call.
// Codex names the calling thread in each call's turn metadata; Claude Code sends only the tool use id, so its PreToolUse hook records each tool use, and the sub-agent that made it, here first.
// The records live in Prism's private app directory, which every server process and hook of the session reads.
const DIRECTORY = "call-agents";
export const CALL_AGENT_TTL_MS = 24 * 60 * 60000;
export const MAIN_AGENT = "main";
const current = new AsyncLocalStorage();
/** The agent that a Codex sub-agent thread is, named by its thread id, as tool call metadata and the SubagentStop hook's agent_id name it. */
export const threadAgent = (thread: string) => `thread:${thread}`;

export function callAgentDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}

const recordFile = (directory: string, session: any, toolUseId: any) => path.join(directory, `${createHash("sha256").update(`${session}\0${toolUseId}`, "utf8").digest("hex").slice(0, 32)}.json`);
const text = (value: any) => typeof value === "string" && value.trim() ? value.trim() : null;

async function removeExpired(directory: string, now: any) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > CALL_AGENT_TTL_MS) await rm(file, { force: true }).catch(() => {});
  }
}

/** Record one Claude Code tool use by session and tool use id, with the sub-agent that made it, or with none for the main agent's. */
export async function recordCallAgent({ session, toolUseId, agentId, directory = callAgentDirectory(), now = Date.now() }: { session: any; toolUseId: any; agentId: any; directory?: string; now?: number }) {
  if (!text(session) || !text(toolUseId)) return false;
  await prepareDirectory(directory);
  await removeExpired(directory, now);
  const file = recordFile(directory, session, text(toolUseId));
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ agentId: text(agentId), at: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

// The hook's record of one tool use, { agentId } with null for the main agent's, or null when no hook recorded it.
async function recordedUse(session: any, toolUseId: any, directory: string, now: any) {
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

function turnMetadata(meta: any) {
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
export async function callAgent(meta: any, { session = claimHolder(), directory = callAgentDirectory(), now = Date.now() }: any = {}) {
  const turn = turnMetadata(meta);
  const thread = text(turn?.thread_id) ?? text(meta?.threadId);
  if (turn && thread && (text(turn.parent_thread_id) || turn.thread_source === "subagent")) return threadAgent(thread);
  if (turn || text(meta?.threadId)) return MAIN_AGENT;
  const toolUseId = text(meta?.["claudecode/toolUseId"]);
  const agentId = toolUseId ? (await recordedUse(session, toolUseId, directory, now))?.agentId : null;
  return agentId ? `agent:${agentId}` : MAIN_AGENT;
}

/**
 * Whether a call is positively the session's main agent's: main, subagent, or unknown.
 * A Codex call is the main agent's when its turn metadata names a thread with no parent and a source other than subagent; a Claude Code call when the hook recorded its tool use without an agent.
 * Every other call, such as one whose tool use no hook recorded, is unknown, while callAgent still counts it as the main agent's for run attribution.
 */
export async function callAgentRole(meta: any, { session = claimHolder(), directory = callAgentDirectory(), now = Date.now() }: any = {}) {
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

/** Run one tool call as its agent, so every step of the call reads the same agent. */
export const withCallAgent = (agent: any, run: any) => current.run(agent, run);
export const currentCallAgent = () => current.getStore() ?? MAIN_AGENT;
