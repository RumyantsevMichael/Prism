import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT, formatProject, write } from "./fixtures/artifact-formats.mjs";
import { actionOf, apply, authorOf, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";
import { mcp } from "./fixtures/shipped-work.mjs";

// Attention's format findings and legacy marks, read from the review server and changed through its actions.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-attention-formats-data-")));
process.env.PLUGIN_DATA = privateData;
process.env.PRISM_REVIEW_APP_DIR = path.join(privateData, "app");
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const BROKEN = "# Old notes\n\nThe client retries.\n";
const LABELS = ["Requirements", "Decisions", "Glossary", "Feature files"];

async function served(context, extra = {}) {
  const root = await formatProject(context, { ...CONFORMING, "docs/requirements/old-a.md": BROKEN, "docs/requirements/old-b.md": BROKEN, "docs/ADRs/old/plain.md": "# Plain decision\n\nWe retry.\n", ...extra });
  const { review, base, opened } = await startActionReview(context, root);
  const headers = await pageSession(review, opened);
  const attention = async () => (await get(base, "api/entity?ref=attention", headers)).json.data;
  const navigation = async () => (await get(base, "api/index", headers)).json.navigation.places.attention;
  return { root, base, headers, attention, navigation };
}

test("clause 17: Attention holds one format entry per format with counts, labels, and each nonconforming artifact's findings", async (context) => {
  const { attention } = await served(context);
  const formats = (await attention()).formats;
  assert.deepEqual(formats.map((entry) => [entry.type, entry.label]), [["requirements", LABELS[0]], ["adr", LABELS[1]], ["glossary", LABELS[2]], ["feature", LABELS[3]]]);
  const [requirements, adr, glossary, feature] = formats;
  assert.deepEqual([requirements.count, requirements.earlier, adr.count, glossary.count, feature.count], [2, 0, 1, 0, 0]);
  assert.deepEqual(requirements.artifacts.map((artifact) => artifact.path), ["docs/requirements/old-a.md", "docs/requirements/old-b.md"]);
  for (const artifact of requirements.artifacts) {
    assert.ok(artifact.findings.some((finding) => finding.rule === "requirements.header"), artifact.path);
    assert.equal(artifact.earlierFormat, null);
  }
  assert.ok(formats.every((entry) => Number.isInteger(entry.version) && typeof entry.reference === "string"));
  assert.deepEqual(requirements.legacy, { count: 0, sets: [] });
});

test("clause 18: each format with findings is an item of the formats kind, counted in the navigation and listed on its own page", async (context) => {
  const { base, headers, attention, navigation } = await served(context);
  const items = (await attention()).needsYou.filter((item) => item.type === "format-findings");
  assert.deepEqual(items.map((item) => [item.artifactType, item.label, item.count, item.earlier]), [["requirements", "Requirements", 2, 0], ["adr", "Decisions", 1, 0]]);
  assert.equal((await navigation()).kinds.formats, 2);
  const page = (await get(base, "api/entity?ref=attention:formats", headers)).json.data;
  assert.equal(page.filter.label, "Format findings");
  assert.deepEqual(page.filter.items.map((entry) => entry.item.artifactType), ["requirements", "adr"]);
});

test("clauses 20, 22: marking a set as legacy stops counting it, shows it as legacy with its author, and keeps covering it after a change", async (context) => {
  const { root, base, headers, attention, navigation } = await served(context);
  const target = "artifacts:requirements";
  const listed = await listing(base, target, headers);
  assert.equal(listed.status, 200, listed.text);
  const mark = actionOf(listed, "artifacts.mark-legacy");
  assert.ok(mark, "the type lists the mark action");
  const paths = mark.fields.find((field) => field.name === "paths");
  assert.deepEqual(paths.options.map((option) => option.value), ["docs/requirements/old-a.md", "docs/requirements/old-b.md"]);
  const body = { action: "artifacts.mark-legacy", target, input: { paths: ["docs/requirements/old-a.md"] }, revision: mark.revision };
  const unconfirmed = await apply(base, body, headers);
  assert.deepEqual([unconfirmed.status, unconfirmed.json.code], [409, "confirmation_required"]);
  const applied = await apply(base, { ...body, confirmed: true }, headers);
  assert.equal(applied.status, 200, applied.text);
  const requirements = (await attention()).formats[0];
  assert.equal(requirements.count, 1);
  assert.deepEqual(requirements.artifacts.map((artifact) => artifact.path), ["docs/requirements/old-b.md"]);
  assert.equal(requirements.legacy.count, 1);
  const [set] = requirements.legacy.sets;
  assert.match(set.id, /^legacy-[0-9a-f]+$/);
  assert.deepEqual(set.by, authorOf(root));
  assert.equal(set.count, 1);
  assert.ok(Date.parse(set.at) <= Date.now());
  assert.equal((await navigation()).kinds.formats, 2, "requirements still has one unmarked artifact");
  await write(root, "docs/requirements/old-a.md", `${BROKEN}\nThe client also logs.\n`);
  assert.equal((await attention()).formats[0].legacy.count, 1, "a changed artifact stays covered");
  await write(root, "docs/requirements/old-a.md", REQUIREMENT);
  const fixed = (await attention()).formats[0];
  assert.deepEqual([fixed.legacy.count, fixed.legacy.sets[0]?.count ?? 0], [0, 0], "a conforming artifact is neither counted nor legacy");
});

test("clause 20: marking refuses an empty choice, a conforming artifact, and another type's artifact", async (context) => {
  const { base, headers } = await served(context);
  const mark = actionOf(await listing(base, "artifacts:requirements", headers), "artifacts.mark-legacy");
  for (const paths of [[], [PATHS.requirements], ["docs/ADRs/old/plain.md"]]) {
    const refused = await apply(base, { action: "artifacts.mark-legacy", target: "artifacts:requirements", input: { paths }, revision: mark.revision, confirmed: true }, headers);
    assert.deepEqual([refused.status, refused.json.code], [400, "invalid_input"], JSON.stringify(paths));
  }
});

test("clause 21: removing a legacy mark counts its artifacts again and records who removed it", async (context) => {
  const { base, headers, attention } = await served(context);
  const mark = actionOf(await listing(base, "artifacts:requirements", headers), "artifacts.mark-legacy");
  const applied = await apply(base, { action: "artifacts.mark-legacy", target: "artifacts:requirements", input: { paths: ["docs/requirements/old-a.md", "docs/requirements/old-b.md"] }, revision: mark.revision, confirmed: true }, headers);
  assert.equal(applied.status, 200, applied.text);
  const [set] = (await attention()).formats[0].legacy.sets;
  assert.equal((await attention()).needsYou.filter((item) => item.type === "format-findings").length, 1, "a fully marked type is no item");
  const remove = actionOf(await listing(base, `legacy:${set.id}`, headers), "artifacts.remove-legacy");
  const removed = await apply(base, { action: "artifacts.remove-legacy", target: `legacy:${set.id}`, input: {}, revision: remove.revision, confirmed: true }, headers);
  assert.equal(removed.status, 200, removed.text);
  assert.ok(removed.json.applied.by && removed.json.applied.at, "the removal names who and when");
  const requirements = (await attention()).formats[0];
  assert.deepEqual([requirements.count, requirements.legacy.count], [2, 0]);
});

test("clause 16: check_artifacts names the legacy mark that covers a nonconforming artifact", async (context) => {
  const { root, base, headers } = await served(context);
  const mark = actionOf(await listing(base, "artifacts:requirements", headers), "artifacts.mark-legacy");
  await apply(base, { action: "artifacts.mark-legacy", target: "artifacts:requirements", input: { paths: ["docs/requirements/old-a.md"] }, revision: mark.revision, confirmed: true }, headers);
  const call = await mcp(context, root);
  const value = (await call("check_artifacts", { paths: ["docs/requirements/old-a.md", "docs/requirements/old-b.md"] })).value;
  const [marked, unmarked] = value.artifacts;
  assert.match(marked.legacy.set, /^legacy-[0-9a-f]+$/);
  assert.equal(marked.legacy.by.name, authorOf(root).name);
  assert.equal(unmarked.legacy, null);
});

test("clause 23: Attention with 300 nonconforming artifacts answers within 5 seconds and follows a change", { timeout: 120000 }, async (context) => {
  const extra = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`docs/requirements/bulk/old-${String(index).padStart(3, "0")}.md`, BROKEN]));
  const { root, base, headers, attention } = await served(context, extra);
  const started = Date.now();
  const index = await get(base, "api/index", headers);
  assert.equal(index.status, 200);
  assert.ok(Date.now() - started < 5000, `answered in ${Date.now() - started} ms`);
  assert.equal((await attention()).formats[0].count, 302);
  await write(root, "docs/requirements/bulk/old-000.md", REQUIREMENT);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await attention()).formats[0].count, 301);
});
