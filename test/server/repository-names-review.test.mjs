import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, registration, repository, storeFolder } from "./fixtures/repository-checkouts.mjs";

const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-review-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const { collectUnnamedCheckouts, describeRecordStore, forgetMigrations, listInitiatives, recordStoreOf, recordsUnavailable } = await import("../../dist/server/workflow/record-store.mjs");
const { remoteIdentity } = await import("../../dist/server/workflow/repository-names.mjs");
const { listArtifacts } = await import("../../dist/server/review/review-server.mjs");

test("the review browser shows a refused checkout as an unavailable store and still lists its documents", async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-review-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const store = await storeFolder(parent);
  const api = await repository(parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  assert.equal((await recordStoreOf(api)).repository, "api");
  assert.equal((await registration(store, "api")).root, git(api, "rev-list", "--max-parents=0", "HEAD"));

  const other = await repository(parent, "other", { remote: "https://github.com/beta/api.git", repository: "api" });
  await mkdir(path.join(other, "docs", "plans", "reports"), { recursive: true });
  await writeFile(path.join(other, "docs", "plans", "reports", "slice.md"), "# Reports\n");
  const refusal = await listInitiatives(other).then(() => null, (error) => error);
  assert.equal(refusal?.code, "repository_name_taken");
  assert.equal(refusal.proposed, "api-2");
  assert.ok(recordsUnavailable(refusal));
  const described = await describeRecordStore(other);
  assert.equal(described.location, null);
  assert.match(described.unavailable, /repository name api/);
  assert.ok((await listArtifacts(other)).includes("docs/plans/reports/slice.md"), "documents still list");
});

test("only the tool call that opened an unnamed checkout's store collects its warning", async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-review-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  await storeFolder(parent);
  const unnamed = await repository(parent, "Web App", { remote: "git@github.com:acme/Web_App.git" });
  forgetMigrations();
  await recordStoreOf(unnamed);
  const { value, unnamed: warnings } = await collectUnnamedCheckouts(async () => (await recordStoreOf(unnamed)).repository);
  assert.equal(value, null);
  assert.deepEqual(warnings, [{ root: unnamed, proposed: "web_app" }]);
  assert.deepEqual((await collectUnnamedCheckouts(async () => 1)).unnamed, [], "a call that opens no store collects nothing");
});

test("remote identity ignores scheme, user, host case, port, and surrounding slashes but keeps path case", () => {
  for (const spelling of ["github.com:acme/api.git", "https://GitHub.com/acme/api", "ssh://github.com:22/acme/api.git/", "git://github.com/acme/api.git"]) assert.equal(remoteIdentity(spelling), "github.com/acme/api", spelling);
  assert.equal(remoteIdentity("https://github.com/Acme/API.git"), "github.com/Acme/API");
  assert.equal(remoteIdentity(null), null);
});
