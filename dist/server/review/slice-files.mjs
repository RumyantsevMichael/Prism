import { listRecordEntries } from "../workflow/record-store.mjs";
import { loadRoadmapView } from "./workspace-model.mjs";

// A slice's files after verification: the files its latest passing run recorded, shown at the verified commit while a branch of the repository's code clone holds it,
// else at the commit recorded at ship, each marked as the same as verified or changed after it by comparing blob hashes, so no record holds file bytes.
// Only a commit that a branch of a code clone holds is read, so unpushed work never shows as content.

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hashOrNull = (value) => (typeof value === "string" && HASH.test(value) ? value : null);

/** The latest passing verification run of a slice, or null. */
export async function latestPassingRun(projectRoot, initiative, slice) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice }).catch(() => []);
  return entries.filter((item) => item.entry?.kind === "verification" && item.entry.passed === true).at(-1)?.entry ?? null;
}

// The commit that ship recorded for a slice, or null when its initiative has not shipped or no commit qualified.
export async function shippedCommit(projectRoot, initiative, slice) {
  const roadmap = await loadRoadmapView(projectRoot).catch(() => null);
  const decision = roadmap?.items?.find((item) => item.id === initiative)?.decision;
  const recorded = decision?.kind === "shipped" ? decision.slices?.[slice] : null;
  return hashOrNull(recorded?.shipped);
}

/**
 * The answer of /api/slice-files: { initiative, slice, repository, verified, shipped, shown, files, message }.
 * code reads the workspace's code clones, { state(repository), reachable(repository, commit), blobs(repository, commit, paths) }, or is null where there are none.
 */
export async function sliceFiles(projectRoot, initiative, slice, code = null) {
  const run = await latestPassingRun(projectRoot, initiative, slice);
  if (!run) return { initiative, slice, repository: null, verified: null, shipped: null, shown: null, files: [], message: "The slice has no passing verification run yet, so it has no verified files to show." };
  const repository = typeof run.checkout?.repository === "string" ? run.checkout.repository : null;
  const verified = hashOrNull(run.checkout?.head);
  const shipped = await shippedCommit(projectRoot, initiative, slice);
  const recorded = (Array.isArray(run.files) ? run.files : []).filter((file) => typeof file?.path === "string").map((file) => ({ path: file.path, blob: hashOrNull(file.blob) }));
  const answer = (shown, blobs, message) => ({
    initiative, slice, repository, verified, shipped, shown,
    files: recorded.map((file) => {
      if (!shown) return { ...file, shownBlob: null, state: "not available" };
      const shownBlob = blobs.get(file.path) ?? null;
      return { ...file, shownBlob, state: shownBlob === file.blob ? "same as verified" : "changed after verification" };
    }),
    message,
    ...(run.filesTruncated === true ? { filesTruncated: true } : {})
  });
  const state = code && repository ? (await code.state(repository).catch(() => null))?.state ?? "off" : "off";
  if (state !== "on") return answer(null, null, `The code of ${repository ?? "the slice's repository"} is not available on this machine, because its code content is ${state === "unreachable" ? "unreachable" : "off"}, so the review app cannot show the slice's files.`);
  const paths = recorded.map((file) => file.path);
  for (const [commit, source] of [[verified, "verified"], [shipped, "ship"]]) {
    if (!commit || !(await code.reachable(repository, commit))) continue;
    const blobs = await code.blobs(repository, commit, paths);
    if (blobs) return answer({ commit, source }, blobs, null);
  }
  return answer(null, null, `Neither the verified commit nor a commit recorded at ship is in the code clone of ${repository}, so the review app cannot show the slice's files; work that was never pushed shows only as its presence.`);
}
