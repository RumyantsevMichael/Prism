import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { parseStoreJson } from "./store-json.mjs";

// A host that cannot move a long tool call to the background, such as Codex, records the wait here,
// and the host's Stop hook for the same session waits on it after the turn ends.
const DIRECTORY = "gate-waits";
// The Stop hook runs right after the turn that asked for the wait, so an older request belongs to a turn that ended without the hook.
export const WAIT_REQUEST_TTL_MS = 30 * 60000;

export function gateWaitDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}

function requestFile(directory, sessionId) {
  return path.join(directory, `${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32)}.json`);
}

// The approval gates that this machine's checkouts asked live beside the requests, kept until each answer reaches its checkout, so expiry passes them by.
export const ASKED_GATES_FILE = "asked-approval-gates.json";

async function removeExpired(directory, now) {
  for (const name of await readdir(directory).catch(() => [])) {
    if (name.startsWith(ASKED_GATES_FILE)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > WAIT_REQUEST_TTL_MS) await rm(file, { force: true });
  }
}

// One request per session: a later wait in the same turn replaces an earlier one, since the agent lists every gate it still waits on.
// A wait names an initiative, or the artifact, with its scope when one was given, whose approval gates it waits on.
// knownEntries are the history entry ids when the wait was asked, so a change the person makes before the hook starts still ends it,
// coordinates keeps whether the asking agent coordinated the initiative, since only such a wait ends on the person's changes,
// and waitId names the wait whose gates the session's notice record holds for the hook; the result names the wait of the request it replaced.
export async function recordWaitRequest({ sessionId, projectRoot, initiative, artifact, scope, gateIds, maxWaitMinutes, knownEntries, coordinates = false, waitId, directory = gateWaitDirectory(), now = Date.now() }) {
  await mkdir(directory, { recursive: true });
  await removeExpired(directory, now);
  const file = requestFile(directory, sessionId);
  const replaced = await readFile(file, "utf8").then((text) => parseStoreJson(text), () => null).catch(() => null);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const source = artifact ? { artifact, ...(scope === undefined ? {} : { scope }) } : { initiative, ...(Array.isArray(knownEntries) ? { knownEntries } : {}), coordinates: coordinates === true, ...(typeof waitId === "string" ? { waitId } : {}) };
  await writeFile(temporary, `${JSON.stringify({ sessionId, projectRoot, ...source, gateIds, maxWaitMinutes, requestedAt: new Date(now).toISOString() })}\n`);
  await rename(temporary, file);
  return { replaced: typeof replaced?.waitId === "string" && typeof replaced.initiative === "string" && typeof replaced.projectRoot === "string" ? { waitId: replaced.waitId, initiative: replaced.initiative, projectRoot: replaced.projectRoot } : null };
}

// The hook takes the request by moving it away first, so two Stop hooks of one session never both wait on it.
export async function takeWaitRequest({ sessionId, directory = gateWaitDirectory(), now = Date.now() }) {
  const file = requestFile(directory, sessionId);
  const taken = `${file}.${randomBytes(6).toString("hex")}.taken`;
  try {
    await rename(file, taken);
  } catch {
    return null;
  }
  try {
    const request = parseStoreJson(await readFile(taken, "utf8"));
    if (request.sessionId !== sessionId || now - Date.parse(request.requestedAt) > WAIT_REQUEST_TTL_MS) return null;
    const named = typeof request.initiative === "string" || typeof request.artifact === "string";
    if (!Array.isArray(request.gateIds) || !request.gateIds.length || !named || typeof request.projectRoot !== "string") return null;
    return request;
  } catch {
    return null;
  } finally {
    await rm(taken, { force: true });
  }
}
