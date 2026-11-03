import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A server, hook, or command that a test spawns sees none of the host's plugin directories or the user's review settings, so it
// never joins the user's review app or writes the host's plugin data, and the browser openers on its PATH do nothing.
// It also never takes the host's cloud session for its own, which would change how it asks for test-command approval.
const HOST_ONLY = /^(?:PRISM_REVIEW_\w+|CLAUDE_PLUGIN_\w+|PLUGIN_DATA|PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_CODE_REMOTE)$/;
let stubs = null;

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
  if (process.platform !== "win32") environment.PATH = `${browserStubs()}${path.delimiter}${environment.PATH ?? ""}`;
  return { ...environment, PRISM_REVIEW_BROWSER_ON_START: "off", ...overrides };
}
