// Measure native semantic chunking and retrieval on a real repository through the generated worker.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "../..");
const { values: options } = parseArgs({ options: {
  repo: { type: "string", default: repoRoot },
  queries: { type: "string", default: path.join(here, "queries/prism.json") },
  out: { type: "string", default: path.join(here, ".work") },
  model: { type: "string" },
  worker: { type: "string", default: path.join(repoRoot, "dist/native-runtime") },
  label: { type: "string", default: "run" },
  "fragments-only": { type: "boolean", default: false },
  "reuse-index": { type: "boolean", default: false },
  show: { type: "string", default: "0" },
  liftoff: { type: "boolean", default: false },
} });

const sha = value => createHash("sha256").update(value).digest("hex");
const out = path.resolve(options.out); mkdirSync(out, { recursive: true });
const modelDirectory = options.model || process.env.PRISM_MODEL_DIRECTORY || findModel();
const require = createRequire(path.join(options.worker, "worker.mjs"));
const { Tokenizer } = require("@huggingface/tokenizers");
const tokenizer = new Tokenizer(JSON.parse(readFileSync(path.join(modelDirectory, "tokenizer.json"), "utf8")), JSON.parse(readFileSync(path.join(modelDirectory, "tokenizer_config.json"), "utf8")));
const countTokens = text => tokenizer.encode(text, { add_special_tokens: false }).ids.length + 2;

function findModel() {
  const data = path.join(os.homedir(), ".claude/plugins/data");
  for (const plugin of existsSync(data) ? readdirSync(data) : []) {
    const assets = path.join(data, plugin, "native-intelligence/assets");
    for (const entry of existsSync(assets) ? readdirSync(assets) : []) if (existsSync(path.join(assets, entry, "tokenizer.json"))) return path.join(assets, entry);
  }
  throw new Error("No model directory. Pass --model or set PRISM_MODEL_DIRECTORY.");
}

// Mirror the snapshot the same way the server does: tracked and untracked files that git does not ignore.
const mirror = path.join(out, "mirror");
const files = [], contents = new Map();
if (!options["reuse-index"]) rmSync(mirror, { recursive: true, force: true });
for (const name of execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: options.repo }).toString().split("\0").filter(Boolean)) {
  // The benchmark folder holds the expected answers, so it never enters the corpus.
  if (!path.relative(here, path.join(options.repo, name)).startsWith("..")) continue;
  let stat; try { stat = statSync(path.join(options.repo, name)); } catch { continue; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
  const bytes = readFileSync(path.join(options.repo, name));
  if (bytes.subarray(0, 8192).includes(0)) continue;
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { continue; }
  if (!options["reuse-index"]) { mkdirSync(path.dirname(path.join(mirror, name)), { recursive: true }); writeFileSync(path.join(mirror, name), bytes); }
  files.push({ file: name, hash: sha(text) }); contents.set(name, text);
}
const snapshot = sha(JSON.stringify(files));

const child = spawn(process.execPath, [...(options.liftoff ? ["--liftoff-only"] : []), path.join(options.worker, "worker.mjs")], { cwd: options.worker, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map(), phases = {};
let id = 0, phase = "", phaseStart = Date.now();
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (message.progress) {
    if (message.progress.phase !== phase) { if (phase) phases[phase] = (Date.now() - phaseStart) / 1000; phase = message.progress.phase; phaseStart = Date.now(); }
    return;
  }
  const request = pending.get(message.id); pending.delete(message.id);
  message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.result);
});
const call = (method, args) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); child.stdin.write(JSON.stringify({ id: i, method, args }) + "\n"); });

const indexPath = path.join(out, "index.json"), cachePath = path.join(out, "embeddings.json");
let index;
const started = Date.now();
if (options["reuse-index"]) index = JSON.parse(readFileSync(indexPath, "utf8"));
else {
  const previousEmbeddings = options["fragments-only"] || !existsSync(cachePath) ? {} : JSON.parse(readFileSync(cachePath, "utf8"));
  index = await call("build", { mirror, files, snapshot, modelDirectory, modelIdentity: "m", previousEmbeddings, fragmentsOnly: options["fragments-only"] });
  if (phase) phases[phase] = (Date.now() - phaseStart) / 1000;
  if (options["fragments-only"]) writeFileSync(path.join(out, "fragments.json"), JSON.stringify(index.chunks));
  else {
    writeFileSync(indexPath, JSON.stringify(index));
    // The cache keeps every vector seen, so variants that share fragment text skip embedding.
    for (const chunk of index.chunks) if (chunk.embeddingKey) previousEmbeddings[chunk.embeddingKey] = chunk.embedding;
    writeFileSync(cachePath, JSON.stringify(previousEmbeddings));
  }
}
const buildSeconds = (Date.now() - started) / 1000;

// Fragment statistics.
const chunks = index.chunks;
const tokens = new Map(chunks.map(chunk => [chunk.id, countTokens(chunk.embeddingText)]));
const unique = new Map(chunks.map(chunk => [chunk.embeddingText, tokens.get(chunk.id)]));
const roles = {};
for (const chunk of chunks) roles[chunk.role || "whole"] = (roles[chunk.role || "whole"] || 0) + 1;
// A source fragment repeats a child when a smaller concept embeds the same source text.
const sourceChunks = chunks.filter(chunk => chunk.role !== "outline"), byFile = new Map();
for (const chunk of sourceChunks) byFile.set(chunk.file, [...(byFile.get(chunk.file) || []), chunk]);
let repeated = 0, embedded = 0;
for (const chunk of chunks) {
  embedded += tokens.get(chunk.id);
  if (chunk.role === "outline") continue;
  const length = chunk.sourceEnd - chunk.sourceStart, covered = new Uint8Array(length);
  for (const other of byFile.get(chunk.file)) if (other.parentId !== chunk.parentId && other.sourceStart >= chunk.sourceStart && other.sourceEnd <= chunk.sourceEnd && other.sourceEnd - other.sourceStart < length)
    covered.fill(1, other.sourceStart - chunk.sourceStart, other.sourceEnd - chunk.sourceStart);
  repeated += tokens.get(chunk.id) * covered.reduce((sum, value) => sum + value, 0) / Math.max(1, length);
}
let cuts = 0, lineEndCuts = 0;
const parts = new Map();
for (const chunk of chunks) if (chunk.role !== "outline") parts.set(chunk.parentId, [...(parts.get(chunk.parentId) || []), chunk]);
for (const list of parts.values()) {
  list.sort((a, b) => a.sourceStart - b.sourceStart);
  for (const chunk of list.slice(0, -1)) {
    const content = contents.get(chunk.file); cuts++;
    if (content[chunk.sourceEnd - 1] === "\n" || content[chunk.sourceEnd] === "\n") lineEndCuts++;
  }
}
const stats = { fragments: chunks.length, roles, embeddedTokens: embedded, uniqueEmbeddedTokens: [...unique.values()].reduce((a, b) => a + b, 0),
  repeatedShare: +(repeated / embedded).toFixed(3), cuts, lineEndCutShare: cuts ? +(lineEndCuts / cuts).toFixed(3) : null,
  smallFragments: [...tokens.values()].filter(value => value < 20).length, counts: index.counts, buildSeconds, phases };
console.log(JSON.stringify(stats, null, 1));

// Retrieval metrics.
const summary = { label: options.label, stats, groups: {} };
if (!options["fragments-only"]) {
  const queries = JSON.parse(readFileSync(options.queries, "utf8"));
  const sameName = (result, name) => result.name === name || result.qualifiedName === name || String(result.qualifiedName || "").endsWith(`::${name}`);
  const findUnit = spec => index.units.find(unit => unit.file === spec.file && sameName(unit, spec.name));
  const records = [];
  for (const query of queries) {
    let text = query.query;
    if (query.queryFrom) { const unit = findUnit(query.queryFrom); text = contents.get(unit.file).slice(unit.span.start, unit.span.end); }
    const results = (await call("search", { query: text, limit: 10 + (query.queryFrom ? 1 : 0), snapshot: index.snapshot, indexPath, modelDirectory, modelIdentity: "m", filters: query.filters }))
      .filter(result => !(query.queryFrom && result.file === query.queryFrom.file && sameName(result, query.queryFrom.name))).slice(0, 10);
    const match = result => query.expect.some(spec => {
      if (result.file !== spec.file) return false;
      if (!spec.name || sameName(result, spec.name)) return true;
      const expected = spec.within && findUnit(spec);
      return Boolean(expected && result.range.startLine >= expected.range.startLine && result.range.endLine <= expected.range.endLine);
    });
    const rank = results.findIndex(match);
    records.push({ group: query.group, query: query.query || `code of ${query.queryFrom.name}`, rank: rank < 0 ? null : rank + 1 });
    if (Number(options.show)) {
      console.log(`\n## [${query.group}] ${query.query || `code of ${query.queryFrom.file}:${query.queryFrom.name}`} -> ${rank < 0 ? "MISS" : rank + 1}`);
      for (const result of results.slice(0, Number(options.show))) console.log(`  ${match(result) ? "*" : " "} ${result.file}:${result.range.startLine}-${result.range.endLine} ${result.kind}${result.role && result.role !== "whole" ? `/${result.role}` : ""} ${String(result.qualifiedName || result.name).slice(0, 50).replace(/\n/g, " ")}`);
    }
  }
  const metrics = list => ({ queries: list.length, hitAt5: list.filter(r => r.rank && r.rank <= 5).length, hitAt10: list.filter(r => r.rank).length,
    mrr: +(list.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / list.length).toFixed(3) });
  for (const group of [...new Set(records.map(r => r.group))]) summary.groups[group] = metrics(records.filter(r => r.group === group));
  summary.groups.all = metrics(records);
  summary.groups.baseline30 = metrics(records.filter(r => ["concept", "exact"].includes(r.group)));
  summary.records = records;
  console.log("\n" + Object.entries(summary.groups).map(([group, m]) => `${group.padEnd(14)} n=${String(m.queries).padStart(2)} hit@5 ${m.hitAt5} hit@10 ${m.hitAt10} MRR ${m.mrr}`).join("\n"));
}
writeFileSync(path.join(out, `summary-${options.label}.json`), JSON.stringify(summary, null, 1));
child.kill();
