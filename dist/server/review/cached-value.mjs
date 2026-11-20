// Generated from src/server/review/cached-value.mts by scripts/native-build/compile.mjs.
function createCachedValue(compute, { ttlMs, now = Date.now }) {
  const ttl = (entry2) => typeof ttlMs === "function" ? ttlMs(entry2.ms) : ttlMs;
  let entry = null;
  let pending = null;
  let generation = 0;
  function renew() {
    if (pending) return pending;
    const started = generation, began = now();
    const running = Promise.resolve().then(compute).then((value) => {
      if (started === generation) entry = { value, at: now(), ms: now() - began };
      return value;
    }).finally(() => {
      if (pending === running) pending = null;
    });
    pending = running;
    return running;
  }
  return {
    get() {
      if (!entry) return renew();
      if (now() - entry.at >= ttl(entry)) renew().catch(() => {
      });
      return Promise.resolve(entry.value);
    },
    invalidate() {
      generation += 1;
      entry = null;
      pending = null;
    }
  };
}
export {
  createCachedValue
};
