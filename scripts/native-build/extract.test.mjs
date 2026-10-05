import test from "node:test";
import assert from "node:assert/strict";
import { Header } from "tar";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractRuntime } from "./extract.mjs";

async function archive(t, entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocks = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.content || "");
    const header = new Header({ path: entry.path, type: entry.type || "File", mode: 0o600, size: bytes.length, linkpath: entry.linkpath || "" });
    header.encode(); blocks.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const file = path.join(root, "runtime.tar"), directory = path.join(root, "output");
  await mkdir(directory); await writeFile(file, Buffer.concat(blocks));
  return { file, directory };
}
test("runtime extraction accepts regular files within its pinned size", async t => {
  const { file, directory } = await archive(t, [{ path: "runtime.json", content: "{}" }]);
  await extractRuntime(file, directory, 2);
  assert.equal(await readFile(path.join(directory, "runtime.json"), "utf8"), "{}");
});
test("runtime extraction rejects escapes, links, duplicate paths, and expansion beyond the pin", async t => {
  for (const entry of [
    { path: "../outside", content: "x" }, { path: "/outside", content: "x" },
    { path: "C:\\outside", content: "x" }, { path: "link", type: "SymbolicLink", linkpath: "../outside" },
    { path: "link", type: "Link", linkpath: "runtime.json" }, { path: "runtime.json", content: "duplicate" }
  ]) {
    const { file, directory } = await archive(t, [{ path: "runtime.json", content: "{}" }, entry]);
    await assert.rejects(extractRuntime(file, directory, 100), { code: "corrupt_asset" });
  }
  const { file, directory } = await archive(t, [{ path: "runtime.json", content: "{}" }]);
  await assert.rejects(extractRuntime(file, directory, 1), { code: "resource_limit" });
  await assert.rejects(extractRuntime(file, directory), { code: "corrupt_asset" });
});
