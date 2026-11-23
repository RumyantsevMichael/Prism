import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadForm, extractTarBz2, extractTarGz, extractZip, placeBinary } from "../../dist/server/session/archive-extract.mjs";
import { zip } from "./fixtures/acp-registry.mjs";

// The archive unpacker of registry installs: what lands inside the version folder, and what refuses the whole archive.

const posixOnly = process.platform === "win32" ? "builds archives with the system tar and symbolic links" : false;

async function scratch(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "prism-extract-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// The system tar's option that renames the member `from` to `to` as it is archived: GNU tar's --transform, or -s of the bsdtar of
// macOS and the BSDs, with -P so that bsdtar keeps a .. part that it would otherwise strip.
const bsdtar = process.platform !== "win32" && /bsdtar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
const renamed = (from, to) => (bsdtar ? ["-P", "-s", `,^${from},${to},`] : [`--transform=s,^${from},${to},`]);

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

test("a tar.gz link that leads outside only through another link, to a target that does not exist, refuses the archive", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await mkdir(path.join(content, "a", "b"), { recursive: true });
    await symlink("../..", path.join(content, "a", "b", "up"));
    await symlink("a/b/up/../missing", path.join(content, "link"));
  }, ["a", "link"]);
  await assert.rejects(extractTarGz(file, path.join(folder, "out", "version")), /leads outside the version folder/);
});

test("a tar.gz link that climbs through another link and stays inside is kept, also when its target does not exist", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await mkdir(path.join(content, "a", "b"), { recursive: true });
    await symlink("..", path.join(content, "a", "b", "up"));
    await symlink("a/b/up/missing", path.join(content, "link"));
  }, ["a", "link"]);
  const out = path.join(folder, "out");
  await extractTarGz(file, out);
  assert.ok(lstatSync(path.join(out, "link")).isSymbolicLink());
});

test("a tar.gz entry written through a link it made refuses the archive", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await symlink(".", path.join(content, "here"));
    await mkdir(path.join(content, "real"));
    await writeFile(path.join(content, "real", "x"), "x");
  }, ["here", "real/x"], renamed("real", "here"));
  await assert.rejects(extractTarGz(file, path.join(folder, "out")), /not a folder/);
});

test("a tar.gz entry with an absolute path or a .. part refuses the archive before anything is written", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const file = await tarOf(folder, async (content) => {
    await writeFile(path.join(content, "first"), "1");
    await writeFile(path.join(content, "second"), "2");
  }, ["first", "second"], renamed("second", "../second"));
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

test("a tar.bz2 unpacks like a tar.gz, and a download that is no archive is placed as its program", { skip: posixOnly }, async (t) => {
  const folder = await scratch(t);
  const content = path.join(folder, "content");
  await mkdir(path.join(content, "bin"), { recursive: true });
  await writeFile(path.join(content, "bin", "agent"), "#!/bin/sh\n", { mode: 0o755 });
  const file = path.join(folder, "archive.tar.bz2");
  execFileSync("tar", ["-cjf", file, "-C", content, "bin"]);
  assert.equal(await downloadForm(file), "bzip2");
  await extractTarBz2(file, path.join(folder, "out"));
  assert.equal(statSync(path.join(folder, "out", "bin", "agent")).mode & 0o777, 0o755);
  const program = path.join(folder, "program");
  await writeFile(program, "#!/bin/sh\necho hi\n");
  assert.equal(await downloadForm(program), "binary");
  await placeBinary(program, path.join(folder, "placed"), "./agent");
  assert.equal(readFileSync(path.join(folder, "placed", "agent"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal(statSync(path.join(folder, "placed", "agent")).mode & 0o777, 0o755);
  await assert.rejects(placeBinary(program, path.join(folder, "nested"), "bin/agent"), /plain file name/);
  await assert.rejects(placeBinary(program, path.join(folder, "escape"), "../agent"), /\.\. part/);
  const broken = path.join(folder, "broken.tar.bz2");
  await writeFile(broken, Buffer.concat([Buffer.from("BZh9"), Buffer.alloc(40)]));
  await assert.rejects(extractTarBz2(broken, path.join(folder, "broken")), /not a valid bzip2 file/);
});
