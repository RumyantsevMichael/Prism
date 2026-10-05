import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

// Input metadata must come from the completed platform build jobs for this release.
export function publishedManifest(original, records, releaseBase) {
  const base = new URL(releaseBase);
  if (base.protocol !== "https:" || base.hostname !== "github.com" || base.username || base.password || base.search || base.hash
    || !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+$/.test(base.pathname)) throw new Error("Use one immutable GitHub release URL.");
  if (original.schemaVersion !== 1 || !original.model?.revision) throw new Error("The pinned model manifest is invalid.");
  const bundles = {};
  for (const platform of PLATFORMS) {
    const record = records[platform];
    if (!record || Object.keys(record).length !== 1 || !record[platform]) throw new Error(`Missing or ambiguous metadata for ${platform}.`);
    const asset = record[platform];
    const expectedUrl = `${base.href}/prism-native-${platform}.tar.gz`;
    if (asset.url !== expectedUrl || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
      || !Number.isSafeInteger(asset.unpackedBytes) || asset.unpackedBytes <= 0) throw new Error(`Invalid published asset metadata for ${platform}.`);
    bundles[platform] = { url: asset.url, bytes: asset.bytes, sha256: asset.sha256, unpackedBytes: asset.unpackedBytes };
  }
  return { ...original, assetVersion: decodeURIComponent(base.pathname.split("/").at(-1)), bundles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, releaseBase, output = fileURLToPath(new URL("../../vendor/native-runtime/manifest.json", import.meta.url))] = process.argv.slice(2);
  if (!directory || !releaseBase) throw new Error("Supply the published metadata directory and immutable release URL.");
  const original = JSON.parse(await readFile(output, "utf8"));
  const records = Object.fromEntries(await Promise.all(PLATFORMS.map(async platform => [platform, JSON.parse(await readFile(path.join(directory, `${platform}.json`), "utf8"))])));
  await writeFile(output, JSON.stringify(publishedManifest(original, records, releaseBase), null, 2) + "\n");
}
