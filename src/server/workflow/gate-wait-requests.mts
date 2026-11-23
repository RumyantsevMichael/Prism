import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { MAIN_AGENT } from "./call-agent.mjs";
import { parseStoreJson } from "./store-json.mjs";

// A host that cannot move a long tool call to the background, such as Codex, records the wait here,
// and the host's Stop hook for the same session waits on it after the turn ends.
const DIRECTORY = "gate-waits";
// The Stop hook runs right after the turn that asked for the wait, so an older request belongs to a turn that ended without the hook.
export const WAIT_REQUEST_TTL_MS = 30 * 60000;

export function gateWaitDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}

// The session's main agent keeps the session's request; every other agent of the session, such as a Codex sub-agent thread, keeps its own beside it.
function requestFile(directory: string, sessionId: string, agent: string) {
  const key = agent === MAIN_AGENT ? sessionId : `${sessionId}\0${agent}`;
  return path.join(directory, `${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}.json`);
}

// The approval gates that this machine's checkouts asked live beside the requests, kept until each answer reaches its checkout, so expiry passes them by.
export const ASKED_GATES_FILE = "asked-approval-gates.json";

async function removeExpired(directory: string, now: any) {
  for (const name of await readdir(directory).catch(() => [])) {
    if (name.startsWith(ASKED_GATES_FILE)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > WAIT_REQUEST_TTL_MS) await rm(file, { force: true });
  }
}

// One request per agent of a session: a later wait of the same agent replaces its earlier one, since the agent lists every gate it still waits on,
// and a wait of another agent, such as a sub-agent of the orchestrator, never replaces it, since each agent's own stop hook continues only that agent.
// A wait names an initiative, or the artifact, with its scope when one was given, whose approval gates it waits on.
// knownEntries are the history entry ids when the wait was asked, so a change the person makes before the hook starts still ends it,
// coordinates keeps whether the asking agent coordinated the initiative, since only such a wait ends on the person's changes,
// and waitId names the wait whose gates the session's notice record holds for the hook; the result names the wait of the request it replaced.
export async function recordWaitRequest({ sessionId, agent = MAIN_AGENT, projectRoot, initiative, artifact, scope, gateIds, maxWaitMinutes, knownEntries, coordinates = false, waitId, directory = gateWaitDirectory(), now = Date.now() }: { sessionId: string; agent?: string; projectRoot: string; initiative: string; artifact: any; scope: any; gateIds: any; maxWaitMinutes: any; knownEntries: any; coordinates?: boolean; waitId: any; directory?: string; now?: number }) {
  await mkdir(directory, { recursive: true });
  await removeExpired(directory, now);
  const file = requestFile(directory, sessionId, agent);
  const replaced = await readFile(file, "utf8").then((text) => parseStoreJson(text), () => null).catch(() => null);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const source = artifact ? { artifact, ...(scope === undefined ? {} : { scope }) } : { initiative, ...(Array.isArray(knownEntries) ? { knownEntries } : {}), coordinates: coordinates === true, ...(typeof waitId === "string" ? { waitId } : {}) };
  await writeFile(temporary, `${JSON.stringify({ sessionId, agent, projectRoot, ...source, gateIds, maxWaitMinutes, requestedAt: new Date(now).toISOString() })}\n`);
  await rename(temporary, file);
  return { replaced: typeof replaced?.waitId === "string" && typeof replaced.initiative === "string" && typeof replaced.projectRoot === "string" ? { waitId: replaced.waitId, initiative: replaced.initiative, projectRoot: replaced.projectRoot } : null };
}

// Whether the agent's request for the wait waitId still waits for its hook: not yet taken, replaced, or expired.
export async function waitRequestPending({ sessionId, agent = MAIN_AGENT, waitId, directory = gateWaitDirectory(), now = Date.now() }: { sessionId: string; agent?: string; waitId: string; directory?: string; now?: number }) {
  try {
    const request = parseStoreJson(await readFile(requestFile(directory, sessionId, agent), "utf8"));
    return request.waitId === waitId && now - Date.parse(request.requestedAt) <= WAIT_REQUEST_TTL_MS;
  } catch {
    return false;
  }
}

// The hook takes the request by moving it away first, so two Stop hooks of one session never both wait on it.
export async function takeWaitRequest({ sessionId, agent = MAIN_AGENT, directory = gateWaitDirectory(), now = Date.now() }: { sessionId: string; agent?: string; directory?: string; now?: number }) {
  const file = requestFile(directory, sessionId, agent);
  const taken = `${file}.${randomBytes(6).toString("hex")}.taken`;
  try {
    await rename(file, taken);
  } catch {
    return null;
  }
  try {
    const request = parseStoreJson(await readFile(taken, "utf8"));
    if (request.sessionId !== sessionId || (request.agent ?? MAIN_AGENT) !== agent || now - Date.parse(request.requestedAt) > WAIT_REQUEST_TTL_MS) return null;
    const named = typeof request.initiative === "string" || typeof request.artifact === "string";
    if (!Array.isArray(request.gateIds) || !request.gateIds.length || !named || typeof request.projectRoot !== "string") return null;
    return request;
  } catch {
    return null;
  } finally {
    await rm(taken, { force: true });
  }
}
