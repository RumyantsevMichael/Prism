// Probe: every requirement and ADR file states its status on a "Status:" line before its first level-two heading.
// Usage: node status-lines.mjs <project root>
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] ?? process.cwd();
const counts = {};
const missing = [];
async function visit(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (entry.name.endsWith(".md")) {
      const head = (await readFile(target, "utf8")).split(/\r?\n/);
      const end = head.findIndex((line) => line.startsWith("## "));
      const line = head.slice(0, end === -1 ? head.length : end).find((item) => item.startsWith("Status:"));
      if (!line) missing.push(path.relative(root, target));
      else { const value = line.slice("Status:".length).trim().split(" ")[0]; counts[value] = (counts[value] ?? 0) + 1; }
    }
  }
}
for (const kind of ["docs/requirements", "docs/ADRs"]) await visit(path.join(root, kind));
console.log(JSON.stringify({ counts, missing }));
