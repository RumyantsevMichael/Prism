import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, chmod, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateRuntime } from "./runtime-output.mjs";
import { copyDependencies } from "./dependencies.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-runtime-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, text) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };
  await write("src/server/value.mts", "import path from 'node:path';\nexport const value: string = path.basename('/example/ok');\n");
  const script = await write("src/hooks/hook.mjs", "#!/usr/bin/env node\nexport const ready = true;\n");
  await chmod(script, 0o755);
  await write("src/server/public/view.html", "<h1>Review</h1>\n");
  await write("src/server/registry.json", '{"version":1}\n');
  await write("src/server/message-types.mts", "export interface Message { value: string }\n");
  await write("src/native-runtime/package.json", '{"private":true}\n');
  await write("src/native-runtime/package-lock.json", '{}\n');
  return { root, write };
}

test("emits complete deterministic output with executable permissions", async t => {
  const { root } = await fixture(t);
  await generateRuntime(root);
  const module = await import(pathToFileURL(path.join(root, "dist/server/value.mjs")).href);
  assert.equal(module.value, "ok");
  const output = path.join(root, "dist/server/value.mjs");
  const before = await readFile(output);
  await generateRuntime(root);
  assert.deepEqual(await readFile(output), before);
  await generateRuntime(root, { check: true });
  assert.equal(await readFile(path.join(root, "dist/server/public/view.html"), "utf8"), "<h1>Review</h1>\n");
  assert.equal(await readFile(path.join(root, "dist/server/registry.json"), "utf8"), '{"version":1}\n');
  if (process.platform !== "win32") assert.equal((await stat(path.join(root, "dist/hooks/hook.mjs"))).mode & 0o777, 0o755);
  await assert.rejects(access(path.join(root, "dist/server/message-types.mjs")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "dist/native-runtime/package.json")), { code: "ENOENT" });
});

test("freshness checks reject missing, edited, obsolete, and wrong-mode output without repair", async t => {
  const { root, write } = await fixture(t);
  await generateRuntime(root);
  const output = path.join(root, "dist/server/value.mjs");
  await rm(output);
  await assert.rejects(generateRuntime(root, { check: true }), /missing/);
  await assert.rejects(access(output), { code: "ENOENT" });
  await generateRuntime(root);
  await writeFile(output, "edited\n");
  await assert.rejects(generateRuntime(root, { check: true }), /stale/);
  assert.equal(await readFile(output, "utf8"), "edited\n");
  await generateRuntime(root);
  await write("dist/server/test/obsolete.mjs", "obsolete\n");
  await assert.rejects(generateRuntime(root, { check: true }), /obsolete/);
  await generateRuntime(root);
  await assert.rejects(access(path.join(root, "dist/server/test/obsolete.mjs")), { code: "ENOENT" });
  if (process.platform !== "win32") {
    await chmod(path.join(root, "dist/hooks/hook.mjs"), 0o644);
    await assert.rejects(generateRuntime(root, { check: true }), /mode/);
  }
});

test("builds remove directories left empty by moved sources", async t => {
  const { root, write } = await fixture(t);
  await write("dist/server/old-group/obsolete.mjs", "obsolete\n");
  await generateRuntime(root);
  await assert.rejects(access(path.join(root, "dist/server/old-group")), { code: "ENOENT" });
  await access(path.join(root, "dist/server/public"));
});

test("builds preserve staged dependencies and archive output", async t => {
  const { root, write } = await fixture(t);
  await write("dist/native-runtime/node_modules/dependency/index.mjs", "dependency\n");
  await write("dist/native/archive.tar.gz", "archive\n");
  await generateRuntime(root);
  await generateRuntime(root, { check: true });
  assert.equal(await readFile(path.join(root, "dist/native-runtime/node_modules/dependency/index.mjs"), "utf8"), "dependency\n");
  assert.equal(await readFile(path.join(root, "dist/native/archive.tar.gz"), "utf8"), "archive\n");
});

test("dependency staging retains packages and excludes executable symlinks", async t => {
  const { root, write } = await fixture(t);
  const dependency = await write("dependencies/package/index.mjs", "dependency\n");
  await mkdir(path.join(root, "dependencies/.bin"));
  if (process.platform === "win32") await write("dependencies/.bin/tool", "tool\n");
  else await symlink(dependency, path.join(root, "dependencies/.bin/tool"));
  await copyDependencies(path.join(root, "dependencies"), path.join(root, "staged"));
  assert.equal(await readFile(path.join(root, "staged/package/index.mjs"), "utf8"), "dependency\n");
  await assert.rejects(access(path.join(root, "staged/.bin")), { code: "ENOENT" });
});
