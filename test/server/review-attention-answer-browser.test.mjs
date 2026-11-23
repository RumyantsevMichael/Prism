import assert from "node:assert/strict";
import test from "node:test";
import { openPage, reviewUrl, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { prepareAttention } from "./fixtures/places-attention.mjs";
import { placesDemo } from "./fixtures/places-browser.mjs";

// The answer beside a long question stays in view while the question scrolls, and a tall answer scrolls inside itself, so Send stays reachable.

// The detail keeps other items' sheets hidden beside the shown one, so the answer is the one outside a hidden sheet.
const SHOWN = ".attention-detail .gate-answer:not([hidden] .gate-answer)";
// Makes the question tall, scrolls the detail past the answer's place, and reports where the answer stands in the detail.
const scrolledAnswer = (page) => page.evaluate((shown) => {
  const answer = document.querySelector(shown);
  const main = answer.closest(".gate-body").querySelector(".gate-main");
  const detail = answer.closest(".attention-detail");
  for (let index = 0; index < 25; index++) {
    const paragraph = document.createElement("p");
    paragraph.textContent = "A long context paragraph that keeps the question tall, so the detail scrolls. ".repeat(4);
    main.append(paragraph);
  }
  detail.scrollTop = detail.scrollHeight;
  const box = answer.getBoundingClientRect();
  const frame = detail.getBoundingClientRect();
  return { position: getComputedStyle(answer).position, top: box.top - frame.top, inside: box.top >= frame.top && box.bottom <= frame.bottom };
}, SHOWN);

test("beside a long question the answer stays in view as the detail scrolls, and a tall answer scrolls inside itself to its Send button", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: prepareAttention });
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await page.locator(`${SHOWN} [data-apply]`).waitFor();
  const wide = await scrolledAnswer(page);
  assert.equal(wide.position, "sticky");
  assert.ok(wide.inside, "the answer stays inside the scrolled detail");
  assert.ok(wide.top < 60, `the answer stands at the detail's top, not ${wide.top}px down`);
  const tall = await page.evaluate((shown) => {
    const answer = document.querySelector(shown);
    const detail = answer.closest(".attention-detail");
    answer.querySelector("prism-field").value = "A line of a long answer.\n".repeat(60);
    const submit = answer.querySelector("[data-apply]");
    submit.scrollIntoView({ block: "nearest" });
    const box = answer.getBoundingClientRect();
    const frame = detail.getBoundingClientRect();
    const button = submit.getBoundingClientRect();
    return { scrolls: answer.scrollHeight > answer.clientHeight, inside: box.top >= frame.top && box.bottom <= frame.bottom, send: button.top >= frame.top && button.bottom <= frame.bottom };
  }, SHOWN);
  assert.deepEqual(tall, { scrolls: true, inside: true, send: true }, "a tall answer fits the detail, scrolls itself, and reaches Send");
  await page.close();
  const narrow = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 820, height: 900 } });
  await waitForView(narrow);
  await narrow.locator(`${SHOWN} [data-apply]`).waitFor();
  assert.equal((await scrolledAnswer(narrow)).position, "static", "where the answer sits below the question it scrolls with it");
  assert.deepEqual([...page.errors, ...narrow.errors], []);
});
