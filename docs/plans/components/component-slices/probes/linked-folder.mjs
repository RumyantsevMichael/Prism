// Show where a committed symbolic link declared as a component folder resolves, and what Git records for it.
// Usage: node docs/plans/components/component-slices/probes/linked-folder.mjs (from the repository root)
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-probe-")));
const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-probe-outside-")));
const git = (...args) => execFileSync("git", ["-c", "user.name=p", "-c", "user.email=p@p", ...args], { cwd: root, stdio: "pipe" }).toString().trim();
try {
  await mkdir(path.join(root, "packages/shared"), { recursive: true });
  await mkdir(path.join(root, "vendor"), { recursive: true });
  await writeFile(path.join(root, "packages/shared/a.txt"), "a\n");
  await symlink(outside, path.join(root, "vendor/out"));
  await symlink("../packages/shared", path.join(root, "vendor/in"));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  const inside = (target) => target === root || target.startsWith(`${root}${path.sep}`);
  const out = await realpath(path.join(root, "vendor/out"));
  const into = await realpath(path.join(root, "vendor/in"));
  console.log(JSON.stringify({ out: { inside: inside(out) }, in: { inside: inside(into), relative: path.relative(root, into) }, tracked: git("ls-files", "-s", "vendor").split("\n").map((line) => line.split(/\s+/)[0] + " " + line.split("\t")[1]) }));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
