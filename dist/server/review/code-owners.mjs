// Generated from src/server/review/code-owners.mts by scripts/native-build/compile.mjs.
import { listInitiatives, listRecordEntries, recordsUnavailable } from "../workflow/record-store.mjs";
import { loadInitiativeView, rememberView } from "./workspace-model.mjs";
const ownerKey = (repository, branch) => `${repository}\0${branch}`;
function branchOwners(projectRoot) {
  return rememberView(projectRoot, "code-owners", async () => {
    const owners = /* @__PURE__ */ new Map();
    const initiatives = await listInitiatives(projectRoot).catch((error) => {
      if (recordsUnavailable(error)) return [];
      throw error;
    });
    for (const initiative of initiatives) {
      const view = await loadInitiativeView(projectRoot, initiative).catch(() => null);
      for (const slice of Object.keys(view?.record?.slices ?? {})) {
        const runs = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice }).catch(() => []);
        const run = runs.filter((item) => item.entry?.kind === "verification" && typeof item.entry.checkout?.branch === "string" && item.entry.checkout.branch && typeof item.entry.checkout?.repository === "string").at(-1)?.entry;
        if (!run) continue;
        const key = ownerKey(run.checkout.repository, run.checkout.branch);
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key).push({ initiative, slice });
      }
    }
    return owners;
  });
}
export {
  branchOwners,
  ownerKey
};
