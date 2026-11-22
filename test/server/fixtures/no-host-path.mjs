import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// No test may start a real Claude Code, Codex, or coding agent, or show a real native dialog: a launch, a resume, or a read of a host's
// run options resolves its host on PATH, and a confirmation its dialog program, and on a developer's machine or in a cloud container
// that finds the real one, which starts a real session or asks the person. Imported first by every test run, this takes each PATH
// folder that holds one of those programs out of PATH; on a POSIX system a folder of links to its other executables takes its place,
// so a test that runs node, npm, or another tool kept beside one by name still finds it. A test of a host, an agent, or a dialog puts
// its own stub first.
// On Windows a folder is dropped whole, so the dialog program powershell.exe, which sits beside programs the suite needs, stays on
// PATH; there the confirmation itself runs no dialog program outside the temporary directory under Node's test runner.

/** The hosts that Prism runs itself. */
export const HOST_NAMES = Object.freeze(["claude", "codex"]);
/** The native dialog programs of Linux and macOS that a confirmation runs. */
export const DIALOG_NAMES = Object.freeze(["osascript", "zenity", "kdialog"]);
/** Well-known ACP adapters and agents, among them every agent that the registry fixtures name, which a declaration could name bare. */
export const AGENT_NAMES = Object.freeze([
  "claude-agent-acp", "claude-code-acp", "codex-acp", "gemini", "opencode", "goose", "qwen", "cursor-agent", "copilot", "kiro-cli",
  "auggie", "fast-agent", "fast-agent-acp"
]);
const WINDOWS_SUFFIXES = [".exe", ".cmd", ".bat", ".ps1"];
const POSIX_HIDDEN = [...HOST_NAMES, ...DIALOG_NAMES, ...AGENT_NAMES];
const WINDOWS_HIDDEN = [...HOST_NAMES, ...AGENT_NAMES].flatMap((name) => [name, ...WINDOWS_SUFFIXES.map((suffix) => `${name}${suffix}`)]);

/** Every program name that no test process finds on PATH, in lower case. */
export const HIDDEN_PROGRAMS = new Set(process.platform === "win32" ? WINDOWS_HIDDEN : POSIX_HIDDEN);
export const hiddenProgram = (name) => HIDDEN_PROGRAMS.has(name.toLowerCase());

function entries(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

function withoutHidden(folder) {
  const names = entries(folder);
  if (!names.some(hiddenProgram)) return folder;
  if (process.platform === "win32") return null;
  const kept = mkdtempSync(path.join(os.tmpdir(), "prism-test-path-"));
  for (const name of names) if (!hiddenProgram(name)) symlinkSync(path.join(folder, name), path.join(kept, name));
  return kept;
}

const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
if (!process.env.PRISM_TEST_PATH_GUARDED) {
  process.env[key] = (process.env[key] ?? "").split(path.delimiter).filter(Boolean).map(withoutHidden).filter(Boolean).join(path.delimiter);
  // The person's own ACP declarations are never read, even when the shell names them: a test that declares agents names its own file,
  // and every other process reads a file that no one writes, in a private folder of this run, rather than one that the person or an
  // earlier run left elsewhere.
  process.env.PRISM_ACP_AGENTS = path.join(mkdtempSync(path.join(os.tmpdir(), "prism-test-acp-")), "acp-agents.json");
  // A test file that the runner starts in its own process imports this again, and finds PATH already guarded.
  process.env.PRISM_TEST_PATH_GUARDED = "1";
}
