// Caches of the Code place's reads that are bounded by the bytes their values hold in all, rather than by their number,
// so a value that grows with a tree, a file, or a branch count can never multiply into more memory than the bound.

import { createHash } from "node:crypto";

/**
 * A cache of promised values by key, holding at most maxBytes of resolved values as sizeOf estimates them, and dropping the least recently used first.
 * A read of a key that is kept, or still being loaded, joins it; a value larger than maxBytes is answered but not kept; a load that fails is not kept.
 */
export function byteCache<V>(maxBytes: number, sizeOf: (value: V) => number) {
  const kept = new Map<string, { value: Promise<V>; bytes: number }>();
  let total = 0;
  const drop = (key: string) => {
    const entry = kept.get(key);
    if (!entry) return;
    total -= entry.bytes;
    kept.delete(key);
  };
  return {
    /** The bytes that the kept values hold, as sizeOf estimates them. */
    get bytes() { return total; },
    get size() { return kept.size; },
    read(key: string, load: () => Promise<V>): Promise<V> {
      const found = kept.get(key);
      if (found) {
        kept.delete(key);
        kept.set(key, found);
        return found.value;
      }
      const entry = { value: load(), bytes: 0 };
      kept.set(key, entry);
      entry.value.then((value) => {
        if (kept.get(key) !== entry) return;
        const bytes = sizeOf(value);
        if (bytes > maxBytes) {
          kept.delete(key);
          return;
        }
        entry.bytes = bytes;
        total += bytes;
        for (const other of kept.keys()) {
          if (total <= maxBytes) break;
          if (other !== key) drop(other);
        }
      }, () => {
        if (kept.get(key) === entry) kept.delete(key);
      });
      return entry.value;
    }
  };
}

/** A read that failed, such as a lazy fetch of an object while the remote is unreachable, which an answer must never be built on or kept as if the read had found nothing. */
export class ReadFailed extends Error {
  status = 503;
  code = "read_failed";
}

/** A run that a newer run for the same request replaced, which stops at its next step. */
export class Superseded extends Error {}

// The fixed-size digest that a kept answer is kept under, 44 characters for a key of any size,
// and the bytes counted for each kept answer besides its JSON and its digest, for the entry that holds them.
const digestOf = (key: string) => createHash("sha256").update(key).digest("base64");
const ENTRY_BYTES = 128;
// How many failed runs' errors are held for the next request of their key.
const FAILURES_HELD = 64;

/**
 * Answers that a request waits for up to waitMs, while their work goes on in the background past it: one run at a time for each key, which a later request joins,
 * and each finished answer kept for its key, so the request after a 202 answers from it without running the work again.
 * At most maxRuns runs go on at once, and a request that would start one more answers null, as a 202 does, and starts it on a later request.
 * A request names its slot, everything of the request that selects what the answer reads, and a run remembers every slot that started or joined it.
 * A request of a slot for a newer key, as after tips move, leaves the slot's earlier run, and a run that every slot has left is superseded:
 * its work's signal is aborted, so its work stops at its next step, and it still counts toward maxRuns until it ends.
 * So a read of one slot never stops a run that another slot's request waits for, as when two scopes show the same lines and share a key; a request that cannot start its run because maxRuns runs go on stops none.
 * A run that fails is never kept: its error is answered to the request that waits for it, or else to the next request of its key, and the request after that runs again;
 * an answer that keep refuses is likewise answered to the request that waits for it, or else to the next request of its key only.
 * The kept answers hold at most maxBytes of JSON and keys in all, dropping the least recently used first, except that the latest answer is always kept, however large;
 * each is kept under a fixed-size digest of its key, so a key that grows with a branch count costs its digest's 44 characters and an entry's ENTRY_BYTES however large it is.
 * keep(answer) says whether an answer may be kept at all, so an answer that says it is still preparing is never kept.
 */
export function keptAnswers({ waitMs, maxBytes, maxRuns = 8, keep = () => true }: { waitMs: number; maxBytes: number; maxRuns?: number; keep?: (answer: any) => boolean }) {
  const running = new Map<string, { done: Promise<{ answer: any } | { error: any }>; controller: AbortController; slots: Set<string> }>();
  const latest = new Map<string, string>();
  const failures = new Map<string, any>();
  const held = new Map<string, any>();
  const finished = new Map<string, { answer: any; bytes: number }>();
  let total = 0;
  function store(key: string, answer: any) {
    if (!keep(answer)) return false;
    const bytes = (JSON.stringify(answer)?.length ?? 0) + key.length + ENTRY_BYTES;
    const previous = finished.get(key);
    if (previous) total -= previous.bytes;
    finished.delete(key);
    finished.set(key, { answer, bytes });
    total += bytes;
    for (const [other, kept] of finished) {
      if (total <= maxBytes || other === key) break;
      total -= kept.bytes;
      finished.delete(other);
    }
    return true;
  }
  // The error of a failed run, or an answer that keep refused, held for the next request of its key only, so a request after a 202 answers what the run found
  // and the request after that runs again; at most FAILURES_HELD are held, the oldest dropped first.
  const hold = (into: Map<string, any>, key: string, value: any) => {
    into.delete(key);
    into.set(key, value);
    while (into.size > FAILURES_HELD) into.delete(into.keys().next().value!);
  };
  // The mark that a request naming no slot started or joined a run, which no slot's move can then supersede.
  const UNSLOTTED = "";
  function start(key: string, slot: string | null, work: (signal: AbortSignal) => Promise<any>) {
    const controller = new AbortController();
    const slots = new Set<string>();
    const done = Promise.resolve().then(() => work(controller.signal)).then((answer) => {
      if (!store(key, answer) && !controller.signal.aborted) hold(held, key, answer);
      return { answer };
    }, (error) => {
      if (!controller.signal.aborted) hold(failures, key, error);
      return { error };
    }).finally(() => {
      for (const joined of slots) if (latest.get(joined) === key) latest.delete(joined);
      running.delete(key);
    });
    running.set(key, { done, controller, slots });
    if (slot === null) slots.add(UNSLOTTED);
    else enter(slot, key);
  }
  // A slot's request for key: the slot leaves the run of its earlier key, which is superseded once no slot that started or joined it remains, and joins key's run.
  function enter(slot: string, key: string) {
    const earlier = latest.get(slot);
    if (earlier !== undefined && earlier !== key) {
      const run = running.get(earlier);
      if (run) {
        run.slots.delete(slot);
        if (run.slots.size === 0) run.controller.abort(new Superseded());
      }
    }
    latest.set(slot, key);
    running.get(key)?.slots.add(slot);
  }
  return {
    get bytes() { return total; },
    /** How many runs go on now, superseded ones included. */
    get running() { return running.size; },
    /**
     * The answer of a key: a kept one at once, or the run's answer within waitMs, or null while the run goes on, while maxRuns runs go on, or when a newer run superseded it.
     * A failed run's error is thrown to the request that waits for it, or else to the next request of its key.
     */
    async read(named: string, work: (signal: AbortSignal) => Promise<any>, slotNamed?: string) {
      const key = digestOf(named);
      const found = finished.get(key);
      if (found) {
        finished.delete(key);
        finished.set(key, found);
        return found.answer;
      }
      if (!running.has(key) && failures.has(key)) {
        const error = failures.get(key);
        failures.delete(key);
        throw error;
      }
      if (!running.has(key) && held.has(key)) {
        const answer = held.get(key);
        held.delete(key);
        return answer;
      }
      if (!running.has(key)) {
        // A request that cannot start its run answers null and stops none, so it never stops a run that another request waits for.
        if (running.size >= maxRuns) return null;
        start(key, slotNamed === undefined ? null : digestOf(slotNamed), work);
      } else if (slotNamed === undefined) running.get(key)!.slots.add(UNSLOTTED);
      else enter(digestOf(slotNamed), key);
      const run = running.get(key)!;
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
      try {
        const settled = await Promise.race([run.done, waited]);
        if (settled === null) return null;
        if ("answer" in settled) {
          held.delete(key);
          return settled.answer;
        }
        if (run.controller.signal.aborted) return null;
        failures.delete(key);
        throw settled.error;
      } finally { clearTimeout(timer); }
    }
  };
}
