// Generated from src/server/workflow/projection.mts by scripts/native-build/compile.mjs.
import { conservationStore } from "../conservation/conservation-store.mjs";
import { writeArtifactText } from "./record-store.mjs";
function generatedNotice(recordName) {
  return `This file is a generated view of ${recordName}.`;
}
async function writeProjection(root, file, contents, recordName, { replace = false } = {}) {
  let handWritten = false;
  await writeArtifactText(root, file, (existing) => {
    if (existing !== null && !replace && !existing.includes(generatedNotice(recordName))) {
      handWritten = true;
      return void 0;
    }
    return contents;
  }, { write: (target, text) => conservationStore.writeManaged(root, target, text), follow: true });
  return handWritten ? { written: false, reason: "hand_written_projection" } : { written: true };
}
export {
  generatedNotice,
  writeProjection
};
