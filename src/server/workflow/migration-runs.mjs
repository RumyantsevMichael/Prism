import { createHash, randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { listFormatMigrationRecords, locateRecord, readRecord, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { syncRecordStoreNow } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Format migration runs: Prism starts one run by itself for each set of nonconforming requirement files, ADRs, or glossaries of one type in one scope,
// the run's session proposes one format migration per artifact of the set, and finishing the run applies all of them or none, or asks the person once.
// A run is a record of its own under format-migrations/, beside no roadmap entry, initiative, slice, claim, or gate.

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
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FormatMigrationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new MigrationRunError(code, message, details);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const labelOf = (scope) => scope?.label ?? null;
const runKey = (id) => ({ kind: "format-migration", id });
const serialize = (record) => `${JSON.stringify(record, null, 2)}\n`;
const sameArtifact = (left, right) => left.path === right.path && labelOf(left.scope) === labelOf(right.scope);
export const artifactName = (entry) => entry.scope === null || entry.scope === undefined ? entry.path : `${entry.path} in scope ${entry.scope.label}`;

// The store's and the record store's own refusals reach the caller as run refusals with the same code, message, and details.
export async function storeRefusing(action) {
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
async function checkoutRunFile(root, id) {
  const located = await locateRecord(root, runKey(id));
  if (!located.target.startsWith(`${path.join(root, ".prism")}${path.sep}`)) return null;
  const folder = path.dirname(located.target);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, ".gitignore"), "# Prism's format migration runs of this checkout, which stay on this machine.\n*\n", { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return located.target;
}

/** A run's record, or null for an id that names none or a record that does not parse. */
export async function readRun(root, id) {
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

const wellFormed = (record) => isRecord(record) && typeof record.id === "string" && RUN_ID.test(record.id) && isRecord(record.set) && Array.isArray(record.set.artifacts) && RUN_STATUSES.includes(record.status);

/** Write a run's record. */
export async function writeRun(root, record) {
  const file = await checkoutRunFile(root, record.id);
  if (file) await writeAtomically(file, serialize(record));
  else await writeRecord(root, runKey(record.id), serialize(record));
}

/** Run an action under a run's record lock. */
export const withRunLock = (root, id, action) => withRecordLock(root, runKey(id), action, fail);

/** A run that exists, read under its lock by the caller: refused with migration_run_unknown when no run has the id. */
export async function storedRun(root, id) {
  const record = await storeRefusing(() => readRun(root, id));
  if (!record) throw fail("migration_run_unknown", `No format migration run has the id ${JSON.stringify(String(id ?? ""))}.`, { run: id ?? null });
  return record;
}

/** Every run the project's records hold, in the record store when one is configured, oldest first. */
export async function allRuns(root) {
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

const setKey = (type, scope, formatVersion) => JSON.stringify([type, labelOf(scope), formatVersion]);

/**
 * The new migration sets among checked artifacts, each { path, scope, type, conforms, earlierFormat, formatVersion, version }:
 * the nonconforming requirement files, ADRs, or glossaries of one type in one scope whose { path, scope, version } no earlier run of that format version holds,
 * as [{ type, scope, formatVersion, artifacts: [{ path, scope, version }], cause }], where cause is format-update when every artifact conforms to an earlier format version.
 * Feature files are never in a set.
 */
export function findMigrationSets(runs, checked) {
  const held = new Set();
  for (const run of runs) for (const artifact of run.set.artifacts) held.add(JSON.stringify([run.set.type, run.set.formatVersion, artifact.path, labelOf(artifact.scope), artifact.version]));
  const sets = new Map();
  for (const artifact of checked) {
    if (artifact.conforms || !MIGRATED_TYPES.has(artifact.type)) continue;
    if (held.has(JSON.stringify([artifact.type, artifact.formatVersion, artifact.path, labelOf(artifact.scope), artifact.version]))) continue;
    const key = setKey(artifact.type, artifact.scope, artifact.formatVersion);
    if (!sets.has(key)) sets.set(key, { type: artifact.type, scope: artifact.scope, formatVersion: artifact.formatVersion, artifacts: [], earlier: true });
    const set = sets.get(key);
    if (set.artifacts.some((entry) => sameArtifact(entry, artifact))) continue;
    set.artifacts.push({ path: artifact.path, scope: artifact.scope, version: artifact.version });
    if (!artifact.earlierFormat) set.earlier = false;
  }
  return [...sets.values()].map(({ earlier, ...set }) => ({ ...set, artifacts: set.artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), cause: earlier ? "format-update" : "findings" }));
}

// A run's id is the hash of its set, so two machines that start a run of the same set record the same run, and the store's sync keeps the one recorded first.
const runIdOf = (set) => `run-${createHash("sha256").update(JSON.stringify([set.type, labelOf(set.scope), set.formatVersion, set.artifacts.map((artifact) => [artifact.path, labelOf(artifact.scope), artifact.version])])).digest("hex").slice(0, 16)}`;

// The function that launches a run's session, which the launch of runs on a host sets: launcher({ projectRoot, run }) with the run's record.
let launcher = null;

/** Set the function that launches each run Prism starts, or null to launch none; it runs apart from the start and its failure never reaches it. */
export function setRunLauncher(value) {
  launcher = typeof value === "function" ? value : null;
}

const starting = new Map();

/**
 * Start one run for each new set among the checked artifacts: the returned promise settles once the runs are recorded on this machine,
 * and every failure is kept from the caller, since a set that no run holds is started by the next check.
 * The rest happens apart from the task that made the check: with store sync on, each new run is confirmed with the store's remote as a slice claim is,
 * so the run that another machine recorded first wins and an unreachable remote withdraws it, and each confirmed run's session is launched.
 */
export function startMigrationRuns(projectRoot, checked) {
  const candidates = checked.filter((artifact) => !artifact.conforms && MIGRATED_TYPES.has(artifact.type));
  if (!candidates.length) return Promise.resolve([]);
  const previous = starting.get(projectRoot) ?? Promise.resolve();
  const next = previous.then(() => startRuns(projectRoot, candidates)).catch(() => []);
  starting.set(projectRoot, next);
  next.finally(() => { if (starting.get(projectRoot) === next) starting.delete(projectRoot); });
  return next;
}

async function startRuns(projectRoot, checked) {
  const root = await realpath(projectRoot);
  const started = await withRecordLock(root, START_LOCK, async () => {
    const sets = findMigrationSets(await allRuns(root), checked);
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
  if (started.length) confirmRuns(root, started).catch(() => {});
  return started;
}

async function confirmRuns(root, started) {
  const { storeSyncBase } = await import("./store-artifacts.mjs");
  const store = await storeSyncBase(root).catch(() => null);
  let confirmed = started;
  if (store?.sync) {
    const status = await syncRecordStoreNow(store.base);
    if (!LOCAL_SYNC.has(status.state) && status.state !== "ok" && status.state !== "conflicts") {
      // An unreachable remote starts nothing now: each run this start wrote is withdrawn, and the next check starts its set again.
      for (const record of started) {
        await withRunLock(root, record.id, async () => {
          const current = await readRun(root, record.id);
          if (current?.nonce === record.nonce && current.status === "starting" && !current.migrations.length) await removeRecord(root, runKey(record.id));
        });
      }
      return [];
    }
    // A run of the same set that another machine recorded first is the one that stands, and this machine launches no second session for it.
    confirmed = [];
    for (const record of started) if ((await readRun(root, record.id))?.nonce === record.nonce) confirmed.push(record);
  }
  for (const record of confirmed) {
    if (!launcher) continue;
    Promise.resolve().then(() => launcher({ projectRoot: root, run: record })).catch(() => {});
  }
  return confirmed;
}

/** Wait until the runs that checks of the project started so far are recorded. */
export async function settledRunStarts(projectRoot) {
  await starting.get(projectRoot)?.catch(() => {});
}

/**
 * The migration state of each checked artifact: { run, status, reason } of the latest run whose set holds it at its current version, else null,
 * with reason the run's failure or waiting reason and otherwise null; checked holds { path, scope, type, formatVersion, version }.
 */
export function migrationStates(runs, checked) {
  return checked.map((artifact) => {
    const holding = runs.filter((run) => run.set.type === artifact.type && run.set.formatVersion === artifact.formatVersion
      && run.set.artifacts.some((entry) => sameArtifact(entry, artifact) && entry.version === artifact.version));
    const latest = holding.at(-1);
    if (!latest) return null;
    return { run: latest.id, status: latest.status, reason: latest.failure?.reason ?? (typeof latest.reason === "string" ? latest.reason : null) };
  });
}

// ---- Reading ----

// A migration as a reader gets it, without the content and versions that only applying it needs.
export function shownMigration(migration) {
  const { content, versions, sourceStore, targetStore, digest, ...rest } = migration;
  return rest;
}

/** A run as get_migration_run returns it, with each set artifact's current findings, or null where the artifact is gone. */
async function shownRun(root, record) {
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
    id: record.id, set: { ...record.set, artifacts }, cause: record.cause, status: record.status, startedAt: record.startedAt, endedAt: record.endedAt ?? null,
    migrations: record.migrations.map(shownMigration), question: record.question ?? null, answers: record.answers ?? null, result: record.result ?? null, failure: record.failure ?? null
  };
}

/** The scope input that names a scope object, as get_artifact and check_artifacts take it. */
export const scopeInputOf = (scope) => scope === null || scope === undefined ? {} : scope.kind === "component" ? { scope: "component", component: scope.component } : { scope: scope.kind };

function runInput(input, name, allowed) {
  if (!isRecord(input)) throw fail("invalid_input", `${name} takes an object of arguments.`);
  const extra = Object.keys(input).filter((key) => !["projectRoot", ...allowed].includes(key));
  if (extra.length) throw fail("invalid_input", `${name} takes no ${extra.join(", ")}.`);
  if (typeof input.run !== "string" || !input.run) throw fail("invalid_input", "run must be a format migration run's id, run- and 16 hexadecimal digits.");
}

/** A run by id: { run }, refused with migration_run_unknown for an unknown run. */
export async function getMigrationRun(input) {
  runInput(input, "get_migration_run", ["run"]);
  const root = await realpath(input.projectRoot);
  const record = await storedRun(root, input.run);
  return { run: await storeRefusing(() => shownRun(root, record)) };
}

// ---- Status ----

/** Record a run's new status, with reason for a status that waits; an ended run keeps its end. Returns the record, or null for an unknown run. */
export async function setRunStatus(projectRoot, id, status, { reason = null } = {}) {
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

const closed = (record) => fail("migration_run_closed", `The format migration run ${record.id} is ${record.status}, so it takes no ${record.status === "asking" ? "call until the person answers its question" : "further call"}.`, { run: record.id, status: record.status });

/** Refuse a call on a run that is not starting, running, or continuing. */
export function requireOpen(record) {
  if (!OPEN_STATUSES.has(record.status)) throw closed(record);
}

// ---- Finishing ----

/**
 * Finish a run: once every artifact of its set has a proposal, apply all its migrations when every asked point has an answer or none was asked,
 * ask the person once about every asked point when no question was asked yet, and fail the run when it asked once and still holds an unanswered point.
 * A stale source or target, or a target that the write check refuses, fails the run with that reason and applies nothing. Returns { run } as get_migration_run does.
 */
export async function finishMigrationRun(input) {
  runInput(input, "finish_migration_run", ["run"]);
  const root = await realpath(input.projectRoot);
  await storedRun(root, input.run);
  const record = await storeRefusing(() => withRunLock(root, input.run, async () => {
    const current = await storedRun(root, input.run);
    requireOpen(current);
    const missing = current.set.artifacts.filter((artifact) => !current.migrations.some((migration) => sameArtifact(migration.source, artifact)));
    if (missing.length) {
      throw fail("migration_run_incomplete", `The format migration run ${current.id} has no proposal yet for ${missing.map(artifactName).join(", ")}: propose a format migration of each artifact of its set before finishing it.`, { run: current.id, artifacts: missing.map(({ path: file, scope }) => ({ path: file, scope })) });
    }
    const asked = current.migrations.flatMap((migration) => migration.points.filter((point) => point.asked !== null).map((point) => ({ migration, point })));
    const answers = current.answers ?? {};
    const unanswered = asked.filter(({ point }) => !isRecord(answers[point.id]));
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
      const points = asked.map(({ migration, point }) => {
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
const runFailure = (error) => typeof error?.code === "string" && RUN_FAILURES.has(error.code);
const failureReason = (message) => {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`;
};

/** Fail a run with a reason of 1 to 500 characters, applying nothing: { run }, refused with migration_run_closed for a run that ended. */
export async function failMigrationRun(input) {
  runInput(input, "fail_migration_run", ["run", "reason"]);
  if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.length > REASON_MAX) throw fail("invalid_input", `reason must be plain text of 1 to ${REASON_MAX} characters on why the run fails.`);
  const root = await realpath(input.projectRoot);
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
export async function appliedMigrationIds(projectRoot) {
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
