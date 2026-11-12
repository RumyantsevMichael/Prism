// A value that is slow to compute and read often, such as one project's gate count in the project list every open tab polls.
// The first read waits for the value; a read within ttlMs answers the kept value, and a later read answers it too while one computation renews it behind.
// invalidate() is for an event known to change the value: the next read waits for a new computation, and a computation started before it is discarded.
// ttlMs may be a function of the last computation's duration, so a value that is slow to compute on a slow machine is renewed less often.
export function createCachedValue(compute, { ttlMs, now = Date.now }) {
  const ttl = (entry) => typeof ttlMs === "function" ? ttlMs(entry.ms) : ttlMs;
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
      if (now() - entry.at >= ttl(entry)) renew().catch(() => {});
      return Promise.resolve(entry.value);
    },
    invalidate() {
      generation += 1;
      entry = null;
      pending = null;
    }
  };
}
