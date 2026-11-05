// Prepare a real native index of one folder of another repository, as a component index would hold it, and report its size and time.
// The folder is copied into a scratch Git repository, so the index holds only that folder's files.
// Usage: node docs/plans/components/probes/index-folder.mjs <folder> <scratch directory> [native storage directory]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { NativeSemanticRuntime } from "../../../../dist/server/repository-intelligence/native-semantic-runtime.mjs";
import { openNativeRepositoryIntelligence } from "../../../../dist/server/repository-intelligence/native-repository-intelligence.mjs";

const [folder, scratch, storage] = process.argv.slice(2);
const root = path.join(scratch, path.basename(folder));
mkdirSync(scratch, { recursive: true });
cpSync(folder, root, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
git("init", "-q"); git("add", "-A"); git("-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-qm", "probe");
const runtime = new NativeSemanticRuntime(storage ? { directory: storage } : {});
const started = Date.now();
let result = await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
while (result.status === "preparing") {
  await new Promise((resolve) => setTimeout(resolve, 15000));
  result = await runtime.status(root);
}
await runtime.sequence;
const status = await runtime.status(root);
console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), status: status.status, coverage: status.coverage, diagnostics: status.diagnostics.slice(0, 5) }));
await runtime.close();
