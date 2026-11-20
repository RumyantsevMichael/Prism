import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsProject, askAsLaunch, holderOf, INITIATIVE, plannedSlices, writeClaim } from "./fixtures/agents.mjs";
import { launch as launchBrowser, openPage, reviewUrl, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// The Agents page, in place of Launched sessions: one table row per agent in shared columns, grouped by what needs the person, with
// a launched session's details and actions kept from the page it replaces.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-agents-page-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);
const SUBTITLE = "Every agent working on this workspace, and every session launched on this computer.";

async function busy(t) {
  const s = await agentsProject(t, {
    plans: { claude: [{ model: "claude-opus-5-5", isError: true, hold: 50 }, { model: "claude-sonnet-5-5", hold: "forever" }], codex: [{ model: "gpt-5.5-codex", hold: "forever" }] },
    before: (fixture) => plannedSlices(fixture.root, [["download", "Signed download link"], ["audit", "Audit event schema"], ["naming", "Export file naming"], ["retention", "Retention policy"]])
  });
  const failed = await s.start(INITIATIVE, "claude-code");
  await s.settledLaunch(failed, (view) => view.state === "failed");
  const running = await s.start("search", "codex");
  await s.settledLaunch(running, (view) => view.state === "running");
  const waiting = await s.start(INITIATIVE, "claude-code");
  await s.settledLaunch(waiting, (view) => view.state === "running");
  const gate = await askAsLaunch(s.root, waiting, "Which retention window?");
  await s.settledLaunch(waiting, (view) => view.state === "waiting");
  await writeClaim(s.root, INITIATIVE, "retention", { label: "Prism Test on vm", host: "Claude Code", model: "claude-sonnet-5-5", holder: holderOf(s.runs("claude")[1].argv[3]), activity: "design", minutesLeft: 28 });
  await writeClaim(s.root, INITIATIVE, "download", { label: "Dana on studio-mac", host: "Codex", model: "gpt-5.5", activity: "design", minutesLeft: 22 });
  await writeClaim(s.root, INITIATIVE, "audit", { label: "Claude on vm", minutesLeft: 9 });
  await writeClaim(s.root, INITIATIVE, "naming", { label: "Michael on work-mac", host: "Claude Code", model: "Opus 5", activity: "design", minutesLeft: -120 });
  const browser = await launchBrowser(t);
  // A tab that Prism opened holds a write session from the grant in its URL fragment; a plain review URL only reads.
  // The project's server already spent its one browser open on the fixture's write session and refuses another while that open's lease
  // lasts, so a write tab comes from its own review server over the same project, whose first open issues a fresh grant.
  const open = async (ref = "agents", { write = false, viewport = { width: 1440, height: 900 } } = {}) => {
    let url = reviewUrl(s.base, ref);
    if (write) {
      const tab = await startActionReview(t, s.root);
      await tab.review.open([]);
      assert.equal(tab.opened.length, 1, "the tab's own server opens the browser once, with a grant");
      const granted = new URL(tab.opened.at(-1));
      url = `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(ref)}${granted.hash}`;
    }
    const page = await openPage(browser, url, { viewport });
    await waitForView(page);
    return page;
  };
  return { ...s, failed, running, waiting, gate, open };
}

const text = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, " ").trim());
const row = (page, id) => page.locator(`[data-agent="${id}"]`);
const cells = (page, id) => row(page, id).locator(":scope > .prism-lib-cell, :scope > .prism-lib-title").evaluateAll((items) => items.map((item) => item.innerText.replace(/\s+/g, " ").trim()));
const groups = (page) => page.locator("prism-lib-table .prism-lib-group-name").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => item.innerText.replace(/\s+/g, " ").trim()));
const shownRef = (page) => page.evaluate(() => new URL(location.href).searchParams.get("artifact"));

test("§20 the Agents page has its title and lead, the old Launched sessions address opens it, and the Jump palette lists it", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await agentsProject(t, {});
  const browser = await launchBrowser(t);
  for (const ref of ["agents", "launches"]) {
    const page = await openPage(browser, reviewUrl(s.base, ref), { viewport: { width: 1440, height: 900 } });
    await waitForView(page);
    assert.equal(await page.getByRole("heading", { name: "Agents", level: 1 }).count(), 1, `${ref} shows the Agents page`);
    assert.match(await text(page.locator("#artifact")), new RegExp(SUBTITLE.replace(/[.]/g, "\\.")));
    assert.equal(await page.getByRole("heading", { name: "Launched sessions" }).count(), 0);
    assert.match(await text(page.getByRole("navigation", { name: "Breadcrumb" }).first()), /Agents/);
    assert.match(await text(page.locator("#artifact")), /No agent works on this workspace, and nothing was launched on this computer\./, "an empty page says so");
    await page.context().close();
  }
  const page = await openPage(browser, reviewUrl(s.base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  await page.keyboard.type("Agents");
  await settled(() => palette.getByRole("option", { name: /^Agents/ }).count(), (count) => count > 0);
  assert.ok(await palette.getByRole("option", { name: /^Agents/ }).count() > 0, "the palette lists the Agents page");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Launched sessions");
  assert.equal(await palette.getByRole("option", { name: /^Launched sessions/ }).count(), 0, "the palette no longer lists Launched sessions");
});

test("§21 §22 the table groups the agents in order, and Show narrows it to one group, also from its address", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open();
  const show = page.getByRole("radiogroup", { name: "Show" });
  await settled(() => show.getByRole("radio").allInnerTexts().then((items) => items.map((item) => item.replace(/\s+/g, " ").trim())), (items) => items[0] === "All 6");
  assert.deepEqual((await show.getByRole("radio").allInnerTexts()).map((item) => item.replace(/\s+/g, " ").trim()), ["All 6", "Needs you 2", "This computer 3", "Other sessions 2", "Expired 1"]);
  assert.deepEqual(await page.locator("prism-lib-table .prism-lib-row.is-head").first().evaluate((head) => [...head.children].map((cell) => cell.textContent.trim()).filter(Boolean)), ["Agent", "Host · model", "Working on", "State", "Time"]);
  assert.deepEqual(await groups(page), ["Needs you 2", "Launched on this computer 1", "Other sessions 2", "Claims that expired 1"]);
  const order = await page.locator("[data-agent]").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => item.dataset.agent));
  assert.deepEqual(order, [`launch:${s.failed}`, `launch:${s.waiting}`, `launch:${s.running}`, `claim:${INITIATIVE}/audit`, `claim:${INITIATIVE}/download`, `claim:${INITIATIVE}/naming`]);
  await show.getByRole("radio", { name: /^Other sessions/ }).click();
  await settled(() => groups(page), ["Other sessions 2"]);
  assert.deepEqual(await groups(page), ["Other sessions 2"]);
  await show.getByRole("radio", { name: /^This computer/ }).click();
  await settled(() => groups(page), ["Needs you 2", "Launched on this computer 1"]);
  assert.deepEqual(await groups(page), ["Needs you 2", "Launched on this computer 1"], "This computer shows every launched session");
  for (const [ref, expected, chosen] of [["agents:needs-you", ["Needs you 2"], /^Needs you/], ["agents:this-computer", ["Needs you 2", "Launched on this computer 1"], /^This computer/], ["agents:other", ["Other sessions 2"], /^Other sessions/], ["agents:expired", ["Claims that expired 1"], /^Expired/]]) {
    const narrowed = await s.open(ref);
    await settled(() => groups(narrowed), expected);
    assert.deepEqual(await groups(narrowed), expected, ref);
    assert.equal(await narrowed.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: chosen }).getAttribute("aria-checked"), "true");
    await narrowed.context().close();
  }
  assert.deepEqual(page.errors, []);
});

test("§23 each row shows the agent, its harness and model, what it works on, its state, its time, and its one action", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open();
  await row(page, `claim:${INITIATIVE}/naming`).waitFor();
  const waiting = await cells(page, `launch:${s.waiting}`);
  assert.match(waiting[0], /^Export reports/);
  assert.deepEqual(waiting.slice(1, 4), ["Claude Code · claude-sonnet-5-5", "design · Retention policy", "Waiting for you"]);
  assert.deepEqual(await row(page, `launch:${s.waiting}`).getByRole("button").allInnerTexts(), ["Answer"]);
  assert.equal(await row(page, `launch:${s.waiting}`).getByRole("link", { name: "Export reports" }).getAttribute("data-artifact"), `initiative:${INITIATIVE}`);
  const failed = await cells(page, `launch:${s.failed}`);
  assert.equal(failed[1], "Claude Code · claude-opus-5-5");
  assert.match(failed[2], /^Ended .*ago: Claude Code reported an error/);
  assert.equal(failed[3], "Failed");
  assert.deepEqual(await row(page, `launch:${s.failed}`).getByRole("button").allInnerTexts(), ["Open"]);
  const running = await cells(page, `launch:${s.running}`);
  assert.match(running[0], /^Search/);
  assert.deepEqual([running[1], running[3]], ["Codex · gpt-5.5-codex", "Running"]);
  assert.match(running[4], /^\d+s$|^\d+m \d\ds$/, "a launch's time is how long it has run");
  assert.deepEqual(await row(page, `launch:${s.running}`).getByRole("button").allInnerTexts(), ["Stop"]);
  const dana = await cells(page, `claim:${INITIATIVE}/download`);
  assert.deepEqual(dana.slice(0, 4), ["Dana on studio-mac", "Codex · gpt-5.5", "design · Signed download link", "Working"]);
  assert.match(dana[4], /^\d+ min left$/);
  assert.equal(await row(page, `claim:${INITIATIVE}/download`).getByRole("button").count(), 0, "a claim offers no action");
  assert.equal(await row(page, `claim:${INITIATIVE}/download`).getByRole("link", { name: "Dana on studio-mac" }).getAttribute("data-artifact"), `slice:${INITIATIVE}/download`);
  const bare = await cells(page, `claim:${INITIATIVE}/audit`);
  assert.equal(bare[1], "Agent", "a claim that records no harness or model says Agent and nothing more");
  const expired = await cells(page, `claim:${INITIATIVE}/naming`);
  assert.deepEqual(expired.slice(1, 4), ["Claude Code · Opus 5", "design · Export file naming", "Expired"]);
  assert.match(expired[4], /^expired .+ ago$/);
  assert.equal(await row(page, `claim:${INITIATIVE}/retention`).count(), 0, "the launch's own claim has no row of its own");
  assert.deepEqual(page.errors, []);
});

test("§24 §25 a launched session keeps its start, running time, exit status, terminal command, and actions in its row", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open("agents", { write: true });
  const failedRow = row(page, `launch:${s.failed}`);
  await failedRow.waitFor();
  assert.match(await text(failedRow), /Started /, "each launch names when it started");
  assert.equal(await failedRow.locator("[data-agent-details]").isVisible().catch(() => false), false, "the details stay folded until opened");
  await failedRow.getByRole("button", { name: "Open" }).click();
  const details = failedRow.locator("[data-agent-details]");
  await details.waitFor({ state: "visible" });
  const shown = await text(details);
  assert.match(shown, new RegExp(`claude --resume ${s.runs("claude")[0].argv[3]}`), "the terminal command that continues it");
  assert.match(shown, new RegExp(s.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the folder to run it in");
  assert.equal(await details.getByRole("button", { name: "Copy" }).count(), 1);
  // The session's own actions load after its details unfold, so wait for Resume before counting it.
  await details.getByRole("button", { name: /^Resume/ }).first().waitFor({ state: "attached" });
  assert.equal(await details.getByRole("button", { name: /^Resume/ }).count(), 1, "the resume action of the launched session");
  const runningRow = row(page, `launch:${s.running}`);
  assert.equal(await runningRow.locator("code", { hasText: "codex resume" }).count(), 0, "no terminal command while it runs");
  const clock = runningRow.locator("[data-running-time]");
  const before = await clock.innerText();
  assert.notEqual(await settled(() => clock.innerText(), (now) => now !== before), before, "the running time counts while it runs");
  await runningRow.getByRole("button", { name: "Stop" }).click();
  const confirm = page.getByRole("button", { name: /^Stop/ }).last();
  if (await page.getByRole("dialog").count()) await confirm.click();
  await settled(() => text(runningRow), (now) => /Stopped/.test(now), { timeout: 20000 });
  assert.match(await text(runningRow), /Stopped/);
  await settled(() => runningRow.locator("[data-agent-details]").count(), (count) => count > 0);
  await runningRow.getByRole("button", { name: "Open" }).click();
  await runningRow.locator("[data-agent-details]").waitFor({ state: "visible" });
  assert.match(await text(runningRow.locator("[data-agent-details]")), /codex resume /);
  assert.match(await text(runningRow), /Exit code|Ended by signal|Stopped/);
  assert.deepEqual(page.errors, []);
});

test("§26 §20 a tab that can only read says so, offers no stop, still opens the waited question, and the initiative page leads to Agents", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open("agents");
  await row(page, `launch:${s.running}`).waitFor();
  await settled(() => page.getByText("This tab can only read.", { exact: false }).count(), (count) => count > 0);
  assert.ok(await page.getByText("This tab can only read.", { exact: false }).count() > 0);
  const stop = row(page, `launch:${s.running}`).getByRole("button", { name: "Stop" });
  assert.ok((await stop.count()) === 0 || (await stop.isDisabled()), "Stop is not offered in a read-only tab");
  await row(page, `launch:${s.waiting}`).getByRole("button", { name: "Answer" }).click();
  await settled(() => shownRef(page), "attention");
  assert.equal(await shownRef(page), "attention");
  await page.locator(`.gate-answer[data-gate="${s.gate}"][data-initiative="${INITIATIVE}"]`).waitFor({ state: "visible" });
  // The initiative page's launch state leads a tab that cannot make changes to the Agents page.
  const initiative = await s.open(`initiative:${INITIATIVE}`);
  const link = initiative.getByRole("link", { name: "Open in Agents" });
  await link.waitFor();
  assert.equal(await link.getAttribute("data-artifact"), "agents");
  assert.equal(await initiative.getByRole("link", { name: "Open in Launched sessions" }).count(), 0);
});
