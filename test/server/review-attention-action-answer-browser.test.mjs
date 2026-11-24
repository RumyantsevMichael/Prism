import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, skip, useAppDirectory, waitForView, writableReviewUrl } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";

// The Attention card draws a gate's answer from its gate.answer listing through the shared action renderer, so a change to how actions render reaches gate answers too,
// and it keeps the answer's note, the Approve and Request changes styling, and the rules for when the answer can be sent.

// A demo project's Attention in a tab that Prism opened, so it holds the write grant that answering needs.
async function writableAttention(context, viewport) {
  await useAppDirectory(context);
  const url = await writableReviewUrl(context, await demoProject(context), "attention");
  const page = await openPage(await launch(context), url, { viewport });
  await waitForView(page);
  return page;
}

const pick = async (page, text) => {
  await page.locator("prism-inbox-item").filter({ hasText: text }).first().click();
  await repainted(page);
};

const SHEET = ".attention-sheet:not([hidden])";
const answerOf = (page) => page.locator(`${SHEET} .gate-answer-form`);
const shownText = (locator) => locator.evaluate((element) => element.innerText.replace(/\s+/g, " ").trim());
const submitOf = (answer) => answer.locator("prism-button[data-apply]");

async function submitState(answer) {
  const submit = submitOf(answer);
  return { label: await shownText(submit), variant: await submit.getAttribute("variant"), disabled: await submit.evaluate((element) => element.hasAttribute("disabled")) };
}

test("a review gate's answer is the shared renderer's row of its gate.answer listing, with Approve and Request changes as cards and the note Request changes needs", { skip, timeout: 90000 }, async (context) => {
  const page = await writableAttention(context, { width: 1440, height: 900 });
  await pick(page, "Review the change map");
  const answer = answerOf(page);
  const row = answer.locator('.action-row[data-action-key$="|gate.answer"]');
  await row.waitFor();
  assert.equal(await row.getAttribute("data-action-key"), `${await answer.getAttribute("data-answer-target")}|gate.answer`, "the row is the listing's action for the card's gate");

  const cards = row.locator("prism-choice-option");
  assert.deepEqual(await cards.evaluateAll((items) => items.map((item) => [item.getAttribute("value"), item.getAttribute("tone")])), [["approve", null], ["request-changes", "danger"]]);
  assert.match(await shownText(cards.nth(0)), /The agent goes on with the work as it stands\./, "each option shows its consequence from the listing");
  assert.match(await shownText(cards.nth(1)), /The agent revises the work from your note before it goes on\./);
  assert.deepEqual(await submitState(answer), { label: "Send answer", variant: "primary", disabled: true });
  assert.equal(await shownText(row.locator(".action-hint")), "Pick Approve or Request changes.");

  const note = row.locator('prism-field[data-field="note"]');
  await note.locator("textarea").fill("The arrows point the wrong way.");
  assert.equal(await shownText(row.locator(".action-hint")), "Pick Approve or Request changes to send your note.", "a note alone never picks an answer");
  assert.equal((await submitState(answer)).disabled, true);

  await cards.nth(1).click();
  await repainted(page);
  assert.deepEqual(await submitState(answer), { label: "Request changes", variant: "danger", disabled: false }, "the note already written lets Request changes go");
  assert.equal(await note.getAttribute("label"), "What should change · required");
  await row.locator('prism-field[data-field="note"] textarea').fill("   ");
  assert.deepEqual(await submitState(answer), { label: "Request changes", variant: "danger", disabled: true }, "whitespace is no note");
  assert.equal(await shownText(row.locator(".action-hint")), "Write what should change to send this.");

  await cards.nth(0).click();
  await repainted(page);
  assert.deepEqual(await submitState(answer), { label: "Approve", variant: "primary", disabled: false });
  assert.equal(await row.locator('prism-field[data-field="note"]').getAttribute("label"), "Note for the agent · optional");
  assert.match(await shownText(row.locator(".action-hint")), /^Ready to send\./);

  const question = await shownText(page.locator(`${SHEET} .gate-question`));
  await submitOf(answer).click();
  await settled(() => page.locator(".attention-group[aria-labelledby='attention-group-answered'] prism-inbox-item").filter({ hasText: question.slice(0, 40) }).count(), 1);
  assert.equal(await page.locator(".attention-group[aria-labelledby='attention-group-answered'] prism-inbox-item").filter({ hasText: question.slice(0, 40) }).count(), 1, "the answered question moves to Answered");
  assert.deepEqual(page.errors, []);
});

test("a decision's answer takes an option or the note alone, and Clear choice leaves the answer to the note", { skip, timeout: 90000 }, async (context) => {
  const page = await writableAttention(context, { width: 1440, height: 900 });
  await pick(page, "Should a report download");
  const answer = answerOf(page);
  const row = answer.locator('.action-row[data-action-key$="|gate.answer"]');
  await row.waitFor();
  assert.deepEqual(await submitState(answer), { label: "Send answer", variant: "primary", disabled: true });
  assert.equal(await shownText(row.locator(".action-hint")), "Pick an option or write your answer.");
  const recommended = row.locator("prism-choice-option").filter({ has: page.locator("prism-badge") });
  assert.equal(await recommended.count(), 1, "the recommended option carries its badge");
  await recommended.click();
  await repainted(page);
  assert.equal((await submitState(answer)).disabled, false);
  const clear = row.locator("prism-button[data-clear]");
  assert.equal(await clear.isVisible(), true);
  await clear.click();
  await repainted(page);
  assert.equal(await row.locator("prism-choice").evaluate((element) => element.value || null), null, "Clear choice unpicks the option");
  assert.equal((await submitState(answer)).disabled, true);
  await row.locator('prism-field[data-field="note"] textarea').fill("Keep the session for a week.");
  assert.equal((await submitState(answer)).disabled, false, "a note alone answers a decision");
  assert.deepEqual(page.errors, []);
});

test("at phone width with a long note the answer keeps its controls inside the card", { skip, timeout: 90000 }, async (context) => {
  const page = await writableAttention(context, { width: 320, height: 700 });
  await pick(page, "Review the change map");
  const answer = answerOf(page);
  const row = answer.locator('.action-row[data-action-key$="|gate.answer"]');
  await row.waitFor();
  await row.locator("prism-choice-option").nth(1).click();
  await row.locator('prism-field[data-field="note"] textarea').fill(`${"Averyveryverylongunbrokenwordthatkeepsgoing".repeat(6)} ${"and a long sentence. ".repeat(30)}`);
  await repainted(page);
  const overflow = await answer.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll("prism-button, prism-choice-option, prism-field, .action-hint")].filter((item) => item.getClientRects().length).map((item) => [item.localName, item.getBoundingClientRect()]).filter(([, rect]) => rect.left < box.left - 1 || rect.right > box.right + 1).map(([name]) => name);
  });
  assert.deepEqual(overflow, [], "no control leaves the card");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page does not scroll sideways");
  assert.deepEqual(page.errors, []);
});

test("an answer being written survives another answer of the same initiative: the note keeps its text and focus while Attention is drawn again, and Send goes against the new revision", { skip, timeout: 90000 }, async (context) => {
  const page = await writableAttention(context, { width: 1440, height: 900 });
  await pick(page, "Review the change map");
  const row = answerOf(page).locator('.action-row[data-action-key$="|gate.answer"]');
  await row.waitFor();
  const target = await answerOf(page).getAttribute("data-answer-target");
  await row.locator("prism-choice-option").nth(1).click();
  const note = row.locator('prism-field[data-field="note"] textarea');
  await note.fill("Split the parser.");
  await note.evaluate((element) => element.setSelectionRange(5, 5));
  // Another tab answers the initiative's other question, which changes the initiative's record and so the revision this card read.
  const other = await page.evaluate(async (own) => {
    const initiative = own.split("/")[0];
    const attention = await (await fetch("./api/entity?ref=attention")).json();
    const gate = attention.data.needsYou.find((item) => item.type === "gate" && `gate:${item.initiative?.id}/${item.id}` !== own && `gate:${item.initiative?.id}` === initiative);
    const headers = { "Content-Type": "application/json", "X-Prism-Write": sessionStorage.getItem("prism-write-session") };
    const listing = await (await fetch(`./api/actions?target=${encodeURIComponent(`gate:${gate.initiative.id}/${gate.id}`)}`, { headers })).json();
    const action = listing.actions.find((item) => item.id === "gate.answer");
    const applied = await fetch("./api/actions/apply", { method: "POST", headers, body: JSON.stringify({ action: "gate.answer", target: action.target, input: { note: "Approve it now." }, revision: action.revision }) });
    return { status: applied.status, question: gate.question };
  }, target);
  assert.equal(other.status, 200);
  await settled(() => page.locator(".attention-group[aria-labelledby='attention-group-answered'] prism-inbox-item").count(), (count) => count > 0);
  await repainted(page);
  const kept = await page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.localName, value: active?.value, at: active?.selectionStart, field: active?.closest("prism-field")?.dataset.field };
  });
  assert.deepEqual(kept, { tag: "textarea", value: "Split the parser.", at: 5, field: "note" }, "the note keeps its text, its focus, and its cursor");
  const submit = answerOf(page).locator("prism-button[data-apply]");
  assert.deepEqual([await shownText(submit), await submit.getAttribute("variant")], ["Request changes", "danger"], "the picked answer is kept too");
  await submit.click();
  await settled(() => page.locator(`.gate-answer-form[data-answer-target="${target}"]`).count(), 0);
  assert.equal(await page.locator(`.gate-answer-form[data-answer-target="${target}"]`).count(), 0, "the answer was recorded although the revision changed after the card read it");
  assert.equal(await page.locator(".attention-detail .action-error:not([hidden])").count(), 0);
  assert.deepEqual(page.errors, []);
});
