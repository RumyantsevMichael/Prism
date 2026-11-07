// Probe: which path names make `git add -A`, the command store sync's commit runs, fail for the whole store.
// Usage: node git-path-names.mjs <scratch folder>
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const folder = process.argv[2];
const git = (...args) => { try { execFileSync("git", args, { cwd: folder, stdio: "pipe" }); return 0; } catch (error) { return error.status; } };
mkdirSync(folder, { recursive: true });
git("init", "-q", "-b", "main");
const names = [".git", ".GIT", ".Git", ".git.", ".git ", "git~1", "GIT~1", ".git::$INDEX_ALLOCATION", ".git~1", ".gitx", ".gitignore", ".GITIGNORE", ".gitmodules", ".gitattributes", "my.git", "digit"];
const result = {};
// Each entry is the exit code of git add -A and whether the index then holds the written files.
const add = (name, files, settings = []) => {
  rmSync(path.join(folder, "artifacts"), { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), "x\n");
  }
  const exit = git(...settings, "add", "-A", "--", ".");
  const indexed = execFileSync("git", ["ls-files"], { cwd: folder }).toString().split("\n").filter(Boolean).length;
  result[name] = { exit, indexed: `${indexed}/${files.length}` };
  git("reset", "-q");
};
for (const name of names) add(JSON.stringify(name), [`artifacts/plans/y/${name}/HEAD`]);
// A folder that looks like a repository's Git folder makes Git take it for an embedded repository.
add("\".git\" repository-like", ["artifacts/plans/y/.git/HEAD", "artifacts/plans/y/.git/objects/keep", "artifacts/plans/y/.git/refs/keep"]);
// macOS turns core.protectHFS on by default, which makes Git ignore these invisible characters when it compares a name with .git.
add("\".g\\u200cit\" protectHFS", ["artifacts/plans/y/.g\u200cit/HEAD"], ["-c", "core.protectHFS=true"]);
add("\".g\\u200cit\" no protectHFS", ["artifacts/plans/y/.g\u200cit/HEAD"], ["-c", "core.protectHFS=false"]);
rmSync(path.join(folder, "artifacts"), { recursive: true, force: true });
console.log(JSON.stringify(result));
