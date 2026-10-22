// Generated from src/server/repository-intelligence/index-status.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { nativeSemanticRuntime } from "./native-semantic-runtime.mjs";
import { HEARTBEAT_MS, freshnessFile, processAlive, projectStorageKey, readProgressRecords, sameFingerprint } from "./index-progress.mjs";
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
async function readIndexingStatus(projectRoot, directories, options = {}) {
  const now = options.now ?? Date.now(), key = projectStorageKey(projectRoot);
  const storages = [...new Set(directories)].map((directory) => path.join(directory, "projects", key));
  const pointers = (await Promise.all(storages.map(readPointer))).filter((pointer2) => pointer2 !== null);
  const pointer = pointers.sort((left, right) => time(right.builtAt) - time(left.builtAt))[0] ?? null;
  const records = (await Promise.all(storages.map(readProgressRecords))).flat().sort((left, right) => time(right.updatedAt) - time(left.updatedAt));
  const running = (record) => record.state === "preparing" && processAlive(record.pid) && now - time(record.updatedAt) <= ABANDONED_MS;
  const index = pointer ? { builtAt: pointer.builtAt, coverage: pointer.coverage ?? null, diagnostics: pointer.diagnostics?.length ?? 0 } : null;
  let stale = null;
  const recorded = pointer?.freshness?.snapshot === pointer?.snapshot ? pointer?.freshness?.git : null;
  if (recorded && options.fingerprint) {
    const current = await options.fingerprint();
    stale = current ? !sameFingerprint(recorded, current) : null;
  }
  const status = (state, record = null, endedAt = null) => ({ state, progress: record?.progress ?? null, startedAt: record?.startedAt ?? null, endedAt, diagnostics: record?.diagnostics ?? [], index, stale });
  const waiting = (record) => record.progress?.phase === "waiting" ? 1 : 0;
  const active = records.filter(running).sort((left, right) => waiting(left) - waiting(right) || time(left.startedAt) - time(right.startedAt) || left.pid - right.pid)[0];
  if (active) return status("preparing", active);
  const ended = records.find((record) => !running(record));
  if (ended) {
    const endedAt = ended.finishedAt ?? ended.updatedAt;
    if (!pointer || time(endedAt) > time(pointer.builtAt)) return status(ended.state === "failed" ? "failed" : "interrupted", ended, endedAt);
  }
  if (pointer) return status("ready");
  const availability = await (options.availability ?? (() => nativeSemanticRuntime.availability()))().catch(() => null);
  return status(availability && availability.supported && availability.published ? "none" : "unavailable");
}
export {
  readIndexingStatus
};
