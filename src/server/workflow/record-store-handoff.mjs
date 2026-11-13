// Watch a Prism process that has store syncs pending, and finish them once it ends, one store after another, then exit.
// The process writes the stores it has pending to this one's input, a JSON list of { base, managed } per line, whenever that list changes.
// This process syncs the last list once its input closes, which happens however the other process ends, so a host's forced end loses no write.
import readline from "node:readline";
import { markManagedStore, syncRecordStoreNow } from "./record-store-sync.mjs";
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
for (const store of stores) {
  if (typeof store?.base !== "string") continue;
  if (store.managed === true) markManagedStore(store.base);
  // The sync records its own outcome in the store's sync status, where the next Prism process reads it.
  await syncRecordStoreNow(store.base).catch(() => {});
}
process.exit(0);
