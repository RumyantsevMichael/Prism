import { x } from "tar";
import path from "node:path";
import { lstat } from "node:fs/promises";

export async function extractRuntime(archive, directory, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw Object.assign(new Error("The runtime expansion limit is invalid."), { code: "corrupt_asset" });
  let bytes = 0;
  let failure;
  const seen = new Set();
  await x({
    file: archive, cwd: directory, strict: true, preservePaths: false,
    noChmod: true, noMtime: true,
    filter(name, entry) {
      if (failure) return false;
      const normalized = name.replace(/\/$/, "");
      if (!normalized || normalized.includes("\\") || normalized.includes(":") || normalized.startsWith("/")
        || normalized.split("/").some(part => !part || part === "." || part === "..")
        || !["File", "Directory"].includes(entry.type) || seen.has(normalized)) {
        failure = Object.assign(new Error("The runtime archive contains an unsafe entry."), { code: "corrupt_asset" });
        return false;
      }
      seen.add(normalized);
      bytes += entry.size;
      if (bytes > maximumBytes) {
        failure = Object.assign(new Error("The runtime archive exceeds its expansion limit."), { code: "resource_limit" });
        return false;
      }
      return true;
    }
  });
  if (failure) throw failure;
  const info = await lstat(path.join(directory, "runtime.json"));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("The runtime archive has no regular runtime manifest.");
}
