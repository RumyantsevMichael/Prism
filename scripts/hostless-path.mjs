import { existsSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Prism launches a headless Claude Code or Codex session by itself for each format migration run it starts, finding the host on PATH.
// The tests and the review demo scripts run Prism on throwaway projects, so they must never find a real host:
// each PATH folder that holds one is replaced by a folder of links to everything else in it, so node, npm, and the rest stay reachable.
// Importing this module makes the current process's PATH hostless, so every process it starts inherits that PATH.

const HOST_EXECUTABLES = ["claude", "codex"].flatMap((name) => process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, name] : [name]);
const shadows = new Map();

function withoutHosts(folder) {
  if (!folder || !HOST_EXECUTABLES.some((name) => existsSync(path.join(folder, name)))) return folder;
  // Windows links need privileges, so there a folder that holds a host is left out of PATH instead.
  if (process.platform === "win32") return null;
  if (shadows.has(folder)) return shadows.get(folder);
  const shadow = mkdtempSync(path.join(os.tmpdir(), "prism-hostless-path-"));
  let names = [];
  try { names = readdirSync(folder); } catch {}
  for (const name of names) if (!HOST_EXECUTABLES.includes(name)) try { symlinkSync(path.join(folder, name), path.join(shadow, name)); } catch {}
  shadows.set(folder, shadow);
  return shadow;
}

/** The PATH value with every folder that holds a Claude Code or Codex executable replaced by one that holds everything else. */
export function hostlessPath(value = "") {
  return String(value).split(path.delimiter).map(withoutHosts).filter((folder) => folder !== null).join(path.delimiter);
}

for (const name of Object.keys(process.env)) if (name.toUpperCase() === "PATH") process.env[name] = hostlessPath(process.env[name]);

// Run as a command, it prints the hostless PATH, so a printed demo command can start Prism with it: PATH="$(node scripts/hostless-path.mjs)" ...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${process.env.PATH ?? ""}\n`);
