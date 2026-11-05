import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, cloneOf, configure, git, prismServer, repository, snapshot, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Git runs with a private home and configuration, a fixed identity, and only local repositories; each test has its own Prism application folder.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-machine-checkouts-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const ok = (response) => { assert.equal(response.error, undefined, response.error?.message); return response; };

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-machine-checkouts-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true }); });
  return { parent, app: path.join(parent, "app"), store: await storeFolder(parent) };
}

const listFile = (place) => path.join(place.app, "checkouts.json");
async function readList(place) {
  try { return JSON.parse(await readFile(listFile(place), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
const entries = async (place) => ((await readList(place))?.checkouts ?? []).map(({ store, repository: name, path: where }) => ({ store, repository: name, path: where }));

// A server that names its checkout at start records it in the background, so the test waits for the list to show it.
async function until(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting until ${label}`);
}

test("a server that starts in a named checkout records the checkout for its repository on this machine, without a tool call", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  await prismServer(context, api, { appFolder: place.app });
  await until(async () => (await entries(place)).length === 1, "the checkout is listed");
  const list = await readList(place);
  assert.deepEqual(Object.keys(list).sort(), ["checkouts", "schemaVersion"]);
  assert.equal(list.schemaVersion, 1);
  assert.deepEqual(Object.keys(list.checkouts[0]).sort(), ["path", "recordedAt", "repository", "store"]);
  assert.deepEqual(await entries(place), [{ store: place.store, repository: "api", path: api }]);
  assert.ok(Number.isFinite(Date.parse(list.checkouts[0].recordedAt)));
});

test("a server that learns its checkout from its first tool call records it then, and every host on the machine shares the list", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const web = await repository(place.parent, "web", { remote: "https://github.com/acme/web.git", repository: "web" });
  // A second worktree of api, and a clone of it, both belong to the api repository.
  git(api, "worktree", "add", "-q", path.join(place.parent, "api-feature"), "-b", "feature");
  const feature = await realpath(path.join(place.parent, "api-feature"));
  const clone = await cloneOf(api, place.parent, "api-clone", {});
  const codex = await prismServer(context, web, { appFolder: place.app, hostRoot: false });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(await entries(place), [], "a server that has not seen its checkout records nothing");
  ok(await codex.call("get_roadmap"));
  for (const checkout of [api, feature, clone]) ok(await (await prismServer(context, checkout, { appFolder: place.app, hostRoot: false })).call("get_roadmap"));
  await prismServer(context, api, { appFolder: place.app });
  const expected = [api, clone, feature].sort().map((where) => ({ store: place.store, repository: "api", path: where }));
  expected.push({ store: place.store, repository: "web", path: web });
  await until(async () => JSON.stringify(await entries(place)) === JSON.stringify(expected), "every checkout is listed once, in store, repository, and path order");
});

test("refused and unnamed checkouts stay off the list, and paths never reach the store", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  ok(await (await prismServer(context, api, { appFolder: place.app, hostRoot: false })).call("get_roadmap"));
  const taken = await repository(place.parent, "taken", { remote: "https://github.com/beta/api.git", repository: "api" });
  const invalid = await repository(place.parent, "invalid", { remote: "https://github.com/acme/invalid.git", repository: "Not Valid" });
  const unnamed = await repository(place.parent, "unnamed", { remote: "https://github.com/acme/unnamed.git" });
  for (const [checkout, code] of [[taken, "repository_name_taken"], [invalid, "repository_name_invalid"], [unnamed, "repository_name_missing"]]) {
    const response = await (await prismServer(context, checkout, { appFolder: place.app, hostRoot: false })).call("get_roadmap");
    assert.equal(response.error?.data?.code, code, `${checkout} is refused`);
  }
  assert.deepEqual(await entries(place), [{ store: place.store, repository: "api", path: api }]);
  const stored = JSON.stringify(await snapshot(place.store));
  for (const checkout of [api, taken, invalid, unnamed]) assert.equal(stored.includes(checkout), false, `${checkout} does not appear in the store`);
  assert.equal(stored.includes(place.parent), false, "no local folder appears in the store");
});

test("a listed path that no longer holds a checkout of its repository leaves the list when another checkout of that repository is recorded", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const removed = await cloneOf(api, place.parent, "api-removed", {});
  const renamed = await cloneOf(api, place.parent, "api-renamed", {});
  const moved = await cloneOf(api, place.parent, "api-moved", {});
  for (const checkout of [removed, renamed, moved]) ok(await (await prismServer(context, checkout, { appFolder: place.app, hostRoot: false })).call("get_roadmap"));
  assert.equal((await entries(place)).length, 3);
  await rm(removed, { recursive: true, force: true });
  // This folder now names its repository differently, as a checkout that changed its Repository line would.
  await configure(renamed, { repository: "api-two" });
  // This folder now names another store.
  await storeFolder(place.parent, "other-store");
  await configure(moved, { store: "../other-store", repository: "api" });
  ok(await (await prismServer(context, api, { appFolder: place.app, hostRoot: false })).call("get_roadmap"));
  assert.deepEqual(await entries(place), [{ store: place.store, repository: "api", path: api }]);
});

test("a list written by a newer Prism is left as it is", async (context) => {
  const place = await folder(context);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  await mkdir(place.app, { recursive: true });
  const newer = `${JSON.stringify({ schemaVersion: 2, checkouts: { future: true } })}\n`;
  await writeFile(listFile(place), newer);
  ok(await (await prismServer(context, api, { appFolder: place.app, hostRoot: false })).call("get_roadmap"), "record operations still work");
  assert.equal(await readFile(listFile(place), "utf8"), newer);
});
