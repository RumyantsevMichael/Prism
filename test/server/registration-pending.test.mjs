import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloneOf, repository } from "./fixtures/repository-checkouts.mjs";
import { cancelRecordSyncs } from "../../src/server/workflow/record-store-sync.mjs";
import { forgetMigrations, recordStoreOf } from "../../src/server/workflow/record-store.mjs";
import { checkRepositoryName } from "../../src/server/workflow/repository-names.mjs";

// A registration that a synced check has written but not yet confirmed is pending to every check that sees the store folder, whatever its own sync setting.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-registration-pending-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(async () => { cancelRecordSyncs(); forgetMigrations(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fail = (code, message, details) => Object.assign(new Error(message), { code, ...details });
const exists = (target) => access(target).then(() => true, () => false);
const outcome = (promise) => promise.then((value) => value, (error) => ({ code: error.code, pending: error.pending === true }));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A path store that is a clone of a bare remote, with the given ignore file, beside a checkout of repository api on github.com.
async function store(context, { gitignore = null } = {}) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-registration-pending-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(parent, "clone", "-q", path.join(parent, "remote.git"), "store");
  const base = path.join(parent, "store");
  git(base, "checkout", "-q", "-b", "main");
  await writeFile(path.join(base, gitignore === null ? "README.md" : ".gitignore"), gitignore ?? "Prism records\n");
  git(base, "add", ".");
  git(base, "commit", "-q", "-m", "init");
  git(base, "push", "-q", "-u", "origin", "main");
  const api = await repository(parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  // The store's remote answers slowly and then fails, as an unreachable host does, once a test calls slowRemote.
  const slowRemote = () => git(base, "config", "remote.origin.uploadpack", "sleep 2; false");
  return { parent, base, api, slowRemote, remote: path.join(parent, "remote.git"), registration: (name) => path.join(base, "repositories", `${name}.json`) };
}

const check = (value, root, name, sync) => checkRepositoryName({ root, base: value.base, name, fail, sync });

test("a checkout without store sync does not accept a registration that a synced checkout is still confirming", async (context) => {
  const value = await store(context);
  const unsynced = await cloneOf(value.api, value.parent, "api-unsynced", { remote: "https://github.com/acme/api.git" });
  value.slowRemote();
  const first = outcome(check(value, value.api, "api", true));
  await pause(500);
  const concurrent = await outcome(check(value, unsynced, "api", false));
  assert.deepEqual(await first, { code: "repository_unconfirmed", pending: false });
  assert.equal(await exists(value.registration("api")), false, "the registration was withdrawn");
  assert.deepEqual(concurrent, { code: "repository_unconfirmed", pending: true }, "the unsynced checkout is told the registration is still pending");
  assert.deepEqual(await check(value, unsynced, "api", false), { repository: "api", created: true }, "once the pending registration is withdrawn, the name is free again");
});

test("a check that a pending registration would refuse answers repository_unconfirmed instead of refusing on it", async (context) => {
  const value = await store(context);
  const web = await cloneOf(value.api, value.parent, "web", { remote: "https://github.com/acme/api.git" });
  const other = await repository(value.parent, "other", { remote: "https://github.com/beta/api.git" });
  value.slowRemote();
  const first = outcome(check(value, value.api, "api", true));
  await pause(500);
  // The same remote under another name, and the same name for another remote, are each decided only by the pending registration.
  assert.deepEqual(await outcome(check(value, web, "web", false)), { code: "repository_unconfirmed", pending: true });
  assert.deepEqual(await outcome(check(value, other, "api", true)), { code: "repository_unconfirmed", pending: true });
  assert.equal(await exists(value.registration("web")), false);
  await first;
  assert.deepEqual(await check(value, web, "web", false), { repository: "web", created: true }, "the withdrawn registration refuses nothing");
});

test("a pending refusal is not trusted for the five seconds a refusal is", async (context) => {
  const value = await store(context);
  const config = { store: "../store", repository: "api" };
  const synced = await cloneOf(value.api, value.parent, "api-synced", { remote: "https://github.com/acme/api.git", ...config, sync: "on" });
  const unsynced = await cloneOf(value.api, value.parent, "api-plain", { remote: "https://github.com/acme/api.git", ...config });
  value.slowRemote();
  const first = outcome(recordStoreOf(synced));
  await pause(500);
  assert.equal((await outcome(recordStoreOf(unsynced))).code, "repository_unconfirmed");
  assert.equal((await first).code, "repository_unconfirmed");
  assert.equal((await recordStoreOf(unsynced)).repository, "api", "the next operation checks again instead of repeating the pending refusal");
});

test("an accepting check never waits for another registration's confirming sync", async (context) => {
  const value = await store(context);
  assert.deepEqual(await check(value, value.api, "api", true), { repository: "api", created: true });
  const web = await repository(value.parent, "web", { remote: "https://github.com/acme/web.git" });
  value.slowRemote();
  const confirming = outcome(check(value, web, "web", true));
  await pause(500);
  // A check nested inside a held record lock makes the same call, so it must answer at once while web is still being confirmed.
  const started = Date.now();
  assert.deepEqual(await check(value, value.api, "api", true), { repository: "api", created: false });
  assert.ok(Date.now() - started < 1000, `the accepting check took ${Date.now() - started} ms`);
  assert.equal(await exists(path.join(value.base, "repositories.lock")), false, "no lock is held across the confirming sync");
  assert.equal((await confirming).code, "repository_unconfirmed");
});

test("a pending marker whose process exited, or that is no longer renewed, has expired", async (context) => {
  const value = await store(context);
  const contents = { schemaVersion: 1, name: "api", remotes: ["https://github.com/acme/api.git"], root: null, registeredAt: new Date().toISOString() };
  await mkdir(path.join(value.base, "repositories"), { recursive: true });
  await writeFile(value.registration("api"), `${JSON.stringify(contents, null, 2)}\n`);
  const marker = path.join(value.base, ".prism-sync", "registering", "api.json");
  await mkdir(path.dirname(marker), { recursive: true });
  const exited = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }));
  await writeFile(marker, `${JSON.stringify({ pid: exited, host: os.hostname(), token: "crashed", at: new Date().toISOString() })}\n`);
  const unsynced = await cloneOf(value.api, value.parent, "api-unsynced", { remote: "https://github.com/acme/api.git" });
  assert.equal((await check(value, unsynced, "api", false)).repository, "api", "a marker whose process exited no longer holds the registration pending");
  await writeFile(marker, `${JSON.stringify({ pid: 1, host: "another-host", token: "elsewhere", at: new Date().toISOString() })}\n`);
  assert.deepEqual(await outcome(check(value, unsynced, "api", false)), { code: "repository_unconfirmed", pending: true }, "a renewed marker of another host holds it pending");
  const old = new Date(Date.now() - 60000);
  await utimes(marker, old, old);
  assert.equal((await check(value, unsynced, "api", false)).repository, "api", "a marker that is no longer renewed has expired");
});

// A store whose own .gitignore, kept because housekeeping never replaces it, does not ignore *.lock.
test("a confirming sync never commits the registration lock it runs under", async (context) => {
  const value = await store(context, { gitignore: "node_modules/\n" });
  assert.deepEqual(await check(value, value.api, "api", true), { repository: "api", created: true });
  const pushed = git(value.remote, "ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(pushed.includes("repositories/api.json"));
  assert.ok(!pushed.includes("repositories.lock"), "the confirming sync pushed the registration lock to the store's remote");
  assert.ok(!pushed.some((file) => file.startsWith(".prism-sync/")), "the pending marker stays out of the store's commits");
  assert.equal(await exists(path.join(value.base, ".prism-sync", "registering", "api.json")), false, "the confirmed registration is no longer pending");
});
