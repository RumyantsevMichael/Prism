import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DURATIONS, durationsFile, parseShard, shardFiles, testFiles } from "./test-shard.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

test("every server test file runs in exactly one shard, whatever the shard count", async () => {
  const files = testFiles();
  const durations = JSON.parse(await readFile(path.join(ROOT, DURATIONS), "utf8"));
  for (const parts of [1, 2, 3, 4, 7]) {
    const listed = shardFiles(files, durations, parts).flatMap((shard) => shard.files);
    assert.deepEqual([...listed].sort(), files, `${parts} shards list each file once`);
  }
});

test("shards are balanced by duration, so the heavy files go to different shards", () => {
  const durations = { "a.test.mjs": 300, "b.test.mjs": 200, "c.test.mjs": 100, "d.test.mjs": 100, "e.test.mjs": 100 };
  const shards = shardFiles(Object.keys(durations), durations, 2);
  assert.deepEqual(shards.map((shard) => shard.files), [["a.test.mjs", "d.test.mjs"], ["b.test.mjs", "c.test.mjs", "e.test.mjs"]]);
  assert.deepEqual(shards.map((shard) => shard.seconds), [400, 400]);
});

test("a file without a recorded duration counts as the median file, and a recorded file that is gone is ignored", () => {
  const durations = { "a.test.mjs": 10, "b.test.mjs": 20, "c.test.mjs": 30, "gone.test.mjs": 1000 };
  const shards = shardFiles(["a.test.mjs", "b.test.mjs", "c.test.mjs", "new.test.mjs"], durations, 2);
  assert.deepEqual(shards.map((shard) => shard.seconds), [40, 40]);
  assert.ok(shards[1].files.includes("new.test.mjs") || shards[0].files.includes("new.test.mjs"));
  assert.ok(!shards.flatMap((shard) => shard.files).includes("gone.test.mjs"));
});

test("the same files and durations always give the same shards", () => {
  const files = ["x.test.mjs", "y.test.mjs", "z.test.mjs", "w.test.mjs"];
  assert.deepEqual(shardFiles(files, {}, 3), shardFiles([...files].reverse(), {}, 3));
});

test("a shard is named k/n with 1 <= k <= n", async () => {
  assert.deepEqual(parseShard("2/3"), { part: 2, parts: 3 });
  for (const text of ["0/3", "4/3", "1/0", "3", "a/b", undefined]) assert.throws(() => parseShard(text), /--shard takes k\/n/);
  const listed = await run(process.execPath, [path.join(ROOT, "scripts/test-shard.mjs"), "--shard", "1/1", "--list"], { cwd: ROOT });
  assert.deepEqual(listed.stdout.trim().split("\n").sort(), testFiles());
  const refused = await run(process.execPath, [path.join(ROOT, "scripts/test-shard.mjs"), "--shard", "5/4"], { cwd: ROOT }).then(() => null, (error) => error);
  assert.ok(refused, "an out-of-range shard fails");
});

test("a system balances by its own durations table when there is one, and by the shared one otherwise", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-test-shard-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "test/server"), { recursive: true });
  await writeFile(path.join(root, "test/server/durations.win32.json"), "{}\n");
  assert.equal(durationsFile("win32", root), path.join("test/server", "durations.win32.json"));
  assert.equal(durationsFile("linux", root), DURATIONS);
  assert.equal(durationsFile("darwin", root), DURATIONS);
});
