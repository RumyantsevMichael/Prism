import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Git names a Windows path with forward slashes, as Prism hands it to Git.
const gitPath = (file) => process.platform === "win32" ? file.replaceAll("\\", "/") : file;

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
const { gitTransportPath, localRepository } = await import("../../dist/server/workflow/git-local-repository.mjs");
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

test("only a remote that Git reaches by its local transport gets the helper with hooks turned off", async (context) => {
  for (const url of ["/srv/stores/records.git", "../records.git", "records.git", "file:///srv/stores/records.git", "./a:b"]) assert.ok(localTransport(url), url);
  // Git takes only a lowercase file:// as its own transport, and hands FILE:// to a remote helper named FILE.
  for (const url of ["git@example.com:team/records.git", "example.com:records.git", "ssh://example.com/records.git", "https://example.com/records.git", "git://example.com/records.git", "ext::sh -c true", "FILE:///srv/records.git"]) {
    assert.ok(!localTransport(url), url);
    assert.deepEqual(await remoteHelperOption("--receive-pack", [url]), [], url);
  }
  const parent = await folder(context);
  const remote = path.join(parent, "records.git");
  git(parent, ["init", "-q", "--bare", remote]);
  const [option, unsigned, ...rest] = await remoteHelperOption("--receive-pack", ["https://example.com/records.git", pathToFileURL(remote).href]);
  // The helper is a shell function that runs receive-pack in the repository its own text names, and ignores the path Git appends to it.
  assert.match(option, /^--receive-pack=prism_pinned_helper\(\) \{ exec git -c 'core\.hooksPath=.*no-hooks' -c 'core\.alternateRefsCommand=exit 0;' -c 'core\.alternateRefsPrefixes=' -c 'receive\.denyCurrentBranch=refuse' .* receive-pack '(.*)'; \}; prism_pinned_helper$/);
  assert.ok(option.endsWith(` receive-pack '${gitPath(remote)}'; }; prism_pinned_helper`), option);
  for (const setting of ["receive.autogc=false", "gc.auto=0", "maintenance.auto=false", "core.fsmonitor=", "hook.pre-receive.enabled=false", "hook.post-receive.enabled=false", "hook.reference-transaction.enabled=false", "hook.pre-auto-gc.enabled=false"]) {
    assert.ok(option.includes(` -c '${setting}' `), setting);
  }
  assert.equal(unsigned, "--no-signed");
  assert.deepEqual(rest, []);
  const fetching = await remoteHelperOption("--upload-pack", [remote]);
  assert.equal(fetching.length, 1);
  assert.match(fetching[0], /^--upload-pack=prism_pinned_helper\(\) \{ exec git -c 'core\.hooksPath=.* -c 'receive\.autogc=false' .* upload-pack '.*'; \}; prism_pinned_helper$/);
  // A local URL at which Git finds no repository gets no helper at all.
  await assert.rejects(remoteHelperOption("--upload-pack", ["file:///srv/prism-no-such-folder/records.git"]), /No Git repository is found at the local remote file:\/\/\/srv\/prism-no-such-folder\/records\.git/);
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
  // gc.recentObjectsHook exists from Git 2.42, so an older Git's maintenance never runs it, and only the check of Prism's push above applies there.
  const [major, minor] = /(\d+)\.(\d+)/.exec(git(parent, ["--version"])).slice(1).map(Number);
  if (major > 2 || (major === 2 && minor >= 42)) assert.match(await read(marker), /recentObjectsHook/, "plain Git's push started no maintenance, so the test proves nothing");
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

// A remote whose configuration sets up the hook audit, as Git 2.54 and later run it, and optionally one whose name holds an equals sign.
function configureHooks(remote, { unnamed = false } = {}) {
  git(remote, ["config", "hook.audit.event", "post-receive"]);
  git(remote, ["config", "hook.audit.command", "true"]);
  if (unnamed) git(remote, ["config", "hook.a=b.command", "true"]);
}

const helperNames = async (url, base) => (await remoteHelperOption("--receive-pack", [url], base))[0];

test("Git's path for a local remote URL follows transport.c and connect.c, with a Windows drive and UNC form", () => {
  const cases = [
    ["linux", "file:///home/me/My%20Drive/records.git", "/home/me/My Drive/records.git"],
    ["linux", "file://server/share/records.git", "/share/records.git"],
    ["linux", "/srv/records.git///", "/srv/records.git///"],
    ["linux", "~/stores/records.git", "~/stores/records.git"],
    ["linux", "[a]/records.git", "]/records.git"],
    ["linux", "file:///srv/a%2Fb%00.git", "/srv/a/b%00.git"],
    ["win32", "file:///C:/Users/me/My%20Drive/records.git", "C:/Users/me/My Drive/records.git"],
    ["win32", "file://C:/stores/records.git", "C:/stores/records.git"],
    ["win32", "C:\\stores\\records.git", "C:\\stores\\records.git"],
    ["win32", "D:/stores/records.git", "D:/stores/records.git"],
    ["win32", "file://server/share/records.git", "//server/share/records.git"],
    ["win32", "file:////server/share/records.git", "//server/share/records.git"],
    ["win32", "\\\\server\\share\\records.git", "\\\\server\\share\\records.git"],
    ["win32", "//server/share/records.git", "//server/share/records.git"]
  ];
  for (const [platform, url, expected] of cases) assert.deepEqual(gitTransportPath(url, platform)?.path, expected, `${platform} ${url}`);
  // A drive path names an SSH host off Windows, and another transport's URL or a remote helper is no local transport.
  for (const [platform, url] of [["linux", "C:/stores/records.git"], ["linux", "FILE:///srv/records.git"], ["win32", "https://example.com/r.git"], ["win32", "host:records.git"]]) {
    assert.equal(gitTransportPath(url, platform), null, `${platform} ${url}`);
  }
  // Git refuses these before it starts a helper.
  for (const [platform, url] of [["linux", "file://"], ["linux", "./a://b"], ["linux", "-records.git"], ["win32", "file://server"]]) assert.deepEqual(gitTransportPath(url, platform), { stops: true }, `${platform} ${url}`);
  // Whether Git takes a Windows path with a reserved name as a path or an SSH host depends on core.protectNTFS, and a URL that decodes to bytes that are not UTF-8 cannot be opened by Node.
  for (const [platform, url] of [["win32", "C:/stores/con/records.git"], ["win32", "C:/stores/name./records.git"], ["linux", "file:///srv/%FF.git"]]) assert.throws(() => gitTransportPath(url, platform), `${platform} ${url}`);
});

test("a percent-encoded file:// URL reads the hook names, refuses a hook it cannot name, and names the repository on the command line", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "My Drive", "remote.git");
  await mkdir(path.dirname(remote), { recursive: true });
  await remoteWithBranch(parent, remote);
  configureHooks(remote, { unnamed: true });
  const encoded = pathToFileURL(remote).href;
  assert.match(encoded, /My%20Drive/);
  assert.deepEqual(await localRepository(encoded, parent), { path: gitPath(remote) });
  await assert.rejects(helperNames(encoded, parent), /hook named "a=b"/);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  git(store, ["remote", "set-url", "origin", encoded]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const refused = await syncRecordStoreNow(store);
  assert.equal(refused.state, "git_failed", JSON.stringify(refused));
  assert.match(refused.message, /hook named "a=b"/);
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{}", "the sync pushed to a remote whose hook it could not turn off");
  // A first clone of the same URL refuses it too.
  const projectRoot = path.join(parent, "project");
  await mkdir(projectRoot);
  useManagedStores(projectRoot, path.join(parent, "stores"));
  await assert.rejects(managedRecordStore(projectRoot, encoded, (message) => Object.assign(new Error(message), { code: "store_unavailable" })), (error) => error.code === "store_unavailable" && /hook named "a=b"/.test(error.message));
  git(remote, ["config", "--unset", "hook.a=b.command"]);
  assert.ok((await helperNames(encoded, parent)).includes(" -c 'hook.audit.enabled=false' "));
  const trace = path.join(parent, "trace");
  process.env.GIT_TRACE = trace;
  try {
    const status = await syncRecordStoreNow(store);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.equal(status.ahead, 0, "the remote-tracking branch did not follow the push");
  } finally {
    delete process.env.GIT_TRACE;
  }
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"store\":true}");
  assert.equal(git(store, ["rev-parse", "refs/remotes/origin/main"]), git(remote, ["rev-parse", "main"]));
  assert.equal(git(store, ["config", "remote.origin.url"]), encoded, "the sync changed the person's remote");
  const helpers = (await read(trace)).split("\n").filter((line) => line.includes("run_command:") && /(upload|receive)-pack '/.test(line));
  assert.ok(helpers.length >= 2, "the trace shows no remote-side helper");
  for (const line of helpers) assert.ok(line.includes(`pack '\\''${gitPath(remote)}'\\''`) || line.includes(`pack '${gitPath(remote)}'`), line);
  const managed = await managedRecordStore(projectRoot, encoded, (message) => new Error(message));
  assert.equal(git(managed, ["config", "remote.origin.url"]), encoded, "the first clone did not record the remote as configured");
  assert.equal(await readFile(path.join(managed, "roadmap.json"), "utf8"), "{\"store\":true}\n");
  await writeFile(path.join(managed, "roadmap.json"), "{\"managed\":true}\n");
  assert.equal((await syncRecordStoreNow(managed)).state, "ok");
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"managed\":true}");
});

test("a remote path that starts with ~ or ends with slashes reads the hook names of the repository Git enters", async (context) => {
  const parent = await folder(context);
  const home = path.join(environment, "stores");
  await mkdir(home, { recursive: true });
  const atHome = path.join(home, `${path.basename(parent)}.git`);
  context.after(() => rm(atHome, { recursive: true, force: true }));
  await remoteWithBranch(parent, atHome);
  configureHooks(atHome);
  const tilde = `~/stores/${path.basename(parent)}.git`;
  assert.deepEqual(await localRepository(tilde, parent), { path: gitPath(atHome) });
  assert.ok((await helperNames(tilde, parent)).includes(" -c 'hook.audit.enabled=false' "), tilde);
  // Git drops the trailing slashes before it tries the .git suffixes, so records/ names records.git.
  const remote = path.join(parent, "records.git");
  await mkdir(path.join(parent, "seeds"));
  await remoteWithBranch(path.join(parent, "seeds"), remote);
  configureHooks(remote);
  for (const url of [`${path.join(parent, "records")}/`, `${remote}///`, `${pathToFileURL(remote).href}/`]) {
    assert.deepEqual(await localRepository(url, parent), { path: gitPath(remote) }, url);
    assert.ok((await helperNames(url, parent)).includes(" -c 'hook.audit.enabled=false' "), url);
  }
  for (const [url, target] of [[tilde, atHome], [`${path.join(parent, "records")}/`, remote]]) {
    const store = path.join(parent, `store-${target === remote ? "slash" : "tilde"}`);
    git(parent, ["clone", "-q", target, store]);
    git(store, ["remote", "set-url", "origin", url]);
    git(target, ["config", "hook.a=b.command", "true"]);
    await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
    assert.equal((await syncRecordStoreNow(store)).state, "git_failed", url);
    git(target, ["config", "--unset", "hook.a=b.command"]);
    const status = await syncRecordStoreNow(store);
    assert.equal(status.state, "ok", `${url}: ${JSON.stringify(status)}`);
    assert.equal(git(target, ["show", "main:roadmap.json"]), "{\"store\":true}", url);
  }
});

test("a remote whose path is a .git file reads the hook names of the Git directory that the file names", async (context) => {
  const parent = await folder(context);
  const real = path.join(parent, "real.git");
  await remoteWithBranch(parent, real);
  configureHooks(real);
  const linked = path.join(parent, "linked");
  await mkdir(linked);
  await writeFile(path.join(linked, ".git"), "gitdir: ../real.git\n");
  const pointer = path.join(parent, "pointer");
  await writeFile(pointer, `gitdir: ${real}\n`);
  for (const url of [linked, pathToFileURL(linked).href, pointer, path.relative(parent, linked)]) {
    assert.deepEqual(await localRepository(url, parent), { path: gitPath(real) }, url);
    assert.ok((await helperNames(url, parent)).includes(" -c 'hook.audit.enabled=false' "), url);
  }
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", real, store]);
  git(store, ["remote", "set-url", "origin", linked]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(real, ["show", "main:roadmap.json"]), "{\"store\":true}");
  // A .git file that names no repository makes Git stop on its own, so the sync fails as Git's fetch does.
  await writeFile(pointer, "gitdir: missing.git\n");
  assert.deepEqual(await localRepository(pointer, parent), { stops: true });
});

test("url.<base>.insteadOf, push URLs, and pushInsteadOf reach the repository that the hook names come from", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "shared", "remote.git");
  await mkdir(path.dirname(remote), { recursive: true });
  await remoteWithBranch(parent, remote);
  configureHooks(remote);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  const shared = path.join(parent, "shared");
  git(store, ["config", `url.${shared}/.insteadOf`, "team:"]);
  git(store, ["config", `url.${pathToFileURL(shared).href}/.pushInsteadOf`, "team:"]);
  git(store, ["remote", "set-url", "origin", "team:remote.git"]);
  assert.equal(git(store, ["remote", "get-url", "--push", "origin"]), `${pathToFileURL(shared).href}/remote.git`);
  await writeFile(path.join(store, "roadmap.json"), "{\"insteadOf\":true}\n");
  assert.equal((await syncRecordStoreNow(store)).state, "ok");
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"insteadOf\":true}");
  // Two push URLs that spell one repository differently push to it once, and a hook named with = on it refuses the push.
  git(store, ["remote", "set-url", "--add", "--push", "origin", "team:remote.git"]);
  git(store, ["remote", "set-url", "--add", "--push", "origin", `${remote}/`]);
  assert.deepEqual(git(store, ["remote", "get-url", "--push", "--all", "origin"]).split("\n"), [`${shared}/remote.git`, `${remote}/`]);
  git(remote, ["config", "hook.a=b.command", "true"]);
  await writeFile(path.join(store, "roadmap.json"), "{\"pushurl\":true}\n");
  assert.equal((await syncRecordStoreNow(store)).state, "git_failed");
  git(remote, ["config", "--unset", "hook.a=b.command"]);
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(status.ahead, 0);
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"pushurl\":true}");
  assert.equal(git(store, ["config", "remote.origin.url"]), "team:remote.git", "the sync changed the person's remote");
  // A push URL that reaches a network remote beside the local repository is refused, since Prism pushes the local one by its path.
  git(store, ["remote", "set-url", "--add", "--push", "origin", "https://example.invalid/remote.git"]);
  await writeFile(path.join(store, "roadmap.json"), "{\"mixed\":true}\n");
  const mixed = await syncRecordStoreNow(store);
  assert.equal(mixed.state, "git_failed", JSON.stringify(mixed));
  assert.match(mixed.message, /example\.invalid/);
});

test("a local remote URL whose repository Prism cannot find the way Git does is refused, by a sync with git_failed and by a first clone with store_unavailable", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "remote.git");
  await remoteWithBranch(parent, remote);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  git(store, ["remote", "set-url", "origin", "~prism-no-such-user/remote.git"]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const status = await syncRecordStoreNow(store);
  if (process.platform === "win32") {
    // Git for Windows has no ~user home lookup and reads the URL as a folder below the store, which holds no repository.
    assert.equal(status.state, "fetch_failed", JSON.stringify(status));
    assert.match(status.message, /No Git repository is found at the local remote/);
  } else {
    assert.equal(status.state, "git_failed", JSON.stringify(status));
    assert.match(status.message, /cannot tell which repository Git opens for the local remote ~prism-no-such-user\/remote\.git/);
  }
  const projectRoot = path.join(parent, "project");
  await mkdir(projectRoot);
  useManagedStores(projectRoot, path.join(parent, "stores"));
  const url = `${pathToFileURL(parent).href}/%FF.git`;
  await assert.rejects(managedRecordStore(projectRoot, url, (message) => Object.assign(new Error(message), { code: "store_unavailable" })), (error) => error.code === "store_unavailable" && /cannot tell which repository/.test(error.message));
});

// A folder of its own for each plain clone that seeds a remote, so one test can seed several remotes.
async function seeded(parent, remote) {
  const seeds = await mkdtemp(path.join(parent, "seed-"));
  await remoteWithBranch(seeds, remote);
}

const helpersIn = async (trace) => (await read(trace)).split("\n").filter((line) => line.includes("run_command:") && /(upload|receive)-pack '/.test(line));

test("the helper enters the repository it names, whatever path Git appends to it, for a path with spaces, quotes, $, backticks, and non-ASCII letters", async (context) => {
  const parent = await folder(context);
  // Windows forbids a double quote in a file name, so there the folder keeps every other character.
  const odd = path.join(parent, process.platform === "win32" ? "it's a $HOME `x` café" : "it's a \"$HOME\" `x` café");
  await mkdir(odd);
  const real = path.join(odd, "real.git");
  const moved = path.join(parent, "moved.git");
  await seeded(parent, real);
  await seeded(parent, moved);
  git(moved, ["branch", "-m", "main", "moved"]);
  const [fetching] = await remoteHelperOption("--upload-pack", [real], parent);
  // Plain Git follows the rule to the other repository, and the helper still enters the one it names.
  const rule = ["-c", `url.${moved}.insteadOf=${real}`];
  assert.match(execFileSync("git", [...rule, "ls-remote", real], { env: process.env }).toString(), /refs\/heads\/moved/);
  const trace = path.join(parent, "trace");
  const listed = execFileSync("git", [...rule, "ls-remote", fetching, real], { env: { ...process.env, GIT_TRACE: trace } }).toString();
  assert.match(listed, /refs\/heads\/main/);
  assert.doesNotMatch(listed, /refs\/heads\/moved/);
  const [started] = await helpersIn(trace);
  assert.ok(started?.includes(`prism_pinned_helper '\\''${moved}'\\''`), `Git did not append the rewritten path: ${started}`);
  // A push whose pushInsteadOf rule rewrites the path lands in the repository the helper names too.
  const clone = path.join(parent, "clone");
  git(parent, ["clone", "-q", real, clone]);
  const pushing = await remoteHelperOption("--receive-pack", [real], parent);
  git(clone, ["-c", `url.${moved}.pushInsteadOf=${real}`, "push", "-q", ...pushing, real, "HEAD:refs/heads/pinned"]);
  assert.ok(has(real, "refs/heads/pinned"), "the push did not reach the repository the helper names");
  assert.ok(!has(moved, "refs/heads/pinned"), "the push reached the repository the rule names");
});

test("a url.<base>.insteadOf or pushInsteadOf rule that matches the repository's own path refuses the sync and the first clone", async (context) => {
  const parent = await folder(context);
  const real = path.join(parent, "real");
  const moved = path.join(parent, "moved");
  await mkdir(real);
  await mkdir(moved);
  await seeded(parent, path.join(real, "remote.git"));
  await seeded(parent, path.join(moved, "remote.git"));
  await symlink(real, path.join(parent, "link"));
  const viaLink = path.join(parent, "link", "remote.git");
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", path.join(real, "remote.git"), store]);
  git(store, ["remote", "set-url", "origin", viaLink]);
  // Plain Git reaches the real folder through the link, where the rule does not apply, so a sync naming the real folder's path must not let the rule apply either.
  assert.deepEqual(await localRepository(viaLink, store), { path: gitPath(path.join(real, "remote.git")) });
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  for (const kind of ["insteadOf", "pushInsteadOf"]) {
    // Git matches a rule against the path Prism names, which on Windows has forward slashes.
    git(store, ["config", `url.${gitPath(moved)}/.${kind}`, `${gitPath(real)}/`]);
    const status = await syncRecordStoreNow(store);
    assert.equal(status.state, "git_failed", `${kind}: ${JSON.stringify(status)}`);
    assert.match(status.message, new RegExp(`url\\.<base>\\.${kind} rule .* matches ${gitPath(path.join(real, "remote.git")).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    git(store, ["config", "--unset", `url.${gitPath(moved)}/.${kind}`]);
  }
  for (const side of [real, moved]) assert.equal(git(path.join(side, "remote.git"), ["show", "main:roadmap.json"]), "{}", side);
  assert.equal((await syncRecordStoreNow(store)).state, "ok");
  assert.equal(git(path.join(real, "remote.git"), ["show", "main:roadmap.json"]), "{\"store\":true}");
  // The person's global rule refuses the first clone the same way.
  const global = path.join(parent, "gitconfig");
  await writeFile(global, "");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  try {
    git(parent, ["config", "--global", `url.${gitPath(moved)}/.insteadOf`, `${gitPath(real)}/`]);
    const projectRoot = path.join(parent, "project");
    await mkdir(projectRoot);
    useManagedStores(projectRoot, path.join(parent, "stores"));
    await assert.rejects(managedRecordStore(projectRoot, pathToFileURL(viaLink).href, (message) => Object.assign(new Error(message), { code: "store_unavailable" })),
      (error) => error.code === "store_unavailable" && /insteadOf rule .* matches/.test(error.message));
  } finally {
    process.env.GIT_CONFIG_GLOBAL = before;
  }
});

test("a local remote reached through a name that is not UTF-8 is refused, by a sync with git_failed and by a first clone with store_unavailable", async (context) => {
  const parent = await folder(context);
  const latin = (name) => Buffer.concat([Buffer.from(path.join(parent, "caf")), Buffer.from([0xe9]), Buffer.from(name)]);
  // A .git file or a commondir file that names such a folder is refused before any path is opened.
  const pointer = path.join(parent, "pointer");
  await writeFile(pointer, Buffer.concat([Buffer.from("gitdir: "), latin(".git"), Buffer.from("\n")]));
  await assert.rejects(localRepository(pointer, parent), /pointer holds a name that is not UTF-8/);
  const worktree = path.join(parent, "worktree.git");
  await mkdir(worktree);
  await writeFile(path.join(worktree, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(worktree, "commondir"), Buffer.concat([latin(".git"), Buffer.from("\n")]));
  await assert.rejects(localRepository(worktree, parent), /commondir holds a name that is not UTF-8/);
  await assert.rejects(localRepository(`${pathToFileURL(parent).href}/caf%E9.git`, parent), /not UTF-8/);
  // macOS and Windows file systems hold only UTF-8 names, so only here can a folder be named this way.
  if (process.platform !== "linux") return;
  const remote = path.join(parent, "remote.git");
  await seeded(parent, remote);
  git(remote, ["config", "hook.a=b.command", "true"]);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  await rename(remote, latin(".git"));
  const shortcut = path.join(parent, "shortcut.git");
  await symlink(latin(".git"), shortcut);
  git(store, ["remote", "set-url", "origin", shortcut]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const status = await syncRecordStoreNow(store);
  assert.equal(status.state, "git_failed", JSON.stringify(status));
  assert.match(status.message, /shortcut\.git holds a name that is not UTF-8/);
  assert.equal(git(shortcut, ["show", "main:roadmap.json"]), "{}", "the sync pushed to a remote whose hooks it could not read");
  const projectRoot = path.join(parent, "project");
  await mkdir(projectRoot);
  useManagedStores(projectRoot, path.join(parent, "stores"));
  await assert.rejects(managedRecordStore(projectRoot, pathToFileURL(shortcut).href, (message) => Object.assign(new Error(message), { code: "store_unavailable" })),
    (error) => error.code === "store_unavailable" && /not UTF-8/.test(error.message));
});

test("a first clone whose URL an insteadOf rule turns into a ~/ path clones the repository Git enters there and reads its hook names", async (context) => {
  const parent = await folder(context);
  const atHome = path.join(environment, "stores", `${path.basename(parent)}-clone.git`);
  context.after(() => rm(atHome, { recursive: true, force: true }));
  await seeded(parent, atHome);
  configureHooks(atHome, { unnamed: true });
  const global = path.join(parent, "gitconfig");
  await writeFile(global, "");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  const trace = path.join(parent, "trace");
  try {
    git(parent, ["config", "--global", "url.~/stores/.insteadOf", "me@team:"]);
    const configured = `me@team:${path.basename(atHome)}`;
    assert.equal(git(parent, ["ls-remote", "--get-url", configured]), `~/stores/${path.basename(atHome)}`);
    const projectRoot = path.join(parent, "project");
    await mkdir(projectRoot);
    useManagedStores(projectRoot, path.join(parent, "stores"));
    const unavailable = (message) => Object.assign(new Error(message), { code: "store_unavailable" });
    await assert.rejects(managedRecordStore(projectRoot, configured, unavailable), (error) => error.code === "store_unavailable" && /hook named "a=b"/.test(error.message));
    git(atHome, ["config", "--unset", "hook.a=b.command"]);
    process.env.GIT_TRACE = trace;
    const managed = await managedRecordStore(projectRoot, configured, unavailable);
    delete process.env.GIT_TRACE;
    assert.equal(git(managed, ["config", "remote.origin.url"]), configured);
    assert.equal(await readFile(path.join(managed, "roadmap.json"), "utf8"), "{}\n");
    const [started] = await helpersIn(trace);
    assert.ok(started?.includes(" -c '\\''hook.audit.enabled=false'\\'' ") && started.includes(`upload-pack '\\''${gitPath(atHome)}'\\''`), started);
    await writeFile(path.join(managed, "roadmap.json"), "{\"managed\":true}\n");
    assert.equal((await syncRecordStoreNow(managed)).state, "ok");
    assert.equal(git(atHome, ["show", "main:roadmap.json"]), "{\"managed\":true}");
  } finally {
    delete process.env.GIT_TRACE;
    process.env.GIT_CONFIG_GLOBAL = before;
  }
});

test("a local remote at which Git finds no repository is neither fetched nor pushed, and a first clone of it is refused", async (context) => {
  const parent = await folder(context);
  const remote = path.join(parent, "remote.git");
  await seeded(parent, remote);
  const store = path.join(parent, "store");
  git(parent, ["clone", "-q", remote, store]);
  const missing = path.join(parent, "missing.git");
  git(store, ["remote", "set-url", "origin", missing]);
  await writeFile(path.join(store, "roadmap.json"), "{\"store\":true}\n");
  const trace = path.join(parent, "trace");
  process.env.GIT_TRACE = trace;
  let fetched;
  try { fetched = await syncRecordStoreNow(store); } finally { delete process.env.GIT_TRACE; }
  assert.equal(fetched.state, "fetch_failed", JSON.stringify(fetched));
  assert.match(fetched.message, /No Git repository is found at the local remote .*missing\.git/);
  assert.deepEqual(await helpersIn(trace), [], "a helper started for a remote with no repository");
  // A push URL with no repository behind it is not pushed either.
  git(store, ["remote", "set-url", "origin", remote]);
  git(store, ["remote", "set-url", "--push", "origin", missing]);
  const pushed = await syncRecordStoreNow(store);
  assert.equal(pushed.state, "push_rejected", JSON.stringify(pushed));
  assert.match(pushed.message, /No Git repository is found at the local remote .*missing\.git/);
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{}");
  const projectRoot = path.join(parent, "project");
  await mkdir(projectRoot);
  useManagedStores(projectRoot, path.join(parent, "stores"));
  await assert.rejects(managedRecordStore(projectRoot, pathToFileURL(missing).href, (message) => Object.assign(new Error(message), { code: "store_unavailable" })),
    (error) => error.code === "store_unavailable" && /Git could not clone it: no Git repository is found at the local remote file:/.test(error.message));
});
