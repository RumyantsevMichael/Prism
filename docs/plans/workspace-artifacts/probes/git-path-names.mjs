// Probe: which path names make `git add -A`, the command store sync's commit runs, fail for the whole store or leave files out.
// Usage: node git-path-names.mjs <scratch folder>
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const folder = process.argv[2];
const git = (...args) => { try { execFileSync("git", args, { cwd: folder, stdio: "pipe" }); return 0; } catch (error) { return error.status; } };
mkdirSync(folder, { recursive: true });
git("init", "-q", "-b", "main");
const names = [".git", ".GIT", ".Git", ".git.", ".git ", "git~1", "GIT~1", ".git::$INDEX_ALLOCATION", ".git~1", ".gitx", ".gitignore", ".GITIGNORE", ".gitmodules", ".gitattributes", "my.git", "digit"];
// Names that begin with an ASCII letter or digit and hold only ASCII letters, digits, ".", "_", and "-", the artifact name form.
const admitted = ["a.", "x...y", "a-", "aux", "con.md", "Report_2", "v1.0-draft.md", "9lives"];
const result = {};
// Each entry is the exit code of git add -A and how many of the written files the index then holds.
const add = (name, files, settings = []) => {
  rmSync(path.join(folder, "artifacts"), { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), "x\n");
  }
  const exit = git(...settings, "add", "-A", "--", ".");
  const indexed = execFileSync("git", ["ls-files", "--", "artifacts"], { cwd: folder }).toString().split("\n").filter(Boolean).length;
  result[name] = { exit, indexed: `${indexed}/${files.length}` };
  git("reset", "-q");
};
for (const name of names) add(JSON.stringify(name), [`artifacts/plans/y/${name}/HEAD`]);
// A folder that looks like a repository's Git folder makes Git take it for an embedded repository.
add("\".git\" repository-like", ["artifacts/plans/y/.git/HEAD", "artifacts/plans/y/.git/objects/keep", "artifacts/plans/y/.git/refs/keep"]);
// macOS turns core.protectHFS on by default, which makes Git ignore these invisible characters when it compares a name with .git.
add("\".g\\u200cit\" protectHFS", ["artifacts/plans/y/.g‌it/HEAD"], ["-c", "core.protectHFS=true"]);
add("\".g\\u200cit\" no protectHFS", ["artifacts/plans/y/.g‌it/HEAD"], ["-c", "core.protectHFS=false"]);
add("admitted names", admitted.map((name) => `artifacts/plans/${name}/${name}`));
// Every store's ignore file lists Prism's lock and temporary files, so the store's Git leaves out any file or folder named like them.
writeFileSync(path.join(folder, ".gitignore"), "*.lock\n.*.tmp\n/.prism-sync/\n");
add("store ignore file", ["artifacts/plans/y/slice.md.lock", "artifacts/plans/a.lock/slice.md", "artifacts/plans/y/.slice.md.1.ab.tmp"]);
add("store ignore file, other case", ["artifacts/plans/y/slice.md.LOCK"]);
rmSync(path.join(folder, "artifacts"), { recursive: true, force: true });
rmSync(path.join(folder, ".gitignore"), { force: true });
console.log(JSON.stringify(result));
