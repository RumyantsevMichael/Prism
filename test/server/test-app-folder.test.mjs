import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reviewAppDirectory } from "../../dist/server/review/review-app-discovery.mjs";
import { logDirectory } from "../../dist/server/log.mjs";
import { managedStoresDirectory } from "../../dist/server/workflow/remote-url.mjs";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";

const run = promisify(execFile);
const DISCOVERY = fileURLToPath(new URL("../../dist/server/review/review-app-discovery.mjs", import.meta.url));
const below = (folder, parent) => {
  const relative = path.relative(parent, folder);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// The person's application folder holds the review app's state and every managed store clone, so a test that resolved it could sync a real store.
test("a test process never resolves the person's application folder, its log folder, or its store clones", () => {
  const environment = { ...process.env };
  delete environment.PRISM_REVIEW_APP_DIR;
  delete environment.PRISM_LOG_DIR;
  delete environment.XDG_STATE_HOME;
  for (const folder of [reviewAppDirectory(environment), logDirectory(environment), managedStoresDirectory(environment)]) {
    assert.ok(!below(folder, os.homedir()), `${folder} lies in the home folder`);
    assert.ok(below(folder, os.tmpdir()), `${folder} lies outside the temporary folder`);
  }
});

test("a server or hook that a test spawns resolves the same test folder as the test", async () => {
  const environment = isolatedEnv();
  delete environment.PRISM_REVIEW_APP_DIR;
  delete environment.XDG_STATE_HOME;
  const script = `import(${JSON.stringify(pathToFileURL(DISCOVERY).href)}).then((module) => console.log(module.reviewAppDirectory()))`;
  const { stdout } = await run(process.execPath, ["-e", script], { env: environment });
  const expected = { ...process.env };
  delete expected.PRISM_REVIEW_APP_DIR;
  delete expected.XDG_STATE_HOME;
  assert.equal(stdout.trim(), reviewAppDirectory(expected));
});

test("a folder that a test names keeps its place", () => {
  const named = path.join(os.tmpdir(), "named-app-folder");
  assert.equal(reviewAppDirectory({ ...process.env, PRISM_REVIEW_APP_DIR: named }), named);
});

test("outside a test run the application folder is the person's own", async () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.PRISM_REVIEW_APP_DIR;
  delete environment.XDG_STATE_HOME;
  delete environment.LOCALAPPDATA;
  const script = `import(${JSON.stringify(pathToFileURL(DISCOVERY).href)}).then((module) => console.log(module.reviewAppDirectory()))`;
  const { stdout } = await run(process.execPath, ["-e", script], { env: environment });
  assert.ok(below(stdout.trim(), os.homedir()), `${stdout.trim()} is not the person's folder`);
});
