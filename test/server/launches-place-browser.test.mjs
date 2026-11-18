import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch as launchBrowser, openPage, reviewUrl, serveProject, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";
import { CODEX_THREAD, INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// The Launched sessions place of the real review page: one row per session on this computer with its initiative, host, start,
// running time, state, reason, and terminal command, the stop and resume actions rendered by the generic action controls,
// its entry in the command palette, and the launch actions on the initiative page.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-place-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);

async function place(t, plans) {
  const fixture = await launchFixture(t, { plans });
  fixture.useAsProcessEnv();
  const { startLaunch, listLaunches } = await import("../../dist/server/session/launched-sessions.mjs");
  const start = (initiative, host) => startLaunch({ projectRoot: fixture.root, initiative, host, env: fixture.env }).then((result) => result.launch.id);
  const state = async (id) => (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((item) => item.id === id)?.state;
  const { base } = await serveProject(t, fixture.root);
  return { ...fixture, start, state, base, browser: await launchBrowser(t) };
}

const row = (page, id) => page.locator(`[data-launch="${id}"]`);

test("the place lists each launched session with its state, reason, and terminal command", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await place(t, { claude: [{ denials: [{ tool: "Bash", reason: "Denied by auto mode." }] }], codex: [{ hold: "forever" }] });
  const blocked = await s.start(INITIATIVE, "claude-code");
  await waitFor(async () => (await s.state(blocked)) === "blocked", { what: "the blocked session" });
  const running = await s.start("search", "codex");
  const page = await openPage(s.browser, reviewUrl(s.base, "launches"));
  await waitForView(page);
  assert.equal(await page.getByRole("heading", { name: "Launched sessions" }).count() >= 1, true);
  await row(page, blocked).waitFor();
  const blockedText = await row(page, blocked).innerText();
  assert.match(blockedText, /Export reports/, "the row names the initiative by its title");
  assert.match(blockedText, /Claude Code/);
  assert.match(blockedText, /Blocked/);
  assert.match(blockedText, /Claude Code refused Bash: Denied by auto mode\./);
  const sessionId = s.runs("claude")[0].argv[3];
  assert.equal(await row(page, blocked).locator("code", { hasText: `claude --resume ${sessionId}` }).count(), 1, "the terminal command shows while the session is not running");
  assert.match(blockedText, new RegExp(s.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the command's folder shows");
  const runningText = await row(page, running).innerText();
  assert.match(runningText, /Codex/);
  assert.match(runningText, /Running/);
  assert.equal(await row(page, running).locator("code", { hasText: "codex resume" }).count(), 0, "no terminal command while the session runs");
  const before = await row(page, running).locator("[data-running-time]").innerText();
  assert.notEqual(await settled(() => row(page, running).locator("[data-running-time]").innerText(), (shown) => shown !== before), before, "the running time counts while the session runs");
  assert.deepEqual(page.errors, []);
});

test("stopping a session from its row ends it, and the row shows it stopped with its terminal command", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await place(t, { codex: [{ hold: "forever" }] });
  const id = await s.start(INITIATIVE, "codex");
  // A tab that Prism opened holds a write session from the grant in its URL fragment; the place's controls write through it.
  const { startActionReview } = await import("./fixtures/review-actions.mjs");
  const { review, opened } = await startActionReview(t, s.root);
  await review.open([]);
  const granted = new URL(opened.at(-1));
  const page = await openPage(s.browser, `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=launches${granted.hash}`);
  await waitForView(page);
  await row(page, id).waitFor();
  await row(page, id).getByRole("button", { name: "Stop" }).click();
  await waitFor(async () => (await s.state(id)) === "stopped", { what: "the stop" });
  await page.waitForFunction((launchId) => document.querySelector(`[data-launch="${launchId}"]`)?.innerText.includes("Stopped"), id, { timeout: 10000 });
  assert.equal(await row(page, id).locator("code", { hasText: `codex resume ${CODEX_THREAD}` }).count(), 1);
});

test("the place says nothing was launched yet, and the command palette lists it", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await place(t, {});
  const page = await openPage(s.browser, reviewUrl(s.base, "attention"));
  await waitForView(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  await page.keyboard.type("Launched sessions");
  await palette.getByRole("option", { name: /Launched sessions/ }).first().click();
  await waitForView(page);
  assert.equal(new URL(page.url()).searchParams.get("artifact"), "launches");
  assert.match(await page.locator("#artifact").innerText(), /Nothing launched on this computer yet\. Launch an initiative from its page\./);
});

test("the initiative page offers both launch actions with their availability", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await place(t, {});
  const page = await openPage(s.browser, reviewUrl(s.base, `initiative:${INITIATIVE}`));
  await waitForView(page);
  assert.equal(await page.getByText("Launch with Claude Code").count() >= 1, true);
  assert.equal(await page.getByText("Launch with Codex").count() >= 1, true);
});

test("the initiative page shows how its latest launched run ended, a failed one with the host's error, and links to the place", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await place(t, { claude: [{ isError: true, exit: 1 }] });
  const id = await s.start(INITIATIVE, "claude-code");
  await waitFor(async () => (await s.state(id)) === "failed", { what: "the failed session" });
  const page = await openPage(s.browser, reviewUrl(s.base, `initiative:${INITIATIVE}`));
  await waitForView(page);
  const latest = page.locator("#artifact [data-page-end] [data-initiative-last-run]");
  await latest.waitFor();
  assert.match(await latest.innerText(), /Last run failed/, "the page head says the latest run failed without opening anything");
  await latest.click();
  const launcher = page.getByRole("dialog", { name: "Launch an orchestration" });
  await launcher.waitFor();
  const run = launcher.locator("[data-launch-latest]");
  await run.waitFor();
  const text = await run.innerText();
  assert.match(text, /Failed/);
  assert.match(text, /Claude Code reported an error: The API returned an error\./, "the reason says why the run failed");
  await run.getByRole("link", { name: "Open in Launched sessions" }).click();
  await waitForView(page);
  assert.equal(new URL(page.url()).searchParams.get("artifact"), "launches");
  await row(page, id).waitFor();
  assert.deepEqual(page.errors, []);
});

test("the initiative page head shows nothing about runs while none was launched for it here", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await place(t, { codex: [{ hold: "forever" }] });
  await s.start("search", "codex");
  const page = await openPage(s.browser, reviewUrl(s.base, `initiative:${INITIATIVE}`));
  await waitForView(page);
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#artifact [data-initiative-last-run]:visible").count(), 0, "another initiative's run is not this one's");
  assert.deepEqual(page.errors, []);
});
