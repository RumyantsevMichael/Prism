import { conservationStore } from "../conservation/conservation-store.mjs";
import { writeArtifactText } from "./record-store.mjs";

export function generatedNotice(recordName: string) {
  return `This file is a generated view of ${recordName}.`;
}

/**
 * Write a generated view at its project-relative path, in the record store when the project names one and the path is an artifact path, else in the checkout.
 * A projection replaces only a missing file or an earlier generated view, so hand-written Markdown is never overwritten, unless replace is true.
 */
export async function writeProjection(root: string, file: string, contents: string, recordName: string, { replace = false }: { replace?: boolean } = {}) {
  let handWritten = false;
  await writeArtifactText(root, file, (existing: string | null) => {
    if (existing !== null && !replace && !existing.includes(generatedNotice(recordName))) {
      handWritten = true;
      return undefined;
    }
    return contents;
  }, { write: (target: string, text: string) => conservationStore.writeManaged(root, target, text), follow: true });
  return handWritten ? { written: false, reason: "hand_written_projection" } : { written: true };
}
