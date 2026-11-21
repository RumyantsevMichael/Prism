import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Under Node's test runner, without PRISM_ACP_AGENTS or PRISM_REVIEW_APP_DIR, Prism reads ACP declarations and installs from fixed
// folders in the shared temporary directory. A folder missing when Prism checks it could be created by another user before the read,
// so a missing folder declares no agent and holds no install, and nothing under it is read.

const posixOnly = process.platform === "win32" || !process.getuid ? "the temporary directory is per user on Windows" : false;
const { readDeclarations, readInstalls } = await import("../../dist/server/session/acp-agents.mjs");

// Points the temporary directory at a private scratch folder, and makes the first check of `folder` find it missing and then plants
// it, as another user racing the check would.
function raceOn(t, folderOf, plant) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "prism-acp-race-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const folder = folderOf();
  const lstat = fs.lstatSync;
  let planted = false;
  fs.lstatSync = function (target, ...rest) {
    if (!planted && path.resolve(String(target)) === folder) {
      planted = true;
      plant(folder);
      const error = new Error(`ENOENT: no such file or directory, lstat '${folder}'`);
      error.code = "ENOENT";
      throw error;
    }
    return lstat.call(this, target, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstatSync = lstat;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(scratch, { recursive: true, force: true });
  });
  return () => planted;
}

const uid = () => process.getuid?.() ?? "user";
const env = { NODE_TEST_CONTEXT: "child-v8" };

test("a shared declaration folder missing at the check declares no agent and its file is not read", { skip: posixOnly }, (t) => {
  const planted = raceOn(t, () => path.join(os.tmpdir(), `prism-test-config-${uid()}`), (folder) => {
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(path.join(folder, "acp-agents.json"), JSON.stringify({ agents: [{ id: "planted", label: "Planted", command: "/bin/sh" }] }));
  });
  const read = readDeclarations(env);
  assert.equal(planted(), true, "the check ran");
  assert.deepEqual([read.state, read.reason, read.agents], ["missing", null, []]);
});

test("a shared review app folder missing at the check holds no install and its records are not read", { skip: posixOnly }, (t) => {
  const planted = raceOn(t, () => path.join(os.tmpdir(), `prism-test-app-${uid()}`), (folder) => {
    const version = path.join(folder, "agents", "planted", "1.0.0");
    mkdirSync(version, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(version, "install.json"), JSON.stringify({ id: "planted", name: "Planted", version: "1.0.0", command: "/bin/sh", args: [], env: {} }));
    writeFileSync(path.join(folder, "agents", "planted", "current.json"), JSON.stringify({ version: "1.0.0" }));
  });
  assert.deepEqual(readInstalls(env), []);
  assert.equal(planted(), true, "the check ran");
});
