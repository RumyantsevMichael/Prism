// A session that holds a build of packages/net after it published structure, until the parent sends release, then lets it save the complete index.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stagedRuntime, until } from "./staged-runtime.mjs";
const { searchRepositoryConcepts } = await import("../../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const [root, storage] = process.argv.slice(2);
const HELD = "packages/net/timeout.ts";
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const first = await stagedRuntime(storage);
first.control.hold(HELD);
await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime: first.runtime, waitMs: 0 });
await first.control.reached(HELD);
const directory = (await first.runtime.location(root, NET)).directory;
await until(async () => JSON.parse(await readFile(path.join(directory, "current.json"), "utf8").catch(() => "null"))?.stage === "structure");
process.send("held");
process.on("message", async () => {
  first.control.release(HELD);
  await until(async () => JSON.parse(await readFile(path.join(directory, "current.json"), "utf8").catch(() => "null"))?.stage === "complete");
  setTimeout(() => { process.send("done"); }, 50);
  setTimeout(() => process.exit(0), 200);
});
