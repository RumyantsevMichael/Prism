import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { browserRequest, checkout, eventually, isolateGit, ok, refused, requirementFile, reviewBrowser, server, shapedEntry, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { launch, openPage, skip as noBrowser } from "./fixtures/kit-browser.mjs";
import { parseRecord } from "../../dist/server/workflow/artifact-status.mjs";

// An approval gate names the work item it serves, so its Attention card links to the initiative and slice the agent works on.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

async function project(context) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  return { api, prism };
}

const ask = (prism, fields) => prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing.", ...fields }] });
const pendingApprovals = async (review) => (await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou.filter((item) => item.type === "gate" && item.kind === "approval");
// The work item Attention shows for the gate an ask recorded, once the page has seen that gate.
async function shownWorkItem(review, asked) {
  const gate = ok(asked).artifacts[0].gate;
  let shown;
  await eventually(async () => (shown = (await pendingApprovals(review)).find((item) => item.id === gate)) !== undefined, 30000, `Attention lists ${gate}`);
  return shown.workItem;
}

test("an approval names the initiative and slice it serves, and Attention links only what the roadmap and the record know", async (context) => {
  const { api, prism } = await project(context);
  const review = await reviewBrowser(context, api);

  assert.equal(await shownWorkItem(review, await ask(prism, {})), null, "an approval that names no work item links none");

  // Requirements that start an initiative are approved before its roadmap entry exists, so the id it will take shows unlinked.
  assert.deepEqual(await shownWorkItem(review, await ask(prism, { initiative: "reports" })), { initiative: { id: "reports", title: "reports", known: false }, slice: null });

  assert.deepEqual((await shownWorkItem(review, await ask(prism, { initiative: "reports", slice: "reports" }))).slice, { slug: "reports", title: "reports", known: false }, "a slice the record does not hold yet shows unlinked");
  // Design starts only on a ready work item, and an initiative without a roadmap entry is none, so its record comes before the entry, which cites the file still waiting for approval.
  ok(await createInitiative(prism, "reports", { claim: false }));
  await eventually(async () => (await pendingApprovals(review))[0]?.workItem?.slice?.known === true, 30000, "the card links the slice the record now holds");

  await shapedEntry(prism, review, { id: "reports", title: "Monthly reports", intent: "Reports ship.", band: "Now", requirements: ["billing.md§1"] });
  // The waiting card links once the roadmap lists the initiative, without a new ask.
  await eventually(async () => (await pendingApprovals(review))[0]?.workItem?.initiative?.known === true, 30000, "the card links the initiative the roadmap now lists");
  assert.deepEqual(await shownWorkItem(review, await ask(prism, { initiative: "reports" })), { initiative: { id: "reports", title: "Monthly reports", known: true }, slice: null }, "the roadmap entry gives the initiative its title");
  assert.deepEqual(await shownWorkItem(review, await ask(prism, { initiative: "reports", slice: "reports" })), { initiative: { id: "reports", title: "Monthly reports", known: true }, slice: { slug: "reports", title: "Reports", known: true } });
});

test("an approval's work item is an id, a slice belongs to an initiative, and an acceptance after a ship serves the shipped initiative", async (context) => {
  const { prism } = await project(context);
  refused(await ask(prism, { initiative: "two words" }), "validation_failed");
  refused(await ask(prism, { initiative: "reports", slice: "a/b" }), "validation_failed");
  refused(await ask(prism, { slice: "reports" }), "validation_failed");
  refused(await ask(prism, { initiative: "reports", shipped: "other" }), "validation_failed");
  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(read.status, "Draft", "a refused ask changes nothing");
});

test("a synced gate whose work item no ask_approval could record is dropped", () => {
  const gate = { id: "approval-1", status: "Approved", version: `sha256:${"0".repeat(64)}`, question: "Approve it?", context: null, askedAt: "2026-11-21T00:00:00.000Z" };
  const kept = (fields) => parseRecord("requirements", JSON.stringify({ status: "Draft", pending: [{ ...gate, ...fields }] })).pending.length;
  assert.equal(kept({}), 1);
  assert.equal(kept({ initiative: "reports", slice: "totals" }), 1);
  assert.equal(kept({ initiative: "reports" }), 1);
  assert.equal(kept({ slice: "totals" }), 0, "a slice without an initiative");
  assert.equal(kept({ initiative: "../reports" }), 0, "an initiative that is no id");
  assert.equal(kept({ initiative: 7 }), 0);
});

test("the approval card links to the work item it serves and shows an id that names nothing yet in full", { skip: noBrowser }, async (context) => {
  const { api, prism } = await project(context);
  const review = await reviewBrowser(context, api);
  await shapedEntry(prism, review, { id: "reports", title: "Monthly reports for every customer account, with a title long enough to wrap", intent: "Reports ship.", band: "Now", requirements: ["billing.md§1"] });
  ok(await ask(prism, { initiative: "reports" }));
  const other = "docs/requirements/refunds.md";
  await writeArtifact(prism, other, requirementFile("Refunds"));
  const unknown = "refunds-for-partial-cancellations-across-every-supported-currency";
  ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: other, question: "Approve refunds?", context: "Refunds.", initiative: unknown, slice: "ledger" }] }));
  const browser = await launch(context);
  for (const width of [390, 1440]) {
    const page = await openPage(browser, `${review.baseUrl.replace(/\/$/, "")}/review?artifact=attention`, { viewport: { width, height: 900 } });
    const card = async (file) => {
      await page.waitForFunction((file) => [...document.querySelectorAll("prism-inbox-item")].some((item) => item.textContent.includes(file)), file, { timeout: 15000 });
      await page.evaluate((file) => {
        const back = document.querySelector("[data-attention-back]");
        if (back && back.offsetParent !== null) back.click();
        [...document.querySelectorAll("prism-inbox-item")].find((item) => item.textContent.includes(file))?.click();
      }, file);
      const sheet = page.locator("[data-detail]:not([hidden]) .gate-approval", { hasText: file });
      await sheet.waitFor({ timeout: 10000 });
      return sheet.locator(".approval-work");
    };
    const known = await card(FILE);
    const link = known.locator('a[data-artifact="initiative:reports"]');
    assert.match(await link.textContent(), /with a title long enough to wrap$/, `${width}px: the link holds the whole title`);
    const box = await link.boundingBox();
    const row = await known.boundingBox();
    assert.ok(box.x + box.width <= row.x + row.width + 1, `${width}px: the title wraps inside the card`);

    const pending = await card(other);
    assert.equal(await pending.locator("a").count(), 0, `${width}px: an initiative the roadmap does not list is not a link`);
    const text = await pending.textContent();
    assert.ok(text.includes(unknown) && text.includes("not on the roadmap yet") && text.includes("ledger"), `${width}px: the ids show in full: ${text}`);
    const overflow = await pending.evaluate((element) => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `${width}px: the unbroken id wraps instead of overflowing`);

    // The link opens the initiative's page.
    await (await card(FILE)).locator('a[data-artifact="initiative:reports"]').click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("artifact") === "initiative:reports", null, { timeout: 10000 });
    await page.close();
  }
});
