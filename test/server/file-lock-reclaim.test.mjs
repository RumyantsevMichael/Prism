import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withFileLock } from "../../dist/server/workflow/artifact-store.mjs";

// Review apps that start together all find the lock of an app that died; each judges it abandoned, and only one may end up holding the lock.
test("starters that find one abandoned lock together never hold it at the same time", { timeout: 120000 }, async (context) => {
  const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-lock-reclaim-"));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const options = { renew: true, abandonWhenUnrenewed: true, heartbeatMs: 1000, staleMs: 30000, timeoutMs: 10000 };
  for (let round = 0; round < 150; round++) {
    const base = path.join(directory, `app-${round}`);
    await writeFile(`${base}.lock`, JSON.stringify({ pid: dead, token: "abandoned", renewable: true, at: new Date().toISOString() }));
    let holders = 0;
    let most = 0;
    const start = () => withFileLock(base, async () => {
      holders += 1;
      most = Math.max(most, holders);
      await new Promise((resolve) => setTimeout(resolve, 5));
      holders -= 1;
    }, undefined, options);
    await Promise.all([start(), start(), start(), start()]);
    assert.equal(most, 1, `round ${round}: two starters held the lock at once`);
  }
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".reclaim")), [], "no reclaim lock is left behind");
});
