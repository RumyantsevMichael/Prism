// Generated from src/server/session/prism-runs.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { builtinHost, EFFORT_PATTERN, hostAvailability, MODEL_PATTERN, PROVIDER_PATTERN } from "./launch-hosts.mjs";
const PRISM_RUNS_FILE = "prism-runs.json";
const AUTOMATIC = "automatic";
const AUTOMATIC_LABEL = "Any available host";
const DEFAULT_RUN = Object.freeze({ provider: null, model: null, effort: null, typed: false });
const MAX_BYTES = 64 * 1024;
const BY_MAX = 200;
const NO_CHOICE = "none";
const LOCK_TIMEOUT_MS = 5e3;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nameOrNull = (value, pattern) => value === null || typeof value === "string" && pattern.test(value);
function prismRunsFile(env = process.env) {
  return path.join(reviewAppDirectory(env), PRISM_RUNS_FILE);
}
class PrismRunsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrismRunsError";
    this.code = code;
  }
}
function storedChoice(value) {
  if (!isRecord(value)) return null;
  const { host, provider = null, model = null, effort = null, typed = false } = value;
  if (host !== AUTOMATIC && !builtinHost(host)) return null;
  if (!nameOrNull(provider, PROVIDER_PATTERN) || !nameOrNull(model, MODEL_PATTERN) || !nameOrNull(effort, EFFORT_PATTERN) || typeof typed !== "boolean") return null;
  if (typed && model === null) return null;
  if (host === AUTOMATIC && (provider !== null || model !== null || effort !== null)) return null;
  return { host, provider, model, effort, typed };
}
async function readPrismRunsChoice(env = process.env) {
  const file = prismRunsFile(env);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "none", choice: null, revision: NO_CHOICE };
    return { state: "unreadable", choice: null, revision: `unreadable-${error.code ?? "error"}` };
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) return { state: "unreadable", choice: null, revision: `unreadable-${info.size}-${info.mtimeMs}` };
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    return { state: "unreadable", choice: null, revision: `unreadable-${error.code ?? "error"}` };
  }
  const revision = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  let parsed;
  try {
    parsed = parseStoreJson(bytes.toString("utf8"));
  } catch {
    return { state: "unreadable", choice: null, revision };
  }
  const choice = storedChoice(parsed);
  return choice ? { state: "chosen", choice, revision } : { state: "unreadable", choice: null, revision };
}
async function writePrismRunsChoice({ choice, by, revision, env = process.env, now = /* @__PURE__ */ new Date() }) {
  const checked = storedChoice(choice);
  if (!checked) throw new PrismRunsError("invalid_choice", "The choice for Prism's own runs breaks a name rule.");
  const file = prismRunsFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  const makeError = (code, message) => new PrismRunsError(code, message);
  return withFileLock(file, async () => {
    const current = await readPrismRunsChoice(env);
    if (current.revision !== revision) throw new PrismRunsError("stale_revision", "The choice changed since the page read it.");
    const info = await lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info && (info.isSymbolicLink() || !info.isFile())) throw new PrismRunsError("not_a_file", `${file} is not a regular file, so Prism cannot store the choice there; remove it and apply the choice again.`);
    const record = { ...checked, at: now.toISOString(), by: String(by ?? "").replace(/\s+/g, " ").trim().slice(0, BY_MAX) };
    await writeAtomically(file, `${JSON.stringify(record, null, 2)}
`, { mode: 384 });
    if (process.platform !== "win32") await chmod(file, 384);
    return record;
  }, makeError, { timeoutMs: LOCK_TIMEOUT_MS });
}
function whyMissing(availability) {
  const reason = availability.reason ?? "";
  const prefix = `${availability.label} was not found: `;
  return (reason.startsWith(prefix) ? reason.slice(prefix.length) : reason).replace(/\.+$/, "") || "it is not installed";
}
async function prismRunLaunch({ checkout = null, env = process.env } = {}) {
  void checkout;
  const [stored, hosts] = await Promise.all([readPrismRunsChoice(env), hostAvailability({ env, acp: false })]);
  const first = hosts.find((item) => item.available) ?? null;
  if (!first) return null;
  const fallback = (reason) => ({ host: first.host, coordinator: { ...DEFAULT_RUN }, reason });
  if (stored.state === "unreadable") return fallback("The choice for Prism's own runs could not be read, so the first available host runs it with its default model.");
  if (stored.state === "none" || stored.choice.host === AUTOMATIC) return fallback(null);
  const { host, provider, model, effort, typed } = stored.choice;
  const chosen = hosts.find((item) => item.host === host);
  if (!chosen?.available) return fallback(`${builtinHost(host).label}, chosen for Prism's own runs, was not found: ${whyMissing(chosen ?? { label: builtinHost(host).label, reason: "" })}. ${first.label} runs it with its default model.`);
  return { host, coordinator: { provider, model, effort, typed }, reason: null };
}
export {
  AUTOMATIC,
  AUTOMATIC_LABEL,
  DEFAULT_RUN,
  PRISM_RUNS_FILE,
  PrismRunsError,
  prismRunLaunch,
  prismRunsFile,
  readPrismRunsChoice,
  writePrismRunsChoice
};
