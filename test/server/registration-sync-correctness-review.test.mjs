import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cancelRecordSyncs } from "../../src/server/workflow/record-store-sync.mjs";
import { checkRepositoryName } from "../../src/server/workflow/repository-names.mjs";

// Review proofs for the registration-sync slice (correctness lane): no check accepts a registration that is not yet confirmed.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-registration-sync-review-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fail = (code, message, details) => Object.assign(new Error(message), { code, ...details });
const exists = (target) => access(target).then(() => true, () => false);

// A synced store whose remote holds one commit, and a checkout of repository api on github.com.
async function synced(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-registration-sync-review-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(parent, "clone", "-q", path.join(parent, "remote.git"), "store");
  const store = path.join(parent, "store");
  git(store, "checkout", "-q", "-b", "main");
  await writeFile(path.join(store, "README.md"), "Prism records\n");
  git(store, "add", ".");
  git(store, "commit", "-q", "-m", "init");
  git(store, "push", "-q", "-u", "origin", "main");
  git(parent, "init", "-q", "-b", "main", "api");
  const checkout = path.join(parent, "api");
  git(checkout, "remote", "add", "origin", "https://github.com/acme/api.git");
  await writeFile(path.join(checkout, "README.md"), "api\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
  const check = () => checkRepositoryName({ root: checkout, base: store, name: "api", fail, sync: true });
  return { store, checkout, check, registration: path.join(store, "repositories", "api.json") };
}

// A second check that runs while a new registration is being confirmed, as a second server sharing the store folder
// or the same server after its 5-second name-check window does, is refused while the registration is pending instead of accepting it.
test("a check does not accept a registration that another check has written but not yet confirmed", async (context) => {
  const value = await synced(context);
  // The store's remote answers slowly and then fails, as an unreachable host does.
  git(value.store, "config", "remote.origin.uploadpack", "sleep 2; false");
  const first = value.check();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = value.check();
  const [confirming, concurrent] = await Promise.allSettled([first, second]);
  assert.equal(confirming.status, "rejected");
  assert.equal(confirming.reason.code, "repository_unconfirmed");
  assert.equal(concurrent.status, "rejected", "the second check accepted the checkout on a registration that the first check then withdrew");
  assert.equal(concurrent.reason.code, "repository_unconfirmed");
  assert.equal(await exists(value.registration), false, "no unconfirmed registration is left behind");
});

// The same check in another process, as a second server sharing the store folder runs it: { repository } or { code }.
const moduleUrl = new URL("../../src/server/workflow/repository-names.mjs", import.meta.url).href;
const checkElsewhere = (checkout, store) => new Promise((resolve, reject) => {
  const script = `import { checkRepositoryName } from ${JSON.stringify(moduleUrl)};
const fail = (code, message) => Object.assign(new Error(message), { code });
checkRepositoryName({ root: ${JSON.stringify(checkout)}, base: ${JSON.stringify(store)}, name: "api", fail, sync: true })
  .then((value) => console.log(JSON.stringify(value)), (error) => console.log(JSON.stringify({ code: error.code })))
  .finally(() => process.exit(0));`;
  execFile(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
});

test("a check in another process does not accept a registration that is still being confirmed", async (context) => {
  const value = await synced(context);
  git(value.store, "config", "remote.origin.uploadpack", "sleep 2; false");
  const first = value.check().then(() => null, (error) => error.code);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const elsewhere = await checkElsewhere(value.checkout, value.store);
  assert.equal(await first, "repository_unconfirmed");
  assert.deepEqual(elsewhere, { code: "repository_unconfirmed" }, "the other process is refused while the registration is pending");
  assert.equal(await exists(value.registration), false);
});

// A confirming sync that throws, here because the store's sync folder is a file, withdraws the registration as a failed sync does.
test("a confirmation that throws withdraws the registration and refuses with repository_unconfirmed", async (context) => {
  const value = await synced(context);
  await writeFile(path.join(value.store, ".prism-sync"), "not a folder\n");
  for (const attempt of ["first", "later"]) {
    const error = await value.check().then(() => null, (caught) => caught);
    assert.equal(error?.code, "repository_unconfirmed", `the ${attempt} check is refused`);
    assert.match(error.message, /api/);
    assert.equal(await exists(value.registration), false, `the ${attempt} check leaves no registration behind`);
  }
});
