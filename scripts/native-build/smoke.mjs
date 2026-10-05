import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extractRuntime } from "./extract.mjs";

const output = path.resolve(process.argv[2] || "dist/native"), platform = `${process.platform}-${process.arch}`;
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-native-smoke-")));
const hash = data => createHash("sha256").update(data).digest("hex");
let child;
try {
  const asset = JSON.parse(await readFile(path.join(output, platform + ".json"), "utf8"))[platform];
  const archive = path.join(output, `prism-native-${platform}.tar.gz`);
  if (hash(await readFile(archive)) !== asset.sha256) throw new Error("Archive checksum mismatch.");
  const runtime = path.join(directory, "runtime"); await mkdir(runtime);
  await extractRuntime(archive, runtime, asset.unpackedBytes);
  const model = JSON.parse(await readFile(new URL("../../vendor/native-runtime/manifest.json", import.meta.url), "utf8")).model;
  const modelDirectory = path.join(directory, "model"); await mkdir(modelDirectory);
  for (const file of model.files) {
    let bytes;
    if (process.env.PRISM_TEST_MODEL_DIRECTORY) bytes = await readFile(path.join(process.env.PRISM_TEST_MODEL_DIRECTORY, file.path));
    else {
      const response = await fetch(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`);
      if (!response.ok) throw new Error(`Model download HTTP ${response.status}.`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error("Model checksum mismatch.");
    const target = path.join(modelDirectory, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  const mirror = path.join(directory, "mirror"); await mkdir(mirror);
  const source = "export function retryRequest() { return 1; }\n";
  await writeFile(path.join(mirror, "retry.ts"), source);
  const env = { ...process.env, PATH: "", PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const executable = path.join(runtime, process.platform === "win32" ? "node.exe" : "node");
  const { chmod } = await import("node:fs/promises"); await chmod(executable, 0o700);
  child = spawn(executable, ["--liftoff-only", "--permission", `--allow-fs-read=${directory}`, `--allow-fs-write=${directory}`, "--allow-addons", path.join(runtime, "worker.mjs")], { cwd: runtime, env, stdio: ["pipe", "pipe", "inherit"] });
  const requests = new Map(); let id = 0;
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line); if (response.progress) return;
    const pending = requests.get(response.id); requests.delete(response.id);
    if (response.error) pending.reject(new Error(JSON.stringify(response.error))); else pending.resolve(response.result);
  });
  child.once("exit", code => { for (const pending of requests.values()) pending.reject(new Error(`Worker exited ${code}.`)); });
  const call = (method, args) => new Promise((resolve, reject) => { requests.set(++id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, args }) + "\n"); });
  const index = await call("build", { mirror, files: [{ file: "retry.ts", hash: hash(source) }], snapshot: "smoke", modelDirectory, modelIdentity: "smoke-pinned-model" });
  if (!index.chunks.length || index.diagnostics.length || !index.fileCoverage["retry.ts"]) throw new Error(`Incomplete packaged graph: ${JSON.stringify(index.diagnostics)}.`);
  const indexPath = path.join(directory, "index.json"); await writeFile(indexPath, JSON.stringify(index));
  const results = await call("search", { query: "repeat failed request", limit: 10, snapshot: "smoke", modelDirectory, modelIdentity: "smoke-pinned-model", indexPath });
  if (!results.length || results[0].file !== "retry.ts" || !Number.isFinite(results[0].cosineSimilarity)) throw new Error("Packaged local inference failed.");
  process.stdout.write(JSON.stringify({ platform, semanticSearch: true, structuralCoverage: true, externalExecutables: false, fragments: index.chunks.length }) + "\n");
} finally { child?.kill(); if (child && child.exitCode === null) await new Promise(resolve => child.once("exit", resolve)); await rm(directory, { recursive: true, force: true }); }
