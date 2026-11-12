// Probe: Git's tree-level merge of a Markdown file kept one sentence per line combines edits to different sentences and reports edits to one sentence as a conflict.
// Usage: node markdown-merge.mjs <scratch folder>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const folder = process.argv[2];
const git = (...args) => { try { return { code: 0, out: execFileSync("git", args, { cwd: folder, stdio: "pipe" }).toString().trim() }; } catch (error) { return { code: error.status, out: error.stdout.toString().trim() }; } };
mkdirSync(folder, { recursive: true });
git("init", "-q", "-b", "main");
git("-c", "user.name=p", "-c", "user.email=p@example.invalid", "commit", "-q", "--allow-empty", "-m", "root");
const file = path.join(folder, "requirement.md");
const base = "# Title\n\nFirst sentence.\nSecond sentence.\nThird sentence.\n";
const commit = (name, text) => { git("checkout", "-q", "-B", name, "main"); writeFileSync(file, text); git("add", "."); git("-c", "user.name=p", "-c", "user.email=p@example.invalid", "commit", "-q", "-m", name); };
writeFileSync(file, base); git("add", "."); git("-c", "user.name=p", "-c", "user.email=p@example.invalid", "commit", "-q", "-m", "base");
commit("left", base.replace("First sentence.", "First sentence, edited on the left."));
commit("right", base.replace("Third sentence.", "Third sentence, edited on the right."));
commit("clash", base.replace("First sentence.", "First sentence, edited differently."));
const clean = git("merge-tree", "--write-tree", "--name-only", "left", "right");
const conflict = git("merge-tree", "--write-tree", "--name-only", "left", "clash");
const merged = clean.code === 0 ? git("cat-file", "-p", `${clean.out.split("\n")[0]}:requirement.md`).out : null;
console.log(JSON.stringify({ different: { exit: clean.code, merged }, same: { exit: conflict.code, conflicted: conflict.out.split("\n").slice(1).filter(Boolean) } }));
