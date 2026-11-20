// Generated from src/server/session/agent-models.mts by scripts/native-build/compile.mjs.
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
const DIRECTORY = "agent-models";
const AGENT_MODEL_TTL_MS = 24 * 60 * 6e4;
const MODEL_LIMIT = 128;
const isAgentModel = (value) => typeof value === "string" && value.length >= 1 && value.length <= MODEL_LIMIT && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
function agentModelDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}
const noteFile = (directory, holder) => path.join(directory, `${createHash("sha256").update(holder, "utf8").digest("hex").slice(0, 32)}.json`);
async function removeExpired(directory, now) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > AGENT_MODEL_TTL_MS) await rm(file, { force: true }).catch(() => {
    });
  }
}
async function writeAgentModel({ holder, model, directory = agentModelDirectory(), now = Date.now() }) {
  if (typeof holder !== "string" || !holder || !isAgentModel(model)) return false;
  await prepareDirectory(directory);
  await removeExpired(directory, now);
  const file = noteFile(directory, holder);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ model, at: new Date(now).toISOString() })}
`, { mode: 384 });
  await rename(temporary, file);
  return true;
}
async function readAgentModel(holder, { directory = agentModelDirectory(), now = Date.now() } = {}) {
  if (typeof holder !== "string" || !holder) return null;
  try {
    const file = noteFile(directory, holder);
    const info = await stat(file);
    if (now - info.mtimeMs > AGENT_MODEL_TTL_MS) return null;
    const model = parseStoreJson(await readFile(file, "utf8"))?.model;
    return isAgentModel(model) ? model : null;
  } catch {
    return null;
  }
}
export {
  AGENT_MODEL_TTL_MS,
  agentModelDirectory,
  isAgentModel,
  readAgentModel,
  writeAgentModel
};
