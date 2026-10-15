import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("the review demo seed builds its project through the current MCP tools", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "prism-demo-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, "demo");
  const { stdout } = await run(process.execPath, [path.join(ROOT, "scripts/review-demo/seed.mjs"), project], { timeout: 120000 });

  assert.match(stdout, /Start the review browser with:/);
  for (const record of ["docs/roadmap.json", "docs/plans/retry-hardening/initiative.json", "docs/plans/retry-hardening/state.json", "docs/plans/retry-hardening/timeout-retries/review.json"]) {
    await access(path.join(project, record));
  }
});

test("the review command prints usage for help and rejects unknown arguments without a stack trace", async () => {
  const cli = path.join(ROOT, "bin/prism");
  const help = await run(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /^Usage: prism review \[artifact-path\]/);

  const unknown = await run(process.execPath, [cli, "publish"]).catch((error) => error);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^Usage: prism review/);
  assert.doesNotMatch(unknown.stderr, /\n\s+at /);
});
