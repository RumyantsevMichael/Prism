import { createHash } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { readChangeMapDocument, writeDerivedChangeMap } from "./change-map.mjs";
import { prepareAnalysis, sourceUnits } from "./conservation-analysis.mjs";
import { conservationStore } from "./conservation-store.mjs";
import { acceptedDesign, latestVerification } from "../workflow/slice-design.mjs";

const RETRY_MS = 15000;
const RETRY_LIMIT = 40;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const lineCount = (text) => text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const contains = (outer, inner) => outer !== inner && outer.file === inner.file && outer.start <= inner.start && inner.end <= outer.end;

// A parsed unit becomes a typed reference that the review browser and conservation checks both understand.
function selectorOf(unit, domain) {
  if (unit.kind === "file") return undefined;
  if (unit.kind === "heading") return { type: "heading", value: unit.selector };
  if (unit.kind === "configuration-key") return { type: path.extname(unit.file) === ".json" ? "json-pointer" : "yaml-key", value: unit.selector };
  return domain === "code" ? { type: "symbol", value: unit.selector } : null;
}

async function unitsOf(projectRoot, snapshotId, options) {
  const store = options.store || conservationStore;
  const snapshot = await store.get(projectRoot, snapshotId, "snapshot");
  const prepared = await prepareAnalysis(projectRoot, snapshotId, options);
  if (prepared.status === "preparing") return { preparing: true };
  const analysis = prepared.analysis ?? null;
  const domains = new Map((analysis?.units ?? []).map((unit) => [JSON.stringify([unit.file, unit.kind, unit.selector || unit.name]), unit.domain]));
  const units = (await sourceUnits(projectRoot, snapshot, analysis, store)).map((unit) => ({ ...unit, domain: domains.get(JSON.stringify([unit.file, unit.kind, unit.selector])) }));
  const texts = new Map();
  for (const file of snapshot.files) if (file.kind === "source") texts.set(file.file, (await store.bytes(projectRoot, file)).toString("utf8"));
  return { units, texts, structured: analysis !== null };
}

/**
 * Compare the units of two snapshots: a unit only in the result is added, only in the baseline removed, and in both with other bytes changed.
 * A change inside a changed container is listed once, at the innermost unit for edits and at the outermost unit for additions and removals.
 * A file appears itself only when it has no listed unit, such as a file without a parser or a change outside every unit.
 */
export function diffUnits(before, after) {
  const beforeByKey = new Map(before.units.map((unit) => [unit.key, unit]));
  const afterByKey = new Map(after.units.map((unit) => [unit.key, unit]));
  const changes = [];
  for (const unit of after.units) {
    const old = beforeByKey.get(unit.key);
    if (!old) changes.push({ action: "ADD", after: unit });
    else if (old.hash !== unit.hash) changes.push({ action: "MODIFY", before: old, after: unit });
  }
  for (const unit of before.units) if (!afterByKey.has(unit.key)) changes.push({ action: "DELETE", before: unit });
  const parsed = changes.filter((change) => (change.after ?? change.before).kind !== "file");
  const kept = parsed.filter((change) => {
    if (change.action === "MODIFY") return !parsed.some((other) => other !== change && (other.action === "DELETE" ? contains(change.before, other.before) : contains(change.after, other.after)));
    const side = change.action === "ADD" ? "after" : "before";
    return !parsed.some((other) => other.action === change.action && contains(other[side], change[side]));
  });
  const listed = new Set(kept.map((change) => (change.after ?? change.before).file));
  const files = changes.filter((change) => (change.after ?? change.before).kind === "file" && !listed.has((change.after ?? change.before).file));
  return [...files, ...kept];
}

function entryOf(change, before, after) {
  const unit = change.after ?? change.before;
  const domain = change.after?.domain ?? change.before?.domain;
  const selector = selectorOf(unit, domain);
  const reference = selector ? { path: unit.file, selector } : { path: unit.file };
  const span = (side, item) => {
    const text = side.texts.get(item.file);
    return text === undefined ? null : lineCount(item.kind === "file" ? text : text.slice(item.start, item.end));
  };
  const added = change.after ? span(after, change.after) : null;
  const removed = change.before ? span(before, change.before) : null;
  const lines = (count) => `${count} ${count === 1 ? "line" : "lines"}`;
  const reason = change.action === "ADD" ? `Added${added === null ? "" : `: ${lines(added)}`}.`
    : change.action === "DELETE" ? `Removed${removed === null ? "" : `: ${lines(removed)}`}.`
      : `Changed${added === null || removed === null ? "" : `: ${lines(added)}, ${removed} before`}.`;
  return {
    id: `${change.action.toLowerCase()}-${sha256(unit.key).slice(0, 12)}`,
    kind: unit.kind,
    label: unit.kind === "file" ? unit.file : unit.selector,
    action: change.action,
    before: change.before ? [reference] : [],
    after: change.after ? [reference] : [],
    reason
  };
}

/**
 * Derive a slice's change map from its design baseline and the source its latest passing verification run tested,
 * and write it as the slice's change map unless an agent wrote one.
 */
export async function deriveSliceChangeMap({ projectRoot, initiative, slice }, options = {}) {
  const root = await realpath(projectRoot);
  const design = await acceptedDesign(root, initiative, slice);
  if (!design?.baselineId) return { status: "unavailable", reason: "The slice has no accepted design with a baseline snapshot." };
  const latest = await latestVerification(root, initiative, slice);
  if (!latest?.passed || !latest.snapshotId || latest.designAcceptedAt !== design.acceptedAt) return { status: "unavailable", reason: "The slice has no passing verification run of its current design." };
  const existing = await readChangeMapDocument(root, { initiative, slice }).catch(() => null);
  if (existing && !existing.document.derived) return { status: "skipped", reason: "authored_change_map" };
  if (existing?.document.derived?.runId === latest.id) return { status: "current", runId: latest.id };
  const before = await unitsOf(root, design.baselineId, options);
  const after = before.preparing ? before : await unitsOf(root, latest.snapshotId, options);
  if (before.preparing || after.preparing) return { status: "preparing" };
  const concepts = diffUnits(before, after).map((change) => entryOf(change, before, after));
  if (!concepts.length) return { status: "empty", runId: latest.id };
  const scope = [...new Set(concepts.flatMap((entry) => [...entry.before, ...entry.after].map((reference) => reference.path)))].sort();
  const document = { schemaVersion: 2, scope, concepts, baselineId: design.baselineId, derived: { runId: latest.id, baselineId: design.baselineId, resultId: latest.snapshotId, derivedAt: new Date().toISOString() } };
  const written = await writeDerivedChangeMap(root, { initiative, slice }, document);
  return { status: written.written ? "written" : "skipped", runId: latest.id, changes: concepts.length, structured: before.structured && after.structured, ...(written.reason ? { reason: written.reason } : {}) };
}

// One derivation per slice at a time; while the parser analysis is still preparing, it tries again a little later.
const derivations = new Map();
const finished = new Map();
const derivationId = (key) => `${key.projectRoot}\n${key.initiative}\n${key.slice}`;

/** The last finished derivation of a slice in this server process, or null. */
export function lastChangeMapDerivation(key) {
  return finished.get(derivationId(key)) ?? null;
}

export function startChangeMapDerivation(key, options = {}) {
  const id = derivationId(key);
  if (derivations.has(id)) return derivations.get(id);
  const attempt = (count) => deriveSliceChangeMap(key, options).then((result) => {
    if (result.status !== "preparing" || count >= RETRY_LIMIT) return result;
    return new Promise((resolve) => { const timer = setTimeout(() => resolve(attempt(count + 1)), options.retryMs ?? RETRY_MS); timer.unref?.(); });
  });
  const running = attempt(0).catch((error) => ({ status: "failed", reason: error.message })).then((result) => {
    finished.set(id, result);
    return result;
  }).finally(() => derivations.delete(id));
  derivations.set(id, running);
  return running;
}
