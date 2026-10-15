import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { modelAssetName } from "../../dist/server/repository-intelligence/native-semantic-runtime.mjs";

// Copy the pinned model files into release assets, so the runtime needs only the release host.
export async function mirrorModel(manifest, directory, fetchBytes = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}) {
  await mkdir(directory, { recursive: true });
  const names = [];
  for (const file of manifest.model.files) {
    const bytes = await fetchBytes(file.url || `https://huggingface.co/${manifest.model.id}/resolve/${manifest.model.revision}/${file.path}`);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`${file.path} does not match the pinned model.`);
    const name = modelAssetName(file.path);
    await writeFile(path.join(directory, name), bytes);
    names.push(name);
  }
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("Supply the release asset directory.");
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../../vendor/native-runtime/manifest.json", import.meta.url)), "utf8"));
  process.stdout.write((await mirrorModel(manifest, directory)).join("\n") + "\n");
}
