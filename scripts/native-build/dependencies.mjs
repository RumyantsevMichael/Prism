import { cp } from "node:fs/promises";
import path from "node:path";

export async function copyDependencies(source, destination) {
  await cp(source, destination, { recursive: true, filter: file => !file.split(path.sep).includes(".bin") });
}
