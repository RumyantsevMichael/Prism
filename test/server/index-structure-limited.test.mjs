import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// A component whose build published its structure and then reached a native limit
// still has that structure-only index stored, so a structural report should include it from that structure.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-structure-limited-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { findSameNameUnits } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

const IS_OBJECT = "export function isObject(value) {\n  return value !== null && typeof value === 'object';\n}\n";
const FILES2 = { ...FILES, "packages/net/is.ts": IS_OBJECT, "packages/app/is.ts": IS_OBJECT };
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("a component that reached a native limit after publishing structure answers a structural report from that structure", async (t) => {
  const { root, storage } = await project(t, { files: FILES2 });
  const { runtime, control } = await stagedRuntime(storage);
  const helper = runtime.helper();
  // An embedding of the held file reaches a native limit, as an over-512-token fragment or an over-512 MiB index does after structure is published.
  runtime.helper = () => ({ ...helper, request: (method, args, progress) => helper.request(method, args, progress)
    .catch((error) => { throw Object.assign(new Error("The model input exceeds 512 tokens."), { code: method === "build" ? "resource_limit" : error.code }); }) });
  control.fail("packages/net/timeout.ts");
  await findSameNameUnits({ projectRoot: root, filters: { paths: ["packages/net/is.ts"] } }, { runtime, waitMs: 0 });
  const directory = (await runtime.location(root, NET)).directory;
  await until(async () => (await runtime.status(root)).components?.find((item) => item.component === "root/net")?.status === "degraded", "net did not fail");
  const pointer = await readJson(path.join(directory, "current.json"));
  assert.equal(pointer.stage, "structure", "the structure-only index stays stored after the failure");
  const found = await findSameNameUnits({ projectRoot: root, filters: { paths: ["packages/net/is.ts"] } }, { runtime, waitMs: 500 });
  const net = found.components.find((item) => item.component === "root/net");
  assert.deepEqual([net.status, net.indexRevision], ["included", pointer.revision], JSON.stringify(net));
});
