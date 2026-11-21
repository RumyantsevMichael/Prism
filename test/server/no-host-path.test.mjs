import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "./fixtures/no-host-path.mjs";

// Every test process takes the real hosts off PATH before any test runs, so no test can start a real Claude Code or Codex session,
// while the other executables beside a host stay reachable by name.
const GUARD = fileURLToPath(new URL("./fixtures/no-host-path.mjs", import.meta.url));

test("a test process finds no claude or codex on PATH, and still finds the tools kept beside them", { skip: process.platform === "win32" ? "the check runs POSIX executables" : false }, (t) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "prism-host-folder-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const name of ["claude", "codex", "helper"]) {
    writeFileSync(path.join(folder, name), `#!/bin/sh\necho ${name}\n`);
    chmodSync(path.join(folder, name), 0o755);
  }
  const probe = "const { spawnSync } = require('node:child_process'); console.log(JSON.stringify(['claude', 'codex', 'helper'].map((name) => spawnSync(name, { encoding: 'utf8' }).stdout?.trim() || null)));";
  const env = { ...process.env, PATH: folder };
  delete env.PRISM_TEST_PATH_GUARDED;
  const found = JSON.parse(execFileSync(process.execPath, ["--import", GUARD, "-e", probe], { env, encoding: "utf8" }));
  assert.deepEqual(found, [null, null, "helper"]);
  const left = process.env.PATH.split(path.delimiter).filter(Boolean).flatMap((entry) => ["claude", "codex"].filter((host) => existsSync(path.join(entry, host))).map((host) => path.join(entry, host)));
  assert.deepEqual(left, [], "this test process holds no host on PATH either");
});
