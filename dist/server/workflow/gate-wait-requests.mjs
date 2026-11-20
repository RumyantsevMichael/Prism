// Generated from src/server/workflow/gate-wait-requests.mts by scripts/native-build/compile.mjs.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { parseStoreJson } from "./store-json.mjs";
const DIRECTORY = "gate-waits";
const WAIT_REQUEST_TTL_MS = 30 * 6e4;
function gateWaitDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}
function requestFile(directory, sessionId) {
  return path.join(directory, `${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32)}.json`);
}
const ASKED_GATES_FILE = "asked-approval-gates.json";
async function removeExpired(directory, now) {
  for (const name of await readdir(directory).catch(() => [])) {
    if (name.startsWith(ASKED_GATES_FILE)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > WAIT_REQUEST_TTL_MS) await rm(file, { force: true });
  }
}
async function recordWaitRequest({ sessionId, projectRoot, initiative, artifact, scope, gateIds, maxWaitMinutes, knownEntries, coordinates = false, waitId, directory = gateWaitDirectory(), now = Date.now() }) {
  await mkdir(directory, { recursive: true });
  await removeExpired(directory, now);
  const file = requestFile(directory, sessionId);
  const replaced = await readFile(file, "utf8").then((text) => parseStoreJson(text), () => null).catch(() => null);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const source = artifact ? { artifact, ...scope === void 0 ? {} : { scope } } : { initiative, ...Array.isArray(knownEntries) ? { knownEntries } : {}, coordinates: coordinates === true, ...typeof waitId === "string" ? { waitId } : {} };
  await writeFile(temporary, `${JSON.stringify({ sessionId, projectRoot, ...source, gateIds, maxWaitMinutes, requestedAt: new Date(now).toISOString() })}
`);
  await rename(temporary, file);
  return { replaced: typeof replaced?.waitId === "string" && typeof replaced.initiative === "string" && typeof replaced.projectRoot === "string" ? { waitId: replaced.waitId, initiative: replaced.initiative, projectRoot: replaced.projectRoot } : null };
}
async function takeWaitRequest({ sessionId, directory = gateWaitDirectory(), now = Date.now() }) {
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
export {
  ASKED_GATES_FILE,
  WAIT_REQUEST_TTL_MS,
  gateWaitDirectory,
  recordWaitRequest,
  takeWaitRequest
};
