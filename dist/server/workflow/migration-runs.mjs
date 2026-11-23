// Generated from src/server/workflow/migration-runs.mts by scripts/native-build/compile.mjs.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { listFormatMigrationRecords, locateRecord, readRecord, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { syncRecordStoreNow } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
const RUN_ID = /^run-[0-9a-f]{16}$/;
const RUN_STATUSES = Object.freeze(["starting", "running", "waiting-for-host", "asking", "continuing", "applied", "failed"]);
const OPEN_STATUSES = /* @__PURE__ */ new Set(["starting", "running", "continuing"]);
const ENDED = /* @__PURE__ */ new Set(["applied", "failed"]);
const REASON_MAX = 500;
const MIGRATED_TYPES = /* @__PURE__ */ new Set(["requirements", "adr", "glossary"]);
const ASKED_AGAIN = "The run asked again after the person answered.";
const START_LOCK = { kind: "format-migration", id: "run-0000000000000000" };
const LOCAL_SYNC = /* @__PURE__ */ new Set(["no_upstream", "not_a_repository"]);
class MigrationRunError extends Error {
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
const serialize = (record) => `${JSON.stringify(record, null, 2)}
`;
const sameArtifact = (left, right) => left.path === right.path && labelOf(left.scope) === labelOf(right.scope);
const artifactName = (entry) => entry.scope === null || entry.scope === void 0 ? entry.path : `${entry.path} in scope ${entry.scope.label}`;
async function storeRefusing(action) {
  try {
    return await action();
  } catch (error) {
    if (error?.name === "FormatMigrationError") throw error;
    if (["ArtifactError", "RecordStoreError", "ComponentError", "ArtifactCheckError"].includes(error?.name) && typeof error.code === "string") {
      throw fail(error.code, error.message, Object.fromEntries(["store", "scopes", "path", "component", "components"].filter((key) => error[key] !== void 0).map((key) => [key, error[key]])));
    }
    throw error;
  }
}
async function checkoutRunFile(root, id) {
  const located = await locateRecord(root, runKey(id));
  if (!located.target.startsWith(`${path.join(root, ".prism")}${path.sep}`)) return null;
  const folder = path.dirname(located.target);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, ".gitignore"), "# Prism's format migration runs of this checkout, which stay on this machine.\n*\n", { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return located.target;
}
async function readRun(root, id) {
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
async function writeRun(root, record) {
  const file = await checkoutRunFile(root, record.id);
  if (file) await writeAtomically(file, serialize(record));
  else await writeRecord(root, runKey(record.id), serialize(record));
}
const withRunLock = (root, id, action) => withRecordLock(root, runKey(id), action, fail);
const PROPOSAL_LOCK = "run-ffffffffffffffff";
const withProposalLock = (root, action) => withRunLock(root, PROPOSAL_LOCK, action);
async function storedRun(root, id) {
  const record = await storeRefusing(() => readRun(root, id));
  if (!record) throw fail("migration_run_unknown", `No format migration run has the id ${JSON.stringify(String(id ?? ""))}.`, { run: id ?? null });
  return record;
}
async function allRuns(root) {
  const found = [];
  for (const { id, bytes } of await listFormatMigrationRecords(root)) {
    if (!RUN_ID.test(id)) continue;
    try {
      const record = parseStoreJson(bytes.toString("utf8"));
      if (wellFormed(record) && record.id === id) found.push(record);
    } catch {
    }
  }
  return found.sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
}
const setKey = (type, scope, formatVersion) => JSON.stringify([type, labelOf(scope), formatVersion]);
function findMigrationSets(runs, checked) {
  const held = /* @__PURE__ */ new Set();
  for (const run of runs) for (const artifact of run.set.artifacts) held.add(JSON.stringify([run.set.type, run.set.formatVersion, artifact.path, labelOf(artifact.scope), artifact.version]));
  const sets = /* @__PURE__ */ new Map();
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
const runIdOf = (set) => `run-${createHash("sha256").update(JSON.stringify([set.type, labelOf(set.scope), set.formatVersion, set.artifacts.map((artifact) => [artifact.path, labelOf(artifact.scope), artifact.version])])).digest("hex").slice(0, 16)}`;
let launcher = null;
function setRunLauncher(value) {
  launcher = typeof value === "function" ? value : null;
}
const LAUNCH_ENDED = "The run's session ended before the run finished: ";
const LAUNCHED_FROM = /* @__PURE__ */ new Set(["starting", "waiting-for-host"]);
async function migrationRunHost(env = process.env, { checkout = null, models = true } = {}) {
  const { prismRunLaunch, readPrismRunsChoice, AUTOMATIC } = await import("../session/prism-runs.mjs");
  const { hostAvailability, HOST_DEFAULT_COORDINATOR } = await import("../session/launch-hosts.mjs");
  const stored = await readPrismRunsChoice(env);
  const unchosen = stored.state === "none" || stored.state === "chosen" && stored.choice?.host === AUTOMATIC;
  const run = (host, model, reason = null, coordinator = { ...HOST_DEFAULT_COORDINATOR, model }) => ({ host, coordinator, model: coordinator.model, access: "read-only", reason });
  if (!unchosen) {
    const chosen = await prismRunLaunch({ checkout, env });
    if (chosen) return run(chosen.host, null, typeof chosen.reason === "string" && chosen.reason ? chosen.reason : null, chosen.coordinator);
  }
  const hosts = await hostAvailability({ env });
  const found = hosts.find((entry) => entry.available);
  if (!found) return { host: null, coordinator: { ...HOST_DEFAULT_COORDINATOR }, model: null, access: "read-only", reason: `No host is available on this machine: ${hosts.map((entry) => entry.reason).join(" ")}` };
  const codex = hosts.some((entry) => entry.host === "codex" && entry.available);
  const listed = codex && models ? await codexModels(checkout, env) : [];
  if (listed.includes(DEFAULT_CODEX_MODEL)) return run("codex", DEFAULT_CODEX_MODEL);
  if (found.host === "claude-code") return run("claude-code", CLAUDE_SMALL_MODEL);
  return run(found.host, listed.find((value) => CODEX_SMALL_ENDINGS.some((ending) => value.endsWith(ending))) ?? null);
}
const DEFAULT_CODEX_MODEL = "gpt-6-luna";
const CLAUDE_SMALL_MODEL = "haiku";
const CODEX_SMALL_ENDINGS = Object.freeze(["-luna", "-mini"]);
async function codexModels(checkout, env) {
  const { readRunOptions } = await import("../session/run-options.mjs");
  try {
    const report = await readRunOptions({ host: "codex", purpose: "coordinator", checkout: checkout ?? process.cwd(), env });
    if (report?.state !== "ready" || report.reason) return [];
    const options = report.options.find((option) => option.id === "model");
    return (options?.values ?? []).map((entry) => entry.value).filter((value) => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}
async function recordLaunch(root, id, { launch, status = null, reason = null, from = LAUNCHED_FROM }) {
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || ENDED.has(record.status)) return record;
    const next = { ...record, ...launch === void 0 ? {} : { launch } };
    if (status !== null && from.has(record.status)) Object.assign(next, { status, reason });
    await writeRun(root, next);
    return next;
  });
}
async function failOpenRun(root, id, reason, { launch = null, endedAt = null } = {}) {
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || !OPEN_STATUSES.has(record.status)) return record;
    if (launch !== null && record.launch?.id && record.launch.id !== launch) return record;
    if (typeof endedAt === "string" && typeof record.continuingAt === "string" && Date.parse(record.continuingAt) >= Date.parse(endedAt)) return record;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const next = { ...record, status: "failed", failure: { reason: failureReason(reason), at: now }, endedAt: now, reason: null };
    await writeRun(root, next);
    return next;
  });
}
async function launchMigrationRun(projectRoot, id, { env = process.env, status = "running" } = {}) {
  const root = await realpath(projectRoot);
  const from = status === "running" ? LAUNCHED_FROM : /* @__PURE__ */ new Set([status]);
  const choice = await migrationRunHost(env, { checkout: root });
  if (!choice.host) return recordLaunch(root, id, { status: "waiting-for-host", reason: choice.reason, from: /* @__PURE__ */ new Set([...from, "starting"]) });
  const { startMigrationLaunch } = await import("../session/launched-sessions.mjs");
  let started;
  try {
    started = await startMigrationLaunch({ projectRoot: root, migrationRun: id, host: choice.host, coordinator: choice.coordinator, access: choice.access, env });
  } catch (error) {
    if (error?.code === "launch_running") return readRun(root, id);
    if (error?.code === "host_unavailable") return recordLaunch(root, id, { status: "waiting-for-host", reason: `No host is available on this machine: ${error.message}`, from: /* @__PURE__ */ new Set([...from, "starting"]) });
    if (typeof error?.code === "string") return failOpenRun(root, id, `${LAUNCH_ENDED}${error.message}`);
    throw error;
  }
  return recordLaunch(root, id, { launch: { id: started.launch.id, host: choice.host }, status, reason: choice.reason, from });
}
const launchRunSession = ({ projectRoot, run }) => launchMigrationRun(projectRoot, run.id);
async function sessionEnded(projectRoot, id, { launch = null, reason, endedAt = null }) {
  const root = await realpath(projectRoot);
  return failOpenRun(root, id, `${LAUNCH_ENDED}${reason}`, { launch, endedAt });
}
async function continueMigrationRun(projectRoot, id, { env = process.env } = {}) {
  const root = await realpath(projectRoot);
  await storedRun(root, id);
  const record = await storeRefusing(() => withRunLock(root, id, async () => {
    const current = await storedRun(root, id);
    if (ENDED.has(current.status)) throw closed(current);
    const next = { ...current, status: "continuing", reason: null, continuingAt: (/* @__PURE__ */ new Date()).toISOString() };
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
      if (error?.code === "launch_running") resumed = true;
      else if (typeof error?.code !== "string") throw error;
    }
  }
  if (!resumed) await launchMigrationRun(root, id, { env, status: "continuing" });
  return { run: await storeRefusing(async () => shownRun(root, await storedRun(root, id))) };
}
async function rerunMigration(projectRoot, id, by = null, { env = process.env } = {}) {
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
      const entry = artifact.scope === null || artifact.scope === void 0 ? artifact.path : { path: artifact.path, ...scopeInputOf(artifact.scope) };
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
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const next = {
      id: `run-${randomBytes(8).toString("hex")}`,
      set: { type: failed.set.type, scope: failed.set.scope, formatVersion, artifacts },
      cause: "rerun",
      rerunOf: id,
      by: by && typeof by === "object" ? { name: String(by.name ?? ""), email: String(by.email ?? "") } : null,
      status: "starting",
      startedAt: now,
      endedAt: null,
      nonce: randomBytes(8).toString("hex"),
      migrations: [],
      question: null,
      answers: null,
      result: null,
      failure: null,
      nextPoint: 1
    };
    await writeRun(root, next);
    return next;
  }, fail));
  trackLaunches(root, confirmRuns(root, [record], ({ projectRoot: base, run }) => launchMigrationRun(base, run.id, { env }))).catch(() => {
  });
  return { run: await storeRefusing(() => shownRun(root, record)) };
}
const followedRun = (runs, record) => followingRun(runs, record) !== null;
function followingRun(runs, record) {
  return runs.find((run) => run.id !== record.id && (run.rerunOf === record.id || run.set.type === record.set.type && String(run.startedAt) > String(record.startedAt) && run.set.artifacts.some((artifact) => record.set.artifacts.some((held) => sameArtifact(artifact, held))))) ?? null;
}
async function answerMigrationRun(projectRoot, id, answers, { askedAt = void 0 } = {}) {
  const root = await realpath(projectRoot);
  await storedRun(root, id);
  return storeRefusing(() => withRunLock(root, id, async () => {
    const current = await storedRun(root, id);
    if (current.answers !== null && current.answers !== void 0) throw fail("already_answered", `The format migration run ${id} already has its answers.`, { run: id });
    if (current.status !== "asking" || askedAt !== void 0 && current.question?.askedAt !== askedAt) throw fail("run_not_asking", `The format migration run ${id} is ${current.status}, so it asks nothing to answer.`, { run: id, status: current.status });
    const next = { ...current, answers, status: "continuing", reason: null, continuingAt: (/* @__PURE__ */ new Date()).toISOString() };
    await writeRun(root, next);
    return next;
  }));
}
async function failContinuation(projectRoot, id, reason) {
  const root = await realpath(projectRoot);
  return failOpenRun(root, id, `${CONTINUATION_FAILED}${reason}`);
}
const starting = /* @__PURE__ */ new Map();
const launching = /* @__PURE__ */ new Map();
function trackLaunches(root, work) {
  const next = Promise.allSettled([launching.get(root), work]).then(() => {
  });
  launching.set(root, next);
  next.finally(() => {
    if (launching.get(root) === next) launching.delete(root);
  });
  return work;
}
async function settledRunLaunches(projectRoot) {
  await launching.get(projectRoot)?.catch(() => {
  });
}
function startMigrationRuns(projectRoot, checked) {
  const candidates = checked.filter((artifact) => !artifact.conforms && MIGRATED_TYPES.has(artifact.type));
  if (!candidates.length) return Promise.resolve([]);
  const previous = starting.get(projectRoot) ?? Promise.resolve();
  const next = previous.then(() => startRuns(projectRoot, candidates)).catch(() => []);
  starting.set(projectRoot, next);
  next.finally(() => {
    if (starting.get(projectRoot) === next) starting.delete(projectRoot);
  });
  return next;
}
async function startRuns(projectRoot, checked) {
  const root = await realpath(projectRoot);
  let waiting = [];
  let superseded = [];
  const started = await withRecordLock(root, START_LOCK, async () => {
    let runs = await allRuns(root);
    superseded = await supersedeRuns(root, runs, checked);
    const ended = new Set(superseded.map((run) => run.id));
    runs = (await failOrphanedRuns(root, runs.filter((run) => !ended.has(run.id)))).filter((run) => !ended.has(run.id));
    waiting = runs.filter((run) => run.status === "waiting-for-host");
    const sets = findMigrationSets(runs, checked);
    const written = [];
    for (const set of sets) {
      const id = runIdOf(set);
      if (await readRun(root, id)) continue;
      const record = { id, set, cause: set.cause, status: "starting", startedAt: (/* @__PURE__ */ new Date()).toISOString(), endedAt: null, nonce: randomBytes(8).toString("hex"), migrations: [], question: null, answers: null, result: null, failure: null, nextPoint: 1 };
      delete record.set.cause;
      await writeRun(root, record);
      written.push(record);
    }
    return written;
  }, fail);
  for (const run of superseded) if (run.launch?.id) stopRunSession(run.launch.id).catch(() => {
  });
  if (started.length) trackLaunches(root, confirmRuns(root, started)).catch(() => {
  });
  if (waiting.length && launcher) trackLaunches(root, relaunchWaiting(root, waiting)).catch(() => {
  });
  return started;
}
const LIVE_STATUSES = /* @__PURE__ */ new Set(["starting", "running", "waiting-for-host", "asking", "continuing"]);
const SUPERSEDED = "An artifact of the run changed into a newer version that breaks its format, so a new run migrates that version: ";
const START_LEASE_MS = 5 * 60 * 1e3;
const STARTER_GONE = "The run's session never started: the process that started the run ended before it launched the session.";
const CONTINUATION_FAILED = "The run could not continue after the answer: ";
const CONTINUATION_GONE = `${CONTINUATION_FAILED}the process that recorded the answer ended before it continued the run.`;
async function endRun(root, id, reason, statuses = LIVE_STATUSES) {
  return withRunLock(root, id, async () => {
    const record = await readRun(root, id);
    if (!record || !statuses.has(record.status)) return null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const next = { ...record, status: "failed", failure: { reason: failureReason(reason), at: now }, endedAt: now, reason: null };
    await writeRun(root, next);
    return next;
  });
}
async function supersedeRuns(root, runs, checked) {
  const current = /* @__PURE__ */ new Map();
  for (const artifact of checked) if (!artifact.conforms && MIGRATED_TYPES.has(artifact.type)) current.set(JSON.stringify([artifact.type, artifact.formatVersion, artifact.path, labelOf(artifact.scope)]), artifact.version);
  const ended = [];
  for (const run of runs) {
    if (!LIVE_STATUSES.has(run.status)) continue;
    const changed = run.set.artifacts.filter((artifact) => {
      const version = current.get(JSON.stringify([run.set.type, run.set.formatVersion, artifact.path, labelOf(artifact.scope)]));
      return version !== void 0 && version !== artifact.version;
    });
    if (!changed.length) continue;
    const record = await endRun(root, run.id, `${SUPERSEDED}${changed.map(artifactName).join(", ")}.`);
    if (record) ended.push(record);
  }
  return ended;
}
async function failOrphanedRuns(root, runs) {
  const { launchEndReason } = await import("../session/launched-sessions.mjs");
  const now = Date.now();
  const standing = [];
  for (const run of runs) {
    let reason = null;
    const resuming = run.status === "continuing" && now - Date.parse(run.continuingAt ?? "") <= START_LEASE_MS;
    if (OPEN_STATUSES.has(run.status) && run.launch?.id && !resuming) {
      const ended = await launchEndReason({ id: run.launch.id }).catch(() => null);
      if (ended) reason = `${LAUNCH_ENDED}${ended}`;
    } else if (run.status === "starting" && !run.launch && now - Date.parse(run.startingAt ?? run.startedAt) > START_LEASE_MS) {
      reason = STARTER_GONE;
    } else if (run.status === "continuing" && !run.launch?.id && !resuming) {
      reason = CONTINUATION_GONE;
    }
    const record = reason ? await endRun(root, run.id, reason, reason === STARTER_GONE ? /* @__PURE__ */ new Set(["starting"]) : reason === CONTINUATION_GONE ? /* @__PURE__ */ new Set(["continuing"]) : OPEN_STATUSES) : null;
    standing.push(record ?? run);
  }
  return standing;
}
async function stopRunSession(id) {
  const { stopLaunch } = await import("../session/launched-sessions.mjs");
  await stopLaunch({ id });
}
async function relaunchWaiting(root, waiting) {
  const claimed = [];
  for (const run of waiting) {
    const claim = await withRunLock(root, run.id, async () => {
      const current = await readRun(root, run.id);
      if (current?.status !== "waiting-for-host") return null;
      const choice = await migrationRunHost(process.env, { checkout: root, models: false });
      if (!choice.host) return null;
      const next = { ...current, status: "starting", reason: null, waitedFor: current.reason ?? null, startingAt: (/* @__PURE__ */ new Date()).toISOString(), nonce: randomBytes(8).toString("hex") };
      await writeRun(root, next);
      return next;
    });
    if (claim) claimed.push(claim);
  }
  if (claimed.length) await confirmRuns(root, claimed, launcher, { withdraw: backToWaiting });
}
async function backToWaiting(root, record) {
  await withRunLock(root, record.id, async () => {
    const current = await readRun(root, record.id);
    if (current?.nonce === record.nonce && current.status === "starting" && !current.launch) await writeRun(root, { ...current, status: "waiting-for-host", reason: record.waitedFor ?? "No host is available on this machine." });
  });
}
async function withdrawRun(root, record) {
  await withRunLock(root, record.id, async () => {
    const current = await readRun(root, record.id);
    if (current?.nonce === record.nonce && current.status === "starting" && !current.migrations.length) await removeRecord(root, runKey(record.id));
  });
}
async function confirmRuns(root, started, launch = launcher, { withdraw = withdrawRun } = {}) {
  const { storeSyncBase } = await import("./store-artifacts.mjs");
  const store = await storeSyncBase(root).catch(() => null);
  let confirmed = started;
  if (store?.sync) {
    const status = await syncRecordStoreNow(store.base);
    if (!LOCAL_SYNC.has(status.state) && status.state !== "ok" && status.state !== "conflicts") {
      for (const record of started) await withdraw(root, record);
      return [];
    }
    confirmed = [];
    for (const record of started) if ((await readRun(root, record.id))?.nonce === record.nonce) confirmed.push(record);
  }
  if (launch) await Promise.all(confirmed.map((record) => Promise.resolve().then(() => launch({ projectRoot: root, run: record })).catch(() => {
  })));
  return confirmed;
}
async function settledRunStarts(projectRoot) {
  await starting.get(projectRoot)?.catch(() => {
  });
}
function migrationStates(runs, checked) {
  return checked.map((artifact) => {
    const holding = runs.filter((run) => run.set.type === artifact.type && run.set.formatVersion === artifact.formatVersion && run.set.artifacts.some((entry) => sameArtifact(entry, artifact) && entry.version === artifact.version));
    const latest = holding.at(-1);
    if (!latest) return null;
    return { run: latest.id, status: latest.status, reason: latest.failure?.reason ?? (typeof latest.reason === "string" ? latest.reason : null) };
  });
}
function shownMigration(migration) {
  const { content, sourceText, versions, sourceStore, targetStore, digest, ...rest } = migration;
  return rest;
}
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
    id: record.id,
    set: { ...record.set, artifacts },
    format: await runFormat(record.set.type),
    cause: record.cause,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    launch: record.launch ?? null,
    migrations: record.migrations.map(shownMigration),
    question: record.question ?? null,
    answers: record.answers ?? null,
    result: record.result ?? null,
    failure: record.failure ?? null
  };
}
async function runFormat(type) {
  const { ARTIFACT_FORMATS } = await import("./artifact-formats.mjs");
  const { PLUGIN_ROOT } = await import("../plugin-root.mjs");
  const format = ARTIFACT_FORMATS.find((entry) => entry.type === type);
  if (!format) throw new Error(`No format of the type ${type}.`);
  const content = await readFile(path.join(PLUGIN_ROOT, ...format.reference.split("/")), "utf8");
  return { type: format.type, version: format.version, reference: { path: format.reference, content } };
}
const scopeInputOf = (scope) => scope === null || scope === void 0 ? {} : scope.kind === "component" ? { scope: "component", component: scope.component } : { scope: scope.kind };
function runInput(input, name, allowed) {
  if (!isRecord(input)) throw fail("invalid_input", `${name} takes an object of arguments.`);
  const extra = Object.keys(input).filter((key) => !["projectRoot", ...allowed].includes(key));
  if (extra.length) throw fail("invalid_input", `${name} takes no ${extra.join(", ")}.`);
  if (typeof input.run !== "string" || !input.run) throw fail("invalid_input", "run must be a format migration run's id, run- and 16 hexadecimal digits.");
}
async function getMigrationRun(input) {
  runInput(input, "get_migration_run", ["run"]);
  const root = await realpath(input.projectRoot);
  const record = await storedRun(root, input.run);
  const shown = await storeRefusing(() => shownRun(root, record));
  const config = await readWorkflowConfig(root);
  const { requirements, adrs, glossary, features } = config.paths;
  const artifacts = await Promise.all(shown.set.artifacts.map(async (artifact) => ({ ...artifact, history: await artifactHistory(root, artifact) })));
  return { run: { ...shown, set: { ...shown.set, artifacts }, settings: { paths: { requirements, adrs, glossary, features }, store: (config.workspace?.store ?? null) !== null } } };
}
const HISTORY_MAX = 100;
async function artifactHistory(root, artifact) {
  let file = null;
  try {
    if (artifact.scope === null || artifact.scope === void 0) file = path.join(root, ...String(artifact.path).split("/"));
    else {
      const { storeArtifactFile } = await import("./store-artifacts.mjs");
      file = await storeArtifactFile(root, artifact.path, scopeInputOf(artifact.scope));
    }
  } catch {
    file = null;
  }
  if (!file) return [];
  const { execFile } = await import("node:child_process");
  const output = await new Promise((resolve) => {
    execFile("git", ["-C", path.dirname(file), "log", "--follow", `--max-count=${HISTORY_MAX}`, "--format=%aI%x1f%s", "--", path.basename(file)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
  return output.split("\n").filter(Boolean).slice(0, HISTORY_MAX).map((line) => {
    const [date, ...subject] = line.split("");
    return { date, subject: subject.join("") };
  }).filter((commit) => Number.isFinite(Date.parse(commit.date)));
}
async function setRunStatus(projectRoot, id, status, { reason = null } = {}) {
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
function requireOpen(record) {
  if (!OPEN_STATUSES.has(record.status)) throw closed(record);
}
async function finishMigrationRun(input) {
  runInput(input, "finish_migration_run", ["run"]);
  const root = await realpath(input.projectRoot);
  await settledRunLaunches(root);
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
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
    } else if (current.question === null || current.question === void 0) {
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
const RUN_FAILURES = /* @__PURE__ */ new Set(["migration_stale", "artifact_nonconforming", "version_conflict", "target_unwritable", "invalid_path", "artifact_outside", "artifact_exists", "artifact_not_found"]);
const runFailure = (error) => typeof error?.code === "string" && RUN_FAILURES.has(error.code);
const failureReason = (message) => {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}\u2026`;
};
async function failMigrationRun(input) {
  runInput(input, "fail_migration_run", ["run", "reason"]);
  if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.length > REASON_MAX) throw fail("invalid_input", `reason must be plain text of 1 to ${REASON_MAX} characters on why the run fails.`);
  const root = await realpath(input.projectRoot);
  await settledRunLaunches(root);
  await storedRun(root, input.run);
  const record = await storeRefusing(() => withRunLock(root, input.run, async () => {
    const current = await storedRun(root, input.run);
    if (ENDED.has(current.status)) throw closed(current);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const next = { ...current, status: "failed", failure: { reason: input.reason, at: now }, endedAt: now, reason: null };
    await writeRun(root, next);
    return next;
  }));
  return { run: await storeRefusing(() => shownRun(root, record)) };
}
async function appliedMigrationIds(projectRoot) {
  const ids = /* @__PURE__ */ new Set();
  for (const { id, bytes } of await listFormatMigrationRecords(projectRoot)) {
    let record;
    try {
      record = parseStoreJson(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (RUN_ID.test(id)) {
      if (record.status === "applied" && Array.isArray(record.migrations)) {
        for (const migration of record.migrations) if (typeof migration?.id === "string") ids.add(migration.id);
      }
    } else if (typeof record.id === "string" && typeof record.appliedAt === "string") ids.add(record.id);
  }
  return ids;
}
export {
  CLAUDE_SMALL_MODEL,
  CODEX_SMALL_ENDINGS,
  DEFAULT_CODEX_MODEL,
  MigrationRunError,
  OPEN_STATUSES,
  RUN_ID,
  RUN_STATUSES,
  allRuns,
  answerMigrationRun,
  appliedMigrationIds,
  artifactName,
  continueMigrationRun,
  failContinuation,
  failMigrationRun,
  findMigrationSets,
  finishMigrationRun,
  followedRun,
  followingRun,
  getMigrationRun,
  launchMigrationRun,
  launchRunSession,
  migrationRunHost,
  migrationStates,
  readRun,
  requireOpen,
  rerunMigration,
  scopeInputOf,
  sessionEnded,
  setRunLauncher,
  setRunStatus,
  settledRunLaunches,
  settledRunStarts,
  shownMigration,
  shownRun,
  startMigrationRuns,
  storeRefusing,
  storedRun,
  withProposalLock,
  withRunLock,
  writeRun
};
