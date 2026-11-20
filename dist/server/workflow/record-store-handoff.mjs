// Generated from src/server/workflow/record-store-handoff.mts by scripts/native-build/compile.mjs.
import readline from "node:readline";
import { configureRecordSync, markManagedStore, syncRecordStoreNow } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";
let stores = [];
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const value = parseStoreJson(line);
    if (Array.isArray(value)) stores = value;
  } catch {
  }
});
process.stdin.on("error", () => lines.close());
await new Promise((resolve) => lines.once("close", resolve));
const pending = stores.filter((store) => typeof store?.base === "string");
const log = pending.length ? await import("../log.mjs").then((loaded) => loaded.log, () => null) : null;
if (log) {
  log.configure({ name: "store-handoff" });
  log.info("store_handoff", { stores: pending.length });
  configureRecordSync({ log });
}
for (const store of pending) {
  if (store.managed === true) markManagedStore(store.base);
  await syncRecordStoreNow(store.base).catch(() => {
  });
}
await Promise.resolve(log?.flush()).catch(() => {
});
process.exit(0);
