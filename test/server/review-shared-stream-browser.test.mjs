import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// A browser opens at most six HTTP/1.1 connections to one host, and the review app serves every project from one host.
// These tests open many review tabs of two projects in one browser and check that they share one event stream, that its events still reach every tab,
// that the stream moves to another tab when its tab closes, and that the last tab still navigates at once.

async function app(context) {
  await useAppDirectory(context);
  const portal = await demoProject(context);
  const billing = await demoProject(context);
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = path.join(path.dirname(portal), "data");
  const { startReviewApp } = await import("../../dist/server/review/review-app-server.mjs");
  const { createReviewAppClient } = await import("../../dist/server/review/review-app-client.mjs");
  const { withWriteGrant } = await import("../../dist/server/review/write-sessions.mjs");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shared-stream-")));
  const started = await startReviewApp({ directory, pluginVersion: "0.0.0-test" });
  const client = createReviewAppClient({ directory, launch: () => null, pluginVersion: "0.0.0-test" });
  context.after(async () => {
    await client.close();
    await started.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.register(portal);
  await client.register(billing);
  const portalAnswer = await client.present(portal, { tabs: [], open: true });
  const billingAnswer = await client.present(billing, { tabs: [], open: false });
  return { client, portal, billing, portalUrl: portalAnswer.url, billingUrl: billingAnswer.url, granted: withWriteGrant(portalAnswer.url, portalAnswer.writeGrant) };
}

// Counts the shared and per-tab event streams every page of the browser context opens.
function streamCounter(context) {
  const opened = { shared: 0, own: 0 };
  context.on("request", (request) => {
    const route = new URL(request.url()).pathname;
    if (route.endsWith("/api/events/shared")) opened.shared += 1;
    else if (route.endsWith("/api/events")) opened.own += 1;
  });
  return opened;
}

async function openTab(context, url) {
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  await page.goto(url, { waitUntil: "commit", timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#artifact")?.getAttribute("aria-busy") === "false", null, { timeout: 10000 });
  return page;
}

const tabValues = (page) => page.evaluate(() => [...document.querySelectorAll("#open-tabs prism-doc-tab")].map((tab) => tab.getAttribute("value")));

async function eventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("eight tabs of two projects share one event stream, and the last tab still navigates within seconds", { skip, timeout: 120000 }, async (context) => {
  const { client, billing, portalUrl, billingUrl, granted } = await app(context);
  const browser = await launch(context);
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const opened = streamCounter(browserContext);
  const pages = [];
  for (let index = 0; index < 8; index += 1) pages.push(await openTab(browserContext, index === 0 ? granted : index % 3 === 2 ? billingUrl : portalUrl));
  assert.equal(opened.shared, 1, "only the first tab opened the shared stream");
  assert.equal(opened.own, 0, "no tab opened a stream of its own");

  const last = pages.at(-1);
  await last.bringToFront();
  await last.getByRole("navigation", { name: "Places" }).getByRole("button", { name: /^Knowledge/ }).click();
  const started = Date.now();
  await last.locator("#sidebar").getByRole("treeitem", { name: /^Glossary/ }).click();
  await last.waitForFunction(() => /Glossary/.test(document.querySelector("#artifact h1")?.textContent ?? ""), null, { timeout: 5000 });
  assert.ok(Date.now() - started < 5000, `the eighth tab navigated in ${Date.now() - started} ms`);

  // A billing tab follows the stream through the portal tab that holds it.
  const billingTab = pages[2];
  await client.present(billing, { tabs: ["roadmap"], open: false });
  assert.ok(await eventually(async () => (await tabValues(billingTab)).includes("roadmap")), "a session change of the billing project reached a billing tab that does not hold the stream");

  // Closing the tab that holds the stream hands it to another tab, and events keep arriving.
  await pages[0].close();
  assert.ok(await eventually(() => opened.shared === 2), "another tab opened the shared stream once the first closed");
  await client.present(billing, { tabs: ["glossary"], open: false });
  assert.ok(await eventually(async () => (await tabValues(billingTab)).includes("glossary")), "events reach the billing tab through the new stream");
  assert.equal(opened.own, 0);
  for (const page of pages.slice(1)) assert.deepEqual(page.errors, []);
});

test("a tab that holds a write session counts as a connected tab although another tab holds the stream", { skip, timeout: 120000 }, async (context) => {
  const { client, portal, portalUrl, granted } = await app(context);
  const browser = await launch(context);
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // The read-only tab opens first, so it holds the stream, and the writable tab only joins it.
  const reader = await openTab(browserContext, portalUrl);
  const writer = await openTab(browserContext, granted);
  assert.equal(await reader.evaluate(() => sessionStorage.getItem("prism-write-session")), null, "the write session stays in the tab that took it");
  assert.notEqual(await writer.evaluate(() => sessionStorage.getItem("prism-write-session")), null);
  // A browser opens at most once per open lease, so the check waits for the lease of the first open to pass.
  await new Promise((resolve) => setTimeout(resolve, 10500));
  assert.equal((await client.present(portal, { tabs: [], open: true })).open, false, "the writable tab is connected, so no new window opens");
  await writer.close();
  assert.ok(await eventually(async () => (await client.present(portal, { tabs: [], open: true })).open === true), "once the writable tab closed, a presentation opens a window again");
  assert.deepEqual(reader.errors, []);
});
