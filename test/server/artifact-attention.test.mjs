import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, REQUIREMENT, formatProject, write } from "./fixtures/artifact-formats.mjs";
import { get, pageSession, startActionReview } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// Attention's format findings, read from the review server.

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
  assert.equal(Object.hasOwn(requirements, "legacy"), false, "no legacy mark exists");
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

test("clause 23: Attention with 300 nonconforming artifacts answers within 5 seconds and follows a change", { timeout: 120000 }, async (context) => {
  const extra = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`docs/requirements/bulk/old-${String(index).padStart(3, "0")}.md`, BROKEN]));
  const { root, base, headers, attention } = await served(context, extra);
  const started = Date.now();
  const index = await get(base, "api/index", headers);
  assert.equal(index.status, 200);
  assert.ok(Date.now() - started < 5000, `answered in ${Date.now() - started} ms`);
  assert.equal((await attention()).formats[0].count, 302);
  await write(root, "docs/requirements/bulk/old-000.md", REQUIREMENT);
  assert.equal(await settled(async () => (await attention()).formats[0].count, 301), 301);
});
