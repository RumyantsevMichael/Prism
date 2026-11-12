import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, GLOSSARY, PATHS, formatProject } from "./fixtures/artifact-formats.mjs";
import { launch, openPage, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { mcp } from "./fixtures/shipped-work.mjs";

// A pending migration on Attention and on its own page, built from the review app's UI kit, answered there by the person.

// The review server reads its private data folder when it loads, so the folder is set before any server starts.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-formats-browser-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const TERMS = "docs/notes/terms.md";
const TERMS_TEXT = "# Payment terms\n\nTerms used by the payments team.\n\n| Term | Definition |\n| --- | --- |\n| Backoff | The wait between two attempts. |\n| Retry deadline | The longest a request may wait. |\n\nAlways write backoff as one word.\n";
const THEIRS = "<a id=\"retry-deadline\"></a>\n## Retry deadline\n\nThe longest a request may wait.\n\nSource: migration\n";
const SUMMARY = "Moves the payments team's terms into the glossary and lists its writing rule for the project instructions.";

const offKit = (page, selector) => page.evaluate((scope) => {
  const root = document.querySelector(scope);
  if (!root) return ["missing"];
  return [...root.querySelectorAll("button, input, select, textarea")].map((element) => element.outerHTML.slice(0, 80));
}, selector);

async function pending(context) {
  await useAppDirectory(context);
  const root = await formatProject(context, { ...CONFORMING, [TERMS]: TERMS_TEXT });
  const call = await mcp(context, root);
  const proposed = await call("propose_migration", {
    type: "glossary", source: TERMS, target: PATHS.glossary, summary: SUMMARY,
    content: `${GLOSSARY}\n<a id="backoff"></a>\n## Backoff\n\nThe wait between two attempts.\n\nSource: migration\n`,
    leftovers: [{ statement: "Terms used by the payments team.", home: "Dropped: the glossary keeps its own purpose." }, { statement: "Always write backoff as one word.", home: "The project instructions, as a writing rule." }],
    conflicts: [{ entry: "retry-deadline", content: THEIRS }]
  });
  const migration = proposed.value?.migration;
  assert.ok(migration, proposed.text);
  return { root, call, migration };
}

test("clause 38: a pending migration is a question on Attention", { timeout: 60000 }, async (context) => {
  const { root, migration } = await pending(context);
  const { base } = await serveProject(context, root);
  const attention = await (await fetch(`${base}/api/entity?ref=attention`)).json();
  const item = attention.data.needsYou.find((entry) => entry.type === "migration");
  assert.deepEqual([item?.id, item?.artifactType, item?.source, item?.target, item?.summary], [migration.id, "glossary", TERMS, PATHS.glossary, SUMMARY]);
  const kinds = (await (await fetch(`${base}/api/index`)).json()).navigation.places.attention.kinds;
  assert.equal(kinds.questions, 1);
});

test("clauses 38, 39: the migration page shows the summary, the diff, leftovers with homes, both sides of a conflict, and the removal choice, and answers there", { skip, timeout: 90000 }, async (context) => {
  const { root, call, migration } = await pending(context);
  // Only a tab the server opened holds a write grant, so the server opens the migration's page and the test records its address.
  const { review, opened } = await startActionReview(context, root);
  await review.open([`migration:${migration.id}`]);
  const browser = await launch(context);
  const page = await openPage(browser, opened.at(-1));
  await waitForView(page);
  const view = page.locator("#artifact");
  for (const text of [SUMMARY, "Always write backoff as one word.", "The project instructions, as a writing rule.", "The longest a request may wait.", "The total time a request may spend across all of its retry attempts."]) {
    assert.equal(await view.getByText(text, { exact: false }).first().isVisible(), true, text);
  }
  assert.equal(await view.getByText("## Backoff", { exact: false }).first().isVisible(), true, "the diff shows the added term");
  assert.equal(await view.getByText(/Remove docs\/notes\/terms\.md/).first().isVisible(), true, "a separate source offers its removal");
  assert.deepEqual(await offKit(page, "#artifact"), [], "every control on the page is a kit element");
  await view.getByText("Accept", { exact: true }).first().click();
  await view.getByText("Send answer", { exact: false }).first().click();
  await page.waitForTimeout(800);
  const answered = (await call("get_migration", { id: migration.id })).value.migration;
  assert.equal(answered.answer?.decision, "accept");
  assert.equal(answered.answer?.removeSource, false, "the source stays unless the person chose its removal");
  assert.deepEqual(answered.answer?.conflicts, { "retry-deadline": "target" }, "the target's entry is the default");
  assert.deepEqual(page.errors, []);
});
