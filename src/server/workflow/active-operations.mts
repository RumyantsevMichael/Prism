import { assertInput } from "./artifact-schema.mjs";
import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { locateRecord } from "./record-store.mjs";
import { checkReviewGate } from "../review/review-ledger.mjs";
import { conservationError } from "../conservation/conservation-store.mjs";
import { objectSchema as obj, arraySchema as arr, textField as str } from "../conservation/conservation-schema.mjs";
const fields = { activity: { enum: ["design", "implementation", "review", "integration"] }, label: str, workers: { ...arr(str), minItems: 1 }, workspace: str, reviewLanes: arr(obj({ id: str, reviewer: str })), findingsPath: str };
export const ACTIVE_OPERATIONS_SCHEMA = arr({ oneOf: [
  obj({ op: { const: "start" }, entry: obj({ slice: str, ...fields }, ["slice", "activity", "workers", "workspace"]) }),
  obj({ op: { const: "update" }, slice: str, set: { ...obj(fields, []), minProperties: 1 } }),
  obj({ op: { enum: ["finish", "release"] }, slice: str })
] });
export interface ActiveEntry { slice: string; activity: string; workers: string[]; workspace: string; [key: string]: unknown }
const gated = (op: string, entry?: ActiveEntry) => Boolean(entry) && (op === "finish" || (op !== "release" && ["implementation", "integration"].includes(entry!.activity)));
// Each active slice's review and change map are the records of that slice, so their locks are taken in path order before the state changes.
export async function withReviewGatesLocked<T>(projectRoot: string, initiative: string, active: ActiveEntry[], operations: unknown, action: () => Promise<T>): Promise<T> {
  assertInput(ACTIVE_OPERATIONS_SCHEMA, operations);
  const simulated = new Map(active.map(entry => [entry.slice, entry])), paths = new Set<string>();
  for (const operation of operations as { op: string; entry?: ActiveEntry; slice?: string; set?: Partial<ActiveEntry> }[]) {
    const slice = operation.entry?.slice || operation.slice!, current = simulated.get(slice);
    const entry = operation.entry || (current ? { ...current, ...operation.set } : undefined);
    if (gated(operation.op, entry)) for (const kind of ["review", "change-map"] as const) paths.add((await locateRecord(projectRoot, { kind, initiative, slice })).target);
    if (["finish", "release"].includes(operation.op)) simulated.delete(slice); else if (entry) simulated.set(slice, entry);
  }
  const ordered = [...paths].sort();
  for (const target of ordered) await mkdir(path.dirname(target), { recursive: true });
  const lock = async (offset: number): Promise<T> => offset === ordered.length ? action() : withArtifactLock(ordered[offset], () => withFileLock(ordered[offset], () => lock(offset + 1), conservationError, { renew: true }));
  return lock(0);
}
export async function applyActiveOperations(projectRoot: string, initiative: string, active: ActiveEntry[], operations: unknown) {
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
      if (await realpath(path.resolve(projectRoot, entry.workspace)) !== await realpath(projectRoot)) throw conservationError("gate_blocked", "The review must belong to the active slice's current workspace.");
      const result = await checkReviewGate({ projectRoot, initiative, slice, gate });
      if (!result.ready) throw conservationError("gate_blocked", "The active-work mutation does not satisfy review prerequisites.", { problems: result.problems });
      if (operation.op === "finish") completions.push({ slice, ...result });
    }
    if (operation.op === "finish") entries.splice(index, 1);
    else if (operation.op === "start") entries.push(entry);
    else entries[index] = entry;
  }
  return { active: entries, completions };
}
