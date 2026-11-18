import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// A cold restart of the review app keeps its port but gives every link a new viewer credential, so a tab from before the restart
// can no longer call the app. The tab reloads into the page that says its link no longer works, instead of staying on screen with every action failing.
test("a tab from before a cold restart of the app shows that its link no longer works", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = path.join(path.dirname(root), "data");
  const { startReviewApp } = await import("../../dist/server/review/review-app-server.mjs");
  const { createReviewAppClient } = await import("../../dist/server/review/review-app-client.mjs");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-expired-link-")));
  let app = await startReviewApp({ directory, pluginVersion: "0.0.0-test" });
  let client = createReviewAppClient({ directory, launch: () => null, pluginVersion: "0.0.0-test" });
  context.after(async () => {
    await client.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.register(root);
  const { url } = await client.present(root, { tabs: [], open: false });

  const browser = await launch(context);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(url, { waitUntil: "commit", timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#artifact")?.getAttribute("aria-busy") === "false", null, { timeout: 10000 });

  await client.close();
  await app.close();
  app = await startReviewApp({ directory, pluginVersion: "0.0.0-test" });
  client = createReviewAppClient({ directory, launch: () => null, pluginVersion: "0.0.0-test" });
  assert.equal(app.port, Number(new URL(url).port), "the restarted app serves the same port");

  await page.waitForFunction(() => document.body?.dataset.reason === "expired" || document.querySelector("[data-reason='expired']"), null, { timeout: 30000 });
  assert.ok(await page.getByRole("heading", { name: "This review link no longer works" }).isVisible());
});
