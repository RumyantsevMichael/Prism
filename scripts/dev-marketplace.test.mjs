import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeDevMarketplace } from "./dev-marketplace.mjs";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const read = async file => JSON.parse(await readFile(file, "utf8"));

test("the development marketplace serves the checkout under the published plugin entries", async () => {
  const directory = await writeDevMarketplace(path.join(await mkdtemp(path.join(os.tmpdir(), "prism-dev-")), "marketplace"), checkout);
  assert.deepEqual(await read(path.join(directory, "prism/.claude-plugin/plugin.json")), await read(path.join(checkout, ".claude-plugin/plugin.json")));
  assert.ok(existsSync(path.join(directory, "prism/hooks/hooks.json")));
  assert.ok(!existsSync(path.join(directory, "prism/.git")));
  for (const [catalog, source] of [
    [".claude-plugin/marketplace.json", "./prism"],
    [".agents/plugins/marketplace.json", { source: "local", path: "./prism" }]
  ]) {
    const published = await read(path.join(checkout, catalog)), generated = await read(path.join(directory, catalog));
    assert.equal(generated.name, published.name);
    assert.deepEqual(generated.plugins.map(({ source: _, ...entry }) => entry), published.plugins.map(({ source: _, ...entry }) => entry));
    assert.deepEqual(generated.plugins.map(entry => entry.source), published.plugins.map(() => source));
  }
});

test("writing the development marketplace again replaces the previous one", async () => {
  const directory = path.join(await mkdtemp(path.join(os.tmpdir(), "prism-dev-")), "marketplace");
  await writeDevMarketplace(directory, checkout);
  await writeFile(path.join(directory, "prism/stale.txt"), "left over");
  await writeDevMarketplace(directory, checkout);
  assert.ok(!existsSync(path.join(directory, "prism/stale.txt")));
});

test("the development marketplace refuses a directory it would destroy", async () => {
  const other = await mkdtemp(path.join(os.tmpdir(), "prism-dev-"));
  await writeFile(path.join(other, "keep.txt"), "someone's file");
  await assert.rejects(writeDevMarketplace(other, checkout), /not empty and is not a development marketplace/);
  assert.ok(existsSync(path.join(other, "keep.txt")));
  await assert.rejects(writeDevMarketplace(checkout, checkout), /outside the checkout/);
  await assert.rejects(writeDevMarketplace(path.join(checkout, "tmp-marketplace"), checkout), /outside the checkout/);
  await mkdir(path.join(other, "empty"));
  await writeDevMarketplace(path.join(other, "empty"), checkout);
});
