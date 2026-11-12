import { readFile } from "node:fs/promises";
import { conservationStore } from "../conservation/conservation-store.mjs";

export function generatedNotice(recordName) {
  return `This file is a generated view of ${recordName}.`;
}

// A projection replaces only a missing file or an earlier generated view, so hand-written Markdown is never overwritten.
export async function writeProjection(root, target, contents, recordName) {
  let existing = null;
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing !== null && !existing.includes(generatedNotice(recordName))) {
    return { written: false, reason: "hand_written_projection" };
  }
  if (existing !== contents) {
    await conservationStore.writeManaged(root, target, contents);
  }
  return { written: true };
}
