import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// No test may start a real Claude Code or Codex: a launch, a resume, or a read of a host's run options resolves its host on PATH, and on a
// developer's machine or in a cloud container that finds the real one, which starts a real session. Imported first by every test run,
// this takes each PATH folder that holds a host executable out of PATH; on a POSIX system a folder of links to its other executables takes
// its place, so a test that runs node, npm, or another tool kept beside a host by name still finds it. A test of a host puts its own stub first.
const HOSTS = new Set(["claude", "codex", "claude.exe", "claude.cmd", "codex.exe", "codex.cmd"]);

function entries(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

function withoutHosts(folder) {
  const names = entries(folder);
  if (!names.some((name) => HOSTS.has(name.toLowerCase()))) return folder;
  if (process.platform === "win32") return null;
  const kept = mkdtempSync(path.join(os.tmpdir(), "prism-test-path-"));
  for (const name of names) if (!HOSTS.has(name.toLowerCase())) symlinkSync(path.join(folder, name), path.join(kept, name));
  return kept;
}

const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
if (!process.env.PRISM_TEST_PATH_GUARDED) {
  process.env[key] = (process.env[key] ?? "").split(path.delimiter).filter(Boolean).map(withoutHosts).filter(Boolean).join(path.delimiter);
  // A test file that the runner starts in its own process imports this again, and finds PATH already without hosts.
  process.env.PRISM_TEST_PATH_GUARDED = "1";
}
