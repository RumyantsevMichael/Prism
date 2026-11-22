import { parentPort, workerData } from "node:worker_threads";
import { bunzip2 } from "./bzip2.mjs";

// Decodes one bzip2 file off the server's main thread, so a large archive does not hold up the review app while it unpacks.
const { input, max } = workerData as { input: Uint8Array; max: number };
try {
  const output = bunzip2(Buffer.from(input.buffer, input.byteOffset, input.byteLength), max);
  parentPort!.postMessage({ output }, [output.buffer as ArrayBuffer]);
} catch (error: any) {
  parentPort!.postMessage({ error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
}
