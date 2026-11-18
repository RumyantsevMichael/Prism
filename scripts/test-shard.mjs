#!/usr/bin/env node
// Run one shard of the server tests, so CI can spread them over several runners that finish at about the same time.
// Usage: node scripts/test-shard.mjs --shard k/n [--list] [-- any node --test option ...]
//        node scripts/test-shard.mjs --record [-- any node --test option ...]
// Shards are balanced by recorded file durations, not by file order, since a few browser files take most of the time.
// Each system reads its own table, test/server/durations.<platform>.json, when there is one, since Windows spends far more of its time in Git and browser files than Linux does; any other system reads test/server/durations.json.
// A file without a recorded duration counts as the median one, so a new test file needs no update to run; --record runs every file and rewrites the durations.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const TEST_DIRECTORY = "test/server";
export const DURATIONS = path.join(TEST_DIRECTORY, "durations.json");

// The table a system records into and balances by: its own table, or the shared one where the system has none.
export function durationsFile(platform = process.platform, root = ROOT) {
  const own = path.join(TEST_DIRECTORY, `durations.${platform}.json`);
  return existsSync(path.join(root, own)) ? own : DURATIONS;
}

export function testFiles(root = ROOT) {
  return readdirSync(path.join(root, TEST_DIRECTORY)).filter((name) => name.endsWith(".test.mjs")).sort();
}

export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(text ?? "");
  const [part, parts] = match ? [Number(match[1]), Number(match[2])] : [];
  if (!(parts >= 1 && part >= 1 && part <= parts)) throw new Error(`--shard takes k/n with 1 <= k <= n, not ${text}`);
  return { part, parts };
}

// Longest file first onto the shard with the least time so far; ties go to the lower shard and the earlier name, so every runner computes the same split.
export function shardFiles(files, durations, parts) {
  const known = files.map((file) => durations[file]).filter((seconds) => Number.isFinite(seconds)).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file) => (Number.isFinite(durations[file]) ? durations[file] : median);
  const shards = Array.from({ length: parts }, () => ({ files: [], seconds: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards;
}

function readDurations(root = ROOT) {
  try {
    return JSON.parse(readFileSync(path.join(root, durationsFile(process.platform, root)), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function runTests(files, options, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...options, ...files.map((file) => path.join(TEST_DIRECTORY, file))], { cwd: ROOT, stdio: "inherit", env });
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function record(options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prism-test-durations-"));
  const output = path.join(directory, "durations.jsonl");
  try {
    const reporter = pathToFileURL(path.join(ROOT, "scripts/test-durations-reporter.mjs")).href;
    const code = await runTests(testFiles(), ["--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, `--test-reporter-destination=${output}`, ...options]);
    const durations = {};
    for (const line of (await readFile(output, "utf8")).split("\n").filter(Boolean)) {
      const { file, seconds } = JSON.parse(line);
      durations[file] = Math.max(1, Math.round(seconds));
    }
    const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
    const table = durationsFile();
    writeFileSync(path.join(ROOT, table), `${JSON.stringify(sorted, null, 2)}\n`);
    process.stdout.write(`Recorded the durations of ${Object.keys(sorted).length} files in ${table}.\n`);
    return code;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const split = args.indexOf("--");
  const own = split >= 0 ? args.slice(0, split) : args;
  const options = split >= 0 ? args.slice(split + 1) : [];
  if (own.includes("--record")) process.exit(await record(options));
  const at = own.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
  const { part, parts } = parseShard(at < 0 ? undefined : own[at].includes("=") ? own[at].slice("--shard=".length) : own[at + 1]);
  const shard = shardFiles(testFiles(), readDurations(), parts)[part - 1];
  if (own.includes("--list")) {
    process.stdout.write(`${shard.files.join("\n")}\n`);
    process.exit(0);
  }
  process.stdout.write(`Shard ${part} of ${parts}: ${shard.files.length} files, about ${Math.round(shard.seconds)} s of recorded test time.\n`);
  process.exit(await runTests(shard.files, options));
}
