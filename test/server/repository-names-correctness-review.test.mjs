import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, createInitiative, prismServer, repository, snapshot, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Review proofs for the repository-registration slice (correctness lane): registrations stay inside the store and an unreadable one never stalls a checkout.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-names-review-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const { recordStoreOf } = await import("../../dist/server/workflow/record-store.mjs");
const ok = (response) => { assert.equal(response.error, undefined, response.error?.message); return response; };
const failure = (promise) => promise.then(() => null, (error) => error);

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-names-review-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true }); });
  return { parent, app: path.join(parent, "app"), store: await storeFolder(parent) };
}

const server = (context, place, checkout) => prismServer(context, checkout, { appFolder: place.app });

test("R1: a repositories folder that links out of the store never receives a registration", async (context) => {
  const place = await folder(context);
  const outside = path.join(place.parent, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(place.store, "repositories"));
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const response = await (await server(context, place, api)).call("get_roadmap");
  assert.equal(response.error?.data?.code, "invalid_path", "refused as a record outside the store is");
  assert.deepEqual(await snapshot(outside), {}, "nothing was written outside the record store");
});

test("R2: a registration that links to an endless file, or exceeds the size limit, counts as unreadable and does not stall record operations", async (context) => {
  const place = await folder(context);
  await mkdir(path.join(place.store, "repositories"));
  await symlink("/dev/zero", path.join(place.store, "repositories", "zzz.json"));
  await writeFile(path.join(place.store, "repositories", "big.json"), `${JSON.stringify({ schemaVersion: 1, name: "big", remotes: ["https://github.com/acme/big.git"], padding: "x".repeat(70 * 1024) })}\n`);
  const api = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const running = await server(context, place, api);
  const answered = await Promise.race([running.call("get_roadmap").then(ok), new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
  assert.ok(answered, "get_roadmap answered within 10 seconds");
  const big = await repository(place.parent, "big", { remote: "https://github.com/acme/big.git", repository: "big" });
  assert.equal((await failure(recordStoreOf(big)))?.code, "repository_name_taken", "an oversized registration keeps its name and accepts no checkout");
});

test("R3: a repositories folder that cannot be listed still proposes a name to an unnamed checkout and refuses a named one with a code", async (context) => {
  const place = await folder(context);
  await symlink("repositories", path.join(place.store, "repositories"));
  const unnamed = await repository(place.parent, "web", { remote: "https://github.com/acme/web.git" });
  const missing = (await createInitiative(await server(context, place, unnamed))).error?.data;
  assert.deepEqual(missing, { code: "repository_name_missing", proposed: "web" }, "the proposal is derived from the remote alone");
  const named = await repository(place.parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
  const refusal = await failure(recordStoreOf(named));
  assert.equal(refusal?.name, "RecordStoreError");
  assert.equal(refusal.code, "invalid_path");
});
