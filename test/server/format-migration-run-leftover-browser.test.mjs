import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS } from "./fixtures/artifact-formats.mjs";
import { runCheckout, runFor } from "./fixtures/format-migration-runs.mjs";
import { launch, openPage, skip as noBrowser, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";

// A leftover point on an asking run's page shows, beneath its quoted statement, the line of the source that holds it.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-leftover-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const skip = noBrowser || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);
const TERMS = "docs/requirements/terms.md";
const PURPOSE = "Terms used by the payments team.";
const SOURCE = `# Payment terms\n\n${PURPOSE}\n\n| Term | Definition |\n| --- | --- |\n| Backoff | The wait between two attempts. |\n`;

test("a leftover point shows the source line of its statement", { skip, timeout: 120000 }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, { ...CONFORMING, [TERMS]: SOURCE });
  const saved = { ...process.env };
  Object.assign(process.env, hosts.env, { PRISM_REVIEW_APP_DIR: hosts.app, PLUGIN_DATA: privateData });
  context.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  const run = await runFor(call, TERMS);
  const glossary = CONFORMING[PATHS.glossary];
  const leftover = { statement: PURPOSE, home: "The project instructions." };
  const proposal = (extra = {}) => ({ run, type: "glossary", source: TERMS, target: PATHS.glossary, content: `${glossary}\n<a id="backoff"></a>\n## Backoff\n\nThe wait between two attempts.\n\nSource: migration\n`, summary: "Moves the payments team's one term into the glossary.", leftovers: [leftover], ...extra });
  const bare = await call("propose_migration", proposal());
  assert.equal(bare.value?.code, "migration_unsettled", bare.text);
  const asked = bare.value.points.map((point) => ({ point, recommendation: "Keep it in the project instructions." }));
  assert.equal((await call("propose_migration", proposal({ asked }))).refused, false);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  const { review, opened } = await startActionReview(context, root);
  await review.open([`migration-run:${run}`]);
  const browser = await launch(context);
  const page = await openPage(browser, opened.at(-1));
  await waitForView(page);
  const quote = page.locator("blockquote.run-quote", { hasText: PURPOSE });
  await quote.first().waitFor();
  assert.match(await quote.first().innerText(), /Line 3 of the source/);
  assert.deepEqual(page.errors, []);
});
