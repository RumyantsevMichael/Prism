import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A Prism server can stop in the middle of a sync, as when its host closes, so a sync that stops while it replaces files for a conflicting merge must still keep the local version.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-crash-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const SYNC = new URL("../../dist/server/workflow/record-store-sync.mjs", import.meta.url).href;
const { cancelRecordSyncs, configureRecordSync, syncRecordStoreNow, takeSavedConflicts } = await import(SYNC);
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

// A git that runs the real one, then kills the process that called it right after the step that STOP_AT names, once the merge commit exists.
const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
const wrapper = path.join(environment, "bin", "git");
await mkdir(path.dirname(wrapper), { recursive: true });
await writeFile(wrapper, `#!/bin/bash
"${realGit}" "$@"; code=$?
case "$*" in *"commit-tree"*"prism: merge records"*) touch "$STOP_FLAG" ;; esac
if [[ -f "$STOP_FLAG" ]]; then
  case "$STOP_AT" in
    first-ls-tree) [[ "$*" == *" ls-tree "* ]] && { rm -f "$STOP_FLAG"; kill -9 $PPID; } ;;
    read-tree) [[ "$*" == *" read-tree "* ]] && { rm -f "$STOP_FLAG"; kill -9 $PPID; } ;;
    update-ref) [[ "$*" == *"update-ref -m prism: sync records"* ]] && { rm -f "$STOP_FLAG"; kill -9 $PPID; } ;;
  esac
fi
exit $code
`);
await chmod(wrapper, 0o755);

async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-crash-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  git(parent, ["clone", "-q", "remote.git", "a"]);
  const storeA = path.join(parent, "a");
  git(storeA, ["checkout", "-q", "-b", "main"]);
  await mkdir(path.join(storeA, "artifacts", "plans"), { recursive: true });
  await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n\nOne.\n");
  await writeFile(path.join(storeA, "roadmap.json"), "{}\n");
  git(storeA, ["add", "."]);
  git(storeA, ["commit", "-q", "-m", "init"]);
  git(storeA, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", "remote.git", "b"]);
  return { parent, storeA, storeB: path.join(parent, "b") };
}

// Every saved copy under a store's conflicts folder, by its text.
async function savedTexts(store) {
  const found = [];
  const visit = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await visit(path.join(folder, entry.name));
      else found.push(await readFile(path.join(folder, entry.name), "utf8"));
    }
  };
  await visit(path.join(store, ".prism-sync", "conflicts"));
  return found;
}

// Sync a store in a process of its own that the git wrapper stops at a step of the merge.
function syncStopped(store, stopAt) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const sync = await import(${JSON.stringify(SYNC)}); sync.configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 }); await sync.syncRecordStoreNow(${JSON.stringify(store)});`], {
    env: { ...process.env, PATH: `${path.dirname(wrapper)}:${process.env.PATH}`, STOP_AT: stopAt, STOP_FLAG: path.join(path.dirname(store), "stop-flag") },
    encoding: "utf8"
  });
  assert.equal(child.signal, "SIGKILL", `the sync stops at ${stopAt}: ${child.stderr}`);
}

for (const stopAt of ["first-ls-tree", "read-tree", "update-ref"]) {
  test(`a sync that stops at the conflicting merge's ${stopAt} step keeps the local version saved once, and the next sync and tool result name it`, async (context) => {
    const { storeA, storeB } = await stores(context);
    await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n\nOne, by a.\n");
    git(storeA, ["commit", "-q", "-am", "a's edit"]);
    git(storeA, ["push", "-q", "origin", "main"]);
    await writeFile(path.join(storeB, "artifacts", "plans", "slice.md"), "# Slice\n\nOne, by b.\n");
    syncStopped(storeB, stopAt);
    // The artifact lock that the stopped process held expires 30 seconds after it was taken, which the test stands in for by ageing it.
    const old = new Date(Date.now() - 60000);
    await utimes(path.join(storeB, "artifacts.lock"), old, old).catch(() => {});
    const status = await syncRecordStoreNow(storeB);
    assert.equal(status.state, "conflicts", JSON.stringify(status));
    assert.deepEqual(status.conflicts.map((conflict) => conflict.path), ["artifacts/plans/slice.md"]);
    assert.equal(await readFile(path.join(storeB, status.conflicts[0].savedAs), "utf8"), "# Slice\n\nOne, by b.\n");
    assert.deepEqual(await savedTexts(storeB), ["# Slice\n\nOne, by b.\n"], "the local version is saved exactly once");
    const taken = (await takeSavedConflicts()).filter((item) => item.store === storeB);
    assert.deepEqual(taken.map((item) => item.location), ["plans/slice.md"], "the next tool result names the artifact");
    assert.equal(await readFile(path.join(storeB, "artifacts", "plans", "slice.md"), "utf8"), "# Slice\n\nOne, by a.\n");
    assert.equal((await syncRecordStoreNow(storeB)).state, "ok");
    assert.deepEqual(await readdir(path.join(storeB, ".prism-sync", "saving")).catch(() => []), [], "no stage is left behind");
  });
}
