// Generated from src/server/workflow/view-validity.mts by scripts/native-build/compile.mjs.
import { AsyncLocalStorage } from "node:async_hooks";
const collecting = new AsyncLocalStorage();
function validUntil(at) {
  const scope = collecting.getStore();
  if (scope && Number.isFinite(at) && at < scope.until) scope.until = at;
}
async function collectValidity(compute) {
  const scope = { until: Infinity };
  const value = await collecting.run(scope, compute);
  return { value, until: scope.until };
}
export {
  collectValidity,
  validUntil
};
