// Probe: which tracked files outside the moved folders name a moved file by its project-relative path, and which name only a moved folder.
// Usage: node references.mjs <project root>
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] ?? process.cwd();
const folders = ["docs/requirements", "docs/ADRs", "docs/plans"];
const files = ["docs/roadmap.md", "docs/Glossary.md"];
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"]).toString().split("\0").filter(Boolean);
const inside = (file) => files.includes(file) || folders.some((folder) => file.startsWith(`${folder}/`));
const moved = tracked.filter(inside);
const byFile = [], byFolder = [];
for (const file of tracked.filter((item) => !inside(item))) {
  let text;
  try { text = await readFile(path.join(root, file), "utf8"); } catch { continue; }
  if (moved.some((name) => text.includes(name))) byFile.push(file);
  else if (folders.some((name) => text.includes(name))) byFolder.push(file);
}
console.log(JSON.stringify({ movedFiles: moved.length, namingMovedFile: byFile, namingOnlyMovedFolder: byFolder.length }));
