// Generated from src/server/repository-intelligence/index-status.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { nativeSemanticRuntime, unitsFile } from "./native-semantic-runtime.mjs";
import { HEARTBEAT_MS, componentStorageKey, freshnessFile, processAlive, projectStorageKey, readProgressRecords, sameFingerprint } from "./index-progress.mjs";
import { indexComponents } from "./component-indexes.mjs";
const ABANDONED_MS = 12 * HEARTBEAT_MS;
const time = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function readPointer(directory) {
  const file = path.join(directory, "current.json"), pointer = await readJson(file);
  if (!pointer?.snapshot) return null;
  const builtAt = pointer.builtAt ?? await stat(file).then((info) => info.mtime.toISOString(), () => (/* @__PURE__ */ new Date(0)).toISOString());
  return { ...pointer, builtAt, freshness: await readJson(freshnessFile(directory)) };
}
async function readStorages(storages, now) {
  const pointers = (await Promise.all(storages.map(readPointer))).filter((pointer2) => pointer2 !== null);
  const pointer = pointers.sort((left, right) => time(right.builtAt) - time(left.builtAt))[0] ?? null;
  const records = (await Promise.all(storages.map(readProgressRecords))).flat().sort((left, right) => time(right.updatedAt) - time(left.updatedAt));
  const running = (record) => record.state === "preparing" && processAlive(record.pid) && now - time(record.updatedAt) <= ABANDONED_MS;
  const waiting = (record) => record.progress?.phase === "waiting" ? 1 : 0;
  const active = records.filter(running).sort((left, right) => waiting(left) - waiting(right) || time(left.startedAt) - time(right.startedAt) || left.pid - right.pid)[0] ?? null;
  const latest = records.find((record) => !running(record));
  const ended = latest && (!pointer || time(latest.finishedAt ?? latest.updatedAt) > time(pointer.builtAt)) ? latest : null;
  return { pointer, active, ended };
}
const stageOf = (pointer) => pointer.stage === "structure" ? "structure" : "complete";
const summary = (pointer) => pointer ? { builtAt: pointer.builtAt, stage: stageOf(pointer), coverage: pointer.coverage ?? null, diagnostics: pointer.diagnostics?.length ?? 0 } : null;
const endedState = (record) => record.state === "failed" ? "failed" : "interrupted";
const recordedGit = (pointer) => pointer?.freshness?.snapshot === pointer?.snapshot ? pointer?.freshness?.git ?? null : null;
async function unavailable(options) {
  const availability = await (options.availability ?? (() => nativeSemanticRuntime.availability()))().catch(() => null);
  return availability && availability.supported && availability.published ? "none" : "unavailable";
}
async function readIndexingStatus(projectRoot, directories, options = {}) {
  const now = options.now ?? Date.now();
  const declaration = await indexComponents(projectRoot).catch(() => null);
  if (declaration) return componentIndexingStatus(await realpath(projectRoot), declaration.components, directories, options, now);
  const key = projectStorageKey(projectRoot);
  const { pointer, active, ended } = await readStorages([...new Set(directories)].map((directory) => path.join(directory, "projects", key)), now);
  const index = summary(pointer);
  let stale = null;
  const recorded = recordedGit(pointer);
  if (recorded && options.fingerprint) {
    const current = await options.fingerprint();
    stale = current ? !sameFingerprint(recorded, current) : null;
  }
  const status = (state, record = null, endedAt = null) => ({ state, progress: record?.progress ?? null, startedAt: record?.startedAt ?? null, endedAt, diagnostics: record?.diagnostics ?? [], index, stale });
  if (active) return status("preparing", active);
  if (ended) return status(endedState(ended), ended, ended.finishedAt ?? ended.updatedAt);
  if (pointer) return status("ready");
  return status(await unavailable(options));
}
async function componentIndexingStatus(root, declared, directories, options, now) {
  const components = [];
  for (const component of declared) {
    const key = componentStorageKey(root, component.folder === "" ? "" : component.name);
    const state = await readStorages([...new Set(directories)].map((directory) => path.join(directory, "projects", key)), now);
    if (state.pointer || state.active || state.ended) components.push({ component: component.identity, ...state });
  }
  const listed = components.map((entry) => ({
    component: entry.component,
    state: entry.active ? "preparing" : entry.ended ? endedState(entry.ended) : "ready"
  }));
  const newest = components.filter((entry) => entry.pointer).sort((left, right) => time(right.pointer.builtAt) - time(left.pointer.builtAt))[0];
  const index = newest ? { ...summary(newest.pointer), component: newest.component } : null;
  let stale = null;
  const recorded = components.map((entry) => recordedGit(entry.pointer)).filter((git) => git !== null);
  if (recorded.length && options.fingerprint) {
    const current = await options.fingerprint();
    stale = current ? recorded.some((git) => !sameFingerprint(git, current)) : null;
  }
  const named = (entry, record) => record.diagnostics.map((item) => ({ ...item, component: entry.component }));
  const base = { index, stale, components: listed };
  const waiting = (record) => record.progress?.phase === "waiting" ? 1 : 0;
  const running = components.filter((entry) => entry.active).sort((left, right) => waiting(left.active) - waiting(right.active) || time(left.active.startedAt) - time(right.active.startedAt) || left.active.pid - right.active.pid)[0];
  if (running) {
    const record = running.active;
    return { state: "preparing", progress: record.progress ? { ...record.progress, component: running.component } : null, startedAt: record.startedAt, endedAt: null, diagnostics: named(running, record), ...base };
  }
  const ended = components.filter((entry) => entry.ended), failed = ended.filter((entry) => entry.ended.state === "failed");
  const reported = failed.length ? failed : ended;
  if (reported.length) {
    const endedAt = reported.map((entry) => entry.ended.finishedAt ?? entry.ended.updatedAt).sort((left, right) => time(right) - time(left))[0];
    return { state: failed.length ? "failed" : "interrupted", progress: null, startedAt: null, endedAt, diagnostics: reported.flatMap((entry) => named(entry, entry.ended)), ...base };
  }
  return { state: newest ? "ready" : await unavailable(options), progress: null, startedAt: null, endedAt: null, diagnostics: [], ...base };
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function readUnits(storages) {
  const pointers = (await Promise.all(storages.map(async (storage) => ({ storage, pointer: await readPointer(storage) })))).filter((entry) => entry.pointer !== null);
  const newest = pointers.sort((left, right) => time(right.pointer.builtAt) - time(left.pointer.builtAt))[0];
  const revision = newest?.pointer.revision;
  if (!newest || !revision || !/^[a-f\d]{64}$/.test(revision)) return null;
  const sidecar = await readJson(path.join(newest.storage, unitsFile(revision)));
  if (sidecar?.schemaVersion !== 1 || sidecar.revision !== revision || sidecar.snapshot !== newest.pointer.snapshot || !Array.isArray(sidecar.units) || !Array.isArray(sidecar.edges)) return null;
  return { snapshot: newest.pointer.snapshot, revision, builtAt: newest.pointer.builtAt, stage: stageOf(newest.pointer), units: sidecar.units, edges: sidecar.edges };
}
async function readPublishedUnits(projectRoot, directories = [nativeSemanticRuntime.directory]) {
  const root = await realpath(projectRoot).catch(() => projectRoot);
  const storages = (key) => [...new Set(directories)].map((directory) => path.join(directory, "projects", key));
  const declaration = await indexComponents(root).catch(() => null);
  if (!declaration) return readUnits(storages(projectStorageKey(root)));
  const views = [];
  for (const component of declaration.components) {
    const view = await readUnits(storages(componentStorageKey(root, component.folder === "" ? "" : component.name)));
    if (view) views.push({ component: component.identity, view });
  }
  if (!views.length) return null;
  return {
    snapshot: sha(views.map(({ component, view }) => `${component} ${view.snapshot}
`).join("")),
    revision: sha(views.map(({ component, view }) => `${component} ${view.revision}
`).join("")),
    builtAt: views.map(({ view }) => view.builtAt).sort((left, right) => time(right) - time(left))[0],
    stage: views.some(({ view }) => view.stage === "structure") ? "structure" : "complete",
    units: views.flatMap(({ view }) => view.units),
    edges: views.flatMap(({ view }) => view.edges)
  };
}
export {
  readIndexingStatus,
  readPublishedUnits
};
