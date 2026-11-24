import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, MACHINE, askGate, askerFixture, askerServer, card } from "./fixtures/gate-askers.mjs";
import { launch, openPage, reviewUrl, skip as noBrowser, waitForView } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §3, §4, §6.
// Contract: docs/plans/late-gate-answers/slice.md clause 9.
// The gate's card says who asked and in what state that session is, and how to reach an open session that no wait holds.

const skip = process.platform === "win32" ? "the stub hosts are POSIX scripts" : noBrowser;

test("clause 9: the card names the asker, its state chip, and how to reach an open session", { skip, timeout: 90000 }, async (t) => {
  const s = await askerFixture(t);
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server);
  await s.setAgentsOpen([CLAUDE_SESSION]);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, "open");
  const browser = await launch(t);
  const page = await openPage(browser, reviewUrl(review.base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const text = await settled(() => page.locator(".attention-detail").innerText().catch(() => ""), (value) => value.includes("Asked by"));
  const asker = page.locator(".attention-detail .gate-asker");
  assert.equal(await asker.locator(".gate-asker-who strong").innerText(), `Claude Code on ${MACHINE}`, text);
  assert.equal(await asker.locator(".gate-asker-state").getAttribute("aria-label"), "Open, not waiting", "the state icon names the open session");
  assert.match(await asker.locator(".gate-asker-state").getAttribute("tip"), /reads your answer only with the next message/, "the state's tooltip explains it");
  assert.ok(text.includes("Prism cannot reach this session, because no wait holds the question. Send any message in that Claude Code session, and it reads the answer."), "the card says how to reach it");
  await s.setAgentsOpen([]);
  await settled(async () => (await card(review, id))?.asker?.state, "not-running");
  await page.reload();
  await waitForView(page);
  const state = () => page.locator(".attention-detail .gate-asker-state").getAttribute("aria-label").catch(() => "");
  assert.equal(await settled(state, "Not running"), "Not running");
  assert.deepEqual(page.errors, []);
});

test("clause 9: a gate without a recorded asker reads as asked by an unknown session", { skip, timeout: 90000 }, async (t) => {
  const s = await askerFixture(t);
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  await updateCoordinationState({ projectRoot: s.root, initiative: "reports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "assistance", question: "Install the signing key.", context: "Signing needs a key that only you can add.", artifacts: [] }] } });
  const review = await s.page();
  const browser = await launch(t);
  const page = await openPage(browser, reviewUrl(review.base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const text = await settled(() => page.locator(".attention-detail").innerText().catch(() => ""), (value) => value.includes("Asked by"));
  const asker = page.locator(".attention-detail .gate-asker");
  assert.equal(await asker.locator(".gate-asker-who strong").innerText(), "An unknown session", text);
  const state = asker.locator(".gate-asker-state");
  assert.equal(await state.getAttribute("aria-label"), "Prism can't see this session", "the warning icon says Prism can't see the session");
  assert.match(await state.getAttribute("tip"), /If it is waiting, it picks up your answer/, "the tooltip says what happens to the answer");
});
