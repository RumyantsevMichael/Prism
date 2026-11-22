import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsProject, askAsLaunch, holderOf, INITIATIVE, plannedSlices, waitFor, writeClaim } from "./fixtures/agents.mjs";
import { demoProject, launch as launchBrowser, openPage, reviewUrl, serveProject, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { launchFixture } from "./fixtures/launched-sessions.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";

// The top bar's agents button, in place of Who's working, and its short menu: what needs the person as rows, everything else as
// counts that lead to the Agents page.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-agents-menu-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);

// A failed launch and a waiting one of Export reports, a running launch of Search, two live claims of other sessions, and an expired claim.
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
  await writeClaim(s.root, INITIATIVE, "retention", { label: "Prism Test on vm", host: "Claude Code", holder: holderOf(s.runs("claude")[1].argv[3]), activity: "design", minutesLeft: 28 });
  await writeClaim(s.root, INITIATIVE, "download", { label: "Dana on studio-mac", host: "Codex", model: "gpt-5.5", activity: "design", minutesLeft: 22 });
  await writeClaim(s.root, INITIATIVE, "audit", { label: "Claude on vm", minutesLeft: 9 });
  await writeClaim(s.root, INITIATIVE, "naming", { label: "Michael on work-mac", host: "Claude Code", model: "Opus 5", activity: "design", minutesLeft: -120 });
  const browser = await launchBrowser(t);
  const open = async (ref = "roadmap", viewport = { width: 1440, height: 900 }) => {
    const page = await openPage(browser, reviewUrl(s.base, ref), { viewport });
    await waitForView(page);
    return page;
  };
  return { ...s, failed, running, waiting, gate, open };
}

const agentsButton = (page) => page.getByRole("button", { name: /^Agents:/ });
const menu = (page) => page.getByRole("dialog", { name: "Agents", exact: true });
const shownRef = (page) => page.evaluate(() => new URL(location.href).searchParams.get("artifact"));
const visibleText = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, " ").trim());

test("§14 §18 the agents button counts working agents and marks failed and waiting sessions apart, and no Who's working is left", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open();
  const button = agentsButton(page);
  await settled(() => button.getAttribute("aria-label").catch(() => null), (name) => name === "Agents: 4 working, 1 failed, 1 waits, 1 claim expired");
  assert.equal(await button.count(), 1);
  assert.equal(await page.getByRole("button", { name: /Who's working/ }).count(), 0, "Who's working is gone");
  const text = await visibleText(button);
  assert.match(text, /\b4 working\b/);
  const badges = await button.locator("prism-badge").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => [item.textContent.trim(), item.getAttribute("tone"), item.getAttribute("variant")]));
  assert.deepEqual(badges, [["1 failed", "danger", "status"], ["1 waits", "warning", "status"]]);
  assert.ok(await button.locator("prism-avatar").count() <= 3, "at most three avatars");
  assert.ok(await button.locator("prism-avatar").count() >= 1);
  for (const ref of ["attention", `slice:${INITIATIVE}/download`, "agents"]) {
    const other = await s.open(ref);
    assert.equal(await agentsButton(other).count(), 1, `the agents button is in the top bar of ${ref}`);
    await other.context().close();
  }
  assert.deepEqual(page.errors, []);
});

test("§14 with nothing to show the button says 0 working and carries no marks", { skip: skipHere, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, {});
  const browser = await launchBrowser(t);
  const page = await openPage(browser, reviewUrl(s.base, "roadmap"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const button = agentsButton(page);
  await settled(() => button.getAttribute("aria-label").catch(() => null), (name) => name === "Agents: 0 working");
  assert.match(await visibleText(button), /\b0 working\b/);
  assert.equal(await button.locator("prism-badge").evaluateAll((items) => items.filter((item) => item.getClientRects().length).length), 0);
  await button.click();
  const dialog = menu(page);
  await dialog.waitFor();
  assert.equal(await dialog.getByText("Needs you", { exact: false }).count(), 0, "no Needs you group without sessions that need the person");
  assert.match(await visibleText(dialog), /Launched from Prism\s*0/);
});

test("§3 §15 on a phone the button shows its avatars and one count of what needs the person, and the workspace name stays whole", { skip: skipHere, timeout: 120000 }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ model: "claude-opus-5-5", isError: true, hold: 50 }] } });
  fixture.useAsProcessEnv();
  const root = await demoProject(t);
  const { startLaunch, listLaunches } = await import("../../dist/server/session/launched-sessions.mjs");
  const id = (await startLaunch({ projectRoot: root, initiative: "retry-hardening", host: "claude-code", env: fixture.env })).launch.id;
  await waitFor(async () => (await listLaunches({ projectRoot: root, env: fixture.env })).launches.find((item) => item.id === id)?.state === "failed", { what: "the failed launch" });
  const { base } = await serveProject(t, root);
  const browser = await launchBrowser(t);
  for (const width of [390, 320]) {
    const page = await openPage(browser, reviewUrl(base, "roadmap"), { viewport: { width, height: 844 } });
    await waitForView(page);
    const button = agentsButton(page);
    await settled(() => button.getAttribute("aria-label").catch(() => null), (name) => /^Agents: \d+ working, 1 failed/.test(name ?? ""));
    await repainted(page);
    assert.doesNotMatch(await visibleText(button), /working/, `${width}px: no words in the button`);
    const corner = await button.locator("prism-badge").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => [item.textContent.trim(), item.getAttribute("tone")]));
    assert.deepEqual(corner, [["1", "danger"]], `${width}px: one count of the sessions that need the person, danger while one failed`);
    const label = await page.locator("#project").evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { cut: node.scrollWidth > node.clientWidth + 1, shown: box.width > 0 && box.left >= 0 && box.right <= innerWidth, text: node.textContent };
    });
    assert.equal(label.cut, false, `${width}px: the workspace name ${label.text} is not cut`);
    assert.equal(label.shown, true, `${width}px: the workspace name is shown`);
    const box = await button.boundingBox();
    assert.ok(box.x + box.width <= width, `${width}px: the button stays inside the window`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test("§16 §17 §19 the menu lists what needs the person as rows, counts the rest, and lists no claim", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open();
  await settled(() => agentsButton(page).getAttribute("aria-label").catch(() => null), (name) => name?.includes("1 waits"));
  await agentsButton(page).click();
  const dialog = menu(page);
  await dialog.waitFor();
  assert.match(await visibleText(dialog), /Needs you\s*2/);
  const rows = dialog.locator("prism-row");
  assert.equal(await rows.count(), 2, "only the sessions that need the person are rows");
  const failed = await visibleText(rows.nth(0));
  assert.match(failed, /Export reports/);
  assert.match(failed, /Claude Code · claude-opus-5-5/);
  assert.match(failed, /Failed/);
  assert.deepEqual(await rows.nth(0).getByRole("button").allInnerTexts(), ["Open"]);
  const waiting = await visibleText(rows.nth(1));
  assert.match(waiting, /Claude Code · claude-sonnet-5-5 · design · Retention policy/);
  assert.match(waiting, /Waiting for you/);
  assert.deepEqual(await rows.nth(1).getByRole("button").allInnerTexts(), ["Answer"]);
  const whole = await visibleText(dialog);
  for (const name of ["Dana on studio-mac", "Claude on vm", "Michael on work-mac", "Search"]) assert.equal(whole.includes(name), false, `${name} is counted, not listed`);
  const counts = await dialog.getByRole("link").evaluateAll((links) => links.map((link) => link.innerText.replace(/\s+/g, " ").trim()));
  assert.deepEqual(counts, ["Launched from Prism 3", "Started outside Prism 2", "Expired claims 1"]);
  assert.equal(await dialog.getByRole("button", { name: "Open Agents", exact: true }).count(), 1);
  assert.deepEqual(page.errors, []);
});

test("§17 each count opens its group on the Agents page, and Open Agents opens every group", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open();
  for (const [name, ref] of [["Launched from Prism", "agents:this-computer"], ["Started outside Prism", "agents:other"], ["Expired claims", "agents:expired"]]) {
    await agentsButton(page).click();
    await menu(page).waitFor();
    await menu(page).getByRole("link", { name: new RegExp(`^${name}`) }).click();
    await settled(() => shownRef(page), ref);
    assert.equal(await shownRef(page), ref);
    await waitForView(page);
    assert.equal(await menu(page).count(), 0, "the menu closes");
  }
  await agentsButton(page).click();
  await menu(page).getByRole("button", { name: "Open Agents", exact: true }).click();
  await settled(() => shownRef(page), "agents");
  assert.equal(await shownRef(page), "agents");
  await waitForView(page);
  assert.equal(await page.getByRole("heading", { name: "Agents", level: 1, exact: true }).count(), 1);
});

test("§18 Answer opens the waited question in Attention, and Open shows the failed session's details on the Agents page", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await busy(t);
  const page = await s.open();
  await settled(() => agentsButton(page).getAttribute("aria-label").catch(() => null), (name) => name?.includes("1 waits"));
  await agentsButton(page).click();
  await menu(page).getByRole("button", { name: "Answer", exact: true }).click();
  await settled(() => shownRef(page), "attention");
  await waitForView(page);
  const form = page.locator(`.gate-answer[data-gate="${s.gate}"][data-initiative="${INITIATIVE}"]`);
  await form.waitFor({ state: "visible" });
  assert.match(await visibleText(page.locator("#artifact")), /Which retention window\?/);
  assert.equal(await menu(page).count(), 0, "the menu closes");
  await agentsButton(page).click();
  await menu(page).getByRole("button", { name: "Open", exact: true }).click();
  await settled(() => shownRef(page), "agents");
  await waitForView(page);
  const details = page.locator(`[data-agent="launch:${s.failed}"] [data-agent-details]`);
  await details.waitFor({ state: "visible" });
  assert.match(await visibleText(details), new RegExp(`claude --resume ${s.runs("claude")[0].argv[3]}`));
});

test("headless-run-questions §15 the button marks a session that ended without a result with an info badge between failed and waiting, and its menu Answer opens the no-result gate", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { archiveProject, pageOpener } = await import("./fixtures/archived-launches.mjs");
  const s = await archiveProject(t);
  const waiting = await s.launch("waiting");
  const unresolved = await s.launch("ended-without-result", { host: "codex", label: "Codex", message: null });
  const failed = await s.launch("failed");
  const page = await (await pageOpener(t, s))("roadmap");
  const button = agentsButton(page);
  await settled(() => button.getAttribute("aria-label").catch(() => null), (name) => name === "Agents: 0 working, 1 failed, 1 ended without a result, 1 waits");
  const badges = await button.locator("prism-badge").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => [item.innerText.replace(/\s+/g, " ").trim(), item.getAttribute("tone")]));
  assert.deepEqual(badges, [["1 failed", "danger"], ["1 ended without a result", "info"], ["1 waits", "warning"]]);
  await page.setViewportSize({ width: 820, height: 900 });
  await settled(() => button.locator("prism-badge.no-result").evaluate((item) => item.innerText.replace(/\s+/g, " ").trim()), "1 no result");
  assert.equal(await button.locator("prism-badge.no-result").evaluate((item) => item.innerText.replace(/\s+/g, " ").trim()), "1 no result", "a tablet's top bar shortens the badge");
  await page.setViewportSize({ width: 1440, height: 900 });
  await button.click();
  const rows = await menu(page).locator("[data-menu-agent]").evaluateAll((items) => items.map((item) => item.dataset.menuAgent));
  assert.deepEqual(rows, [`launch:${failed}`, `launch:${unresolved}`, `launch:${waiting}`]);
  const row = menu(page).locator(`[data-menu-agent="launch:${unresolved}"]`);
  assert.match(await visibleText(row), /Ended without a result/);
  await row.getByRole("button", { name: "Answer", exact: true }).click();
  await settled(() => shownRef(page), "attention");
  await waitForView(page);
  const card = page.locator(".gate-no-result:visible");
  await card.waitFor();
  assert.match(await visibleText(card), /The run left no message\./);
  assert.equal(await visibleText(card.locator(".attention-where")), "Export reports · Codex");
  assert.deepEqual(page.errors, []);
});
