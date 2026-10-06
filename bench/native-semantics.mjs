import path from "node:path";
import os from "node:os";
import { readFile, writeFile, mkdir, readdir, lstat, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { NativeSemanticRuntime } from "../dist/server/repository-intelligence/native-semantic-runtime.mjs";
import { openNativeRepositoryIntelligence } from "../dist/server/repository-intelligence/native-repository-intelligence.mjs";

const [manifestPath, outputArgument] = process.argv.slice(2);
if (!manifestPath || !outputArgument) throw new Error("Usage: node bench/native-semantics.mjs ASSET_MANIFEST OUTPUT_DIRECTORY");
const output = path.resolve(outputArgument); await mkdir(output, { recursive: true });
const root = path.join(output, "fixture-project"); await mkdir(root, { recursive: true });
const fixture = JSON.parse(await readFile(new URL("../test/native-runtime/fixtures/retrieval.json", import.meta.url), "utf8"));
const queries = [];
for (const item of fixture.cases) {
  const extension = item.domain === "code" ? "ts" : item.domain === "configuration" ? "json" : "md";
  const folder = item.domain === "instruction" ? "instructions" : item.domain;
  await mkdir(path.join(root, folder), { recursive: true });
  for (const [id, description] of [[item.id, item.meaning], [item.negativeId, item.negative]]) {
    const contents = extension === "ts" ? `/** ${description} */\nexport function ${id}() { return 0; }\n` : extension === "json" ? JSON.stringify({ [id]: { description, default: 1000 } }, null, 2) + "\n" : `# ${id}\n\n${description}\n`;
    await writeFile(path.join(root, folder, `${id}.${extension}`), contents);
  }
  queries.push({ id: item.id, domain: item.domain, query: item.query, relevant: `${folder}/${item.id}.${extension}`, hardNegative: `${folder}/${item.negativeId}.${extension}` });
  queries.push({ id: `${item.id}-exact`, domain: item.domain, query: item.id, relevant: `${folder}/${item.id}.${extension}`, hardNegative: `${folder}/${item.negativeId}.${extension}`, exact: true });
}
const source = await openNativeRepositoryIntelligence(await realpath(root));
const cache = path.join(output, "cache");
const runtime = new NativeSemanticRuntime({ directory: cache, manifestPath });
const records = [];
const start = performance.now();
try {
  let preparation = await runtime.prepare(source);
  while (preparation.status === "preparing") { await runtime.status(root, 30000); preparation = await runtime.prepare(source); }
  if (preparation.status !== "ready") throw new Error(JSON.stringify(preparation.diagnostics));
  const preparationMilliseconds = performance.now() - start, prepared = preparation.prepared;
  const indexMilliseconds = prepared.index.resources.indexMilliseconds;
  for (const query of queries) for (const mode of ["native-file-lexical", "chunk-lexical", "hybrid"]) {
    const latencies = []; let ranked;
    for (let run = 0; run < 3; run++) {
      const begin = performance.now();
      const results = mode === "native-file-lexical" ? (await source.search(query.query, {}, { topK: 100 })).hits.map(hit => hit.node)
        : mode === "hybrid" ? await runtime.search(prepared, source, query.query, undefined, 50)
        : await runtime.helper(prepared.runtime).request("search", { query: query.query, mode: "lexical", limit: 50, snapshot: prepared.index.snapshot, indexPath: prepared.indexPath, modelDirectory: prepared.modelDirectory, modelIdentity: prepared.modelIdentity });
      latencies.push(performance.now() - begin);
      ranked = [...new Set(results.map(result => result.file))];
    }
    const rank = ranked.indexOf(query.relevant) + 1;
    records.push({ ...query, mode, rank: rank || null, recallAt5: rank > 0 && rank <= 5 ? 1 : 0, reciprocalRank: rank > 0 ? 1 / rank : 0,
      ndcgAt5: rank > 0 && rank <= 5 ? 1 / Math.log2(rank + 1) : 0, hardNegativeRank: ranked.indexOf(query.hardNegative) + 1 || null, latencyMilliseconds: latencies, top5: ranked.slice(0, 5) });
  }
  let seed = 12345;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const interval = values => {
    const samples = Array.from({ length: 2000 }, () => mean(values.map(() => values[Math.floor(random() * values.length)]))).sort((a, b) => a - b);
    return { mean: mean(values), bootstrap95: [samples[50], samples[1949]] };
  };
  const summaries = [];
  for (const mode of ["native-file-lexical", "chunk-lexical", "hybrid"]) for (const population of ["all", "paraphrase", "exact"]) {
    const selected = records.filter(record => record.mode === mode && (population === "all" || Boolean(record.exact) === (population === "exact")));
    const latency = selected.flatMap(record => record.latencyMilliseconds).sort((a, b) => a - b);
    summaries.push({ mode, population, queries: selected.length, recallAt5: interval(selected.map(item => item.recallAt5)), mrr: interval(selected.map(item => item.reciprocalRank)), ndcgAt5: interval(selected.map(item => item.ndcgAt5)), warmMedianMs: latency[Math.floor(latency.length / 2)], warmP95Ms: latency[Math.floor(latency.length * 0.95)] });
  }
  const pairedComparisons = [];
  for (const baseline of ["native-file-lexical", "chunk-lexical"]) for (const population of ["all", "paraphrase", "exact"]) {
    const hybrid = records.filter(record => record.mode === "hybrid" && (population === "all" || Boolean(record.exact) === (population === "exact")));
    const deltas = metric => hybrid.map(record => record[metric] - records.find(other => other.mode === baseline && other.id === record.id)[metric]);
    pairedComparisons.push({ baseline, population, recallAt5Delta: interval(deltas("recallAt5")), mrrDelta: interval(deltas("reciprocalRank")), ndcgAt5Delta: interval(deltas("ndcgAt5")) });
  }
  const disk = async directory => { let size = 0; for (const name of await readdir(directory)) { const file = path.join(directory, name), info = await lstat(file); size += info.isDirectory() ? await disk(file) : info.size; } return size; };
  const report = { schemaVersion: 1, date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length,
    fixture: "test/native-runtime/fixtures/retrieval.json", fixtureCases: fixture.cases.length, queries: queries.length, runsPerQuery: 3,
    snapshot: prepared.index.snapshot, modelIdentity: prepared.modelIdentity, indexRevision: prepared.revision,
    preparationMilliseconds, indexMilliseconds, resources: prepared.index.resources, counts: prepared.index.counts,
    indexBytes: (await lstat(prepared.indexPath)).size, cacheBytes: await disk(cache), summaries, pairedComparisons, records,
    limitations: ["Synthetic fixed fixtures with one relevant file and one semantic hard negative per case.", "Bootstrap intervals resample queries, not independent repositories.", "Warm hybrid latency includes whole-snapshot verification; lexical-only timing measures retrieval.", "This expands the original small diagnostic experiment but does not establish broad release-quality accuracy."] };
  await writeFile(path.join(output, "retrieval-results.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ report: path.join(output, "retrieval-results.json"), indexMilliseconds, summaries }) + "\n");
} finally { runtime.close(); }
