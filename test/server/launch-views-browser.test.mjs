import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, apply, fakeEntry, get, launches, setSettings } from "./fixtures/acp-agents.mjs";
import { launch as launchBrowser, openPage, reviewUrl, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launched-sessions.md §30 and docs/requirements/acp-agents.md §16.
// Contract clauses 59 and 60 of docs/plans/harness-client-protocol/slice.md, following the mockups in
// scripts/review-demo/mockups/harness-client-protocol/: a permission request on Attention with Allow and Refuse, and an ACP agent's
// reported usage on the Agents page.

const skipHere = skip || (process.platform === "win32" ? "the fake agent and the dialogs are POSIX scripts" : false);
const text = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, " ").trim());

async function setup(t, plan) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  await setSettings(s.root, INITIATIVE, { host: "acp-gemini" });
  const started = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(started.status, 200, started.text);
  const id = started.json.launch.id;
  const browser = await launchBrowser(t);
  // A write tab comes from its own review server over the same project, as on the Agents page tests, because the fixture spent the first open.
  const open = async (ref, viewport = { width: 1440, height: 900 }) => {
    const tab = await startActionReview(t, s.root);
    await tab.review.open([]);
    const granted = new URL(tab.opened.at(-1));
    const page = await openPage(browser, `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(ref)}${granted.hash}`, { viewport });
    await waitForView(page);
    return page;
  };
  return { ...s, id, open, browser };
}
const pending = (s) => settled(async () => (await get(s.base, "api/entity?ref=attention")).json.data.permissions ?? [], (list) => list.length > 0);
const answered = (s) => settled(() => s.entries().find((entry) => entry.kind === "permission-answer"), Boolean);
const item = (page) => page.locator("prism-inbox-item").filter({ hasText: "Write probe.txt" });

test("clause 59: Attention lists the request as a Permission under Needs you with its initiative, host, action, and age", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { permission: { title: "Write probe.txt" } });
  await pending(s);
  const page = await s.open("attention");
  await item(page).waitFor();
  const row = await text(item(page));
  for (const part of ["Write probe.txt", "Permission", "Export reports", "Gemini CLI"]) assert.match(row, new RegExp(part.replace(".", "\\.")));
  assert.equal(await item(page).getAttribute("icon"), "lock");
  const group = page.locator(".attention-group").filter({ has: item(page) });
  assert.match(await text(group.locator(".attention-group-label")), /^Needs you/);
  await item(page).click();
  const sheet = page.locator(".attention-sheet:not([hidden])");
  assert.match(await text(sheet.locator(".gate-question")), /^Gemini CLI asks you to allow: Write probe\.txt$/);
  const facts = await text(sheet);
  for (const part of ["Initiative", "Export reports", "Host", "Gemini CLI", "Action", "Reason"]) assert.match(facts, new RegExp(part));
  assert.deepEqual(await sheet.getByRole("button").allInnerTexts().then((names) => names.map((name) => name.trim()).filter((name) => /^(Allow|Refuse)$/.test(name))), ["Allow", "Refuse"]);
  assert.match(facts, /You confirm outside the browser\./);
});

test("clause 59: Refuse answers the agent at once with no dialog, and the item leaves Attention", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { permission: { title: "Write probe.txt" } });
  await pending(s);
  const dialogs = s.dialogs().length;
  const page = await s.open("attention");
  await item(page).click();
  await page.locator(".attention-sheet:not([hidden])").getByRole("button", { name: "Refuse" }).click();
  assert.deepEqual((await answered(s)).outcome, { outcome: "selected", optionId: "no" });
  assert.equal(s.dialogs().length, dialogs, "a refusal asks no dialog");
  await settled(() => item(page).count(), (count) => count === 0);
});

test("clause 59: Allow asks the native dialog, and only then answers the agent with its single-use allow", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { permission: { title: "Write probe.txt" } });
  await pending(s);
  const dialogs = s.dialogs().length;
  const page = await s.open("attention");
  await item(page).click();
  await page.locator(".attention-sheet:not([hidden])").getByRole("button", { name: "Allow" }).click();
  assert.deepEqual((await answered(s)).outcome, { outcome: "selected", optionId: "yes" });
  assert.equal(s.dialogs().length, dialogs + 1);
  await settled(() => item(page).count(), (count) => count === 0);
});

test("clause 59: a declined dialog keeps the item on Attention and says the approval was not confirmed", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { permission: { title: "Write probe.txt" } });
  await pending(s);
  await s.setDialog({ code: 1 });
  const page = await s.open("attention");
  await item(page).click();
  const sheet = page.locator(".attention-sheet:not([hidden])");
  await sheet.getByRole("button", { name: "Allow" }).click();
  await settled(() => text(sheet), (shown) => /not confirmed|declined/i.test(shown));
  assert.equal(await item(page).count(), 1);
  assert.equal(s.entries().some((entry) => entry.kind === "permission-answer"), false);
});

test("clause 60: the Agents page shows an ACP run's tokens, context, and cost, and what the agent did not report", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 1200 }, usageUpdate: { used: 500, size: 1000, cost: { amount: 0.25, currency: "USD" } } });
  await settled(async () => (await launches(s)).find((entry) => entry.id === s.id), (entry) => entry?.state === "finished");
  const page = await s.open("agents");
  const row = page.locator(`[data-agent="launch:${s.id}"]`);
  await row.waitFor();
  await row.getByRole("button", { name: "Open" }).click();
  const details = await text(row.locator("[data-agent-details]"));
  assert.match(details, /Tokens 1,200/);
  assert.match(details, /Context 500 of 1,000/);
  assert.match(details, /Cost 0\.25 USD/);
});

test("clause 60: usage an agent does not report reads Not reported by <label>", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { usage: null, usageUpdate: null });
  await settled(async () => (await launches(s)).find((entry) => entry.id === s.id), (entry) => entry?.state === "finished");
  const page = await s.open("agents");
  const row = page.locator(`[data-agent="launch:${s.id}"]`);
  await row.waitFor();
  await row.getByRole("button", { name: "Open" }).click();
  const details = await text(row.locator("[data-agent-details]"));
  for (const fact of ["Tokens", "Context", "Cost"]) assert.match(details, new RegExp(`${fact} Not reported by Gemini CLI`));
});

test("clause 59: at phone width the permission sheet keeps Allow and Refuse in view", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await setup(t, { permission: { title: "Write probe.txt" } });
  await pending(s);
  const page = await s.open("attention", { width: 390, height: 844 });
  await item(page).click();
  const sheet = page.locator(".attention-sheet:not([hidden])");
  for (const name of ["Allow", "Refuse"]) {
    const box = await sheet.getByRole("button", { name }).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name} lies inside the window`);
  }
});
