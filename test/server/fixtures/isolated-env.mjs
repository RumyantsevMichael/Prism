import { chmodSync, existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A server, hook, or command that a test spawns sees none of the host's plugin directories or the user's review settings, so it
// never joins the user's review app or writes the host's plugin data, and the browser openers on its PATH do nothing.
// It also never takes the host's cloud session for its own, which would change how it asks for test-command approval.
// It finds no real Claude Code or Codex on its PATH either, since Prism launches a format migration run's session by itself:
// a PATH folder that holds one is replaced by a folder of links to everything else in it, so node, npm, and the rest stay reachable.
const HOST_ONLY = /^(?:PRISM_REVIEW_\w+|CLAUDE_PLUGIN_\w+|PLUGIN_DATA|PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_CODE_REMOTE)$/;
const HOST_EXECUTABLES = new Set(["claude", "codex"]);
let stubs = null;
const hostless = new Map();

function withoutHosts(folder) {
  if (!folder || ![...HOST_EXECUTABLES].some((name) => existsSync(path.join(folder, name)))) return folder;
  if (hostless.has(folder)) return hostless.get(folder);
  const shadow = mkdtempSync(path.join(os.tmpdir(), "prism-test-path-"));
  let names = [];
  try { names = readdirSync(folder); } catch {}
  for (const name of names) if (!HOST_EXECUTABLES.has(name)) try { symlinkSync(path.join(folder, name), path.join(shadow, name)); } catch {}
  hostless.set(folder, shadow);
  return shadow;
}

function browserStubs() {
  if (stubs) return stubs;
  stubs = mkdtempSync(path.join(os.tmpdir(), "prism-test-browser-"));
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(path.join(stubs, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(stubs, name), 0o755);
  }
  return stubs;
}

export function isolatedEnv(overrides = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !HOST_ONLY.test(name)));
  if (process.platform !== "win32") environment.PATH = [browserStubs(), ...(environment.PATH ?? "").split(path.delimiter).map(withoutHosts)].join(path.delimiter);
  // It writes no Prism log either, so a test run leaves the user's log as it was; a test of the log sets its own level and folder.
  return { ...environment, PRISM_REVIEW_BROWSER_ON_START: "off", PRISM_LOG_LEVEL: "off", ...overrides };
}
