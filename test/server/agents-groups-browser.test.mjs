import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsButton, agentsMenu, archiveProject, groupsOf, INITIATIVE, pageOpener, rowsOf, showsOf, textOf } from "./fixtures/archived-launches.mjs";
import { plannedSlices } from "./fixtures/agents.mjs";
import { skip, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";

// The Agents page's groups named by who started the agent, its Show choices with Archived, the default view without archived sessions
// and claims that expired a day ago, and the menu's counts under the same names.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-agents-groups-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const HOUR = 60;

// A failed and a finished launch, an archived finished one, a live claim from a harness that is neither Claude Code nor Codex, a claim
// that expired an hour ago, and one that expired 25 hours ago.
async function project(t) {
  const s = await archiveProject(t);
  await plannedSlices(s.root, [["live", "Back off between retries"], ["recent", "Audit event schema"], ["old", "Export file naming"], ["turning", "Retention policy"]]);
  const failed = await s.launch("failed");
  const finished = await s.launch("finished");
  const archived = await s.launch("finished");
  assert.equal((await s.archive({ launch: archived })).status, 200);
  await writeClaim(s.root, INITIATIVE, "live", { label: "Priya on linux-ws", host: "OpenCode", model: "kimi-k3", activity: "design", minutesLeft: 19 });
  await writeClaim(s.root, INITIATIVE, "recent", { label: "Sam on ci-runner-02", host: "Codex", model: "gpt-5.5", minutesLeft: -HOUR });
  await writeClaim(s.root, INITIATIVE, "old", { label: "Michael on work-mac", host: "Claude Code", minutesLeft: -25 * HOUR, minutesClaimed: 26 * HOUR });
  return { ...s, failed, finished, archived, open: await pageOpener(t, s) };
}

test("§13 the groups read Needs you, Launched from Prism, Started outside Prism, and Claims that expired, in that order", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open();
  await settled(() => groupsOf(page), (groups) => groups.length === 4);
  assert.deepEqual(await groupsOf(page), ["Needs you 1", "Launched from Prism 1", "Started outside Prism 1", "Claims that expired 1"]);
  const shown = await textOf(page.locator("#artifact"));
  for (const old of ["Launched on this computer", "Other sessions", "This computer"]) assert.equal(shown.includes(old), false, `${old} is gone`);
  assert.deepEqual(page.errors, []);
});

test("§14 Show offers All, Needs you, Launched from Prism, Started outside Prism, Expired, and Archived, also from each address", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open();
  await settled(() => showsOf(page), (items) => items[0] === "All 4");
  assert.deepEqual(await showsOf(page), ["All 4", "Needs you 1", "Launched from Prism 2", "Started outside Prism 1", "Expired 2", "Archived 1"]);
  const show = page.getByRole("radiogroup", { name: "Show" });
  await show.getByRole("radio", { name: /^Launched from Prism/ }).click();
  await settled(() => groupsOf(page), ["Needs you 1", "Launched from Prism 1"]);
  assert.deepEqual(await groupsOf(page), ["Needs you 1", "Launched from Prism 1"], "Launched from Prism shows every launched session that is not archived");
  await show.getByRole("radio", { name: /^Started outside Prism/ }).click();
  await settled(() => groupsOf(page), ["Started outside Prism 1"]);
  assert.deepEqual(await groupsOf(page), ["Started outside Prism 1"]);
  for (const [ref, expected, chosen] of [
    ["agents:needs-you", ["Needs you 1"], /^Needs you/],
    ["agents:this-computer", ["Needs you 1", "Launched from Prism 1"], /^Launched from Prism/],
    ["agents:other", ["Started outside Prism 1"], /^Started outside Prism/],
    ["agents:expired", ["Claims that expired 2"], /^Expired/],
    ["agents:archived", ["Archived 1"], /^Archived/]
  ]) {
    const narrowed = await s.open(ref);
    await settled(() => groupsOf(narrowed), expected);
    assert.deepEqual(await groupsOf(narrowed), expected, ref);
    assert.equal(await narrowed.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: chosen }).getAttribute("aria-checked"), "true", ref);
    assert.deepEqual(narrowed.errors, [], ref);
    await narrowed.context().close();
  }
});

test("§15 All shows no archived session and no claim that expired a day ago, and a claim leaves it once its expiry is a day old", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  // A claim whose expiry turns a day old a few seconds after the page opens.
  await writeClaim(s.root, INITIATIVE, "turning", { label: "Dana on studio-mac", host: "Codex", minutesLeft: -24 * HOUR + 0.25, minutesClaimed: 25 * HOUR });
  const page = await s.open();
  await settled(() => rowsOf(page), (rows) => rows.length >= 4);
  const rows = await rowsOf(page);
  assert.equal(rows.includes(`launch:${s.archived}`), false, "no archived session");
  assert.equal(rows.includes(`claim:${INITIATIVE}/old`), false, "no claim that expired 25 hours ago");
  assert.ok(rows.includes(`claim:${INITIATIVE}/recent`), "a claim that expired an hour ago");
  await settled(() => rowsOf(page), (now) => !now.includes(`claim:${INITIATIVE}/turning`), { timeout: 45000 });
  assert.equal((await rowsOf(page)).includes(`claim:${INITIATIVE}/turning`), false, "the claim left All once its expiry was a day old");
  assert.deepEqual(await groupsOf(page), ["Needs you 1", "Launched from Prism 1", "Started outside Prism 1", "Claims that expired 1"]);
  assert.match((await showsOf(page))[0], /^All 4$/, "All counts what it shows");
  assert.deepEqual(page.errors, []);
});

test("§16 Expired shows every expired claim, however long ago it expired", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open("agents:expired");
  await settled(() => rowsOf(page), (rows) => rows.length === 2);
  assert.deepEqual(await rowsOf(page), [`claim:${INITIATIVE}/recent`, `claim:${INITIATIVE}/old`], "the latest to lapse first");
  assert.deepEqual(await groupsOf(page), ["Claims that expired 2"]);
  assert.equal((await showsOf(page))[4], "Expired 2");
  assert.deepEqual(page.errors, []);
});

test("§17 the menu counts Launched from Prism, Started outside Prism, and claims that expired in the last day, each leading to its group", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open("roadmap");
  await agentsButton(page).click();
  const menu = agentsMenu(page);
  await menu.waitFor();
  await settled(() => menu.getByRole("link").evaluateAll((links) => links.map((link) => link.innerText.replace(/\s+/g, " ").trim())), (links) => links[0] === "Launched from Prism 2");
  assert.deepEqual(await menu.getByRole("link").evaluateAll((links) => links.map((link) => link.innerText.replace(/\s+/g, " ").trim())), ["Launched from Prism 2", "Started outside Prism 1", "Expired claims 1"]);
  for (const [name, ref] of [["Launched from Prism", "agents:this-computer"], ["Started outside Prism", "agents:other"], ["Expired claims", "agents:expired"]]) {
    if (!(await agentsMenu(page).count())) await agentsButton(page).click();
    await agentsMenu(page).getByRole("link", { name: new RegExp(`^${name}`) }).click();
    await settled(() => page.evaluate(() => new URL(location.href).searchParams.get("artifact")), ref);
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("artifact")), ref);
    await waitForView(page);
  }
  assert.deepEqual(page.errors, []);
});

test("headless-run-questions §14 §16 Needs you lists a session that ended without a result after failed ones and before waiting ones, with Answer and Archive", { skip, timeout: 120000 }, async (t) => {
  const s = await archiveProject(t);
  // An installed ACP agent, whose command does not exist, so the session names it by its label and nothing can start it.
  const version = path.join(s.app, "agents", "gemini", "1.0.0");
  await mkdir(version, { recursive: true });
  await writeFile(path.join(version, "install.json"), JSON.stringify({ id: "gemini", name: "Gemini CLI", version: "1.0.0", command: path.join(version, "missing-agent"), args: [], env: {}, installedAt: "2026-11-19T10:00:00.000Z" }));
  await writeFile(path.join(s.app, "agents", "gemini", "current.json"), JSON.stringify({ version: "1.0.0" }));
  const waiting = await s.launch("waiting");
  const unresolved = await s.launch("ended-without-result", { host: "acp-gemini", label: "Gemini CLI" });
  const failed = await s.launch("failed");
  const open = await pageOpener(t, s);
  const page = await open("agents:needs-you");
  await settled(() => rowsOf(page), (rows) => rows.length === 3);
  assert.deepEqual(await rowsOf(page), [`launch:${failed}`, `launch:${unresolved}`, `launch:${waiting}`]);
  const row = page.locator(`[data-agent="launch:${unresolved}"]`);
  assert.match(await textOf(row), /Ended without a result/);
  assert.equal(await row.locator('prism-badge[tone="info"]').count(), 1, "the state reads with tone info");
  assert.deepEqual(await row.locator("[data-agent-action]").evaluateAll((items) => items.map((item) => item.dataset.agentAction)), ["answer", "archive"]);
  await row.locator('[data-agent-action="answer"]').click();
  await settled(() => page.evaluate(() => new URL(location.href).searchParams.get("artifact")), (ref) => typeof ref === "string" && ref.startsWith("attention"));
  const card = page.locator(".gate-no-result:visible");
  await card.waitFor();
  assert.equal(await textOf(card.locator(".attention-where")), "Export reports · Gemini CLI", "Answer opens its no-result gate on Attention");
  assert.match(await textOf(card), /Should I park it\?/);
  assert.deepEqual(page.errors, []);
});
