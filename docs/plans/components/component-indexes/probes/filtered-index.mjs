// Prepare a real native index of only some files of a repository, in place, as a component index would hold them, and report size, time, and coverage.
// The snapshot keeps project-relative paths and its fingerprint covers only the kept files, so the probe shows what a component source sees without copying the folder.
// Usage: node docs/plans/components/component-indexes/probes/filtered-index.mjs <repository> <include|exclude> <folder>[,<folder>] [native storage directory]
import { createHash } from "node:crypto";
import { NativeSemanticRuntime } from "../../../../../dist/server/repository-intelligence/native-semantic-runtime.mjs";
import { openNativeRepositoryIntelligence } from "../../../../../dist/server/repository-intelligence/native-repository-intelligence.mjs";

const [root, mode, list, storage] = process.argv.slice(2);
const folders = list.split(",");
const inside = file => folders.some(folder => file === folder || file.startsWith(`${folder}/`));
const keep = file => mode === "include" ? inside(file) : !inside(file);
const source = await openNativeRepositoryIntelligence(root);
const whole = source.snapshot.bind(source);
const filtered = async () => {
  const snapshot = await whole();
  const files = snapshot.files.filter(file => keep(file.file));
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.kind}\0${file.file}\0${file.hash}\0`);
  return { ...snapshot, files, filesByPath: new Map(files.map(file => [file.file, file])), sourceFingerprint: hash.digest("hex"), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
};
let current = null;
source.snapshot = async () => (current ||= await filtered());
source.verifySnapshot = async () => {
  const fresh = await (async () => { source.snapshotPromise = null; return filtered(); })();
  if (fresh.sourceFingerprint !== current.sourceFingerprint) throw Object.assign(new Error("The filtered snapshot changed."), { code: "snapshot-changed" });
  return {};
};
const runtime = new NativeSemanticRuntime(storage ? { directory: storage } : {});
const started = Date.now();
let result = await runtime.prepare(source, undefined, 0);
while (result.status === "preparing") {
  await new Promise(resolve => setTimeout(resolve, 15000));
  result = await runtime.status(root);
}
await runtime.sequence;
const status = await runtime.status(root);
const job = [...runtime.jobs.values()][0];
const index = job?.prepared?.index;
const files = Object.keys(index?.fileCoverage || {});
const outside = files.filter(file => !keep(file));
console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), status: status.status, files: files.length, filesOutsideSelection: outside.length,
  coverage: status.coverage, syntaxCovered: Object.values(index?.syntaxCoverage || {}).filter(Boolean).length,
  peakRssMiB: Math.round((index?.resources?.peakRssBytes || 0) / 1048576), unscopedDiagnostics: (status.diagnostics || []).filter(item => !item.file).map(item => item.message) }));
await runtime.close();
