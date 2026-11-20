import { createHash, randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { listFormatMigrationRecords, locateRecord, readRecord, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { syncRecordStoreNow } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

// Format migration runs: Prism starts one run by itself for each set of nonconforming requirement files, ADRs, or glossaries of one type in one scope,
// the run's session proposes one format migration per artifact of the set, and finishing the run applies all of them or none, or asks the person once.
// A run is a record of its own under format-migrations/, beside no roadmap entry, initiative, slice, claim, or gate.
// Prism launches each run's session itself, on this machine, as a launched session of the checkout whose prompt is the migrate-artifact skill and the run's id alone.

export const RUN_ID = /^run-[0-9a-f]{16}$/;
export const RUN_STATUSES = Object.freeze(["starting", "running", "waiting-for-host", "asking", "continuing", "applied", "failed"]);
export const OPEN_STATUSES = new Set(["starting", "running", "continuing"]);
const ENDED = new Set(["applied", "failed"]);
const REASON_MAX = 500;
const MIGRATED_TYPES = new Set(["requirements", "adr", "glossary"]);
const ASKED_AGAIN = "The run asked again after the person answered.";
// The lock that serializes the start of runs in a project: a run key that no set's hash names in practice.
const START_LOCK = { kind: "format-migration", id: "run-0000000000000000" };
const LOCAL_SYNC = new Set(["no_upstream", "not_a_repository"]);

export class MigrationRunError extends Error {
  declare code: any;
  // The details a refusal carries, such as its artifacts.
  [key: string]: any;
  constructor(code: any, message: any, details = {}) {
    super(message);
    this.name = "FormatMigrationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code: any, message: any, details?: any) => new MigrationRunError(code, message, details);
const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const labelOf = (scope: any) => scope?.label ?? null;
const runKey = (id: any) => ({ kind: "format-migration", id });
const serialize = (record: any) => `${JSON.stringify(record, null, 2)}\n`;
const sameArtifact = (left: any, right: any) => left.path === right.path && labelOf(left.scope) === labelOf(right.scope);
export const artifactName = (entry: any) => entry.scope === null || entry.scope === undefined ? entry.path : `${entry.path} in scope ${entry.scope.label}`;

// The store's and the record store's own refusals reach the caller as run refusals with the same code, message, and details.
export async function storeRefusing(action: any) {
  try { return await action(); }
  catch (error) {
    if (error?.name === "FormatMigrationError") throw error;
    if (["ArtifactError", "RecordStoreError", "ComponentError", "ArtifactCheckError"].includes(error?.name) && typeof error.code === "string") {
      throw fail(error.code, error.message, Object.fromEntries(["store", "scopes", "path", "component", "components"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])));
    }
    throw error;
  }
}

// ---- Records ----

/**
 * Without a record store, runs live under .prism/format-migrations/ in the checkout, where they are this machine's upkeep and no change of the person's:
 * the folder ignores its own files, so a run never shows in git status beside the artifacts it migrates.
 */
async function checkoutRunFile(root: any, id: any) {
  const located = await locateRecord(root, runKey(id));
  if (!located.target.startsWith(`${path.join(root, ".prism")}${path.sep}`)) return null;
  const folder = path.dirname(located.target);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, ".gitignore"), "# Prism's format migration runs of this checkout, which stay on this machine.\n*\n", { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return located.target;
}

/** A run's record, or null for an id that names none or a record that does not parse. */
export async function readRun(root: any, id: any) {
  if (typeof id !== "string" || !RUN_ID.test(id)) return null;
  const read = await readRecord(root, runKey(id));
  if (read.bytes === null) return null;
  try {
    const record = parseStoreJson(read.bytes.toString("utf8"));
    return wellFormed(record) && record.id === id ? record : null;
  } catch {
    return null;
  }
}

const wellFormed = (record: any) => isRecord(record) && typeof record.id === "string" && RUN_ID.test(record.id) && isRecord(record.set) && Array.isArray(record.set.artifacts) && RUN_STATUSES.includes(record.status);

/** Write a run's record. */
export async function writeRun(root: any, record: any) {
  const file = await checkoutRunFile(root, record.id);
  if (file) await writeAtomically(file, serialize(record));
  else await writeRecord(root, runKey(record.id), serialize(record));
}

/** Run an action under a run's record lock. */
export const withRunLock = (root: any, id: any, action: any) => withRecordLock(root, runKey(id), action, fail);
// Proposals of every run take one shared lock before their own run's, so two runs never both see a target free and both hold it.
const PROPOSAL_LOCK = "run-ffffffffffffffff";
export const withProposalLock = (root: any, action: any) => withRunLock(root, PROPOSAL_LOCK, action);

/** A run that exists, read under its lock by the caller: refused with migration_run_unknown when no run has the id. */
export async function storedRun(root: any, id: any) {
  const record = await storeRefusing(() => readRun(root, id));
  if (!record) throw fail("migration_run_unknown", `No format migration run has the id ${JSON.stringify(String(id ?? ""))}.`, { run: id ?? null });
  return record;
}

/** Every run the project's records hold, in the record store when one is configured, oldest first. */
export async function allRuns(root: any) {
  const found = [];
  for (const { id, bytes } of await listFormatMigrationRecords(root)) {
    if (!RUN_ID.test(id)) continue;
    try {
      const record = parseStoreJson(bytes.toString("utf8"));
      if (wellFormed(record) && record.id === id) found.push(record);
    } catch {
      // A damaged record names no run.
    }
  }
  return found.sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
}

// ---- Sets ----

const setKey = (type: any, scope: any, formatVersion: any) => JSON.stringify([type, labelOf(scope), formatVersion]);

/**
 * The new migration sets among checked artifacts, each { path, scope, type, conforms, earlierFormat, formatVersion, version }:
 * the nonconforming requirement files, ADRs, or glossaries of one type in one scope whose { path, scope, version } no earlier run of that format version holds,
 * as [{ type, scope, formatVersion, artifacts: [{ path, scope, version }], cause }], where cause is format-update when every artifact conforms to an earlier format version.
 * Feature files are never in a set.
 */
export function findMigrationSets(runs: any, checked: any) {
  const held = new Set();
  for (const run of runs) for (const artifact of run.set.artifacts) held.add(JSON.stringify([run.set.type, run.set.formatVersion, artifact.path, labelOf(artifact.scope), artifact.version]));
  const sets = new Map();
  for (const artifact of checked) {
    if (artifact.conforms || !MIGRATED_TYPES.has(artifact.type)) continue;
    if (held.has(JSON.stringify([artifact.type, artifact.formatVersion, artifact.path, labelOf(artifact.scope), artifact.version]))) continue;
    const key = setKey(artifact.type, artifact.scope, artifact.formatVersion);
    if (!sets.has(key)) sets.set(key, { type: artifact.type, scope: artifact.scope, formatVersion: artifact.formatVersion, artifacts: [], earlier: true });
    const set = sets.get(key);
    if (set.artifacts.some((entry: any) => sameArtifact(entry, artifact))) continue;
    set.artifacts.push({ path: artifact.path, scope: artifact.scope, version: artifact.version });
    if (!artifact.earlierFormat) set.earlier = false;
  }
  return [...sets.values()].map(({ earlier, ...set }: any) => ({ ...set, artifacts: set.artifacts.sort((left: any, right: any) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), cause: earlier ? "format-update" : "findings" }));
}

// A run's id is the hash of its set, so two machines that start a run of the same set record the same run, and the store's sync keeps the one recorded first.
const runIdOf = (set: any) => `run-${createHash("sha256").update(JSON.stringify([set.type, labelOf(set.scope), set.formatVersion, set.artifacts.map((artifact: any) => [artifact.path, labelOf(artifact.scope), artifact.version])])).digest("hex").slice(0, 16)}`;

// The function that launches a run's session: launcher({ projectRoot, run }) with the run's record.
// A Prism server sets it to launchRunSession when it starts, so a module that only reads runs, such as a test's, launches nothing.
let launcher: any = null;

/** Set the function that launches each run Prism starts, or null to launch none; it runs apart from the start and its failure never reaches it. */
export function setRunLauncher(value: any) {
  launcher = typeof value === "function" ? value : null;
}

// ---- Launching ----

const LAUNCH_ENDED = "The run's session ended before the run finished: ";
// The statuses from which a launch that started its host makes the run running.
const LAUNCHED_FROM = new Set(["starting", "waiting-for-host"]);

/**
 * The host, coordinator choice, and access of a format migration run's session on this machine: { host, coordinator, model, access, reason },
 * with coordinator { provider, model, effort, typed } and model its model. The host and model are the computer's choice for Prism's own runs,
 * as prismRunLaunch reads it for the checkout, with its reason when the chosen host is not found or the choice cannot be read, which the run keeps;
 * without a supported host found there, the first available host of Claude Code and Codex, in that order, with its own default model,
 * and when no host is available, host is null and reason says why for each host.
 * The access is read-only: the session reads artifact text that others wrote, so it gets Prism's tools, file reads, and `git log`, and nothing that writes or runs.
 * This is the only choice of a run's host, model, and access.
 */
export async function migrationRunHost(env: NodeJS.ProcessEnv = process.env, { checkout = null }: { checkout?: string | null } = {}) {
  const { prismRunLaunch } = await import("../session/prism-runs.mjs");
  const chosen = await prismRunLaunch({ checkout, env });
  if (chosen) return { host: chosen.host, coordinator: chosen.coordinator, model: chosen.coordinator.model, access: "read-only", reason: typeof chosen.reason === "string" && chosen.reason ? chosen.reason : null };
  const { hostAvailability, HOST_DEFAULT_COORDINATOR } = await import("../session/launch-hosts.mjs");
  const hosts = await hostAvailability({ env });
  const found = hosts.find((entry: any) => entry.available);
  const coordinator = { ...HOST_DEFAULT_COORDINATOR };
  if (found) return { host: found.host, coordinator, model: null, access: "read-only", reason: null };
  return { host: null, coordinator, model: null, access: "read-only", reason: `No host is available on this machine: ${hosts.map((entry: any) => entry.reason).join(" ")}` };
}

// Record a run's launch, its status, or both, unless the run ended: the status changes only from one of `from`, so a run that asked or failed meanwhile keeps that.
async function recordLaunch(root: any, id: any, { launch, status = null, reason = null, from = LAUNCHED_FROM }: any) {
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || ENDED.has(record.status)) return record;
    const next = { ...record, ...(launch === undefined ? {} : { launch }) };
    if (status !== null && from.has(record.status)) Object.assign(next, { status, reason });
    await writeRun(root, next);
    return next;
  });
}

// Fail an open run, applying nothing, unless a later session of the run took over from the one that names launch.
async function failOpenRun(root: any, id: any, reason: any, { launch = null }: any = {}) {
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || !OPEN_STATUSES.has(record.status)) return record;
    if (launch !== null && record.launch?.id && record.launch.id !== launch) return record;
    const now = new Date().toISOString();
    const next = { ...record, status: "failed", failure: { reason: failureReason(reason), at: now }, endedAt: now, reason: null };
    await writeRun(root, next);
    return next;
  });
}

/**
 * Launch a run's session on this machine at once, without asking anyone, on the host that migrationRunHost chooses, with the migrate-artifact prompt alone:
 * the run becomes running with launch { id, host } once the host started, with the reason why it runs on another host than the one chosen for Prism's runs,
 * or waiting-for-host with the reason when no host is available.
 * A session of the run that already runs here starts no second one. `status` is the status that a started launch records, running for a new run;
 * a continuation keeps continuing. Returns the run's record, or null for an unknown run.
 */
export async function launchMigrationRun(projectRoot: any, id: any, { env = process.env, status = "running" }: any = {}) {
  const root = await realpath(projectRoot);
  const from = status === "running" ? LAUNCHED_FROM : new Set([status]);
  const choice = await migrationRunHost(env, { checkout: root });
  if (!choice.host) return recordLaunch(root, id, { status: "waiting-for-host", reason: choice.reason, from: new Set([...from, "starting"]) });
  const { startMigrationLaunch } = await import("../session/launched-sessions.mjs");
  let started: any;
  try {
    started = await startMigrationLaunch({ projectRoot: root, migrationRun: id, host: choice.host, coordinator: choice.coordinator, access: choice.access, env });
  } catch (error) {
    if (error?.code === "launch_running") return readRun(root, id);
    if (error?.code === "host_unavailable") return recordLaunch(root, id, { status: "waiting-for-host", reason: `No host is available on this machine: ${error.message}`, from: new Set([...from, "starting"]) });
    if (typeof error?.code === "string") return failOpenRun(root, id, `${LAUNCH_ENDED}${error.message}`);
    throw error;
  }
  return recordLaunch(root, id, { launch: { id: started.launch.id, host: choice.host }, status, reason: choice.reason, from });
}

/** The launcher that a Prism server sets: it launches each run Prism starts as launchMigrationRun does. */
export const launchRunSession = ({ projectRoot, run }: any) => launchMigrationRun(projectRoot, run.id);

/**
 * The end of a run's session, by its exit, a host error, or a stop: a run that is still starting, running, or continuing fails with the session's last reason,
 * applying nothing, while a run that asks, waits, or ended keeps its status.
 */
export async function sessionEnded(projectRoot: any, id: any, { launch = null, reason }: any) {
  const root = await realpath(projectRoot);
  return failOpenRun(root, id, `${LAUNCH_ENDED}${reason}`, { launch });
}

/**
 * Continue a run once the person answered its question: the run is continuing, and its session resumes with the same prompt,
 * or a new session starts on an available host when the earlier one cannot be resumed, or the run waits for a host when none is available.
 * Returns { run } as get_migration_run does, refused with migration_run_unknown or, for a run that ended, migration_run_closed.
 */
export async function continueMigrationRun(projectRoot: any, id: any, { env = process.env }: any = {}) {
  const root = await realpath(projectRoot);
  await storedRun(root, id);
  const record = await storeRefusing(() => withRunLock(root, id, async () => {
    const current = await storedRun(root, id);
    if (ENDED.has(current.status)) throw closed(current);
    const next = { ...current, status: "continuing", reason: null, continuingAt: new Date().toISOString() };
    await writeRun(root, next);
    return next;
  }));
  const { resumeLaunch } = await import("../session/launched-sessions.mjs");
  let resumed = false;
  if (record.launch?.id) {
    try {
      await resumeLaunch({ id: record.launch.id, env, cause: "person" });
      resumed = true;
    } catch (error) {
      // A session of the run that still runs keeps the run; any other refusal starts a new session.
      if (error?.code === "launch_running") resumed = true;
      else if (typeof error?.code !== "string") throw error;
    }
  }
  if (!resumed) await launchMigrationRun(root, id, { env, status: "continuing" });
  return { run: await storeRefusing(async () => shownRun(root, await storedRun(root, id))) };
}

/**
 * Run a failed run again: a new run with the cause rerun for the artifacts of the failed run's set that still break their format at their current version,
 * confirmed as a new run is and launched as launchMigrationRun launches it, apart from the call. `by` is who asked, { name, email }.
 * Returns { run } as get_migration_run does. A run that did not fail, or that a rerun already follows, is refused with run_not_failed,
 * and a set whose every artifact now conforms with migration_run_conforming.
 */
export async function rerunMigration(projectRoot: any, id: any, by: any = null, { env = process.env }: any = {}) {
  const root = await realpath(projectRoot);
  const { checkTargets, contentVersion, resolveArtifacts, targetBytes } = await import("./artifact-check.mjs");
  const record = await storeRefusing(() => withRecordLock(root, START_LOCK, async () => {
    const failed = await storedRun(root, id);
    const followed = (await allRuns(root)).some((run) => run.rerunOf === id);
    if (failed.status !== "failed" || followed) {
      throw fail("run_not_failed", `The format migration run ${id} ${failed.status !== "failed" ? `is ${failed.status}, and only a failed run runs again` : "already runs again in a later run"}.`, { run: id, status: failed.status });
    }
    const artifacts = [];
    let formatVersion = failed.set.formatVersion;
    for (const artifact of failed.set.artifacts) {
      const entry = artifact.scope === null || artifact.scope === undefined ? artifact.path : { path: artifact.path, ...scopeInputOf(artifact.scope) };
      let resolved;
      try {
        resolved = await resolveArtifacts({ projectRoot: root, paths: [entry] });
      } catch (error) {
        if (["artifact_missing", "artifact_ambiguous", "artifact_type_unknown"].includes(error?.code)) continue;
        throw error;
      }
      const [checked] = await checkTargets(resolved.root, resolved.store, resolved.targets, { startRuns: false });
      if (!checked || checked.conforms || checked.type !== failed.set.type) continue;
      formatVersion = checked.version;
      artifacts.push({ path: checked.path, scope: checked.scope, version: contentVersion(await targetBytes(resolved.root, resolved.targets[0])) });
    }
    if (!artifacts.length) throw fail("migration_run_conforming", `Every artifact of the format migration run ${id} now conforms to its format, so no run starts again.`, { run: id });
    const now = new Date().toISOString();
    const next = {
      id: `run-${randomBytes(8).toString("hex")}`, set: { type: failed.set.type, scope: failed.set.scope, formatVersion, artifacts }, cause: "rerun", rerunOf: id,
      by: by && typeof by === "object" ? { name: String(by.name ?? ""), email: String(by.email ?? "") } : null,
      status: "starting", startedAt: now, endedAt: null, nonce: randomBytes(8).toString("hex"), migrations: [], question: null, answers: null, result: null, failure: null, nextPoint: 1
    };
    await writeRun(root, next);
    return next;
  }, fail));
  trackLaunches(root, confirmRuns(root, [record], ({ projectRoot: base, run }: any) => launchMigrationRun(base, run.id, { env }))).catch(() => {});
  return { run: await storeRefusing(() => shownRun(root, record)) };
}

const starting = new Map();
// The launches that this process has under way, by project root, so a call on a run on this machine follows the start of its session.
const launching = new Map();

function trackLaunches(root: any, work: any) {
  const next = Promise.allSettled([launching.get(root), work]).then(() => {});
  launching.set(root, next);
  next.finally(() => { if (launching.get(root) === next) launching.delete(root); });
  return work;
}

/** Wait until the sessions that this process is launching for the project's runs have started or failed to start. */
export async function settledRunLaunches(projectRoot: any) {
  await launching.get(projectRoot)?.catch(() => {});
}

/**
 * Start one run for each new set among the checked artifacts: the returned promise settles once the runs are recorded on this machine,
 * and every failure is kept from the caller, since a set that no run holds is started by the next check.
 * The rest happens apart from the task that made the check: with store sync on, each new run is confirmed with the store's remote as a slice claim is,
 * so the run that another machine recorded first wins and an unreachable remote withdraws it, and each confirmed run's session is launched.
 */
export function startMigrationRuns(projectRoot: any, checked: any) {
  const candidates = checked.filter((artifact: any) => !artifact.conforms && MIGRATED_TYPES.has(artifact.type));
  if (!candidates.length) return Promise.resolve([]);
  const previous = starting.get(projectRoot) ?? Promise.resolve();
  const next = previous.then(() => startRuns(projectRoot, candidates)).catch(() => []);
  starting.set(projectRoot, next);
  next.finally(() => { if (starting.get(projectRoot) === next) starting.delete(projectRoot); });
  return next;
}

async function startRuns(projectRoot: any, checked: any) {
  const root = await realpath(projectRoot);
  let waiting: any[] = [];
  let superseded: any[] = [];
  const started = await withRecordLock(root, START_LOCK, async () => {
    let runs = await allRuns(root);
    // An artifact has at most one open run: a run whose artifact has a newer nonconforming version ends, so the new run of its set takes over.
    superseded = await supersedeRuns(root, runs, checked);
    const ended = new Set(superseded.map((run) => run.id));
    runs = (await failOrphanedRuns(root, runs.filter((run) => !ended.has(run.id)))).filter((run) => !ended.has(run.id));
    waiting = runs.filter((run) => run.status === "waiting-for-host");
    const sets = findMigrationSets(runs, checked);
    const written = [];
    for (const set of sets) {
      const id = runIdOf(set);
      if (await readRun(root, id)) continue;
      const record = { id, set, cause: set.cause, status: "starting", startedAt: new Date().toISOString(), endedAt: null, nonce: randomBytes(8).toString("hex"), migrations: [], question: null, answers: null, result: null, failure: null, nextPoint: 1 };
      delete record.set.cause;
      await writeRun(root, record);
      written.push(record);
    }
    return written;
  }, fail);
  for (const run of superseded) if (run.launch?.id) stopRunSession(run.launch.id).catch(() => {});
  if (started.length) trackLaunches(root, confirmRuns(root, started)).catch(() => {});
  if (waiting.length && launcher) trackLaunches(root, relaunchWaiting(root, waiting)).catch(() => {});
  return started;
}

const LIVE_STATUSES = new Set(["starting", "running", "waiting-for-host", "asking", "continuing"]);
const SUPERSEDED = "An artifact of the run changed into a newer version that breaks its format, so a new run migrates that version: ";
// A run that is starting gets this long to launch its session before Prism takes its starter for gone.
const START_LEASE_MS = 5 * 60 * 1000;
const STARTER_GONE = "The run's session never started: the process that started the run ended before it launched the session.";

// End a live run with a reason, applying nothing, unless it ended meanwhile; returns the ended record, or null.
async function endRun(root: any, id: any, reason: any, statuses = LIVE_STATUSES) {
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || !statuses.has(record.status)) return null;
    const now = new Date().toISOString();
    const next = { ...record, status: "failed", failure: { reason: failureReason(reason), at: now }, endedAt: now, reason: null };
    await writeRun(root, next);
    return next;
  });
}

// The live runs that hold an artifact whose current version is another one that breaks the format: each ends, naming the artifacts, and its session stops.
async function supersedeRuns(root: any, runs: any, checked: any) {
  const current = new Map();
  for (const artifact of checked) if (!artifact.conforms && MIGRATED_TYPES.has(artifact.type)) current.set(JSON.stringify([artifact.type, artifact.formatVersion, artifact.path, labelOf(artifact.scope)]), artifact.version);
  const ended = [];
  for (const run of runs) {
    if (!LIVE_STATUSES.has(run.status)) continue;
    const changed = run.set.artifacts.filter((artifact: any) => {
      const version = current.get(JSON.stringify([run.set.type, run.set.formatVersion, artifact.path, labelOf(artifact.scope)]));
      return version !== undefined && version !== artifact.version;
    });
    if (!changed.length) continue;
    const record = await endRun(root, run.id, `${SUPERSEDED}${changed.map(artifactName).join(", ")}.`);
    if (record) ended.push(record);
  }
  return ended;
}

// Each open run whose owner is gone fails, so its set can run again: a session of this machine whose supervision was lost or that ended
// without reporting it, and a run that stayed starting without a launch past its lease. Returns the runs as they now stand.
async function failOrphanedRuns(root: any, runs: any) {
  const { launchEndReason } = await import("../session/launched-sessions.mjs");
  const now = Date.now();
  const standing = [];
  for (const run of runs) {
    let reason = null;
    // A continuation that is resuming its session gets the same lease, since its session's last run ended before the resume starts the next.
    const resuming = run.status === "continuing" && now - Date.parse(run.continuingAt ?? "") <= START_LEASE_MS;
    if (OPEN_STATUSES.has(run.status) && run.launch?.id && !resuming) {
      const ended = await launchEndReason({ id: run.launch.id }).catch(() => null);
      if (ended) reason = `${LAUNCH_ENDED}${ended}`;
    } else if (run.status === "starting" && !run.launch && now - Date.parse(run.startingAt ?? run.startedAt) > START_LEASE_MS) {
      reason = STARTER_GONE;
    }
    const record = reason ? await endRun(root, run.id, reason, reason === STARTER_GONE ? new Set(["starting"]) : OPEN_STATUSES) : null;
    standing.push(record ?? run);
  }
  return standing;
}

// Stop a superseded run's session on this machine, apart from the check; a session elsewhere finds its run ended at its next call.
async function stopRunSession(id: any) {
  const { stopLaunch } = await import("../session/launched-sessions.mjs");
  await stopLaunch({ id });
}

// A check on this machine launches each run that waits for a host: the run is starting again under its lock with a nonce of this claim,
// and with store sync on the claim is confirmed with the store's remote as a new run is, so one machine alone launches it.
async function relaunchWaiting(root: any, waiting: any) {
  const claimed = [];
  for (const run of waiting) {
    const claim = await withRunLock(root, run.id, async () => {
      const current = await readRun(root, run.id);
      if (current?.status !== "waiting-for-host") return null;
      const choice = await migrationRunHost(process.env, { checkout: root });
      if (!choice.host) return null;
      const next = { ...current, status: "starting", reason: null, waitedFor: current.reason ?? null, startingAt: new Date().toISOString(), nonce: randomBytes(8).toString("hex") };
      await writeRun(root, next);
      return next;
    });
    if (claim) claimed.push(claim);
  }
  if (claimed.length) await confirmRuns(root, claimed, launcher, { withdraw: backToWaiting });
}

// A claim that an unreachable remote could not confirm waits for a host again, for the next check.
async function backToWaiting(root: any, record: any) {
  await withRunLock(root, record.id, async () => {
    const current = await readRun(root, record.id);
    if (current?.nonce === record.nonce && current.status === "starting" && !current.launch) await writeRun(root, { ...current, status: "waiting-for-host", reason: record.waitedFor ?? "No host is available on this machine." });
  });
}

// A new run that an unreachable remote could not confirm is withdrawn, and the next check starts its set again.
async function withdrawRun(root: any, record: any) {
  await withRunLock(root, record.id, async () => {
    const current = await readRun(root, record.id);
    if (current?.nonce === record.nonce && current.status === "starting" && !current.migrations.length) await removeRecord(root, runKey(record.id));
  });
}

async function confirmRuns(root: any, started: any, launch = launcher, { withdraw = withdrawRun }: any = {}) {
  const { storeSyncBase } = await import("./store-artifacts.mjs");
  const store = await storeSyncBase(root).catch(() => null);
  let confirmed = started;
  if (store?.sync) {
    const status = await syncRecordStoreNow(store.base);
    if (!LOCAL_SYNC.has(status.state) && status.state !== "ok" && status.state !== "conflicts") {
      // An unreachable remote starts nothing now.
      for (const record of started) await withdraw(root, record);
      return [];
    }
    // A run, or a claim of a waiting run, that another machine recorded first is the one that stands, and this machine launches no second session for it.
    confirmed = [];
    for (const record of started) if ((await readRun(root, record.id))?.nonce === record.nonce) confirmed.push(record);
  }
  if (launch) await Promise.all(confirmed.map((record: any) => Promise.resolve().then(() => launch({ projectRoot: root, run: record })).catch(() => {})));
  return confirmed;
}

/** Wait until the runs that checks of the project started so far are recorded. */
export async function settledRunStarts(projectRoot: any) {
  await starting.get(projectRoot)?.catch(() => {});
}

/**
 * The migration state of each checked artifact: { run, status, reason } of the latest run whose set holds it at its current version, else null,
 * with reason the run's failure or waiting reason and otherwise null; checked holds { path, scope, type, formatVersion, version }.
 */
export function migrationStates(runs: any, checked: any) {
  return checked.map((artifact: any) => {
    const holding = runs.filter((run: any) => run.set.type === artifact.type && run.set.formatVersion === artifact.formatVersion
      && run.set.artifacts.some((entry: any) => sameArtifact(entry, artifact) && entry.version === artifact.version));
    const latest = holding.at(-1);
    if (!latest) return null;
    return { run: latest.id, status: latest.status, reason: latest.failure?.reason ?? (typeof latest.reason === "string" ? latest.reason : null) };
  });
}

// ---- Reading ----

// A migration as a reader gets it, without the content and versions that only applying it needs.
export function shownMigration(migration: any) {
  const { content, versions, sourceStore, targetStore, digest, ...rest } = migration;
  return rest;
}

/** A run as get_migration_run returns it, with each set artifact's current findings, or null where the artifact is gone. */
async function shownRun(root: any, record: any) {
  const { checkArtifacts } = await import("./artifact-check.mjs");
  const artifacts = [];
  for (const artifact of record.set.artifacts) {
    let findings = null;
    try {
      const entry = artifact.scope === null ? artifact.path : { path: artifact.path, ...scopeInputOf(artifact.scope) };
      const checked = await checkArtifacts({ projectRoot: root, paths: [entry], startRuns: false });
      findings = checked.artifacts[0]?.findings ?? null;
    } catch (error) {
      if (!["artifact_missing", "artifact_ambiguous", "artifact_type_unknown"].includes(error?.code)) throw error;
    }
    artifacts.push({ ...artifact, findings });
  }
  return {
    id: record.id, set: { ...record.set, artifacts }, cause: record.cause, status: record.status, startedAt: record.startedAt, endedAt: record.endedAt ?? null, launch: record.launch ?? null,
    migrations: record.migrations.map(shownMigration), question: record.question ?? null, answers: record.answers ?? null, result: record.result ?? null, failure: record.failure ?? null
  };
}

/** The scope input that names a scope object, as get_artifact and check_artifacts take it. */
export const scopeInputOf = (scope: any) => scope === null || scope === undefined ? {} : scope.kind === "component" ? { scope: "component", component: scope.component } : { scope: scope.kind };

function runInput(input: any, name: any, allowed: any) {
  if (!isRecord(input)) throw fail("invalid_input", `${name} takes an object of arguments.`);
  const extra = Object.keys(input).filter((key) => !["projectRoot", ...allowed].includes(key));
  if (extra.length) throw fail("invalid_input", `${name} takes no ${extra.join(", ")}.`);
  if (typeof input.run !== "string" || !input.run) throw fail("invalid_input", "run must be a format migration run's id, run- and 16 hexadecimal digits.");
}

/** A run by id: { run }, refused with migration_run_unknown for an unknown run. */
export async function getMigrationRun(input: any) {
  runInput(input, "get_migration_run", ["run"]);
  const root = await realpath(input.projectRoot);
  const record = await storedRun(root, input.run);
  const shown = await storeRefusing(() => shownRun(root, record));
  // The run's session reads no file of the checkout and runs no Git command, so the run names the configured paths and each source's Git history.
  const config = await readWorkflowConfig(root);
  const { requirements, adrs, glossary, features } = config.paths;
  const artifacts = await Promise.all(shown.set.artifacts.map(async (artifact: any) => ({ ...artifact, history: await artifactHistory(root, artifact) })));
  return { run: { ...shown, set: { ...shown.set, artifacts }, settings: { paths: { requirements, adrs, glossary, features }, store: (config.workspace?.store ?? null) !== null } } };
}

const HISTORY_MAX = 100;

/**
 * The commits that changed an artifact of a run's set in the repository that holds it, the checkout for a checkout file and the record store for a store artifact,
 * as [{ date, subject }], newest first and at most HISTORY_MAX, following renames, or [] where that folder is no Git repository or the file has no history.
 */
async function artifactHistory(root: string, artifact: any) {
  let file: string | null = null;
  try {
    if (artifact.scope === null || artifact.scope === undefined) file = path.join(root, ...String(artifact.path).split("/"));
    else {
      const { storeArtifactFile } = await import("./store-artifacts.mjs");
      file = await storeArtifactFile(root, artifact.path, scopeInputOf(artifact.scope));
    }
  } catch {
    file = null;
  }
  if (!file) return [];
  const { execFile } = await import("node:child_process");
  const output: string = await new Promise((resolve) => {
    execFile("git", ["-C", path.dirname(file!), "log", "--follow", `--max-count=${HISTORY_MAX}`, "--format=%aI%x1f%s", "--", path.basename(file!)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
  return output.split("\n").filter(Boolean).slice(0, HISTORY_MAX).map((line) => {
    const [date, ...subject] = line.split("\u001f");
    return { date, subject: subject.join("\u001f") };
  }).filter((commit) => Number.isFinite(Date.parse(commit.date)));
}

// ---- Status ----

/** Record a run's new status, with reason for a status that waits; an ended run keeps its end. Returns the record, or null for an unknown run. */
export async function setRunStatus(projectRoot: any, id: any, status: any, { reason = null }: any = {}) {
  if (!RUN_STATUSES.includes(status) || ENDED.has(status)) throw new Error(`A run's status is set to one of ${RUN_STATUSES.filter((value) => !ENDED.has(value)).join(", ")} here.`);
  const root = await realpath(projectRoot);
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || ENDED.has(record.status)) return record;
    const next = { ...record, status, reason: reason ?? null };
    await writeRun(root, next);
    return next;
  });
}

const closed = (record: any) => fail("migration_run_closed", `The format migration run ${record.id} is ${record.status}, so it takes no ${record.status === "asking" ? "call until the person answers its question" : "further call"}.`, { run: record.id, status: record.status });

/** Refuse a call on a run that is not starting, running, or continuing. */
export function requireOpen(record: any) {
  if (!OPEN_STATUSES.has(record.status)) throw closed(record);
}

// ---- Finishing ----

/**
 * Finish a run: once every artifact of its set has a proposal, apply all its migrations when every asked point has an answer or none was asked,
 * ask the person once about every asked point when no question was asked yet, and fail the run when it asked once and still holds an unanswered point.
 * A stale source or target, or a target that the write check refuses, fails the run with that reason and applies nothing. Returns { run } as get_migration_run does.
 */
export async function finishMigrationRun(input: any) {
  runInput(input, "finish_migration_run", ["run"]);
  const root = await realpath(input.projectRoot);
  await settledRunLaunches(root);
  await storedRun(root, input.run);
  const record = await storeRefusing(() => withRunLock(root, input.run, async () => {
    const current = await storedRun(root, input.run);
    requireOpen(current);
    const missing = current.set.artifacts.filter((artifact: any) => !current.migrations.some((migration: any) => sameArtifact(migration.source, artifact)));
    if (missing.length) {
      throw fail("migration_run_incomplete", `The format migration run ${current.id} has no proposal yet for ${missing.map(artifactName).join(", ")}: propose a format migration of each artifact of its set before finishing it.`, { run: current.id, artifacts: missing.map(({ path: file, scope }: any) => ({ path: file, scope })) });
    }
    const asked = current.migrations.flatMap((migration: any) => migration.points.filter((point: any) => point.asked !== null).map((point: any) => ({ migration, point })));
    const answers = current.answers ?? {};
    const unanswered = asked.filter(({ point }: any) => !isRecord(answers[point.id]));
    const now = new Date().toISOString();
    let next;
    if (!unanswered.length) {
      const { applyRun } = await import("./format-migrations.mjs");
      try {
        const result = await applyRun(root, current, now);
        next = { ...current, status: "applied", result, endedAt: now, reason: null };
      } catch (error) {
        if (!runFailure(error)) throw error;
        next = { ...current, status: "failed", failure: { reason: failureReason(error.message), at: now }, endedAt: now, reason: null };
      }
    } else if (current.question === null || current.question === undefined) {
      const points = asked.map(({ migration, point }: any) => {
        const { id, kind, settled, asked: question, ...detail } = point;
        return { id, migration: migration.id, artifact: { path: migration.source.path, scope: migration.source.scope }, kind, ...detail, recommendation: question.recommendation };
      });
      next = { ...current, status: "asking", question: { points, askedAt: now }, reason: null };
    } else {
      next = { ...current, status: "failed", failure: { reason: ASKED_AGAIN, at: now }, endedAt: now, reason: null };
    }
    await writeRun(root, next);
    return next;
  }));
  return { run: await storeRefusing(() => shownRun(root, record)) };
}

// The refusals that fail a run rather than the call: a source or target that changed, a target that the write check refuses, and a target that cannot be written.
const RUN_FAILURES = new Set(["migration_stale", "artifact_nonconforming", "version_conflict", "target_unwritable", "invalid_path", "artifact_outside", "artifact_exists", "artifact_not_found"]);
const runFailure = (error: any) => typeof error?.code === "string" && RUN_FAILURES.has(error.code);
const failureReason = (message: any) => {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`;
};

/** Fail a run with a reason of 1 to 500 characters, applying nothing: { run }, refused with migration_run_closed for a run that ended. */
export async function failMigrationRun(input: any) {
  runInput(input, "fail_migration_run", ["run", "reason"]);
  if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.length > REASON_MAX) throw fail("invalid_input", `reason must be plain text of 1 to ${REASON_MAX} characters on why the run fails.`);
  const root = await realpath(input.projectRoot);
  await settledRunLaunches(root);
  await storedRun(root, input.run);
  const record = await storeRefusing(() => withRunLock(root, input.run, async () => {
    const current = await storedRun(root, input.run);
    if (ENDED.has(current.status)) throw closed(current);
    const now = new Date().toISOString();
    const next = { ...current, status: "failed", failure: { reason: input.reason, at: now }, endedAt: now, reason: null };
    await writeRun(root, next);
    return next;
  }));
  return { run: await storeRefusing(() => shownRun(root, record)) };
}

/** The ids of the format migrations whose run applied, and of an earlier Prism's single migrations that applied, whichever checkout applied them. */
export async function appliedMigrationIds(projectRoot: any) {
  const ids = new Set();
  for (const { id, bytes } of await listFormatMigrationRecords(projectRoot)) {
    let record;
    try { record = parseStoreJson(bytes.toString("utf8")); } catch { continue; }
    if (!isRecord(record)) continue;
    if (RUN_ID.test(id)) {
      if (record.status === "applied" && Array.isArray(record.migrations)) for (const migration of record.migrations) if (typeof migration?.id === "string") ids.add(migration.id);
    } else if (typeof record.id === "string" && typeof record.appliedAt === "string") ids.add(record.id);
  }
  return ids;
}
