import { readFile } from "node:fs/promises";
import { pluginURL } from "./plugin-root.mjs";
import { reviewAppDirectory } from "./review/review-app-discovery.mjs";
import { startReviewApp } from "./review/review-app-server.mjs";
import { errorFields, log, startProcessLog } from "./log.mjs";

// The detached review app that no agent session owns; a start that loses the lock exits quietly, so concurrent starts leave one app.
const { version } = JSON.parse(await readFile(pluginURL(".claude-plugin", "plugin.json"), "utf8"));
// The app runs detached with no terminal, so the shared Prism log file is its only record.
startProcessLog("review-app", { version });
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
log.info("process_stopping", { reason: "closed" });
await log.flush();
process.exit(0);
