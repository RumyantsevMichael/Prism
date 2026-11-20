import { parentPort, workerData } from "node:worker_threads";
import { log } from "../log.mjs";
import { Helper } from "./native-helper.mjs";
import { LocalIndexStore } from "./index-store.mjs";
import type { HelperOptions } from "./native-helper.mjs";
import type { Progress } from "./repository-unit-types.mjs";

// The thread of the default index store: it holds the build helper and every full index, and answers the process's calls one message each.

const { helper: options, log: logOptions } = workerData as { helper: HelperOptions; log: { name: string; directory: string | null; level: number } };
log.configure(logOptions);
let helper: Helper | null = null;
const store = new LocalIndexStore((runtime, args, progress) => {
  if (helper?.runtime !== runtime) { helper?.stop(); helper = new Helper(runtime, options, "build"); }
  return helper.request("build", args, progress);
}, () => helper?.stop());
const operations: Record<string, (...args: never[]) => Promise<unknown>> = {
  read: (indexPath: string, revision: string) => store.read(indexPath, revision),
  save: (token: string, finish: Parameters<LocalIndexStore["save"]>[1]) => store.save(token, finish),
  saveStructure: (token: string, finish: Parameters<LocalIndexStore["saveStructure"]>[1]) => store.saveStructure(token, finish),
  discard: (token: string) => store.discard(token),
  stop: () => store.stop(),
  close: async () => { await store.close(); await helper?.close(); helper = null; await log.flush(); }
};

parentPort!.on("message", async ({ id, op, args }: { id: number; op: string; args: never[] }) => {
  try {
    const result = op === "build"
      ? await store.build(args[0], (progress: Progress, embedded?: boolean) => parentPort!.postMessage({ id, progress, ...(embedded ? { embedded } : {}) }),
        args[1] ? (structure: string) => parentPort!.postMessage({ id, structure }) : undefined, () => parentPort!.postMessage({ id, sent: true }))
      : await operations[op](...args);
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: { message: error.message, ...(error.code === undefined ? {} : { code: error.code }) } });
  }
});
