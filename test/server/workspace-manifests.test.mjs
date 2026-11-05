import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { componentName, parseToml, pnpmPatterns, proposeComponents } from "../../dist/server/workflow/workspace-manifests.mjs";

// The manifest readers behind a proposed ## Components block, beyond the acceptance tests of components.md.

async function project(context, files) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-workspace-manifests-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

test("the TOML reader reads Cargo tables, quoted keys, multi-line arrays and strings, and dependency subtables", () => {
  const manifest = parseToml([
    "[package]",
    "name = \"core\" # the crate",
    "description = \"\"\"",
    "A \"quoted\" line.\"\"\"",
    "",
    "[[bin]]",
    "name = 'core-cli'",
    "",
    "[dependencies]",
    "windows = { version = \"0.58\", features = [",
    "  \"Win32_Foundation\",",
    "] }",
    "",
    "[dependencies.shared]",
    "path = \"../shared\"",
    "",
    "[target.'cfg(unix)'.dependencies]",
    "libc = \"0.2\"",
    "released = 1979-05-27T07:32:00Z",
    ""
  ].join("\n"));
  assert.equal(manifest.package.name, "core");
  assert.equal(manifest.package.description, "A \"quoted\" line.");
  assert.equal(manifest.bin[0].name, "core-cli");
  assert.deepEqual(manifest.dependencies.windows.features, ["Win32_Foundation"]);
  assert.equal(manifest.dependencies.shared.path, "../shared");
  assert.equal(manifest.target["cfg(unix)"].dependencies.libc, "0.2");
  assert.throws(() => parseToml("[package\nname = \"x\"\n"), /closing bracket/);
  assert.throws(() => parseToml("name = \"x\" trailing\n"), /text after a value/);
});

test("the pnpm reader reads block and flow lists and refuses YAML it cannot read", () => {
  assert.deepEqual(pnpmPatterns("packages:\n  - apps/* # apps\n  - \"!apps/old\"\ncatalog:\n  react: ^19\n"), ["apps/*", "!apps/old"]);
  assert.deepEqual(pnpmPatterns("packages: ['a/*', \"b\"]\n"), ["a/*", "b"]);
  assert.throws(() => pnpmPatterns("packages:\n  - { path: a }\n"), /plain or quoted string/);
});

test("component names are normalized and cut to the name rule's length", () => {
  assert.equal(componentName("@Acme Web!!App"), "acme-web-app");
  assert.equal(componentName(`${"a".repeat(63)}-b`), "a".repeat(63));
  assert.equal(componentName("___"), "");
});

test("a proposal walks ** without node_modules or dot folders, reads Cargo subtables and Go require blocks, and skips unreadable TOML", async (context) => {
  const root = await project(context, {
    "Cargo.toml": "[workspace]\nmembers = [\n  \"crates/**\",\n]\n",
    "go.work": "use (\n\t\"./svc\" // the service\n)\n",
    "crates/a/Cargo.toml": "[package]\nname = \"a\"\n\n[dev-dependencies.b]\npath = \"../nested/b/\"\n",
    "crates/nested/b/Cargo.toml": "[package]\nname = \"b\"\n",
    "crates/node_modules/c/Cargo.toml": "[package]\nname = \"c\"\n",
    "crates/.hidden/Cargo.toml": "[package]\nname = \"hidden\"\n",
    "crates/bad/Cargo.toml": "[package]\nname = \n",
    "svc/go.mod": "module example.com/svc\n\nrequire (\n\texample.com/lib v1.0.0 // indirect\n)\n"
  });
  const proposal = await proposeComponents(root, { rootName: "root" });
  assert.deepEqual(proposal.components, [
    { name: "a", folder: "crates/a", testCommand: null, dependsOn: ["b"] },
    { name: "bad", folder: "crates/bad", testCommand: null, dependsOn: [] },
    { name: "b", folder: "crates/nested/b", testCommand: null, dependsOn: [] },
    { name: "svc", folder: "svc", testCommand: null, dependsOn: [] }
  ]);
  assert.deepEqual(proposal.skipped.map((item) => item.path), ["crates/bad/Cargo.toml"]);
  assert.deepEqual(proposal.sharedPaths, []);
});

test("a name taken by the folder's own segment too gets a numbered suffix, and a stray lockfile of another tool is not shared", async (context) => {
  const root = await project(context, {
    "package.json": JSON.stringify({ workspaces: ["a/*", "b/*"] }),
    "yarn.lock": "\n",
    "package-lock.json": "{}\n",
    "Cargo.lock": "# no Cargo workspace\n",
    "a/x/package.json": JSON.stringify({ name: "x" }),
    "b/x/package.json": JSON.stringify({ name: "x" })
  });
  const proposal = await proposeComponents(root, { rootName: "root" });
  assert.deepEqual(proposal.components.map(({ name, folder }) => [name, folder]), [["x", "a/x"], ["x-2", "b/x"]]);
  assert.deepEqual(proposal.sharedPaths, ["yarn.lock"]);
  assert.equal(await proposeComponents(await project(context, { "Cargo.toml": "[package]\nname = \"solo\"\n" }), { rootName: "root" }), null);
});
