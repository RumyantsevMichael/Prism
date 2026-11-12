// Finish the store syncs that an ending Prism process handed off, one store after another, and exit.
// Its argument is a JSON list of { base, managed }, as handOffRecordSyncs writes it.
import { markManagedStore, syncRecordStoreNow } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";

let stores = [];
try { stores = parseStoreJson(process.argv[2] ?? "[]"); } catch { stores = []; }
for (const store of Array.isArray(stores) ? stores : []) {
  if (typeof store?.base !== "string") continue;
  if (store.managed === true) markManagedStore(store.base);
  // The sync records its own outcome in the store's sync status, where the next Prism process reads it.
  await syncRecordStoreNow(store.base).catch(() => {});
}
process.exit(0);
