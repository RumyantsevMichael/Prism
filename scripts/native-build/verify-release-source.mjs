import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS, publishedManifest } from "./published-manifest.mjs";

// Version and manifest promotion commits do not change these runtime inputs.
const INPUTS = [
  "native-runtime", "server", "scripts/native-build", "scripts/build-native-runtime.mjs",
  "tsconfig.native.json", "vendor/native-runtime/extract.mjs", "vendor/native-runtime/licenses",
  "vendor/native-runtime/licenses.json", ".github/workflows/native-runtime.yml", ".github/workflows/native-default.yml"
];

export function releaseTag(manifest, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Supply the GitHub repository name.");
  if (!/^native-runtime-\d+-\d+$/.test(manifest.assetVersion)) throw new Error("The manifest must select a published native runtime.");
  const records = Object.fromEntries(PLATFORMS.map(platform => [platform, { [platform]: manifest.bundles?.[platform] }]));
  publishedManifest(manifest, records, `https://github.com/${repository}/releases/download/${manifest.assetVersion}`);
  return manifest.assetVersion;
}

export function verifyReleaseSource(directory, runtimeRef, sourceRef = "HEAD") {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const resolve = ref => git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const runtime = resolve(runtimeRef), source = resolve(sourceRef);
  const changes = git("diff", "--name-only", runtime, source, "--", ...INPUTS).trim();
  if (changes) throw new Error(`The published runtime does not match the release source:\n${changes}`);
  const modelAt = ref => JSON.parse(git("show", `${ref}:vendor/native-runtime/manifest.json`)).model;
  assert.deepEqual(modelAt(runtime), modelAt(source), "The published runtime uses a different model manifest.");
  return { runtime, source };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile("vendor/native-runtime/manifest.json", "utf8"));
  const tag = releaseTag(manifest, process.env.GITHUB_REPOSITORY);
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", `refs/tags/${tag}`], { stdio: "inherit" });
  process.stdout.write(JSON.stringify(verifyReleaseSource(process.cwd(), "FETCH_HEAD")) + "\n");
}
