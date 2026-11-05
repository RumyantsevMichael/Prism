// Count what a components proposal derived from a Bun workspace would hold: folders matched by package.json workspaces, how many lack a package.json, and which manifests name them.
// Usage: node docs/plans/components/component-slices/probes/workspace-manifests.mjs <repository root>
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
const folders = [];
for (const pattern of patterns) {
  const [base, star] = pattern.split("/");
  if (star !== "*") { folders.push(pattern); continue; }
  for (const name of readdirSync(path.join(root, base)).sort()) if (!name.startsWith(".") && statSync(path.join(root, base, name)).isDirectory()) folders.push(`${base}/${name}`);
}
const kinds = {};
for (const folder of folders) {
  const kind = ["package.json", "Cargo.toml", "go.mod", "Package.swift"].find((file) => existsSync(path.join(root, folder, file))) ?? "none";
  kinds[kind] = (kinds[kind] ?? 0) + 1;
}
const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "go.work.sum"].filter((file) => existsSync(path.join(root, file)));
console.log(JSON.stringify({ patterns, folders: folders.length, firstManifest: kinds, lockfiles }));
