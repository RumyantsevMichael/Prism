import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";

// The model of each host session's main agent, as its session-facts hook last observed it, keyed by the session's claim holder.
// The notes live in Prism's private review app folder, never in the record store, and a claim that a main agent's call takes or renews copies the model from here.
const DIRECTORY = "agent-models";
export const AGENT_MODEL_TTL_MS = 24 * 60 * 60000;
const MODEL_LIMIT = 128;

/** Whether a value is a model a claim may record: a string of 1 to 128 characters with no control character. */
export const isAgentModel = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= MODEL_LIMIT && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

export function agentModelDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), DIRECTORY);
}

const noteFile = (directory: string, holder: string) => path.join(directory, `${createHash("sha256").update(holder, "utf8").digest("hex").slice(0, 32)}.json`);

async function removeExpired(directory: string, now: number) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > AGENT_MODEL_TTL_MS) await rm(file, { force: true }).catch(() => {});
  }
}

/** Write the main agent's model for one session's claim holder; a missing holder or a malformed model writes nothing. */
export async function writeAgentModel({ holder, model, directory = agentModelDirectory(), now = Date.now() }: { holder: unknown; model: unknown; directory?: string; now?: number }) {
  if (typeof holder !== "string" || !holder || !isAgentModel(model)) return false;
  await prepareDirectory(directory);
  await removeExpired(directory, now);
  const file = noteFile(directory, holder);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ model, at: new Date(now).toISOString() })}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

/** The main agent's model for one session's claim holder, or null without a note younger than 24 hours. */
export async function readAgentModel(holder: unknown, { directory = agentModelDirectory(), now = Date.now() }: { directory?: string; now?: number } = {}): Promise<string | null> {
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
