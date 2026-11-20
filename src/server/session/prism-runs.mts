import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { EFFORT_PATTERN, hostAvailability, hostDefinition, MODEL_PATTERN, PROVIDER_PATTERN } from "./launch-hosts.mjs";

// The host and model of Prism's own runs on this computer, such as the runs that move records to a new format: one choice per
// computer, kept in the review app folder because a host must be installed and signed in where it runs, and read by the code
// that starts those runs through prismRunLaunch, and for a format migration run through migrationRunHost. The choice is { host, provider, model, effort, typed, at, by },
// where host is a supported host or AUTOMATIC, which chooses no host and no model, so a migration run then starts as with no choice, with Codex and gpt-6-luna
// where Codex lists it and otherwise on the first host found with a small model; a file that is missing reads as no choice, and a file
// that cannot be read, or holds a value that breaks a name rule, reads as unreadable and is never passed on.

export const PRISM_RUNS_FILE = "prism-runs.json";
/** The host value that chooses no host and no model, so each run starts as with no stored choice. */
export const AUTOMATIC = "automatic";
export const AUTOMATIC_LABEL = "Any available host";
/** A choice of the host default for the provider, the model, and the effort. */
export const DEFAULT_RUN = Object.freeze({ provider: null, model: null, effort: null, typed: false });

const MAX_BYTES = 64 * 1024;
const BY_MAX = 200;
// The revision of a choice that was never stored.
const NO_CHOICE = "none";
const LOCK_TIMEOUT_MS = 5000;

const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const nameOrNull = (value: any, pattern: any) => value === null || (typeof value === "string" && pattern.test(value));

/** The stored choice's file: prism-runs.json in the review app folder. */
export function prismRunsFile(env = process.env) {
  return path.join(reviewAppDirectory(env), PRISM_RUNS_FILE);
}

export class PrismRunsError extends Error {
  declare code: any;
  constructor(code: any, message: any) {
    super(message);
    this.name = "PrismRunsError";
    this.code = code;
  }
}

// A stored value as a choice, or null when any part breaks its rule: a supported host or AUTOMATIC, each name null or keeping its
// rule, typed true only beside a model, and AUTOMATIC only with the host defaults.
function storedChoice(value: any) {
  if (!isRecord(value)) return null;
  const { host, provider = null, model = null, effort = null, typed = false } = value;
  if (host !== AUTOMATIC && !hostDefinition(host)) return null;
  if (!nameOrNull(provider, PROVIDER_PATTERN) || !nameOrNull(model, MODEL_PATTERN) || !nameOrNull(effort, EFFORT_PATTERN) || typeof typed !== "boolean") return null;
  if (typed && model === null) return null;
  if (host === AUTOMATIC && (provider !== null || model !== null || effort !== null)) return null;
  return { host, provider, model, effort, typed };
}

/**
 * The stored choice: { state, choice, revision }, state being `none` for no stored choice, `chosen`, or `unreadable`; choice is the
 * stored { host, provider, model, effort, typed } only when chosen, and revision follows the file's bytes.
 */
export async function readPrismRunsChoice(env = process.env): Promise<{ state: string; choice: any; revision: string }> {
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

/**
 * Stores a choice under the file's lock, after checking that the file still has the revision the change was made against; a
 * stale revision throws a PrismRunsError stale_revision and stores nothing. Answers the stored record.
 */
export async function writePrismRunsChoice({ choice, by, revision, env = process.env, now = new Date() }: any) {
  const checked = storedChoice(choice);
  if (!checked) throw new PrismRunsError("invalid_choice", "The choice for Prism's own runs breaks a name rule.");
  const file = prismRunsFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const makeError = (code: any, message: any) => new PrismRunsError(code, message);
  return withFileLock(file, async () => {
    const current = await readPrismRunsChoice(env);
    if (current.revision !== revision) throw new PrismRunsError("stale_revision", "The choice changed since the page read it.");
    // Prism replaces only a regular file, so a link or a folder in its place is left alone and named.
    const info = await lstat(file).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (info && (info.isSymbolicLink() || !info.isFile())) throw new PrismRunsError("not_a_file", `${file} is not a regular file, so Prism cannot store the choice there; remove it and apply the choice again.`);
    const record = { ...checked, at: now.toISOString(), by: String(by ?? "").replace(/\s+/g, " ").trim().slice(0, BY_MAX) };
    await writeAtomically(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(file, 0o600);
    return record;
  }, makeError, { timeoutMs: LOCK_TIMEOUT_MS });
}

// The part of a host's availability reason after "<Label> was not found: ", without its closing period.
function whyMissing(availability: any) {
  const reason = availability.reason ?? "";
  const prefix = `${availability.label} was not found: `;
  return (reason.startsWith(prefix) ? reason.slice(prefix.length) : reason).replace(/\.+$/, "") || "it is not installed";
}

/**
 * The host and coordinator choice that a run of Prism's own starts with on this computer: { host, coordinator: { provider, model,
 * effort, typed }, reason }, or null when no supported host is found. A stored choice whose host is found answers it with reason
 * null; no choice, or AUTOMATIC, answers the first host found with the host defaults, which a format migration run does not use, since
 * migrationRunHost then chooses Codex with gpt-6-luna where Codex lists it or the first host found with a small model; a chosen host that is not found,
 * or a choice that cannot be read, answers the first host found with its defaults and the reason why. checkout is the checkout the run starts in.
 */
export async function prismRunLaunch({ checkout = null, env = process.env }: { checkout?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  void checkout;
  const [stored, hosts] = await Promise.all([readPrismRunsChoice(env), hostAvailability({ env })]);
  const first = hosts.find((item) => item.available) ?? null;
  if (!first) return null;
  const fallback = (reason: any) => ({ host: first.host, coordinator: { ...DEFAULT_RUN }, reason });
  if (stored.state === "unreadable") return fallback("The choice for Prism's own runs could not be read, so the first available host runs it with its default model.");
  if (stored.state === "none" || stored.choice.host === AUTOMATIC) return fallback(null);
  const { host, provider, model, effort, typed } = stored.choice;
  const chosen = hosts.find((item) => item.host === host);
  if (!chosen?.available) return fallback(`${hostDefinition(host)!.label}, chosen for Prism's own runs, was not found: ${whyMissing(chosen ?? { label: hostDefinition(host)!.label, reason: "" })}. ${first.label} runs it with its default model.`);
  return { host, coordinator: { provider, model, effort, typed }, reason: null };
}
