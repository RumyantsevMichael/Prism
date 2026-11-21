import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsButton, agentsMenu, archiveProject, groupsOf, INITIATIVE, NOT_ENDED, pageOpener, rowOf, rowsOf, showsOf, textOf } from "./fixtures/archived-launches.mjs";
import { plannedSlices } from "./fixtures/agents.mjs";
import { skip, writeClaim } from "./fixtures/kit-browser.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// Archiving on the Agents page: Archive on each ended launched session's row, Archive all ended, the Archived filter with Unarchive,
// a tab that can only read, and the agents menu and mark without archived sessions.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-agents-archive-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

// One launched session in each state and a live claim; the running one's heartbeat stays fresh while the test runs.
async function project(t) {
  const s = await archiveProject(t);
  await plannedSlices(s.root, [["download", "Signed download link"]]);
  const ids = {};
  for (const state of ["failed", "finished", "stopped", "blocked", "running", "waiting"]) ids[state] = await s.launch(state);
  await s.beat(ids.running);
  const timer = setInterval(() => void s.beat(ids.running).catch(() => {}), 5000);
  t.after(() => clearInterval(timer));
  await writeClaim(s.root, INITIATIVE, "download", { label: "Dana on studio-mac", host: "Codex", model: "gpt-5.5", activity: "design", minutesLeft: 22 });
  return { ...s, ids, open: await pageOpener(t, s) };
}

const ENDED = ["failed", "finished", "stopped", "blocked"];
const buttons = (locator) => locator.getByRole("button").evaluateAll((items) => items.filter((item) => item.getClientRects().length).map((item) => item.innerText.trim()));
const actionCell = (page, id) => rowOf(page, id).locator(":scope > .prism-lib-cell").last();
const toasts = (page) => page.getByRole("status").allInnerTexts().then((items) => items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean));
const archiveAll = (page) => page.getByRole("button", { name: "Archive all ended", exact: true });

test("§18 each ended launched session offers Archive beside Open, and no running or waiting session or claim offers it", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open("agents", { write: true });
  await rowOf(page, `claim:${INITIATIVE}/download`).waitFor();
  for (const state of ENDED) assert.deepEqual(await buttons(actionCell(page, `launch:${s.ids[state]}`)), ["Open", "Archive"], state);
  assert.deepEqual(await buttons(actionCell(page, `launch:${s.ids.running}`)), ["Stop"]);
  assert.deepEqual(await buttons(actionCell(page, `launch:${s.ids.waiting}`)), ["Answer"]);
  assert.equal(await rowOf(page, `claim:${INITIATIVE}/download`).getByRole("button", { name: "Archive", exact: true }).count(), 0, "a claim offers no Archive");
  assert.deepEqual(page.errors, []);
});

test("§19 Archive removes the session from its group and every count at once, and a refused archive keeps the row and says why", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open("agents", { write: true });
  const finished = `launch:${s.ids.finished}`;
  await rowOf(page, finished).waitFor();
  await settled(() => showsOf(page), (items) => items[0] === "All 7");
  await actionCell(page, finished).getByRole("button", { name: "Archive", exact: true }).click();
  await settled(() => rowsOf(page), (rows) => !rows.includes(finished));
  assert.equal((await rowsOf(page)).includes(finished), false, "the row left the page");
  assert.deepEqual(await showsOf(page), ["All 6", "Needs you 2", "Launched from Prism 5", "Started outside Prism 1", "Expired 0", "Archived 1"]);
  assert.deepEqual(await groupsOf(page), ["Needs you 2", "Launched from Prism 3", "Started outside Prism 1"]);
  await settled(() => toasts(page), (items) => items.includes("Archived. The Archived filter keeps it."));
  assert.ok((await toasts(page)).includes("Archived. The Archived filter keeps it."));
  assert.deepEqual(page.requests.map((request) => [request.path, JSON.parse(request.body)]), [["api/agents/archive", { launch: s.ids.finished }]]);
  // The stopped session runs again before the person presses Archive, so the server refuses it.
  const stopped = `launch:${s.ids.stopped}`;
  await s.addRun(s.ids.stopped, "running");
  await s.beat(s.ids.stopped);
  await actionCell(page, stopped).getByRole("button", { name: "Archive", exact: true }).click();
  await settled(() => toasts(page), (items) => items.includes(NOT_ENDED));
  assert.ok((await toasts(page)).includes(NOT_ENDED), "the refusal's message");
  assert.ok((await rowsOf(page)).includes(stopped), "the row stays");
  assert.deepEqual(page.errors, []);
});

test("§20 Archive all ended archives every ended session without asking, and shows only where an ended session can be archived", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open("agents", { write: true });
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  await rowOf(page, `launch:${s.ids.failed}`).waitFor();
  await archiveAll(page).waitFor({ state: "visible" });
  const show = page.getByRole("radiogroup", { name: "Show" });
  await show.getByRole("radio", { name: /^Started outside Prism/ }).click();
  await settled(() => archiveAll(page).isVisible(), false);
  assert.equal(await archiveAll(page).isVisible(), false, "not shown where no launched session is");
  await show.getByRole("radio", { name: /^Needs you/ }).click();
  await archiveAll(page).waitFor({ state: "visible" });
  await show.getByRole("radio", { name: /^All/ }).click();
  await archiveAll(page).click();
  const ended = ENDED.map((state) => `launch:${s.ids[state]}`);
  await settled(() => rowsOf(page), (rows) => ended.every((id) => !rows.includes(id)));
  const rows = await rowsOf(page);
  for (const id of ended) assert.equal(rows.includes(id), false, `${id} was archived`);
  assert.ok(rows.includes(`launch:${s.ids.running}`) && rows.includes(`launch:${s.ids.waiting}`), "the running and the waiting session stay");
  assert.equal(dialogs, 0, "no confirmation");
  assert.equal(await page.locator("prism-dialog[open]").count(), 0, "no confirmation dialog");
  await settled(() => toasts(page), (items) => items.includes("Archived 4 sessions. The Archived filter keeps them."));
  assert.ok((await toasts(page)).includes("Archived 4 sessions. The Archived filter keeps them."));
  assert.deepEqual(page.requests.map((request) => [request.path, JSON.parse(request.body)]), [["api/agents/archive", { ended: true }]]);
  await settled(() => archiveAll(page).isVisible(), false);
  assert.equal(await archiveAll(page).isVisible(), false, "with nothing left to archive the button goes");
  assert.equal((await showsOf(page)).at(-1), "Archived 4");
  // One ended session archived at once says so in the singular.
  await s.addRun(s.ids.failed, "finished");
  await settled(() => rowsOf(page), (now) => now.includes(`launch:${s.ids.failed}`));
  await archiveAll(page).click();
  await settled(() => toasts(page), (items) => items.includes("Archived 1 session. The Archived filter keeps it."));
  assert.ok((await toasts(page)).includes("Archived 1 session. The Archived filter keeps it."));
  assert.deepEqual(page.errors, []);
});

test("§21 §22 Archived lists each archived session with its details and Unarchive, which brings it back to its group", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  for (const state of ["failed", "finished"]) assert.equal((await s.archive({ launch: s.ids[state] })).status, 200);
  const page = await s.open("agents", { write: true });
  await rowOf(page, `launch:${s.ids.running}`).waitFor();
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /^Archived/ }).click();
  await settled(() => groupsOf(page), ["Archived 2"]);
  assert.deepEqual(await groupsOf(page), ["Archived 2"]);
  assert.deepEqual(await rowsOf(page), [`launch:${s.ids.failed}`, `launch:${s.ids.finished}`], "the latest launched first");
  const failed = `launch:${s.ids.failed}`;
  assert.deepEqual(await buttons(actionCell(page, failed)), ["Open", "Unarchive"]);
  assert.match(await textOf(rowOf(page, failed)), /Failed/);
  await actionCell(page, failed).getByRole("button", { name: "Open", exact: true }).click();
  const details = rowOf(page, failed).locator("[data-agent-details]");
  await details.waitFor({ state: "visible" });
  assert.match(await textOf(details), /claude --resume [0-9a-f-]{36}/, "the terminal command that continues it");
  assert.equal(await details.getByRole("button", { name: "Copy", exact: true }).count(), 1);
  // The session's own actions load after its details unfold, so wait for Resume before counting it.
  await details.getByRole("button", { name: /^Resume/ }).first().waitFor({ state: "attached" });
  assert.equal(await details.getByRole("button", { name: /^Resume/ }).count(), 1);
  await actionCell(page, failed).getByRole("button", { name: "Unarchive", exact: true }).click();
  await settled(() => rowsOf(page), (rows) => !rows.includes(failed));
  assert.deepEqual(await rowsOf(page), [`launch:${s.ids.finished}`], "it left Archived");
  await settled(() => toasts(page), (items) => items.includes("Unarchived."));
  assert.ok((await toasts(page)).includes("Unarchived."));
  assert.equal((await showsOf(page)).at(-1), "Archived 1");
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /^Needs you/ }).click();
  await settled(() => rowsOf(page), (rows) => rows.includes(failed));
  assert.deepEqual(await rowsOf(page), [failed, `launch:${s.ids.waiting}`], "a failed session needs the person again");
  assert.deepEqual(page.requests.map((request) => [request.path, JSON.parse(request.body)]), [["api/agents/unarchive", { launch: s.ids.failed }]]);
  assert.deepEqual(page.errors, []);
});

test("§23 a tab that can only read shows Archive, Unarchive, and Archive all ended unavailable and sends nothing", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  assert.equal((await s.archive({ launch: s.ids.finished })).status, 200);
  const page = await s.open("agents");
  const failed = `launch:${s.ids.failed}`;
  await rowOf(page, failed).waitFor();
  const archive = actionCell(page, failed).getByRole("button", { name: "Archive", exact: true });
  await archive.waitFor();
  assert.equal(await archive.isDisabled(), true);
  assert.equal(await archiveAll(page).isDisabled(), true);
  await archive.hover();
  await settled(() => page.getByRole("tooltip").allInnerTexts(), (items) => items.some((item) => item.includes("This tab can only read.")));
  assert.ok((await page.getByRole("tooltip").allInnerTexts()).some((item) => item.includes("This tab can only read.")));
  await archive.click({ force: true });
  await archiveAll(page).click({ force: true });
  await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /^Archived/ }).click();
  const unarchive = actionCell(page, `launch:${s.ids.finished}`).getByRole("button", { name: "Unarchive", exact: true });
  await unarchive.waitFor();
  assert.equal(await unarchive.isDisabled(), true);
  await unarchive.click({ force: true });
  await pause(500, "a disabled button sends nothing, which no event shows");
  assert.deepEqual(page.requests, [], "nothing was sent");
  assert.equal((await s.agents()).agents.find((agent) => agent.id === failed).group, "needs-you");
  assert.deepEqual(page.errors, []);
});

test("§24 an archived failed session leaves the menu's Needs you, the mark, and its count, and comes back once it waits again", { skip, timeout: 120000 }, async (t) => {
  const s = await project(t);
  const page = await s.open("roadmap");
  await settled(() => agentsButton(page).getAttribute("aria-label").catch(() => null), (name) => /1 failed/.test(name ?? ""));
  assert.equal((await s.archive({ launch: s.ids.failed })).status, 200);
  await settled(() => agentsButton(page).getAttribute("aria-label").catch(() => null), (name) => !/failed/.test(name ?? ""), { timeout: 30000 });
  assert.doesNotMatch(await agentsButton(page).getAttribute("aria-label"), /failed/, "the mark no longer counts the archived failed session");
  await agentsButton(page).click();
  const menu = agentsMenu(page);
  await menu.waitFor();
  await settled(() => menu.locator("prism-row").count(), 1);
  assert.equal(await menu.locator("prism-row").count(), 1, "only the waiting session needs the person");
  assert.match(await textOf(menu), /Needs you\s*1/);
  const counts = () => menu.getByRole("link").evaluateAll((links) => links.map((link) => link.innerText.replace(/\s+/g, " ").trim()));
  assert.equal((await counts())[0], "Launched from Prism 5");
  // The archived session waits for the person again, so it leaves the archive by itself.
  await s.markGate(s.ids.failed);
  await s.addRun(s.ids.failed, "finished");
  await settled(() => menu.locator("prism-row").count(), 2, { timeout: 30000 });
  assert.equal(await menu.locator("prism-row").count(), 2);
  assert.equal((await counts())[0], "Launched from Prism 6");
  assert.deepEqual(page.errors, []);
});
