import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Evaluates an SPDX expression: OR needs one acceptable side, AND needs both, and parentheses group.
export function satisfies(expression, accepts) {
  const tokens = String(expression).replace(/[()]/g, " $& ").trim().split(/\s+/);
  let position = 0;
  const primary = () => {
    if (tokens[position] === "(") { position++; const value = or(); position++; return value; }
    let id = tokens[position++];
    if (tokens[position] === "WITH") position += 2;
    return accepts(id);
  };
  const and = () => { let value = primary(); while (tokens[position] === "AND") { position++; value = primary() && value; } return value; };
  const or = () => { let value = and(); while (tokens[position] === "OR") { position++; value = and() || value; } return value; };
  return or();
}

const matches = (patterns, id) => patterns.some(pattern => pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern);

// A package that is not dev-only reaches users and must carry an allowed license; a dev-only package must not carry a forbidden one.
export function violations(lockfile, policy) {
  const found = [];
  for (const [location, entry] of Object.entries(lockfile.packages ?? {})) {
    if (!location) continue;
    const name = entry.name ?? location.replace(/^.*node_modules\//, "");
    const license = typeof entry.license === "string" && entry.license.trim() ? entry.license.trim() : "UNKNOWN";
    if (Object.hasOwn(policy.approved, name)) continue;
    const ships = !entry.dev;
    const acceptable = ships
      ? satisfies(license, id => matches(policy.allowed, id))
      : satisfies(license, id => !matches(policy.notAllowed, id));
    if (!acceptable) found.push({ name, version: entry.version, license, ships });
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const policy = JSON.parse(await readFile(path.join(root, "scripts/dependency-licenses.json"), "utf8"));
  let failed = false;
  for (const file of policy.lockfiles) {
    const lockfile = JSON.parse(await readFile(path.join(root, file), "utf8"));
    for (const { name, version, license, ships } of violations(lockfile, policy)) {
      failed = true;
      console.error(`${file}: ${name}@${version} is licensed ${license}, which is not allowed for a ${ships ? "shipped" : "development-only"} dependency.`);
    }
  }
  if (failed) {
    console.error("See Dependencies in CONTRIBUTING.md; an approved exception goes in scripts/dependency-licenses.json.");
    process.exit(1);
  }
  console.log(`Dependency licenses follow the policy in ${policy.lockfiles.length} lockfiles.`);
}
