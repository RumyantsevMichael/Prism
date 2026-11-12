import { writePlanFile } from "./plan-files.mjs";

// A split into parts needs evidence, so fixtures cite an Unprobed assumption that they write into the parent's slice.md, in the record store when the project names one.
export const UNPROBED = "the storage service keeps the order of reports";

export async function splitEvidence(root, folder, settledBy) {
  await writePlanFile(root, `${folder}/slice.md`, `\n## Assumptions\n- Unprobed: ${UNPROBED}; the command refuses an unordered page.\n`, { append: true });
  return { kind: "unfrozen", assumption: UNPROBED, settledBy };
}
