import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { nativeSemanticRuntime, unitsFile } from "./native-semantic-runtime.mjs";
import { HEARTBEAT_MS, componentStorageKey, freshnessFile, processAlive, projectStorageKey, readProgressRecords, sameFingerprint } from "./index-progress.mjs";
import { indexComponents } from "./component-indexes.mjs";
import type { FreshnessRecord, GitFingerprint, ProgressRecord } from "./index-progress.mjs";
import type { Diagnostic, Progress, PublishedUnit } from "./repository-unit-types.mjs";

export type IndexingState = "none" | "unavailable" | "preparing" | "failed" | "interrupted" | "ready";
// `stage` is "structure" while the index holds no embeddings yet; a pointer without `stage` names a complete index.
interface IndexSummary { builtAt: string; stage: "structure" | "complete"; coverage: Record<string, unknown> | null; diagnostics: number; component?: string }
type ComponentIndexingState = Exclude<IndexingState, "none" | "unavailable">;
export interface IndexingStatus { state: IndexingState; progress: (Progress & { component?: string }) | null; startedAt: string | null; endedAt: string | null; diagnostics: Diagnostic[]; index: IndexSummary | null; stale: boolean | null;
  components?: { component: string; state: ComponentIndexingState }[] }
interface Pointer { snapshot?: string; revision?: string; stage?: string; coverage?: Record<string, unknown>; diagnostics?: Diagnostic[]; builtAt?: string }
// `stage` is "structure" when an answering index holds no embeddings yet, as a structure-only index published while its build embeds.
export interface PublishedUnitsView { snapshot: string; revision: string; builtAt: string; stage: "structure" | "complete"; units: PublishedUnit[]; edges: [string, string][] }
interface Options { fingerprint?: () => Promise<GitFingerprint | null>; now?: number; availability?: () => Promise<{ supported: boolean; published: boolean }> }

// A preparing record that missed this many heartbeats belongs to a process that stopped or hung.
const ABANDONED_MS = 12 * HEARTBEAT_MS;
const time = (value: string | undefined | null) => { const parsed = Date.parse(value ?? ""); return Number.isFinite(parsed) ? parsed : 0; };

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}

async function readPointer(directory: string) {
  const file = path.join(directory, "current.json"), pointer = await readJson<Pointer>(file);
  if (!pointer?.snapshot) return null;
  // Indexes written before build times were recorded fall back to the pointer's modification time.
  const builtAt = pointer.builtAt ?? (await stat(file).then(info => info.mtime.toISOString(), () => new Date(0).toISOString()));
  return { ...pointer, builtAt, freshness: await readJson<FreshnessRecord>(freshnessFile(directory)) };
}

// What the storages of one index say: its newest pointer across hosts, its running build, and its latest build that ended after that pointer.
interface StorageState { pointer: Pointer & { builtAt: string; freshness: FreshnessRecord | null } | null; active: ProgressRecord | null; ended: ProgressRecord | null }

async function readStorages(storages: string[], now: number): Promise<StorageState> {
  const pointers = (await Promise.all(storages.map(readPointer))).filter(pointer => pointer !== null);
  const pointer = pointers.sort((left, right) => time(right.builtAt) - time(left.builtAt))[0] ?? null;
  const records: ProgressRecord[] = (await Promise.all(storages.map(readProgressRecords))).flat().sort((left, right) => time(right.updatedAt) - time(left.updatedAt));
  const running = (record: ProgressRecord) => record.state === "preparing" && processAlive(record.pid) && now - time(record.updatedAt) <= ABANDONED_MS;
  // Every running build heartbeats, so the newest write alternates between concurrent builds. The chip follows one build: the one that holds
  // the project lock before any that wait for it, then the earliest started, which keeps the choice stable from one poll to the next.
  const waiting = (record: ProgressRecord) => record.progress?.phase === "waiting" ? 1 : 0;
  const active = records.filter(running).sort((left, right) => waiting(left) - waiting(right) || time(left.startedAt) - time(right.startedAt) || left.pid - right.pid)[0] ?? null;
  const latest = records.find(record => !running(record));
  const ended = latest && (!pointer || time(latest.finishedAt ?? latest.updatedAt) > time(pointer.builtAt)) ? latest : null;
  return { pointer, active, ended };
}

const stageOf = (pointer: Pointer) => pointer.stage === "structure" ? "structure" as const : "complete" as const;
const summary = (pointer: StorageState["pointer"]) => pointer ? { builtAt: pointer.builtAt, stage: stageOf(pointer), coverage: pointer.coverage ?? null, diagnostics: pointer.diagnostics?.length ?? 0 } : null;
const endedState = (record: ProgressRecord): ComponentIndexingState => record.state === "failed" ? "failed" : "interrupted";

// The Git state recorded with an index, unless it was recorded for another snapshot, such as a retained baseline's index, which says nothing about this one.
const recordedGit = (pointer: StorageState["pointer"]) => pointer?.freshness?.snapshot === pointer?.snapshot ? pointer?.freshness?.git ?? null : null;

async function unavailable(options: Options) {
  const availability = await (options.availability ?? (() => nativeSemanticRuntime.availability()))().catch(() => null);
  return availability && availability.supported && availability.published ? "none" : "unavailable";
}

// Reads the index state that any session's build left beside the index, without starting or changing a build.
// Each storage directory belongs to one host's plugin data, so a project indexed by several hosts reports the most recent of them.
// In a repository that declares components, the state combines every component's index, as componentIndexingStatus describes.
export async function readIndexingStatus(projectRoot: string, directories: string[], options: Options = {}): Promise<IndexingStatus> {
  const now = options.now ?? Date.now();
  // An invalid declaration builds no component index, so the status reads the project's own storage, where background preparation records the refusal.
  const declaration = await indexComponents(projectRoot).catch(() => null);
  if (declaration) return componentIndexingStatus(await realpath(projectRoot), declaration.components, directories, options, now);
  const key = projectStorageKey(projectRoot);
  const { pointer, active, ended } = await readStorages([...new Set(directories)].map(directory => path.join(directory, "projects", key)), now);
  const index = summary(pointer);
  let stale: boolean | null = null;
  const recorded = recordedGit(pointer);
  if (recorded && options.fingerprint) {
    const current = await options.fingerprint();
    stale = current ? !sameFingerprint(recorded, current) : null;
  }
  const status = (state: IndexingState, record: ProgressRecord | null = null, endedAt: string | null = null): IndexingStatus =>
    ({ state, progress: record?.progress ?? null, startedAt: record?.startedAt ?? null, endedAt, diagnostics: record?.diagnostics ?? [], index, stale });
  if (active) return status("preparing", active);
  if (ended) return status(endedState(ended), ended, ended.finishedAt ?? ended.updatedAt);
  if (pointer) return status("ready");
  return status(await unavailable(options));
}

// One state over every component's index: preparing while a component prepares in any session, else failed or interrupted when a component's latest
// preparation ended so after its latest index, failed first, else ready when a component has an index. The running build's progress names its component,
// index describes the most recently built component index, and stale compares the Git state recorded with each component's index with the current one.
async function componentIndexingStatus(root: string, declared: { name: string; identity: string; folder: string }[], directories: string[], options: Options, now: number): Promise<IndexingStatus> {
  const components: (StorageState & { component: string })[] = [];
  for (const component of declared) {
    const key = componentStorageKey(root, component.folder === "" ? "" : component.name);
    const state = await readStorages([...new Set(directories)].map(directory => path.join(directory, "projects", key)), now);
    if (state.pointer || state.active || state.ended) components.push({ component: component.identity, ...state });
  }
  const listed = components.map(entry => ({ component: entry.component,
    state: (entry.active ? "preparing" : entry.ended ? endedState(entry.ended) : "ready") as ComponentIndexingState }));
  const newest = components.filter(entry => entry.pointer).sort((left, right) => time(right.pointer!.builtAt) - time(left.pointer!.builtAt))[0];
  const index = newest ? { ...summary(newest.pointer)!, component: newest.component } : null;
  let stale: boolean | null = null;
  const recorded = components.map(entry => recordedGit(entry.pointer)).filter(git => git !== null);
  if (recorded.length && options.fingerprint) {
    const current = await options.fingerprint();
    stale = current ? recorded.some(git => !sameFingerprint(git, current)) : null;
  }
  const named = (entry: { component: string }, record: ProgressRecord) => record.diagnostics.map(item => ({ ...item, component: entry.component }));
  const base = { index, stale, components: listed };
  // The chip follows one running build: the one that holds its lock before any that wait for one, then the earliest started.
  const waiting = (record: ProgressRecord) => record.progress?.phase === "waiting" ? 1 : 0;
  const running = components.filter(entry => entry.active)
    .sort((left, right) => waiting(left.active!) - waiting(right.active!) || time(left.active!.startedAt) - time(right.active!.startedAt) || left.active!.pid - right.active!.pid)[0];
  if (running) {
    const record = running.active!;
    return { state: "preparing", progress: record.progress ? { ...record.progress, component: running.component } : null, startedAt: record.startedAt, endedAt: null, diagnostics: named(running, record), ...base };
  }
  const ended = components.filter(entry => entry.ended), failed = ended.filter(entry => entry.ended!.state === "failed");
  const reported = failed.length ? failed : ended;
  if (reported.length) {
    const endedAt = reported.map(entry => entry.ended!.finishedAt ?? entry.ended!.updatedAt).sort((left, right) => time(right) - time(left))[0];
    return { state: failed.length ? "failed" : "interrupted", progress: null, startedAt: null, endedAt, diagnostics: reported.flatMap(entry => named(entry, entry.ended!)), ...base };
  }
  return { state: newest ? "ready" : await unavailable(options), progress: null, startedAt: null, endedAt: null, diagnostics: [], ...base };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// Reads the units of one index's newest pointer across storages from its small sidecar, or null when it has none or it does not match.
async function readUnits(storages: string[]): Promise<PublishedUnitsView | null> {
  const pointers = (await Promise.all(storages.map(async storage => ({ storage, pointer: await readPointer(storage) }))))
    .filter((entry): entry is { storage: string; pointer: NonNullable<Awaited<ReturnType<typeof readPointer>>> } => entry.pointer !== null);
  const newest = pointers.sort((left, right) => time(right.pointer.builtAt) - time(left.pointer.builtAt))[0];
  const revision = newest?.pointer.revision;
  if (!newest || !revision || !/^[a-f\d]{64}$/.test(revision)) return null;
  const sidecar = await readJson<{ schemaVersion?: number; snapshot?: string; revision?: string; units?: PublishedUnit[]; edges?: [string, string][] }>(path.join(newest.storage, unitsFile(revision)));
  if (sidecar?.schemaVersion !== 1 || sidecar.revision !== revision || sidecar.snapshot !== newest.pointer.snapshot || !Array.isArray(sidecar.units) || !Array.isArray(sidecar.edges)) return null;
  return { snapshot: newest.pointer.snapshot!, revision, builtAt: newest.pointer.builtAt, stage: stageOf(newest.pointer), units: sidecar.units, edges: sidecar.edges };
}

// Reads the units of the most recently published index from its small sidecar, never the full index, and never starts or changes a build.
// An index published before sidecars existed gets one when a later preparation reuses it, so until then this answers null.
// In a repository that declares components, the units of every component's latest index are merged in component order, so a file of a component
// without an index has none; the merged snapshot and revision hash each component's identity with its own, and builtAt is the newest build.
export async function readPublishedUnits(projectRoot: string, directories: string[] = [nativeSemanticRuntime.directory]): Promise<PublishedUnitsView | null> {
  const root = await realpath(projectRoot).catch(() => projectRoot);
  const storages = (key: string) => [...new Set(directories)].map(directory => path.join(directory, "projects", key));
  const declaration = await indexComponents(root).catch(() => null);
  if (!declaration) return readUnits(storages(projectStorageKey(root)));
  const views = [];
  for (const component of declaration.components) {
    const view = await readUnits(storages(componentStorageKey(root, component.folder === "" ? "" : component.name)));
    if (view) views.push({ component: component.identity, view });
  }
  if (!views.length) return null;
  return { snapshot: sha(views.map(({ component, view }) => `${component} ${view.snapshot}\n`).join("")), revision: sha(views.map(({ component, view }) => `${component} ${view.revision}\n`).join("")),
    builtAt: views.map(({ view }) => view.builtAt).sort((left, right) => time(right) - time(left))[0],
    stage: views.some(({ view }) => view.stage === "structure") ? "structure" : "complete",
    units: views.flatMap(({ view }) => view.units), edges: views.flatMap(({ view }) => view.edges) };
}
