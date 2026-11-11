// Generated from src/server/repository-intelligence/index-store-thread.mts by scripts/native-build/compile.mjs.
import { parentPort, workerData } from "node:worker_threads";
import { log } from "../log.mjs";
import { Helper } from "./native-helper.mjs";
import { LocalIndexStore } from "./index-store.mjs";
const { helper: options, log: logOptions } = workerData;
log.configure(logOptions);
let helper = null;
const store = new LocalIndexStore((runtime, args, progress) => {
  if (helper?.runtime !== runtime) {
    helper?.stop();
    helper = new Helper(runtime, options, "build");
  }
  return helper.request("build", args, progress);
});
const operations = {
  read: (indexPath, revision) => store.read(indexPath, revision),
  save: (token, finish) => store.save(token, finish),
  discard: (token) => store.discard(token),
  close: async () => {
    await store.close();
    await helper?.close();
    helper = null;
    await log.flush();
  }
};
parentPort.on("message", async ({ id, op, args }) => {
  try {
    const result = op === "build" ? await store.build(args[0], (progress) => parentPort.postMessage({ id, progress })) : await operations[op](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, ...error.code === void 0 ? {} : { code: error.code } } });
  }
});
