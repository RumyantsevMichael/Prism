// Generated from src/server/review-app.mts by scripts/native-build/compile.mjs.
import { readFile } from "node:fs/promises";
import { pluginURL } from "./plugin-root.mjs";
import { reviewAppDirectory } from "./review/review-app-discovery.mjs";
import { startReviewApp } from "./review/review-app-server.mjs";
import { errorFields, log, startProcessLog } from "./log.mjs";
import { launchRunSession, setRunLauncher } from "./workflow/migration-runs.mjs";
import { configureRecordSync, handOffRecordSyncs } from "./workflow/record-store-sync.mjs";
const { version } = JSON.parse(await readFile(pluginURL(".claude-plugin", "plugin.json"), "utf8"));
startProcessLog("review-app", { version });
configureRecordSync({ watchPending: true, log });
setRunLauncher(launchRunSession);
let app;
try {
  app = await startReviewApp({ directory: reviewAppDirectory(), pluginVersion: version });
} catch (error) {
  log.info("process_stopping", { reason: "another app holds the lock or the start failed", ...errorFields(error) });
  await log.flush();
  process.exit(0);
}
log.info("review_app_started", { port: app.port ?? null });
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());
await app.closed;
handOffRecordSyncs();
log.info("process_stopping", { reason: "closed" });
await log.flush();
process.exit(0);
