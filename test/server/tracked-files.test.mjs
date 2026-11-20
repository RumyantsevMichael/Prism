import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Installed packages are never committed, whether as a folder or as a link to one, because a committed link replaces a clean checkout's own install.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("git tracks no node_modules folder or link", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  assert.deepEqual(tracked.filter((file) => file.split("/").includes("node_modules")), []);
});
