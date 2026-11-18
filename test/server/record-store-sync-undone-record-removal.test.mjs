import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkout, closeServers, isolateGit, notes, server } from "./fixtures/workspace-artifacts.mjs";

// A record that this machine removed while another machine edited it comes back with the other machine's edit, and the next tool result names that undone removal once, as it names an artifact's.
const environment = await isolateGit();
const { cancelRecordSyncs, configureRecordSync, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const STATE = "initiatives/reports/state.json";
const ROADMAP = "roadmap.json";

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
}

function push(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  git(root, ["push", "-q", "origin", "main"]);
}

// Two machines' stores cloned from one bare remote that holds an initiative's coordination state and a roadmap.
async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-undone-record-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  git(parent, ["clone", "-q", remote, "a"]);
  const a = path.join(parent, "a");
  git(a, ["checkout", "-q", "-b", "main"]);
  await put(a, { "README.md": "Prism store\n", [STATE]: "{\"v\":0}\n", [ROADMAP]: "{\"v\":0}\n" });
  git(a, ["add", "-A"]);
  git(a, ["commit", "-q", "-m", "init"]);
  git(a, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", remote, "b"]);
  const b = path.join(parent, "b");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  return { parent, remote, a, b };
}

// The notes of two later tool results of a Prism server whose project uses the store.
async function laterNotes(context, store) {
  const parent = path.dirname(store);
  const machine = { parent, storeSetting: `../${path.basename(store)}`, app: path.join(parent, `app-${path.basename(store)}`), sync: "on" };
  const prism = await server(context, machine, await checkout(machine, "api"));
  const said = [notes(await prism.call("get_artifact", {})), notes(await prism.call("get_artifact", {}))];
  await closeServers();
  return said;
}

test("a removal of a record that gives way to another machine's edit is named once as an undone removal", { timeout: 200000 }, async (context) => {
  const { a, b } = await stores(context);
  await put(a, { [STATE]: "{\"v\":\"a\"}\n" });
  push(a, "an edit on a");
  await rm(path.join(b, STATE));
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.equal(status.message, "Concurrent changes to records were resolved; this machine's removal of a file gave way to the upstream's change, so the store holds the upstream's version there again.");
  assert.equal(await readFile(path.join(b, STATE), "utf8"), "{\"v\":\"a\"}\n", "the store holds the other machine's record again");

  const [first, second] = await laterNotes(context, b);
  assert.match(first, /^Store sync undid this machine's removal of 1 record, because another machine changed it before this machine's removal reached the store; the store holds it again with the other machine's version\./m, first);
  assert.ok(first.includes(`- .prism/${STATE} in the record store at ${b}`), first);
  assert.doesNotMatch(second, /state\.json/, "the undone removal is named once");
});

test("removals of several records that give way are named together, each once", { timeout: 200000 }, async (context) => {
  const { a, b } = await stores(context);
  await put(a, { [STATE]: "{\"v\":\"a\"}\n", [ROADMAP]: "{\"v\":\"a\"}\n" });
  push(a, "edits on a");
  await rm(path.join(b, STATE));
  await rm(path.join(b, ROADMAP));
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.equal(await readFile(path.join(b, ROADMAP), "utf8"), "{\"v\":\"a\"}\n");

  const [first, second] = await laterNotes(context, b);
  assert.match(first, /^Store sync undid this machine's removal of 2 records, because another machine changed them before this machine's removal reached the store; the store holds them again with the other machine's version\./m, first);
  assert.ok(first.includes(`- .prism/${ROADMAP} in the record store at ${b}`), first);
  assert.ok(first.includes(`- .prism/${STATE} in the record store at ${b}`), first);
  assert.doesNotMatch(second, /roadmap\.json|state\.json/, "the undone removals are named once");
});
