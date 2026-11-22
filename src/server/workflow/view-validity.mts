import { AsyncLocalStorage } from "node:async_hooks";

// A view that a time decides, such as whether a claim is still live, stays true only until that time, even when no file changes.
const collecting = new AsyncLocalStorage<{ until: number }>();

/** Note that what is being computed holds only until the time `at`, in milliseconds since the epoch; outside a collection it does nothing. */
export function validUntil(at: number) {
  const scope = collecting.getStore();
  if (scope && Number.isFinite(at) && at < scope.until) scope.until = at;
}

/** Run `compute` and resolve to { value, until }: the result and the earliest time that anything it read noted with validUntil, or Infinity. */
export async function collectValidity<T>(compute: () => Promise<T>) {
  const scope = { until: Infinity };
  const value = await collecting.run(scope, compute);
  return { value, until: scope.until };
}
