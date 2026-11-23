import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Prism launches a headless Claude Code or Codex session by itself for each format migration run it starts, finding the host on PATH.
// The tests and the review demo scripts run Prism on throwaway projects, so they must never find a real host:
// each PATH folder that holds one is replaced by a folder of links to everything else in it, so node, npm, and the rest stay reachable.
// Importing this module makes the current process's PATH hostless, so every process it starts inherits that PATH.
// The folder of links for a PATH folder is one fixed folder per that folder and its listing, which every process reuses, so runs leave no new folders behind.

const HOST_EXECUTABLES = ["claude", "codex"].flatMap((name) => process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, name] : [name]);
const shadows = new Map();

function withoutHosts(folder) {
  if (!folder || !HOST_EXECUTABLES.some((name) => existsSync(path.join(folder, name)))) return folder;
  // Windows links need privileges, so there a folder that holds a host is left out of PATH instead.
  if (process.platform === "win32") return null;
  if (shadows.has(folder)) return shadows.get(folder);
  let names = [];
  try { names = readdirSync(folder).sort(); } catch {}
  const key = createHash("sha256").update(JSON.stringify([folder, names])).digest("hex").slice(0, 16);
  const shadow = path.join(os.tmpdir(), `prism-hostless-path-${key}`);
  if (!ownFolder(shadow)) {
    // Each process builds the folder aside and renames it into place, so a concurrent process either wins the rename or reuses the winner's folder.
    const building = mkdtempSync(path.join(os.tmpdir(), `prism-hostless-path-${key}-`));
    for (const name of names) if (!HOST_EXECUTABLES.includes(name)) try { symlinkSync(path.join(folder, name), path.join(building, name)); } catch {}
    try { renameSync(building, shadow); } catch { rmSync(building, { recursive: true, force: true }); }
    // A fixed folder that someone else made, or that is no folder, is never trusted: this process keeps a private one and removes it at exit.
    if (!ownFolder(shadow)) return privateShadow(folder, names);
  }
  shadows.set(folder, shadow);
  return shadow;
}

// A folder that this user made and only this user may change, which a link cannot stand in for.
function ownFolder(folder) {
  try {
    const stats = lstatSync(folder);
    return stats.isDirectory() && (typeof process.getuid !== "function" || stats.uid === process.getuid()) && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function privateShadow(folder, names) {
  const shadow = mkdtempSync(path.join(os.tmpdir(), "prism-hostless-path-own-"));
  for (const name of names) if (!HOST_EXECUTABLES.includes(name)) try { symlinkSync(path.join(folder, name), path.join(shadow, name)); } catch {}
  process.once("exit", () => rmSync(shadow, { recursive: true, force: true }));
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
