// A value that is slow to compute and read often, such as one project's gate count in the project list every open tab polls.
// The first read waits for the value; a read within ttlMs answers the kept value, and a later read answers it too while one computation renews it behind.
// invalidate() is for an event known to change the value: the next read waits for a new computation, and a computation started before it is discarded.
export function createCachedValue(compute, { ttlMs, now = Date.now }) {
  let entry = null;
  let pending = null;
  let generation = 0;

  function renew() {
    if (pending) return pending;
    const started = generation;
    const running = Promise.resolve().then(compute).then((value) => {
      if (started === generation) entry = { value, at: now() };
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
      if (now() - entry.at >= ttlMs) renew().catch(() => {});
      return Promise.resolve(entry.value);
    },
    invalidate() {
      generation += 1;
      entry = null;
      pending = null;
    }
  };
}
