import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repository, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Review proof for the repository-registration slice (correctness lane, wave 2): a name check that cannot accept because of the store's layout still lets the review browser list documents.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-layout-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const { listArtifacts } = await import("../../dist/server/review/review-server.mjs");
const { loadNavigation } = await import("../../dist/server/review/workspace-model.mjs");

for (const [label, place] of [["a file", (store) => writeFile(path.join(store, "repositories"), "not a folder\n")], ["a link out of the store", async (store) => { const outside = path.join(store, "..", "outside"); await mkdir(outside); await symlink(outside, path.join(store, "repositories")); }]]) {
  test(`R4: the review browser opens without a named checkout's copies of its artifacts when the store's repositories entry is ${label}`, async (context) => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-repository-layout-")));
    context.after(() => rm(parent, { recursive: true, force: true }));
    const store = await storeFolder(parent);
    await place(store);
    const api = await repository(parent, "api", { remote: "https://github.com/acme/api.git", repository: "api" });
    await mkdir(path.join(api, "docs", "plans", "reports"), { recursive: true });
    await writeFile(path.join(api, "docs", "plans", "reports", "slice.md"), "# Reports\n");
    assert.equal((await listArtifacts(api)).includes("docs/plans/reports/slice.md"), false, "an unusable store shows no checkout copy of an artifact");
    assert.ok(await loadNavigation(api), "navigation loads with the records hidden");
  });
}
