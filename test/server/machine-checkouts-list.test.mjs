import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkoutsFile, recordCheckout } from "../../dist/server/workflow/machine-checkouts.mjs";

// The machine's checkout list on its own: each test has a private application folder and plain folders for a store and its checkouts.
async function place(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-checkout-list-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const env = { PRISM_REVIEW_APP_DIR: path.join(parent, "app") };
  await mkdir(path.join(parent, "store"));
  const checkout = async (name, workflow = "## Workspace\n- Store: ../store\n- Repository: api\n") => {
    await mkdir(path.join(parent, name, ".prism"), { recursive: true });
    await writeFile(path.join(parent, name, ".prism", "workflow.md"), workflow);
    return path.join(parent, name);
  };
  return { parent, env, store: path.join(parent, "store"), checkout, file: checkoutsFile(env) };
}

const read = async (file) => JSON.parse(await readFile(file, "utf8"));

test("an unreadable list is replaced by a list of the recorded checkout", async (context) => {
  const at = await place(context);
  const api = await at.checkout("api");
  await mkdir(path.dirname(at.file), { recursive: true });
  await writeFile(at.file, "{ not json");
  assert.equal(await recordCheckout({ store: at.store, repository: "api", path: api, env: at.env }), true);
  const list = await read(at.file);
  assert.equal(list.schemaVersion, 1);
  assert.deepEqual(list.checkouts.map(({ path: where }) => where), [api]);
  assert.match(await readFile(at.file, "utf8"), /\n$/);
});

test("recording the same path again replaces its entry, and entries of other repositories stay whatever their folders hold", async (context) => {
  const at = await place(context);
  const api = await at.checkout("api");
  const web = await at.checkout("web", "## Workspace\n- Store: ../store\n- Repository: web\n");
  await recordCheckout({ store: at.store, repository: "web", path: web, env: at.env, now: new Date("2026-01-01T00:00:00Z") });
  await recordCheckout({ store: at.store, repository: "api", path: api, env: at.env, now: new Date("2026-01-01T00:00:00Z") });
  await rm(web, { recursive: true, force: true });
  await recordCheckout({ store: at.store, repository: "api", path: api, env: at.env, now: new Date("2026-02-01T00:00:00Z") });
  const { checkouts } = await read(at.file);
  assert.deepEqual(checkouts.map(({ repository, path: where, recordedAt }) => ({ repository, path: where, recordedAt })), [
    { repository: "api", path: api, recordedAt: "2026-02-01T00:00:00.000Z" },
    { repository: "web", path: web, recordedAt: "2026-01-01T00:00:00.000Z" }
  ]);
});
