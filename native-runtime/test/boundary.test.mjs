import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFileBoundary } from "../fs-boundary.mjs";

test("snapshot boundary rejects outside reads, symlinks, and writes to immutable source", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prism-boundary-")));
  const source = path.join(root, "source"), cache = path.join(root, "cache");
  fs.mkdirSync(source); fs.mkdirSync(cache); fs.writeFileSync(path.join(source, "a.txt"), "inside");
  fs.writeFileSync(path.join(root, "outside.txt"), "outside");
  if (process.platform !== "win32") fs.symlinkSync(path.join(root, "outside.txt"), path.join(source, "escape"));
  const boundary = installFileBoundary();
  try {
    boundary.begin({ readRoots: [source, cache], writeRoots: [cache] });
    assert.equal(fs.readFileSync(path.join(source, "a.txt"), "utf8"), "inside");
    assert.throws(() => fs.readFileSync(path.join(root, "outside.txt")), { code: "ERR_ACCESS_DENIED" });
    assert.throws(() => fs.writeFileSync(path.join(source, "a.txt"), "bad"), { code: "ERR_ACCESS_DENIED" });
    if (process.platform !== "win32") assert.equal(fs.existsSync(path.join(source, "escape")), false);
    fs.writeFileSync(path.join(cache, "index"), "allowed");
    assert.ok(boundary.end().length >= 2);
  } finally { boundary.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
