import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DECLARATION, command, componentProject, workflow, write } from "./fixtures/components.mjs";

// Requirements: docs/requirements/components.md §3, §4.
// Contract: docs/plans/components/component-slices/slice.md clauses 40-42.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-proposal-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const components = async (root) => (await getRoadmap({ projectRoot: root })).components;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const plain = (context, files) => componentProject(context, { config: workflow({ components: null }), files });

// Shaped like Lumen: Bun workspaces over packages/*, one bun.lock, packages whose package.json names match their folders,
// a Rust package and a Swift package without a package.json, and folders that are no packages.
const LUMEN = {
  "package.json": json({ private: true, name: "lumen", workspaces: ["packages/*"], devDependencies: { lantern: "workspace:*" } }),
  "bun.lock": "{}\n",
  "packages/messages/package.json": json({ name: "messages", scripts: { test: "bun test --isolate --parallel" } }),
  "packages/messages/bunfig.toml": "[test]\npreload = [\"../../tests/preload.ts\"]\n",
  "packages/di/package.json": json({ name: "di", scripts: { test: "bun test" }, dependencies: { messages: "workspace:*", zod: "^3.0.0" } }),
  "packages/lumend/package.json": json({ name: "lumend", devDependencies: { messages: "workspace:*" }, peerDependencies: { di: "workspace:*" } }),
  "packages/lantern/package.json": json({ name: "lantern", scripts: { build: "bun build" } }),
  "packages/logging-rs/Cargo.toml": "[package]\nname = \"logging-rs\"\nversion = \"0.1.0\"\n\n[lib]\npath = \"src/lib.rs\"\n",
  "packages/logging-rs/Cargo.lock": "# lock\n",
  "packages/audio-runtime-apple/Package.swift": "// swift-tools-version:5.9\n",
  "packages/notes/README.md": "# Not a package\n",
  "packages/.cache/package.json": json({ name: "cache" }),
  "packages/README.md": "# Packages\n"
};

test("clause 40: get_roadmap lists the declared components by identity, and reports an invalid declaration without refusing", async (context) => {
  const root = await componentProject(context);
  const listed = await components(root);
  assert.equal(listed.repository, "root");
  assert.deepEqual(listed.declared, [
    { component: "root/root", folder: "", testCommand: command("root", 0), dependsOn: [] },
    { component: "root/billing", folder: "packages/billing", testCommand: command("billing"), dependsOn: ["root/shared"] },
    { component: "root/shared", folder: "packages/shared", testCommand: command("shared"), dependsOn: [] },
    { component: "root/web", folder: "apps/web", testCommand: null, dependsOn: ["root/billing"] },
    { component: "root/docs", folder: "handbook", testCommand: command("docs", 1), dependsOn: [] }
  ]);
  assert.equal(listed.proposal, undefined, "a repository that declares components gets no proposal");
  assert.equal(listed.problem, undefined);

  const invalid = await componentProject(context, { config: workflow({ components: DECLARATION.replace("- web: apps/web", "- web: packages/billing/web") }) });
  const reported = await components(invalid);
  assert.deepEqual(reported.declared, []);
  assert.equal(reported.problem.code, "component_overlap");
  assert.equal(typeof reported.problem.message, "string");
});

test("clauses 41 and 42: a Lumen-shaped Bun workspace gets a proposal of every package folder, which Prism never writes", async (context) => {
  const root = await plain(context, LUMEN);
  const before = await readFile(path.join(root, ".prism/workflow.md"), "utf8");
  const listed = await components(root);
  assert.deepEqual(listed.declared, [{ component: "root/root", folder: "", testCommand: command("root", 0), dependsOn: [] }]);
  const proposal = listed.proposal;
  assert.deepEqual(proposal.components, [
    { name: "audio-runtime-apple", folder: "packages/audio-runtime-apple", testCommand: null, dependsOn: [] },
    { name: "di", folder: "packages/di", testCommand: "bun run test", dependsOn: ["messages"] },
    { name: "lantern", folder: "packages/lantern", testCommand: null, dependsOn: [] },
    { name: "logging-rs", folder: "packages/logging-rs", testCommand: null, dependsOn: [] },
    { name: "lumend", folder: "packages/lumend", testCommand: null, dependsOn: ["di", "messages"] },
    { name: "messages", folder: "packages/messages", testCommand: "bun run test", dependsOn: [] }
  ]);
  assert.deepEqual(proposal.sharedPaths, ["bun.lock"]);
  assert.deepEqual(proposal.skipped, []);
  assert.equal(proposal.problem, undefined);
  assert.equal(proposal.markdown, [
    "## Components",
    "- audio-runtime-apple: packages/audio-runtime-apple",
    "- di: packages/di",
    "  - Test command: bun run test",
    "  - Depends on: messages",
    "- lantern: packages/lantern",
    "- logging-rs: packages/logging-rs",
    "- lumend: packages/lumend",
    "  - Depends on: di, messages",
    "- messages: packages/messages",
    "  - Test command: bun run test",
    "- Shared paths: bun.lock",
    ""
  ].join("\n"));
  assert.equal(await readFile(path.join(root, ".prism/workflow.md"), "utf8"), before, "the configuration is unchanged");

  await write(root, { ".prism/workflow.md": workflow({ components: proposal.markdown }) });
  const adopted = await components(root);
  assert.equal(adopted.problem, undefined, "the proposed block is a valid declaration");
  assert.deepEqual(adopted.declared.map((item) => item.component), ["root/root", "root/audio-runtime-apple", "root/di", "root/lantern", "root/logging-rs", "root/lumend", "root/messages"]);
});

test("clause 41: pnpm, Cargo, and Go workspaces give patterns, exclusions, and their own dependencies", async (context) => {
  const pnpm = await plain(context, {
    "pnpm-workspace.yaml": "packages:\n  - \"apps/*\"\n  - 'libs/**'\n  - \"!apps/legacy\"\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "apps/shop/package.json": json({ name: "@acme/shop", scripts: { test: "vitest" }, dependencies: { "@acme/ui": "workspace:^" } }),
    "apps/legacy/package.json": json({ name: "legacy" }),
    "libs/ui/package.json": json({ name: "@acme/ui", scripts: { test: "vitest" } }),
    "libs/ui/node_modules/dep/package.json": json({ name: "dep" }),
    "libs/tools/lint/package.json": json({ name: "lint" })
  });
  assert.deepEqual((await components(pnpm)).proposal.components, [
    { name: "shop", folder: "apps/shop", testCommand: "pnpm run test", dependsOn: ["ui"] },
    { name: "lint", folder: "libs/tools/lint", testCommand: null, dependsOn: [] },
    { name: "ui", folder: "libs/ui", testCommand: "pnpm run test", dependsOn: [] }
  ]);
  assert.deepEqual((await components(pnpm)).proposal.sharedPaths, ["pnpm-lock.yaml"]);

  const cargo = await plain(context, {
    "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/old\"]\n",
    "Cargo.lock": "# lock\n",
    "crates/core/Cargo.toml": "[package]\nname = \"core-lib\"\n",
    "crates/cli/Cargo.toml": "[package]\nname = \"cli\"\n\n[dependencies]\ncore-lib = { path = \"../core\" }\nserde = \"1\"\n",
    "crates/old/Cargo.toml": "[package]\nname = \"old\"\n"
  });
  const crates = (await components(cargo)).proposal;
  assert.deepEqual(crates.components, [
    { name: "cli", folder: "crates/cli", testCommand: null, dependsOn: ["core-lib"] },
    { name: "core-lib", folder: "crates/core", testCommand: null, dependsOn: [] }
  ]);
  assert.deepEqual(crates.sharedPaths, ["Cargo.lock"]);

  const go = await plain(context, {
    "go.work": "go 1.22\n\nuse (\n\t./api\n\t./tools\n)\n\nuse ./web\n",
    "go.work.sum": "\n",
    "api/go.mod": "module example.com/shop/api\n\ngo 1.22\n",
    "web/go.mod": "module example.com/shop/web\n\ngo 1.22\n\nrequire example.com/shop/api v0.0.0\n",
    "tools/go.mod": "module example.com/shop/tools\n"
  });
  const modules = (await components(go)).proposal;
  assert.deepEqual(modules.components, [
    { name: "api", folder: "api", testCommand: null, dependsOn: [] },
    { name: "tools", folder: "tools", testCommand: null, dependsOn: [] },
    { name: "web", folder: "web", testCommand: null, dependsOn: ["api"] }
  ]);
  assert.deepEqual(modules.sharedPaths, ["go.work.sum"]);
});

test("clause 42: names are normalized and kept unique, the package manager names the test command, and problems are reported, not fixed", async (context) => {
  const npm = await plain(context, {
    "package.json": json({ name: "shop", workspaces: { packages: ["packages/*"] } }),
    "package-lock.json": "{}\n",
    "packages/web-app/package.json": json({ name: "@acme/Web_App!", scripts: { test: "jest" } }),
    "packages/ui/package.json": json({ name: "ui", scripts: { test: "jest" } }),
    "packages/ui-kit/package.json": json({ name: "ui" }),
    "packages/root-tools/package.json": json({ name: "root" }),
    "packages/symbols/package.json": json({ name: "@@@" }),
    "packages/broken/package.json": "{ not json\n"
  });
  const proposal = (await components(npm)).proposal;
  assert.deepEqual(proposal.components.map(({ name, folder, testCommand }) => [name, folder, testCommand]), [
    ["broken", "packages/broken", null],
    ["root-tools", "packages/root-tools", null],
    ["symbols", "packages/symbols", null],
    ["ui", "packages/ui", "npm run test"],
    ["ui-kit", "packages/ui-kit", null],
    ["web_app", "packages/web-app", "npm run test"]
  ]);
  assert.deepEqual(proposal.skipped.map((item) => item.path), ["packages/broken/package.json"]);
  assert.equal(typeof proposal.skipped[0].reason, "string");
  assert.deepEqual(proposal.sharedPaths, ["package-lock.json"]);

  const yarn = await plain(context, {
    "package.json": json({ workspaces: ["pkgs/*"] }),
    "yarn.lock": "\n",
    "pkgs/a/package.json": json({ name: "a", scripts: { test: "x" }, dependencies: { b: "1.0.0" } }),
    "pkgs/b/package.json": json({ name: "b", optionalDependencies: { a: "1.0.0" } }),
    "pkgs/b-copy/package.json": json({ name: "b" }),
    "other/b/package.json": json({ name: "b" })
  });
  const cyclic = (await components(yarn)).proposal;
  assert.deepEqual(cyclic.components.map(({ name, testCommand, dependsOn }) => [name, testCommand, dependsOn]), [["a", "yarn run test", ["b"]], ["b", null, ["a"]], ["b-copy", null, []]]);
  assert.equal(cyclic.problem.code, "component_cycle", "a proposal that would be refused says why");
  assert.equal(typeof cyclic.problem.message, "string");

  const lone = await plain(context, { "package.json": json({ name: "single", scripts: { test: "node --test" } }) });
  assert.equal((await components(lone)).proposal, undefined, "a manifest without workspace patterns proposes nothing");
});
