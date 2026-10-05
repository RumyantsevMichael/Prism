import { assertInput } from "./artifact-schema.mjs";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolveArtifactPath } from "./concept-delta.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { checkReviewGate, loadReview } from "./review-ledger.mjs";
import { conservationError } from "./conservation-store.mjs";
import { objectSchema as obj, arraySchema as arr, textField as str } from "./conservation-schema.mjs";
const fields = { activity: { enum: ["design", "implementation", "review", "integration"] }, label: str, workers: { ...arr(str), minItems: 1 }, workspace: str, reviewPath: str, reviewLanes: arr(obj({ id: str, reviewer: str })), findingsPath: str };
export const ACTIVE_OPERATIONS_SCHEMA = arr({ oneOf: [
  obj({ op: { const: "start" }, entry: obj({ slice: str, ...fields }, ["slice", "activity", "workers", "workspace"]) }),
  obj({ op: { const: "update" }, slice: str, set: { ...obj(fields, []), minProperties: 1 } }),
  obj({ op: { enum: ["finish", "release"] }, slice: str })
] });
export interface ActiveEntry { slice: string; activity: string; workers: string[]; workspace: string; reviewPath?: string; [key: string]: unknown }
export async function withReviewGatesLocked<T>(projectRoot: string, active: ActiveEntry[], operations: unknown, action: () => Promise<T>): Promise<T> {
  assertInput(ACTIVE_OPERATIONS_SCHEMA, operations);
  const simulated = new Map(active.map(entry => [entry.slice, entry])), paths = new Set<string>(), reviews = new Set<string>();
  for (const operation of operations as { op: string; entry?: ActiveEntry; slice?: string; set?: Partial<ActiveEntry> }[]) {
    const slice = operation.entry?.slice || operation.slice!, current = simulated.get(slice);
    const entry = operation.entry || (current ? { ...current, ...operation.set } : undefined);
    if (entry?.reviewPath && (operation.op === "finish" || (operation.op !== "release" && ["implementation", "integration"].includes(entry.activity)))) { paths.add((await resolveArtifactPath(projectRoot, entry.reviewPath, false, "review.json")).target); reviews.add(entry.reviewPath); }
    if (["finish", "release"].includes(operation.op)) simulated.delete(slice); else if (entry) simulated.set(slice, entry);
  }
  const ordered = [...paths].sort();
  const lockDeltas = async () => {
    const deltas = new Set<string>();
    for (const reviewPath of reviews) { const review = await loadReview(projectRoot, reviewPath); if (review.document) deltas.add((await resolveArtifactPath(projectRoot, review.document.deltaPath, false)).target); }
    const targets = [...deltas].sort();
    const lockDelta = async (offset: number): Promise<T> => offset === targets.length ? action() : withArtifactLock(targets[offset], () => withFileLock(targets[offset], () => lockDelta(offset + 1), conservationError, { renew: true }));
    return lockDelta(0);
  };
  const lock = async (offset: number): Promise<T> => offset === ordered.length ? lockDeltas() : withArtifactLock(ordered[offset], () => withFileLock(ordered[offset], () => lock(offset + 1), conservationError, { renew: true }));
  return lock(0);
}
export async function applyActiveOperations(projectRoot: string, active: ActiveEntry[], operations: unknown) {
  assertInput(ACTIVE_OPERATIONS_SCHEMA, operations);
  const entries = structuredClone(active), completions: unknown[] = [];
  for (const operation of operations as { op: string; entry?: ActiveEntry; slice?: string; set?: Partial<ActiveEntry> }[]) {
    const slice = operation.entry?.slice || operation.slice!, index = entries.findIndex(entry => entry.slice === slice);
    if (operation.op === "start" ? index >= 0 : index < 0) throw conservationError("validation_failed", "Active operations require an unused start or an existing entry.", { slice });
    if (operation.op === "release") { entries.splice(index, 1); continue; }
    const entry = operation.op === "start" ? operation.entry! : { ...entries[index], ...(operation.set || {}) };
    if (operation.op !== "finish" && !["design", "implementation", "review", "integration"].includes(entry.activity)) throw conservationError("gate_blocked", "Use an explicit supported activity when updating legacy active work.");
    const gate = operation.op === "finish" ? "completion" : entry.activity === "implementation" ? "implementation" : entry.activity === "integration" ? "completion" : null;
    if (gate) {
      if (!entry.reviewPath) throw conservationError("gate_blocked", "This operation needs the slice reviewPath.");
      if (path.posix.basename(path.posix.dirname(entry.reviewPath)) !== slice || await realpath(path.resolve(projectRoot, entry.workspace)) !== await realpath(projectRoot)) throw conservationError("gate_blocked", "The review must belong to the active slice and its current workspace.");
      const result = await checkReviewGate({ projectRoot, reviewPath: entry.reviewPath, gate });
      if (!result.ready) throw conservationError("gate_blocked", "The active-work mutation does not satisfy review prerequisites.", { problems: result.problems });
      if (operation.op === "finish") completions.push({ slice, reviewPath: entry.reviewPath, ...result });
    }
    if (operation.op === "finish") entries.splice(index, 1);
    else if (operation.op === "start") entries.push(entry);
    else entries[index] = entry;
  }
  return { active: entries, completions };
}
