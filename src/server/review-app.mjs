import { readFile } from "node:fs/promises";
import { pluginURL } from "./plugin-root.mjs";
import { reviewAppDirectory } from "./review/review-app-discovery.mjs";
import { startReviewApp } from "./review/review-app-server.mjs";

// The detached review app that no agent session owns; a start that loses the lock exits quietly, so concurrent starts leave one app.
const { version } = JSON.parse(await readFile(pluginURL(".claude-plugin", "plugin.json"), "utf8"));
let app;
try {
  app = await startReviewApp({ directory: reviewAppDirectory(), pluginVersion: version });
} catch {
  process.exit(0);
}
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());
await app.closed;
process.exit(0);
