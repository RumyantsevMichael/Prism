// Generated from src/server/review/byte-cache.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
function byteCache(maxBytes, sizeOf) {
  const kept = /* @__PURE__ */ new Map();
  let total = 0;
  const drop = (key) => {
    const entry = kept.get(key);
    if (!entry) return;
    total -= entry.bytes;
    kept.delete(key);
  };
  return {
    /** The bytes that the kept values hold, as sizeOf estimates them. */
    get bytes() {
      return total;
    },
    get size() {
      return kept.size;
    },
    read(key, load) {
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
class ReadFailed extends Error {
  status = 503;
  code = "read_failed";
}
class Superseded extends Error {
}
const digestOf = (key) => createHash("sha256").update(key).digest("base64");
const ENTRY_BYTES = 128;
const FAILURES_HELD = 64;
function keptAnswers({ waitMs, maxBytes, maxRuns = 8, keep = () => true }) {
  const running = /* @__PURE__ */ new Map();
  const latest = /* @__PURE__ */ new Map();
  const failures = /* @__PURE__ */ new Map();
  const held = /* @__PURE__ */ new Map();
  const finished = /* @__PURE__ */ new Map();
  let total = 0;
  function store(key, answer) {
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
  const hold = (into, key, value) => {
    into.delete(key);
    into.set(key, value);
    while (into.size > FAILURES_HELD) into.delete(into.keys().next().value);
  };
  const UNSLOTTED = "";
  function start(key, slot, work) {
    const controller = new AbortController();
    const slots = /* @__PURE__ */ new Set();
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
  function enter(slot, key) {
    const earlier = latest.get(slot);
    if (earlier !== void 0 && earlier !== key) {
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
    get bytes() {
      return total;
    },
    /** How many runs go on now, superseded ones included. */
    get running() {
      return running.size;
    },
    /**
     * The answer of a key: a kept one at once, or the run's answer within waitMs, or null while the run goes on, while maxRuns runs go on, or when a newer run superseded it.
     * A failed run's error is thrown to the request that waits for it, or else to the next request of its key.
     */
    async read(named, work, slotNamed) {
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
        if (running.size >= maxRuns) return null;
        start(key, slotNamed === void 0 ? null : digestOf(slotNamed), work);
      } else if (slotNamed === void 0) running.get(key).slots.add(UNSLOTTED);
      else enter(digestOf(slotNamed), key);
      const run = running.get(key);
      let timer;
      const waited = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      });
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
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
export {
  ReadFailed,
  Superseded,
  byteCache,
  keptAnswers
};
