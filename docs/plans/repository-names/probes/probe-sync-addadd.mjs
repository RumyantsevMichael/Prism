// P2: two clones of one store remote each add repositories/api.json with different bytes; what does Prism's store sync do?
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, realpath, readFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
const env = await realpath(await mkdtemp(path.join(os.tmpdir(), "probe-env-")));
await writeFile(path.join(env, "gitconfig"), "");
Object.assign(process.env, { HOME: env, GIT_CONFIG_GLOBAL: path.join(env, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" });
const { syncRecordStore, configureRecordSync } = await import(new URL("../../../../dist/server/workflow/record-store-sync.mjs", import.meta.url).href);
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
const p = env;
git(p, "init", "-q", "--bare", "-b", "main", "remote.git");
git(p, "clone", "-q", "remote.git", "a"); const a = path.join(p, "a");
git(a, "checkout", "-q", "-b", "main"); await writeFile(path.join(a, "README.md"), "x\n"); git(a, "add", "."); git(a, "commit", "-q", "-m", "i"); git(a, "push", "-q", "-u", "origin", "main");
git(p, "clone", "-q", "remote.git", "b"); const b = path.join(p, "b");
for (const [dir, remote] of [[a, "github.com/acme/api"], [b, "github.com/other/api"]]) { await mkdir(path.join(dir, "repositories"), { recursive: true }); await writeFile(path.join(dir, "repositories/api.json"), JSON.stringify({ name: "api", remotes: [remote] }) + "\n"); }
console.log("a:", (await syncRecordStore(a)).state);
const sb = await syncRecordStore(b);
console.log("b:", sb.state, sb.message);
// Same with a record path under initiatives/, which sync treats as a record file.
for (const [dir, v] of [[a, "A"], [b, "B"]]) { await mkdir(path.join(dir, "initiatives/x/claims"), { recursive: true }); await writeFile(path.join(dir, "initiatives/x/claims/s.json"), JSON.stringify({ v }) + "\n"); }
git(b, "checkout", "-q", "--", "."); 
