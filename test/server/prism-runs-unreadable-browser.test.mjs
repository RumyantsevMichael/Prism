import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { runOptionsFixture } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// The Settings section of Prism's own runs when the stored choice cannot be read: it says so and applies any available host.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-runs-unreadable-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);

test("an unreadable choice shows why and applies any available host as a readable choice", { skip: skipHere, timeout: 90000 }, async (t) => {
  const fixture = await runOptionsFixture(t, { hosts: ["claude"] });
  fixture.useAsProcessEnv();
  const file = path.join(fixture.app, "prism-runs.json");
  await writeFile(file, "{ not json", { mode: 0o600 });
  const { review, opened } = await startActionReview(t, fixture.root);
  await review.open([]);
  const page = await openPage(await launch(t), opened.at(-1));
  await waitForView(page);
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("treeitem", { name: "Prism's own runs" }).click();
  const region = settings.getByRole("region", { name: "Prism's own runs" });
  await region.waitFor();
  assert.match(await region.innerText(), /The stored choice could not be read/);
  assert.equal(await region.getByRole("combobox", { name: "Host" }).inputValue(), "automatic");
  const applyButton = region.getByRole("button", { name: "Apply", exact: true });
  assert.equal(await settled(() => applyButton.isEnabled(), true), true, "any available host can be applied over the unreadable choice");
  await applyButton.click();
  const stored = await settled(() => readFile(file, "utf8").then(JSON.parse).catch(() => null), (value) => value !== null);
  assert.equal(stored.host, "automatic");
  assert.equal(await settled(() => region.innerText().then((text) => /could not be read/.test(text)), false), false, "the section no longer says the choice could not be read");
  assert.equal(await settled(() => applyButton.isEnabled(), false), false, "a stored any available host leaves nothing to apply");
  assert.deepEqual(page.errors, []);
});
