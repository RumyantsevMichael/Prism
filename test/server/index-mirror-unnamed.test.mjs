import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A build that stops after copying a file, before it names the file in the manifest, leaves a file that no later manifest names;
// the code graph indexes every file of the mirror, so the next build must not keep it.
const { updateMirror, markIndexed } = await import("../../dist/server/repository-intelligence/index-mirror.mjs");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const privateDirectory = async (directory) => { await mkdir(directory, { recursive: true, mode: 0o700 }); return directory; };

async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-mirror-unnamed-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), directory = path.join(root, "location");
  await mkdir(source); await mkdir(directory);
  const write = (file, content) => mkdir(path.dirname(path.join(source, file)), { recursive: true }).then(() => writeFile(path.join(source, file), content));
  const snapshot = (files) => Promise.all(files.map(async (file) => ({ file, hash: sha(await readFile(path.join(source, file))), absolutePath: path.join(source, file) })));
  return { source, directory, write, snapshot };
}
async function mirrorFiles(mirror, folder = "") {
  const found = [];
  for (const entry of await readdir(path.join(mirror, folder), { withFileTypes: true })) {
    const file = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (file !== ".codegraph") found.push(...await mirrorFiles(mirror, file)); } else found.push(file);
  }
  return found.sort();
}
const pauseAfter = (copies) => { let calls = 0; return () => { if (calls++ === copies) throw Object.assign(new Error("paused"), { code: "paused" }); }; };

test("a file a paused build copied and the source then lost is not kept by the next build", async (t) => {
  const { source, directory, write, snapshot } = await setup(t);
  await write("a.ts", "export function main() {\n  return extra();\n}\n");
  await write("b.ts", "export function helper() {\n  return 1;\n}\n");
  let files = await snapshot(["a.ts", "b.ts"]);
  await updateMirror(directory, files, { privateDirectory });
  await markIndexed(directory, files);
  await mkdir(path.join(directory, "runtime-state"));
  await writeFile(path.join(directory, "runtime-state", "kept.json"), "{}");
  await write("c.ts", "export function extra() {\n  return 2;\n}\n");
  await write("nested/d.ts", "export const d = 1;\n");
  files = await snapshot(["a.ts", "b.ts", "c.ts", "nested/d.ts"]);
  await assert.rejects(updateMirror(directory, files, { privateDirectory, current: pauseAfter(1) }), { code: "paused" });
  const mirror = path.join(directory, "mirror");
  assert.deepEqual(await mirrorFiles(mirror), ["a.ts", "b.ts", "c.ts"], "the paused build copied c.ts before it stopped");
  await rm(path.join(source, "c.ts"));
  await rm(path.join(source, "nested"), { recursive: true });
  files = await snapshot(["a.ts", "b.ts"]);
  const update = await updateMirror(directory, files, { privateDirectory });
  assert.deepEqual(await mirrorFiles(mirror), ["a.ts", "b.ts"]);
  assert.deepEqual(update, { mirror }, "the mirror could not be trusted, so the build is a full one");
  await assert.rejects(readFile(path.join(directory, "runtime-state", "kept.json")), { code: "ENOENT" });
});

test("a file a paused build copied that the source still holds keeps the next build incremental", async (t) => {
  const { directory, write, snapshot } = await setup(t);
  await write("a.ts", "export const a = 1;\n");
  let files = await snapshot(["a.ts"]);
  await updateMirror(directory, files, { privateDirectory });
  await markIndexed(directory, files);
  await write("b.ts", "export const b = 1;\n");
  await write("c.ts", "export const c = 1;\n");
  files = await snapshot(["a.ts", "b.ts", "c.ts"]);
  await assert.rejects(updateMirror(directory, files, { privateDirectory, current: pauseAfter(1) }), { code: "paused" });
  const mirror = path.join(directory, "mirror");
  await mkdir(path.join(mirror, ".codegraph"), { recursive: true });
  await writeFile(path.join(mirror, ".codegraph", "codegraph.db"), "kept graph");
  const update = await updateMirror(directory, files, { privateDirectory });
  assert.deepEqual(update, { mirror, changedFiles: ["b.ts", "c.ts"], removedFiles: [] });
  assert.deepEqual(await mirrorFiles(mirror), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(await readFile(path.join(mirror, ".codegraph", "codegraph.db"), "utf8"), "kept graph", "the runtime's graph is not a mirror file");
});
