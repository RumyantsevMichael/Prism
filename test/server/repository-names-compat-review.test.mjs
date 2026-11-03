import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloneOf, configure, git, registration, repository, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Review proofs for the repository-registration slice (compatibility lane): how long a running server trusts a name check.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-compat-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const { forgetMigrations, recordStoreOf } = await import("../../dist/server/workflow/record-store.mjs");
const failure = (promise) => promise.then(() => null, (error) => error);

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-compat-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, store: await storeFolder(parent) };
}

test("C1: a running server accepts a shallow clone by its root commit after the git fetch --unshallow its refusal asks for", async (context) => {
  const { parent, store } = await folder(context);
  const api = await repository(parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  assert.equal((await recordStoreOf(api)).repository, "api");
  assert.ok((await registration(store, "api")).root);

  const moved = await cloneOf(api, parent, "moved", { shallow: true, repository: "api" });
  git(moved, "remote", "set-url", "origin", "https://example.com/acme/api.git");
  const refusal = await failure(recordStoreOf(moved));
  assert.equal(refusal?.code, "repository_name_taken");
  assert.match(refusal.message, /shallow/);

  git(moved, "remote", "set-url", "origin", `file://${api}`);
  git(moved, "fetch", "-q", "--unshallow");
  git(moved, "remote", "set-url", "origin", "https://example.com/acme/api.git");
  assert.equal(git(moved, "rev-parse", "--is-shallow-repository"), "false");
  // The refusal is trusted for five seconds, as an acceptance is, and the check after that sees the revealed root commit.
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.equal((await recordStoreOf(moved)).repository, "api", "the same process accepts the unshallowed clone without a restart");
  assert.deepEqual((await registration(store, "api")).remotes, ["https://github.com/acme/api.git", "https://example.com/acme/api.git"]);
});

test("C2: a refused name check is reused for five seconds, as an accepted one is", async (context) => {
  const { parent } = await folder(context);
  const api = await repository(parent, "api", { remote: "https://github.com/acme/api.git", repository: "Not Valid" });
  assert.equal((await failure(recordStoreOf(api)))?.code, "repository_name_invalid");
  await configure(api, { repository: "api" });
  assert.equal((await failure(recordStoreOf(api)))?.code, "repository_name_invalid", "the refusal is reused without checking again");
  forgetMigrations();
  assert.equal((await recordStoreOf(api)).repository, "api", "a forgotten refusal is checked again");
});
