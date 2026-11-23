import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, fakeEntry, setSettings } from "./fixtures/acp-agents.mjs";
import { launch as launchBrowser, openPage, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/acp-agents.md §16 and docs/requirements/launch-run-configuration.md §2.
// An agent that needs a sign-in says so once, under its option in the host chooser, and the Launch button stays disabled while it
// is the chosen host; a banner of the dialog shows only reasons that the host chooser does not already show.

const skipHere = skip || (process.platform === "win32" ? "the fake agent is a POSIX script" : false);
const text = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, " ").trim());
const METHODS = [
  { id: "oauth", name: "Log in with Example", description: "Log in with your Example account" },
  { id: "key", name: "Example API key", description: "Use an API key" },
  { id: "cli", name: "Terminal login", description: "Run example-agent and choose Log in" }
];
const REASON = "Example agent needs you to sign in before it can run: Log in with Example, Example API key, Terminal login (Run example-agent and choose Log in). Prism checks that it starts Prism's tools once you have signed in.";

async function setup(t, { host }) {
  const s = await acpFixture(t, { plans: { example: { authRequired: true, authMethods: METHODS } } });
  await s.declare([fakeEntry(s, "example", { label: "Example agent" })]);
  if (host) await setSettings(s.root, INITIATIVE, { host });
  const browser = await launchBrowser(t);
  const tab = await startActionReview(t, s.root);
  await tab.review.open([]);
  const granted = new URL(tab.opened.at(-1));
  const page = await openPage(browser, `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(TARGET(INITIATIVE))}${granted.hash}`, { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await page.locator("[data-launch-open]").click();
  const dialog = page.locator("[data-launch-dialog]");
  await dialog.locator("prism-choice-option").first().waitFor();
  return { s, page, dialog };
}
const count = (haystack, needle) => haystack.split(needle).length - 1;
const option = (dialog, label) => dialog.locator("prism-choice-option").filter({ hasText: label });
const launchButton = (dialog) => dialog.locator("[data-launch-confirm]");

test("an agent whose report needs a sign-in shows why once, under the chosen host, and holds the launch", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { dialog } = await setup(t, { host: "acp-example" });
  await settled(() => text(option(dialog, "Example agent")), (shown) => shown.includes("needs you to sign in"));
  assert.equal(await text(option(dialog, "Example agent")), `Example agent ${REASON}`, "the reason names each method once, and a description only when it says more than its name");
  // The pickers read the host as well, so wait until nothing reads before counting.
  await settled(() => dialog.locator("prism-picker[busy]").count(), 0);
  const shown = await text(dialog);
  assert.equal(count(shown, "needs you to sign in"), 1, `the sign-in reason shows once in the dialog: ${shown}`);
  assert.equal(await dialog.locator("[data-launch-hold]").isHidden(), true, "the hold banner does not repeat the host's reason");
  assert.equal(await dialog.locator("[data-launch-error]").isHidden(), true);
  assert.equal(await launchButton(dialog).getAttribute("disabled"), "", "the launch stays held while the chosen host cannot run");
});

test("choosing an agent that needs a sign-in holds the launch and says why only under that host", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { dialog } = await setup(t, { host: null });
  await settled(() => launchButton(dialog).getAttribute("disabled"), null);
  await option(dialog, "Example agent").click();
  await settled(() => text(option(dialog, "Example agent")), (shown) => shown.includes("needs you to sign in"));
  await settled(() => dialog.locator("prism-picker[busy]").count(), 0);
  assert.equal(await launchButton(dialog).getAttribute("disabled"), "", "the launch is held while the chosen host cannot run");
  const shown = await text(dialog);
  assert.equal(count(shown, "needs you to sign in"), 1, `the sign-in reason shows once in the dialog: ${shown}`);
  // Choosing a host that can run again clears the hold, and the reason stays under the agent's option alone.
  await option(dialog, "Claude Code").click();
  await settled(() => launchButton(dialog).getAttribute("disabled"), null);
  assert.equal(count(await text(dialog), "needs you to sign in"), 1);
});

test("the initiative's Settings dialog shows an agent's sign-in reason once, under the host", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { page } = await setup(t, { host: "acp-example" });
  await page.keyboard.press("Escape");
  await page.locator("[data-initiative-settings-open]").click();
  const dialog = page.locator("[data-initiative-settings-dialog]");
  await settled(() => text(option(dialog, "Example agent")), (shown) => shown.includes("needs you to sign in"));
  await settled(() => dialog.locator("prism-picker[busy]").count(), 0);
  const shown = await text(dialog);
  assert.equal(count(shown, "needs you to sign in"), 1, `the sign-in reason shows once in the dialog: ${shown}`);
});
