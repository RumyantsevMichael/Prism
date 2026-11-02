import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

// A split into parts needs evidence, so fixtures cite an Unprobed assumption that they write into the parent's slice.md.
export const UNPROBED = "the storage service keeps the order of reports";

export async function splitEvidence(root, folder, settledBy) {
  await mkdir(path.join(root, folder), { recursive: true });
  await appendFile(path.join(root, folder, "slice.md"), `\n## Assumptions\n- Unprobed: ${UNPROBED}; the command refuses an unordered page.\n`);
  return { kind: "unfrozen", assumption: UNPROBED, settledBy };
}
