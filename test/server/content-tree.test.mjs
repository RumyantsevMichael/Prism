import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { contentTree } = await import("../../dist/server/workflow/slice-gate.mjs");
const { readWorkflowConfig } = await import("../../dist/server/workflow/workflow-config.mjs");

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-content-tree-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism", "reports"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(root, ".prism", "reports", "state.json"), "{\"revision\":1}\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Prism", "-c", "user.email=prism@example.invalid", "commit", "-q", "-m", "start");
  // The real index holds a record that differs from HEAD, as it does once a record write has been staged.
  await writeFile(path.join(root, ".prism", "reports", "state.json"), "{\"revision\":2}\n");
  git(root, "add", "-A");
  return root;
}

// A Git that writes the record again just before it runs a removal against a temporary index, which is where a record write that overlaps hashing lands.
async function gitWritingRecordBeforeRemoval(context, record) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-git-shim-")));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = path.join(folder, "git");
  await writeFile(shim, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (process.env.GIT_INDEX_FILE && args[0] === "rm") writeFileSync(${JSON.stringify(record)}, "{\\"revision\\":3}\\n");
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  await chmod(shim, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${folder}${path.delimiter}${previous}`;
  context.after(() => { process.env.PATH = previous; });
}

test("a record write while the project is hashed leaves the content tree unchanged", { skip: process.platform === "win32" && "the Git stand-in is a POSIX script" }, async (context) => {
  const root = await project(context);
  const config = await readWorkflowConfig(root);
  const expected = await contentTree(root, config);
  await gitWritingRecordBeforeRemoval(context, path.join(root, ".prism", "reports", "state.json"));
  assert.equal(await contentTree(root, config), expected);
});
