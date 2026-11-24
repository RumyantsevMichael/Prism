import { listInitiatives, listRecordEntries, recordsUnavailable } from "../workflow/record-store.mjs";
import { loadInitiativeView, rememberView } from "./workspace-model.mjs";

// Which slice owns which line of work: a slice owns a repository's branch when its latest verification run that names a branch names that repository and branch,
// because claims name no branch and a run records the checkout it ran in.

/** A key of a repository and branch in the map that branchOwners answers. */
export const ownerKey = (repository: string, branch: string) => `${repository}\0${branch}`;

/** The slices that own each repository and branch, as a Map of ownerKey to [{ initiative, slice }] in record order. */
export function branchOwners(projectRoot: string): Promise<Map<string, { initiative: string; slice: string }[]>> {
  return rememberView(projectRoot, "code-owners", async () => {
    const owners = new Map<string, { initiative: string; slice: string }[]>();
    const initiatives = await listInitiatives(projectRoot).catch((error) => { if (recordsUnavailable(error)) return []; throw error; });
    for (const initiative of initiatives) {
      const view = await loadInitiativeView(projectRoot, initiative).catch((): any => null);
      for (const slice of Object.keys(view?.record?.slices ?? {})) {
        const runs = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice }).catch((): any[] => []);
        const run = runs.filter((item) => item.entry?.kind === "verification" && typeof item.entry.checkout?.branch === "string" && item.entry.checkout.branch
          && typeof item.entry.checkout?.repository === "string").at(-1)?.entry;
        if (!run) continue;
        const key = ownerKey(run.checkout.repository, run.checkout.branch);
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key)!.push({ initiative, slice });
      }
    }
    return owners;
  });
}
