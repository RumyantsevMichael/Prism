import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, acpFixture, fakeEntry, installRecord } from "./fixtures/acp-agents.mjs";
import { binaryAgent, registryFixture } from "./fixtures/acp-registry.mjs";
import { launch as launchBrowser, openPage, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/acp-agents.md §3, §4, §9, §15, and §17, and docs/requirements/launch-run-configuration.md §2.
// Contract clauses 58, 60, and 61 of docs/plans/harness-client-protocol/slice.md, following the mockups in
// scripts/review-demo/mockups/harness-client-protocol/: the Coding agents section of Settings, and every agent's reason in the host chooser.

const skipHere = skip || (process.platform === "win32" ? "the fake agent and the dialogs are POSIX scripts" : false);
const text = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, " ").trim());

async function setup(t, { down = false } = {}) {
  const s = await acpFixture(t);
  const registry = await registryFixture(t, s);
  await installRecord(s, { id: "opencode", name: "OpenCode", version: "2.3.1" });
  registry.setAgents([
    await binaryAgent(s, registry, { id: "opencode", name: "OpenCode", version: "2.3.2" }),
    await binaryAgent(s, registry, { id: "goose", name: "Goose", version: "1.14.0", license: "Apache-2.0" }),
    await binaryAgent(s, registry, { id: "nosum", name: "No Sum", sha: false })
  ]);
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" }), { id: "broken", label: "Broken agent", command: "/nowhere/broken-agent" }]);
  if (down) registry.down(503);
  const browser = await launchBrowser(t);
  const open = async (ref, viewport = { width: 1440, height: 900 }) => {
    const tab = await startActionReview(t, s.root);
    await tab.review.open([]);
    const granted = new URL(tab.opened.at(-1));
    const page = await openPage(browser, `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(ref)}${granted.hash}`, { viewport });
    await waitForView(page);
    return page;
  };
  return { s, registry, open };
}
async function codingAgents(page) {
  await page.locator("#settings-button").click();
  await page.locator('#settings-sections prism-tree-item[value="agents"]').click();
  const section = page.locator('.settings-section[data-section="agents"]');
  await section.waitFor();
  return section;
}
const agentRow = (section, name) => section.locator("prism-row").filter({ hasText: name });

test("clause 58: Settings has a Coding agents section listing each agent's name, version, authors, license, and source", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { open } = await setup(t);
  const page = await open("roadmap");
  const tree = await page.locator("#settings-sections prism-tree-item").evaluateAll((items) => items.map((item) => item.getAttribute("label")));
  assert.ok(tree.includes("Coding agents"), `the Settings sections are ${tree.join(", ")}`);
  const section = await codingAgents(page);
  assert.match(await text(section.locator("h3")), /^Coding agents$/);
  const goose = await text(agentRow(section, "Goose"));
  for (const part of ["Goose", "1.14.0", "Fake Authors", "Apache-2.0", "Goose for tests."]) assert.match(goose, new RegExp(part.replace(/\./g, "\\.")));
  assert.equal(await agentRow(section, "Goose").getByRole("link").first().getAttribute("href"), "https://example.invalid/goose");
});

test("clause 58: installed and declared agents are marked, an update shows its version, and each action shows where it is available", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { open } = await setup(t);
  const section = await codingAgents(await open("roadmap"));
  const opencode = agentRow(section, "OpenCode");
  assert.match(await text(opencode), /Installed/);
  assert.match(await text(opencode), /2\.3\.2/, "the update names its version");
  assert.deepEqual((await opencode.getByRole("button").allInnerTexts()).map((name) => name.trim()).sort(), ["Remove", "Update"]);
  assert.match(await text(agentRow(section, "Gemini CLI")), /Declared/);
  assert.equal(await agentRow(section, "Gemini CLI").getByRole("button", { name: "Install" }).count(), 0, "a declared agent is not installed by Prism");
  assert.deepEqual((await agentRow(section, "Goose").getByRole("button").allInnerTexts()).map((name) => name.trim()), ["Install"]);
  const nosum = agentRow(section, "No Sum");
  assert.equal(await nosum.getByRole("button", { name: "Install" }).count(), 0);
  assert.match(await text(nosum), /SHA-256|checksum/i, "the reason it cannot be installed shows in its place");
  assert.match(await text(agentRow(section, "Broken agent")), /broken-agent/, "an agent that cannot run says why");
});

test("clause 58: Install asks the native confirmation and the agent then shows as installed", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { s, open } = await setup(t);
  const section = await codingAgents(await open("roadmap"));
  const before = s.dialogs().length;
  await agentRow(section, "Goose").getByRole("button", { name: "Install" }).click();
  await settled(() => s.dialogs().length, (count) => count === before + 1);
  await settled(() => text(agentRow(section, "Goose")), (shown) => /Installed/.test(shown));
  assert.deepEqual((await agentRow(section, "Goose").getByRole("button").allInnerTexts()).map((name) => name.trim()), ["Remove"]);
});

test("clause 58: while the registry cannot be read the section says so and keeps installed and declared agents", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { open } = await setup(t, { down: true });
  const section = await codingAgents(await open("roadmap"));
  assert.match(await text(section), /503/);
  assert.match(await text(agentRow(section, "OpenCode")), /Installed/);
  assert.match(await text(agentRow(section, "Gemini CLI")), /Declared/);
  assert.equal(await agentRow(section, "Goose").count(), 0, "an agent that is only in the registry is not listed while it cannot be read");
  assert.equal(await section.getByRole("button", { name: "Update" }).count(), 0);
});

test("clauses 60, 61: the run configuration's host chooser lists every agent with the reason it cannot run", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { open } = await setup(t);
  const page = await open(`initiative:${INITIATIVE}`);
  await page.locator("[data-launch-open]").click();
  const dialog = page.locator("[data-launch-dialog]");
  await settled(() => text(dialog), (shown) => /OpenCode/.test(shown));
  const shown = await text(dialog);
  for (const label of ["Claude Code", "Codex", "OpenCode", "Gemini CLI", "Broken agent"]) assert.match(shown, new RegExp(label));
  assert.match(shown, /Broken agent was not found/);
  const order = ["Claude Code", "Codex", "OpenCode", "Gemini CLI"].map((label) => shown.indexOf(label));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "installed agents follow the built-in hosts and precede declared ones");
});

test("clause 61: with neither Claude Code nor Codex on PATH the host chooser still offers an ACP agent", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await acpFixture(t, { hosts: [] });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  const browser = await launchBrowser(t);
  const tab = await startActionReview(t, s.root);
  await tab.review.open([]);
  const granted = new URL(tab.opened.at(-1));
  const page = await openPage(browser, `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(`initiative:${INITIATIVE}`)}${granted.hash}`, { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await page.locator("[data-launch-open]").click();
  const dialog = page.locator("[data-launch-dialog]");
  const option = dialog.getByRole("radio", { name: /Gemini CLI/ });
  await option.first().waitFor({ timeout: 20000 });
  assert.equal(await option.first().isDisabled(), false, "the ACP agent can be chosen as the host");
  assert.doesNotMatch(await text(dialog), /install Claude Code or Codex/i);
});

test("clause 58: at phone width the Coding agents section keeps every action inside the window", { skip: skipHere, timeout: 120000 }, async (t) => {
  const { open } = await setup(t);
  const section = await codingAgents(await open("roadmap", { width: 390, height: 844 }));
  for (const button of await section.getByRole("button").all()) {
    const box = await button.boundingBox();
    if (box) assert.ok(box.x >= 0 && box.x + box.width <= 390, `${await button.innerText()} lies inside the window`);
  }
});
