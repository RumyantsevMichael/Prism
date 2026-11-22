import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION, INITIATIVE, actionOf, apply, askGate, askerFixture, askerServer, answer, card, listing } from "./fixtures/gate-askers.mjs";
import { contrastFailures, escapes, launch, openPage, reviewUrl, skip as noBrowser, waitForView } from "./fixtures/kit-browser.mjs";
import { settled } from "./fixtures/wait.mjs";

// The gate card names the latest wake that this computer sent to the cloud session that asked: when it was sent, or why Claude Code
// did not deliver it, in both themes and without escaping its card.

const skip = process.platform === "win32" ? "the stub hosts are POSIX scripts" : noBrowser;
const CLOUD_ENV = { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION };
const REFUSAL = "Error: session cse_01LateGateCloudSession7 belongs to another account";

async function woken(t, plan) {
  const s = await askerFixture(t, { dialog: { code: 0 } });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: CLOUD_ENV });
  const id = await askGate(server);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker, Boolean);
  assert.equal((await answer(review, id, "drop")).status, 200);
  await s.setWake(plan);
  const target = `gate:${INITIATIVE}/${id}`;
  const action = actionOf(await listing(review.base, target, review.headers), "gate.continue");
  const sent = await apply(review.base, { action: "gate.continue", target, input: { continuation: "wake" }, revision: action.revision }, review.headers);
  assert.equal(sent.status, 200, sent.text);
  await settled(async () => (await card(review, id))?.asker?.wake, Boolean);
  return { review };
}

async function wakeLine(t, review, colorScheme) {
  const browser = await launch(t);
  const page = await openPage(browser, reviewUrl(review.base, "attention"), { colorScheme, viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const line = page.locator(".attention-detail [data-wake]");
  await line.waitFor();
  if (process.env.PRISM_WAKE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PRISM_WAKE_SCREENSHOTS, `wake-${colorScheme}-${Date.now()}.png`), fullPage: true });
  return { page, text: await line.innerText() };
}

for (const colorScheme of ["light", "dark"]) {
  test(`the card shows a delivered wake with its time, ${colorScheme}`, { skip, timeout: 90000 }, async (t) => {
    const { review } = await woken(t, { code: 0 });
    const { page, text } = await wakeLine(t, review, colorScheme);
    assert.match(text.trim(), /^Wake sent \S/);
    assert.deepEqual(await contrastFailures(page, ".attention-detail [data-wake]"), []);
    assert.deepEqual(page.errors, []);
  });

  test(`the card shows a wake that was not delivered with the harness's reason, ${colorScheme}`, { skip, timeout: 90000 }, async (t) => {
    const { review } = await woken(t, { code: 1, stderr: REFUSAL });
    const { page, text } = await wakeLine(t, review, colorScheme);
    assert.equal(text.trim(), `Wake not delivered: ${REFUSAL}`);
    assert.deepEqual(await escapes(page, ".attention-detail"), []);
    assert.deepEqual(page.errors, []);
  });
}
