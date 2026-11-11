import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, cloneOf, createInitiative, git, notes, prismServer, registration, repository } from "./fixtures/repository-checkouts.mjs";

// Git runs with a private home and configuration, a fixed identity, and only local repositories.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-sync-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const exists = (target) => access(target).then(() => true, () => false);
const ok = (response) => { assert.equal(response.error, undefined, response.error?.message); return response; };
const refused = (response, code) => { assert.ok(response.error, `expected ${code}, got a result`); assert.equal(response.error.data?.code, code, response.error.message); return response.error; };
const remoteFiles = (remote) => git(remote, "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean);
const remoteRegistration = (remote, name) => JSON.parse(git(remote, "show", `main:repositories/${name}.json`));

// Two machines: each has its own Prism application folder and a synced store that is a clone of one bare remote.
async function machines(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-sync-")));
  // A Git command that a stopped server started may still be ending in a store, which Windows reports as busy for a moment.
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  git(parent, "init", "-q", "--bare", "-b", "main", "store-remote.git");
  const remote = path.join(parent, "store-remote.git");
  git(parent, "clone", "-q", remote, "store-a");
  const storeA = path.join(parent, "store-a");
  git(storeA, "checkout", "-q", "-b", "main");
  await writeFile(path.join(storeA, "README.md"), "Prism records\n");
  git(storeA, "add", ".");
  git(storeA, "commit", "-q", "-m", "init");
  git(storeA, "push", "-q", "-u", "origin", "main");
  git(parent, "clone", "-q", remote, "store-b");
  return {
    parent, remote, storeA, storeB: path.join(parent, "store-b"),
    a: { app: path.join(parent, "app-a"), store: "../store-a", sync: "on" },
    b: { app: path.join(parent, "app-b"), store: "../store-b", sync: "on" }
  };
}

const on = (context, machine, checkout) => prismServer(context, checkout, { appFolder: machine.app });
const config = (machine, extra) => ({ store: machine.store, sync: machine.sync, ...extra });

test("the first machine's registration of a name stands, and another repository on a second machine is refused with nothing left behind", async (context) => {
  const value = await machines(context);
  const api = await repository(value.parent, "api", { remote: "https://github.com/acme/api.git", ...config(value.a, { repository: "api" }) });
  ok(await createInitiative(await on(context, value.a, api), "api-work"));
  assert.ok(remoteFiles(value.remote).includes("repositories/api.json"), "the registration reached the store's remote before the result returned");
  assert.deepEqual(remoteRegistration(value.remote, "api").remotes, ["https://github.com/acme/api.git"]);

  // The second machine's store has not pulled the registration when its checkout of another repository names itself api.
  const other = await repository(value.parent, "other", { remote: "https://github.com/beta/api.git", ...config(value.b, { repository: "api" }) });
  const error = refused(await createInitiative(await on(context, value.b, other), "other-work"), "repository_name_taken");
  assert.match(error.message, /https:\/\/github\.com\/acme\/api\.git/);
  assert.match(error.message, /https:\/\/github\.com\/beta\/api\.git/);
  assert.deepEqual(remoteRegistration(value.remote, "api").remotes, ["https://github.com/acme/api.git"], "the remote keeps the first registration");
  assert.deepEqual((await registration(value.storeB, "api")).remotes, ["https://github.com/acme/api.git"], "the second store now holds the first registration");
  assert.equal(await exists(path.join(value.storeB, "initiatives", "other-work")), false, "the refused update wrote nothing");
  assert.equal(remoteFiles(value.remote).some((file) => file.startsWith("initiatives/other-work")), false);

  // The lost registration is the refusal's news: neither the store status nor a later result on that machine reports it as a saved conflict.
  const status = JSON.parse(await readFile(path.join(value.storeB, ".prism-sync", "status.json"), "utf8"));
  assert.equal(status.conflicts.some((conflict) => conflict.path.startsWith("repositories/")), false);
  const web = await repository(value.parent, "web", { remote: "https://github.com/acme/web.git", ...config(value.b, { repository: "web" }) });
  const later = ok(await createInitiative(await on(context, value.b, web), "web-work"));
  assert.doesNotMatch(notes(later), /repositories\//);
});

test("two machines that register one repository under different spellings of its remote both keep working", async (context) => {
  const value = await machines(context);
  const api = await repository(value.parent, "api", { remote: "https://github.com/acme/api.git", ...config(value.a, { repository: "api" }) });
  const apiOnB = await cloneOf(api, value.parent, "api-b", { remote: "git@github.com:acme/api.git", ...config(value.b, { repository: "api" }) });
  ok(await (await on(context, value.a, api)).call("get_roadmap"));
  ok(await (await on(context, value.b, apiOnB)).call("get_roadmap"));
  assert.equal(remoteFiles(value.remote).filter((file) => file.startsWith("repositories/")).length, 1);
  assert.deepEqual(remoteRegistration(value.remote, "api").remotes, ["https://github.com/acme/api.git"]);
});

test("a registration that cannot reach the store's remote is withdrawn and refused", async (context) => {
  const value = await machines(context);
  git(value.storeB, "remote", "set-url", "origin", path.join(value.parent, "missing-remote.git"));
  const web = await repository(value.parent, "web", { remote: "https://github.com/acme/web.git", ...config(value.b, { repository: "web" }) });
  const server = await on(context, value.b, web);
  for (const attempt of [1, 2]) {
    const error = refused(await createInitiative(server, "web-work"), "repository_unconfirmed");
    assert.match(error.message, /web/, `attempt ${attempt}`);
    assert.match(error.message, /fetch_failed/);
    assert.equal(await registration(value.storeB, "web"), null, "the unconfirmed registration was withdrawn");
    assert.equal(await exists(path.join(value.storeB, "initiatives", "web-work")), false);
  }
});

test("a name the store already registered needs no remote, and a moved remote is added without one", async (context) => {
  const value = await machines(context);
  const api = await repository(value.parent, "api", { remote: "https://github.com/acme/api.git", ...config(value.a, { repository: "api" }) });
  ok(await (await on(context, value.a, api)).call("get_roadmap"));
  git(value.storeA, "remote", "set-url", "origin", path.join(value.parent, "missing-remote.git"));
  ok(await createInitiative(await on(context, value.a, api), "offline-work"));
  const moved = await cloneOf(api, value.parent, "moved", { remote: "https://github.com/acme/platform-api.git" });
  ok(await (await on(context, value.a, moved)).call("get_roadmap"));
  assert.deepEqual((await registration(value.storeA, "api")).remotes, ["https://github.com/acme/api.git", "https://github.com/acme/platform-api.git"]);
});
