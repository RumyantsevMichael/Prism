// Resolve the directory that holds generated benchmark state, outside the plugin root.
// The harness in bench/harness/bench.py resolves the same directory.
import os from "node:os";
import path from "node:path";

export function benchStateDir() {
  if (process.env.PRISM_BENCH_HOME) return path.resolve(process.env.PRISM_BENCH_HOME);
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "prism-bench");
}
