import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { nativeSemanticRuntime } from "./native-semantic-runtime.mjs";
import { HEARTBEAT_MS, freshnessFile, processAlive, projectStorageKey, readProgressRecords, sameFingerprint } from "./index-progress.mjs";
import type { FreshnessRecord, GitFingerprint, ProgressRecord } from "./index-progress.mjs";
import type { Diagnostic, Progress } from "./repository-unit-types.mjs";

export type IndexingState = "none" | "unavailable" | "preparing" | "failed" | "interrupted" | "ready";
interface IndexSummary { builtAt: string; coverage: Record<string, unknown> | null; diagnostics: number }
export interface IndexingStatus { state: IndexingState; progress: Progress | null; startedAt: string | null; endedAt: string | null; diagnostics: Diagnostic[]; index: IndexSummary | null; stale: boolean | null }
interface Pointer { snapshot?: string; coverage?: Record<string, unknown>; diagnostics?: Diagnostic[]; builtAt?: string }
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

// Reads the index state that any session's build left beside the index, without starting or changing a build.
// Each storage directory belongs to one host's plugin data, so a project indexed by several hosts reports the most recent of them.
export async function readIndexingStatus(projectRoot: string, directories: string[], options: Options = {}): Promise<IndexingStatus> {
  const now = options.now ?? Date.now(), key = projectStorageKey(projectRoot);
  const storages = [...new Set(directories)].map(directory => path.join(directory, "projects", key));
  const pointers = (await Promise.all(storages.map(readPointer))).filter(pointer => pointer !== null);
  const pointer = pointers.sort((left, right) => time(right.builtAt) - time(left.builtAt))[0] ?? null;
  const records: ProgressRecord[] = (await Promise.all(storages.map(readProgressRecords))).flat().sort((left, right) => time(right.updatedAt) - time(left.updatedAt));
  const running = (record: ProgressRecord) => record.state === "preparing" && processAlive(record.pid) && now - time(record.updatedAt) <= ABANDONED_MS;
  const index = pointer ? { builtAt: pointer.builtAt, coverage: pointer.coverage ?? null, diagnostics: pointer.diagnostics?.length ?? 0 } : null;
  let stale: boolean | null = null;
  // Freshness recorded for another snapshot, such as a retained baseline's index, says nothing about this index.
  const recorded = pointer?.freshness?.snapshot === pointer?.snapshot ? pointer?.freshness?.git : null;
  if (recorded && options.fingerprint) {
    const current = await options.fingerprint();
    stale = current ? !sameFingerprint(recorded, current) : null;
  }
  const status = (state: IndexingState, record: ProgressRecord | null = null, endedAt: string | null = null): IndexingStatus =>
    ({ state, progress: record?.progress ?? null, startedAt: record?.startedAt ?? null, endedAt, diagnostics: record?.diagnostics ?? [], index, stale });
  // Every running build heartbeats, so the newest write alternates between concurrent builds. The chip follows one build: the one that holds
  // the project lock before any that wait for it, then the earliest started, which keeps the choice stable from one poll to the next.
  const waiting = (record: ProgressRecord) => record.progress?.phase === "waiting" ? 1 : 0;
  const active = records.filter(running).sort((left, right) => waiting(left) - waiting(right) || time(left.startedAt) - time(right.startedAt) || left.pid - right.pid)[0];
  if (active) return status("preparing", active);
  const ended = records.find(record => !running(record));
  if (ended) {
    const endedAt = ended.finishedAt ?? ended.updatedAt;
    if (!pointer || time(endedAt) > time(pointer.builtAt)) return status(ended.state === "failed" ? "failed" : "interrupted", ended, endedAt);
  }
  if (pointer) return status("ready");
  const availability = await (options.availability ?? (() => nativeSemanticRuntime.availability()))().catch(() => null);
  return status(availability && availability.supported && availability.published ? "none" : "unavailable");
}
