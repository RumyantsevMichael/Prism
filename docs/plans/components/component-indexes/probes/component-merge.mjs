// Build real native indexes of a two-package fixture three ways, the whole project and each package alone, and compare what a merged search and structural report would see.
// Usage: node docs/plans/components/component-indexes/probes/component-merge.mjs <scratch directory>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NativeSemanticRuntime } from "../../../../../dist/server/repository-intelligence/native-semantic-runtime.mjs";
import { openNativeRepositoryIntelligence } from "../../../../../dist/server/repository-intelligence/native-repository-intelligence.mjs";

const scratch = process.argv[2];
const root = path.join(scratch, "merge-fixture");
rmSync(root, { recursive: true, force: true });
const files = {
  "packages/net/retry.ts": "export async function retryRequest(send: () => Promise<Response>, attempts = 3) {\n  for (let attempt = 1; ; attempt++) {\n    try { return await send(); } catch (error) { if (attempt >= attempts) throw error; }\n  }\n}\n",
  "packages/net/index.ts": "export { retryRequest } from \"./retry\";\nexport const timeoutMs = 5000;\n",
  "packages/app/client.ts": "import { retryRequest } from \"../net/retry\";\nimport { z } from \"zod\";\nexport function fetchUser(id: string) {\n  return retryRequest(() => fetch(`/users/${id}`));\n}\nexport const User = z.object({ id: z.string() });\n",
  "packages/app/backoff.ts": "export function backoffDelay(attempt: number) {\n  return Math.min(1000 * 2 ** attempt, 30000);\n}\n",
  "README.md": "# Fixture\n\nRetry failed network requests with exponential backoff.\n"
};
for (const [file, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); }
const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
git("init", "-q"); git("add", "-A"); git("-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-qm", "probe");

async function source(keep) {
  const native = await openNativeRepositoryIntelligence(root);
  if (!keep) return native;
  const whole = native.snapshot.bind(native);
  let current;
  native.snapshot = async () => {
    if (current) return current;
    const snapshot = await whole(), kept = snapshot.files.filter(file => keep(file.file)), hash = createHash("sha256");
    for (const file of kept) hash.update(`${file.kind}\0${file.file}\0${file.hash}\0`);
    return (current = { ...snapshot, files: kept, filesByPath: new Map(kept.map(file => [file.file, file])), sourceFingerprint: hash.digest("hex") });
  };
  native.verifySnapshot = async () => ({});
  return native;
}
// A separate runtime per view keeps each index in its own job; they share the default asset and storage directory, so only the storage key matters.
async function prepared(keep, key) {
  const runtime = new NativeSemanticRuntime();
  runtime.location = async () => ({ root, directory: path.join(runtime.directory, "projects", createHash("sha256").update(`${root}\0${key}`).digest("hex")) });
  const view = await source(keep);
  let result = await runtime.prepare(view, undefined, 0);
  await runtime.sequence;
  result = await runtime.prepare(view, undefined, 0);
  return { runtime, view, result };
}
const views = {
  whole: await prepared(null, "whole"),
  net: await prepared(file => file.startsWith("packages/net/"), "net"),
  app: await prepared(file => file.startsWith("packages/app/"), "app")
};
const query = "retry a failed network request";
const report = {};
for (const [name, { runtime, view, result }] of Object.entries(views)) {
  const index = result.prepared.index;
  const hits = await runtime.search(result.prepared, view, query, undefined, 10);
  report[name] = {
    status: result.status,
    units: index.units.filter(unit => unit.kind !== "file").map(unit => `${unit.id} ${unit.file}#${unit.name}`).sort(),
    fileCoverage: index.fileCoverage, syntaxCoverage: index.syntaxCoverage,
    fileDiagnostics: index.diagnostics.filter(item => item.file).map(item => `${item.file}: ${item.message}`),
    hits: hits.map(hit => ({ id: hit.id, file: hit.file, name: hit.name, cosine: hit.cosineSimilarity, lexical: hit.lexicalScore, fused: hit.fusedScore, rank: hit.fusedRank }))
  };
  await runtime.close();
}
const byId = Object.fromEntries(report.whole.hits.map(hit => [hit.id, hit]));
const same = [...report.net.hits, ...report.app.hits].filter(hit => byId[hit.id]).map(hit => ({ id: hit.id, name: hit.name,
  cosineEqual: hit.cosine === byId[hit.id].cosine, lexicalEqual: hit.lexical === byId[hit.id].lexical, fusedEqual: hit.fused === byId[hit.id].fused }));
const ids = view => new Set(report[view].units.map(line => line.split(" ")[0]));
const overlap = [...ids("net")].filter(id => ids("app").has(id));
const wholeIds = ids("whole");
console.log(JSON.stringify({ report, compared: same, idsSharedBetweenComponents: overlap.length,
  componentIdsInWhole: [...ids("net"), ...ids("app")].filter(id => wholeIds.has(id)).length, componentIds: ids("net").size + ids("app").size }, null, 1));
