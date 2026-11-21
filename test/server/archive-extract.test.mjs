import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractTarGz, extractZip } from "../../dist/server/session/archive-extract.mjs";
import { zip } from "./fixtures/acp-registry.mjs";

// The archive unpacker of registry installs: what lands inside the version folder, and what refuses the whole archive.

const posixOnly = process.platform === "win32" ? "builds archives with the system tar and symbolic links" : false;

async function scratch(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "prism-extract-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// A .tar.gz of a content folder that setup lays out, built with the system tar from the given member names.
async function tarOf(folder, setup, members, extra = []) {
  const content = path.join(folder, "content");
  await mkdir(content, { recursive: true });
  await setup(content);
  const file = path.join(folder, "archive.tar.gz");
  execFileSync("tar", ["-czf", file, ...extra, "-C", content, ...members]);
  return file;
}

test("a tar.gz keeps folders, modes, and links that stay inside the version folder", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await mkdir(path.join(content, "bin"));
    await writeFile(path.join(content, "bin", "agent"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink("bin/agent", path.join(content, "agent"));
  }, ["bin", "agent"]);
  const out = path.join(folder, "out");
  await extractTarGz(file, out);
  assert.equal(readFileSync(path.join(out, "bin", "agent"), "utf8"), "#!/bin/sh\n");
  assert.equal(statSync(path.join(out, "bin", "agent")).mode & 0o111, 0o111);
  assert.ok(lstatSync(path.join(out, "agent")).isSymbolicLink());
});

test("a tar.gz link that leads outside the version folder refuses the archive", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, (content) => symlink("../../outside", path.join(content, "link")), ["link"]);
  await assert.rejects(extractTarGz(file, path.join(folder, "out")), /leads outside the version folder/);
});

test("a tar.gz entry written through a link it made refuses the archive", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await symlink(".", path.join(content, "here"));
    await mkdir(path.join(content, "real"));
    await writeFile(path.join(content, "real", "x"), "x");
  }, ["here", "real/x"], ["--transform=s,^real,here,"]);
  await assert.rejects(extractTarGz(file, path.join(folder, "out")), /not a folder/);
});

test("a tar.gz entry with an absolute path or a .. part refuses the archive before anything is written", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await writeFile(path.join(content, "first"), "1");
    await writeFile(path.join(content, "second"), "2");
  }, ["first", "second"], ["--transform=s,^second,../second,"]);
  const out = path.join(folder, "out");
  await assert.rejects(extractTarGz(file, out), /\.\. part/);
  assert.equal(existsSync(path.join(out, "first")), false);
  assert.equal(existsSync(path.join(folder, "second")), false);
});

test("a zip with an absolute path refuses the archive, and one inside unpacks with its modes", async (t) => {
  const folder = await scratch(t);
  const bad = path.join(folder, "bad.zip");
  await writeFile(bad, zip({ "/etc/escape": { text: "x" } }));
  await assert.rejects(extractZip(bad, path.join(folder, "bad")), /absolute path/);
  const good = path.join(folder, "good.zip");
  await writeFile(good, zip({ "dir/agent": { text: "run", mode: 0o755 } }));
  await extractZip(good, path.join(folder, "good"));
  assert.equal(readFileSync(path.join(folder, "good", "dir", "agent"), "utf8"), "run");
  if (process.platform !== "win32") assert.equal(statSync(path.join(folder, "good", "dir", "agent")).mode & 0o777, 0o755);
});
