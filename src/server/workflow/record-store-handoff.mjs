// Watch a Prism process that has store syncs pending, and finish them once it ends, one store after another, then exit.
// The process writes the stores it has pending to this one's input, a JSON list of { base, managed } per line, whenever that list changes.
// This process syncs the last list once its input closes, which happens however the other process ends, so a host's forced end loses no write.
import readline from "node:readline";
import { configureRecordSync, markManagedStore, syncRecordStoreNow } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";

let stores = [];
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const value = parseStoreJson(line);
    if (Array.isArray(value)) stores = value;
  } catch { /* A torn line, as from a process that ended mid-write, leaves the list before it. */ }
});
// An input whose writer ended by force can report an error instead of its end.
process.stdin.on("error", () => lines.close());
await new Promise((resolve) => lines.once("close", resolve));
const pending = stores.filter((store) => typeof store?.base === "string");
// Only a watcher that has syncs to finish writes to the shared log, so the many that end with nothing pending leave no line.
// The log loads only then, and a log that cannot load leaves the syncs to run without it.
const log = pending.length ? await import("../log.mjs").then((loaded) => loaded.log, () => null) : null;
if (log) {
  log.configure({ name: "store-handoff" });
  log.info("store_handoff", { stores: pending.length });
  configureRecordSync({ log });
}
for (const store of pending) {
  if (store.managed === true) markManagedStore(store.base);
  // The sync records its own outcome in the store's sync status, where the next Prism process reads it.
  await syncRecordStoreNow(store.base).catch(() => {});
}
await Promise.resolve(log?.flush()).catch(() => {});
process.exit(0);
