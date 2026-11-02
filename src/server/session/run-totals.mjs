// Run totals are computed on read from shared run records, never stored.
// Every function takes identifiers only, and records are read only through readRunRecords.
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { totalRunSegments } from "./run-measures.mjs";
import { readRunRecords } from "./run-records.mjs";

const UNAVAILABLE = { unavailable: true };

const runsKey = (initiative, slice) => ({ kind: "runs", initiative, slice });

// Slice-level parts carry their record's run times; an unreadable key or each invalid entry adds an unavailable part.
function sliceParts(read) {
  if (!read.readable) return [UNAVAILABLE];
  const parts = read.records.flatMap((record) => record.segments.map((segment) => ({
    runId: record.runId,
    segment,
    startedAt: record.startedAt,
    endedAt: record.endedAt
  })));
  return [...parts, ...Array.from({ length: read.invalid }, () => UNAVAILABLE)];
}

// Waves in first-seen record order and design runs in number order; segments store no times, so their wall span is approximate.
// A skipped invalid entry may hold segments of any wave or design run, so each group also gets one unavailable part per entry.
function sliceResult(read) {
  const waves = new Map();
  const designRuns = new Map();
  for (const record of read.records) {
    for (const segment of record.segments) {
      const groups = segment.kind === "wave" ? waves : segment.kind === "design-run" ? designRuns : null;
      if (groups === null) continue;
      const id = segment.kind === "wave" ? segment.wave : segment.designRun;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ runId: record.runId, segment });
    }
  }
  const skipped = Array.from({ length: read.invalid }, () => UNAVAILABLE);
  const groupTotals = (parts) => totalRunSegments([...parts, ...skipped]);
  return {
    slice: totalRunSegments(sliceParts(read)),
    waves: [...waves].map(([wave, parts]) => ({ wave, totals: groupTotals(parts) })),
    designRuns: [...designRuns].sort((left, right) => left[0] - right[0])
      .map(([designRun, parts]) => ({ designRun, totals: groupTotals(parts) }))
  };
}

/** Returns `{ slice, waves, designRuns }` totals of one slice's run records. */
export async function readSliceRunTotals(projectRoot, { initiative, slice }) {
  return sliceResult(await readRunRecords(projectRoot, runsKey(initiative, slice)));
}

/**
 * Returns `{ initiative, slices }` for an initiative's derived topology: each `slices[slug]` holds the slice's totals and
 * `withDescendants`, its own and all descendants' records, and `initiative` equals the root's `withDescendants`.
 */
export async function readInitiativeRunTotals(projectRoot, { initiative, root, children }) {
  const slugs = Object.keys(children);
  const reads = new Map(await Promise.all(slugs.map(async (slug) => [slug, await readRunRecords(projectRoot, runsKey(initiative, slug))])));
  const subtree = (slug) => [...sliceParts(reads.get(slug)), ...(children[slug] ?? []).flatMap(subtree)];
  const slices = Object.fromEntries(slugs.map((slug) => [slug, { ...sliceResult(reads.get(slug)), withDescendants: totalRunSegments(subtree(slug)) }]));
  return { initiative: slices[root].withDescendants, slices };
}

// Run totals with every measure unavailable, so an unexpected failure never fails the read it is added to.
function unavailableRunTotals() {
  return totalRunSegments([UNAVAILABLE]);
}

/** Returns the totals of the slice a review read names; `null` for invalid identifiers, or every measure unavailable on an unexpected error. */
export async function readReviewRunTotals(projectRoot, { initiative, slice }) {
  if (!SLUG_PATTERN.test(initiative ?? "") || !SLUG_PATTERN.test(slice ?? "")) return null;
  try {
    return await readSliceRunTotals(projectRoot, { initiative, slice });
  } catch {
    return { slice: unavailableRunTotals(), waves: [], designRuns: [] };
  }
}

/**
 * Returns `readInitiativeRunTotals` for an initiative record's `{ exists, valid, derived }`; `null` for an absent or
 * invalid record, or `{ initiative: <unavailable>, slices: {} }` on an unexpected error.
 */
export async function readInitiativeRecordRunTotals(projectRoot, initiative, { exists, valid, derived }) {
  if (!exists || !valid || !derived) return null;
  try {
    return await readInitiativeRunTotals(projectRoot, { initiative, root: derived.root, children: derived.children });
  } catch {
    return { initiative: unavailableRunTotals(), slices: {} };
  }
}

/**
 * Totals the calling session's recorded runs, `[{ projectRoot, key, runId }]`, reading each distinct key once and
 * counting only those runs' entries; a missing, invalid, or unreadable expected entry adds an unavailable part.
 */
export async function readSessionRunTotals(recorded) {
  const keys = new Map();
  for (const { projectRoot, key, runId } of recorded) {
    const id = JSON.stringify([projectRoot, key.initiative, key.slice]);
    if (!keys.has(id)) keys.set(id, { projectRoot, key, runIds: [] });
    keys.get(id).runIds.push(runId);
  }
  const parts = [];
  for (const { projectRoot, key, runIds } of keys.values()) {
    const read = await readRunRecords(projectRoot, runsKey(key.initiative, key.slice));
    for (const runId of runIds) {
      const record = read.records.find((item) => item.runId === runId);
      if (!record) {
        parts.push(UNAVAILABLE);
        continue;
      }
      parts.push(...sliceParts({ readable: true, records: [record], invalid: 0 }));
    }
  }
  return totalRunSegments(parts);
}
