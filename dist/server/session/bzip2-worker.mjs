// Generated from src/server/session/bzip2-worker.mts by scripts/native-build/compile.mjs.
import { parentPort, workerData } from "node:worker_threads";
import { bunzip2 } from "./bzip2.mjs";
const { input, max } = workerData;
try {
  const output = bunzip2(Buffer.from(input.buffer, input.byteOffset, input.byteLength), max);
  parentPort.postMessage({ output }, [output.buffer]);
} catch (error) {
  parentPort.postMessage({ error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
}
