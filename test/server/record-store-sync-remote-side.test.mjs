import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// A remote reached by a path or a file:// URL has its receive-pack and upload-pack run on this machine, so no hook or command that the remote's own files name runs during a sync or a first clone,
// and a sync's fetch removes only the remote-tracking branches its remote no longer holds, whatever refspecs the person configured.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-remote-side-env-")));
const plain = path.join(environment, "gitconfig");
await writeFile(plain, "");
// The app folder's path has a space and a quote, as a macOS application folder or a home folder may, so the helper command quotes it for the shell.
const appFolder = path.join(environment, "App Support", "it's");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: plain, GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment, PRISM_REVIEW_APP_DIR: appFolder,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const { cancelRecordSyncs, configureRecordSync, localTransport, remoteHelperOption, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { managedRecordStore, useManagedStores } = await import("../../dist/server/workflow/record-store-remote.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { env: process.env, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const has = (cwd, ref) => { try { git(cwd, ["rev-parse", "--verify", "--quiet", ref]); return true; } catch { return false; } };
const read = (file) => readFile(file, "utf8").catch(() => "");

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-remote-side-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

// A remote whose main branch has one commit, made before any hostile file is planted: a bare one pushed by a plain Git clone, or a checkout that commits it.
async function remoteWithBranch(parent, remote, bare = true) {
  git(parent, ["init", "-q", ...(bare ? ["--bare"] : []), "-b", "main", remote]);
  const seed = bare ? path.join(parent, "seed") : remote;
  if (bare) git(parent, ["clone", "-q", remote, seed]);
  await writeFile(path.join(seed, "roadmap.json"), "{}\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "init"]);
  if (bare) git(seed, ["push", "-q", "origin", "HEAD:main"]);
}

async function hook(file, marker) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\necho "$0" >> '${marker}'\n`);
  await chmod(file, 0o755);
}

test("only a remote that Git reaches by its local transport gets the helper with hooks turned off", async () => {
  for (const url of ["/srv/stores/records.git", "../records.git", "records.git", "file:///srv/stores/records.git", "FILE:///srv/records.git", "./a:b"]) assert.ok(localTransport(url), url);
  for (const url of ["git@example.com:team/records.git", "example.com:records.git", "ssh://example.com/records.git", "https://example.com/records.git", "git://example.com/records.git", "ext::sh -c true"]) {
    assert.ok(!localTransport(url), url);
    assert.deepEqual(await remoteHelperOption("--receive-pack", [url]), [], url);
  }
  const [option, unsigned, ...rest] = await remoteHelperOption("--receive-pack", ["https://example.com/records.git", "file:///srv/records.git"]);
  assert.match(option, /^--receive-pack=git -c 'core\.hooksPath=.*no-hooks' -c 'core\.alternateRefsCommand=exit 0;' -c 'core\.alternateRefsPrefixes=' -c 'receive\.denyCurrentBranch=refuse' .* receive-pack$/);
  for (const setting of ["receive.autogc=false", "gc.auto=0", "maintenance.auto=false", "core.fsmonitor=", "hook.pre-receive.enabled=false", "hook.post-receive.enabled=false", "hook.reference-transaction.enabled=false", "hook.pre-auto-gc.enabled=false"]) {
    assert.ok(option.includes(` -c '${setting}' `), setting);
  }
  assert.equal(unsigned, "--no-signed");
  assert.deepEqual(rest, []);
  const fetching = await remoteHelperOption("--upload-pack", ["/srv/records.git"]);
  assert.equal(fetching.length, 1);
  assert.match(fetching[0], /^--upload-pack=git -c 'core\.hooksPath=.* -c 'receive\.autogc=false' .* upload-pack$/);
});

// Automatic maintenance is due on the remote, and its configuration names a command that the maintenance runs to ask which unreachable objects to keep.
async function remoteWithDueMaintenance(parent, marker) {
  const remote = path.join(parent, "shared", "remote.git");
  await mkdir(path.dirname(remote), { recursive: true });
  await remoteWithBranch(parent, remote);
  git(remote, ["repack", "-q", "-a", "-d"]);
  const planted = execFileSync("git", ["-C", remote, "hash-object", "-w", "--stdin"], { input: "planted\n", env: process.env }).toString().trim();
  await utimes(path.join(remote, "objects", planted.slice(0, 2), planted.slice(2)), new Date("2020-01-01"), new Date("2020-01-01"));
  for (const [key, value] of [["receive.unpackLimit", "1"], ["gc.autoPackLimit", "1"], ["gc.autoDetach", "false"], ["maintenance.autoDetach", "false"], ["gc.recentObjectsHook", `echo recentObjectsHook >> '${marker}'; true`]]) {
    git(remote, ["config", key, value]);
  }
  return remote;
}

test("a push to a file:// remote whose configuration makes maintenance due starts no maintenance and runs none of its commands", async (context) => {
  const parent = await folder(context);
  const marker = path.join(parent, "ran-here");
  const remote = await remoteWithDueMaintenance(parent, marker);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", pathToFileURL(remote).href, store]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"store\":true}");
  assert.equal(await read(marker), "", "a command that the remote's own configuration names ran on this machine");
  // The same push by plain Git runs the remote's maintenance and its command, so the remote above did make maintenance due.
  const plain = path.join(parent, "plain");
  git(parent, ["clone", "-q", pathToFileURL(remote).href, plain]);
  await writeFile(path.join(plain, "roadmap.json"), "{\"plain\":true}\n");
  git(plain, ["commit", "-q", "-am", "plain"]);
  git(plain, ["push", "-q", "origin", "HEAD:main"]);
  assert.match(await read(marker), /recentObjectsHook/, "plain Git's push started no maintenance, so the test proves nothing");
});

test("the helper turns off by name each hook that the remote's configuration sets up, and refuses one it cannot name", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "remote.git");
  await remoteWithBranch(parent, remote);
  git(remote, ["config", "hook.audit.event", "post-receive"]);
  git(remote, ["config", "hook.audit.command", "true"]);
  git(remote, ["config", "hook.Post.Notes.parallel", "true"]);
  // A hook.<event>.command makes the event's name a hook's own, so Git 2.55's event switch no longer turns that event off.
  git(remote, ["config", "hook.post-receive.command", "true"]);
  for (const url of [remote, pathToFileURL(remote).href, path.relative(parent, remote)]) {
    const [option] = await remoteHelperOption("--receive-pack", [url], parent);
    for (const name of ["audit", "Post.Notes", "post-receive"]) assert.ok(option.includes(` -c 'hook.${name}.enabled=false' `), `${url}: ${name}`);
  }
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", pathToFileURL(remote).href, store]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  assert.equal((await syncRecordStoreNow(store)).state, "ok");
  git(remote, ["config", "hook.a=b.command", "true"]);
  await writeFile(path.join(store, "roadmap.json"), "{\"again\":true}\n");
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "git_failed", JSON.stringify(status));
  assert.match(status.message, /hook named "a=b"/);
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"store\":true}", "the sync pushed to a remote whose hook it could not turn off");
});

test("a first clone, a fetch, and a push to a file:// or path remote run no hook or command that the remote's own files name", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "shared", "remote.git");
  await mkdir(path.dirname(remote), { recursive: true });
  await remoteWithBranch(parent, remote);
  const marker = path.join(parent, "ran-here");
  // Hooks in the remote's own hooks folder, in a core.hooksPath its configuration names, and a core.alternateRefsCommand that needs no executable file.
  for (const name of ["pre-receive", "update", "post-receive", "post-update", "reference-transaction"]) await hook(path.join(remote, "hooks", name), marker);
  for (const name of ["pre-receive", "post-receive"]) await hook(path.join(parent, "shared", "elsewhere", name), marker);
  git(remote, ["config", "core.hooksPath", path.join(parent, "shared", "elsewhere")]);
  git(parent, ["init", "-q", "--bare", path.join(parent, "shared", "other.git")]);
  await writeFile(path.join(remote, "objects", "info", "alternates"), `${path.join(parent, "shared", "other.git", "objects")}\n`);
  git(remote, ["config", "core.alternateRefsCommand", `echo alternateRefsCommand >> '${marker}'; true`]);
  const trace = path.join(parent, "trace");
  process.env.GIT_TRACE = trace;
  try {
    const projectRoot = path.join(parent, "project");
    await mkdir(projectRoot);
    useManagedStores(projectRoot, path.join(parent, "stores"));
    const managed = await managedRecordStore(projectRoot, pathToFileURL(remote).href, (message) => new Error(message));
    await writeFile(path.join(managed, "roadmap.json"), "{\"managed\":true}\n");
    assert.equal((await syncRecordStoreNow(managed)).state, "ok");
    assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"managed\":true}");
    // A store whose upstream is the remote's plain path syncs the same way; the test's own clone of it is left out of the trace.
    const byPath = path.join(parent, "by-path");
    delete process.env.GIT_TRACE;
    git(parent, ["clone", "-q", remote, byPath]);
    process.env.GIT_TRACE = trace;
    await writeFile(path.join(byPath, "roadmap.json"), "{\"path\":true}\n");
    assert.equal((await syncRecordStoreNow(byPath)).state, "ok");
    assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"path\":true}");
    assert.equal((await syncRecordStoreNow(managed)).state, "ok");
    assert.equal(await readFile(path.join(managed, "roadmap.json"), "utf8"), "{\"path\":true}\n");
  } finally {
    delete process.env.GIT_TRACE;
  }
  assert.equal(await read(marker), "", "a command that the remote's own files name ran on this machine");
  // Git ran each remote-side helper as Prism named it: the clone's and fetches' upload-pack and the pushes' receive-pack all read hooks from Prism's empty folder.
  const helpers = (await read(trace)).split("\n").filter((line) => line.includes("run_command:") && /(upload|receive)-pack '/.test(line));
  assert.ok(helpers.some((line) => line.includes("upload-pack")) && helpers.some((line) => line.includes("receive-pack")), "the trace shows no remote-side helper");
  for (const line of helpers) assert.match(line, /core\.hooksPath=.*no-hooks/, line);
});

test("a push to a local remote's checked-out branch never checks it out with the remote's filters", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "remote");
  await remoteWithBranch(parent, remote, false);
  const marker = path.join(parent, "ran-here");
  await writeFile(path.join(remote, ".gitattributes"), "* filter=planted\n");
  git(remote, ["add", ".gitattributes"]);
  git(remote, ["commit", "-q", "-m", "attributes"]);
  git(remote, ["config", "receive.denyCurrentBranch", "updateInstead"]);
  git(remote, ["config", "filter.planted.smudge", `sh -c 'echo smudge >> "${marker}"; cat'`]);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  const before = git(remote, ["rev-parse", "HEAD"]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "push_rejected");
  assert.match(status.message, /checked out/, "the refusal does not say why");
  assert.equal(git(remote, ["rev-parse", "HEAD"]), before, "the push moved the checked-out branch");
  assert.equal(await read(marker), "", "the remote's filter ran on this machine");
});

test("a sync's fetch keeps the person's tags and refs that their own refspecs map, and still removes stale remote-tracking branches", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "remote.git");
  await remoteWithBranch(parent, remote);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  git(store, ["push", "-q", "origin", "main:refs/heads/other"]);
  git(store, ["fetch", "-q", "origin"]);
  git(remote, ["update-ref", "-d", "refs/heads/other"]);
  // The Git FAQ's way to have fetch update moved tags, and a second copy of the remote's branches.
  git(store, ["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
  git(store, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/backup/*"]);
  git(store, ["tag", "-a", "-m", "milestone", "before-upgrade"]);
  git(store, ["update-ref", "refs/remotes/backup/kept", "HEAD"]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"store\":true}");
  assert.equal(git(store, ["tag", "--list"]), "before-upgrade", "the sync's fetch removed the person's local tag");
  assert.ok(has(store, "refs/remotes/backup/kept"), "the sync's fetch removed a ref the person's own refspec maps");
  assert.ok(!has(store, "refs/remotes/origin/other"), "the fetch kept the remote-tracking branch the remote no longer holds");
  assert.equal(git(store, ["rev-parse", "refs/remotes/origin/main"]), git(remote, ["rev-parse", "main"]));
});
