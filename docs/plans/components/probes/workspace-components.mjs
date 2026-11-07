// Read a Bun workspace's packages as components would see them: folder, name, test script, and workspace dependencies.
// Usage: node workspace-components.mjs <repository root>
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const graph = new Map();
const unnamed = [];
for (const folder of readdirSync(path.join(root, "packages")).sort()) {
  const manifest = path.join(root, "packages", folder, "package.json");
  if (!existsSync(manifest)) { unnamed.push(folder); continue; }
  const json = JSON.parse(readFileSync(manifest, "utf8"));
  const all = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
  graph.set(json.name, { folder, test: json.scripts?.test ?? null, bunfig: existsSync(path.join(root, "packages", folder, "bunfig.toml")),
    deps: Object.entries(all).filter(([, version]) => String(version).startsWith("workspace:")).map(([name]) => name) });
}
const cycles = [];
const state = new Map();
const visit = (name, stack) => {
  if (state.get(name) === 1) { cycles.push([...stack.slice(stack.indexOf(name)), name].join(" > ")); return; }
  if (state.get(name) === 2) return;
  state.set(name, 1);
  for (const dependency of graph.get(name)?.deps ?? []) visit(dependency, [...stack, dependency]);
  state.set(name, 2);
};
for (const name of graph.keys()) visit(name, [name]);
const dependents = new Map();
for (const [name, entry] of graph) for (const dependency of entry.deps) dependents.set(dependency, [...(dependents.get(dependency) ?? []), name]);
const transitive = (name) => {
  const seen = new Set(), queue = [name];
  while (queue.length) for (const next of dependents.get(queue.pop()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen.size;
};
const tests = {};
for (const entry of graph.values()) tests[entry.test] = (tests[entry.test] ?? 0) + 1;
console.log(JSON.stringify({
  packages: graph.size,
  withoutPackageJson: unnamed,
  nameDiffersFromFolder: [...graph].filter(([name, entry]) => name !== entry.folder).map(([name]) => name),
  testScripts: tests,
  ownBunfig: [...graph.values()].filter((entry) => entry.bunfig).length,
  cycles,
  mostTransitiveDependents: [...graph.keys()].map((name) => [name, transitive(name)]).sort((a, b) => b[1] - a[1]).slice(0, 5)
}, null, 2));
