import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-stale-tabs-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { findMissingTabs, movedRecordTabs, startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const { forgetWorkspace } = await import("../../dist/server/review/workspace-model.mjs");
const { forgetMigrations, moveLegacyRecords } = await import("../../dist/server/workflow/record-store.mjs");
const { updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { missingNotice, nextMissingTabs } = await import("../../dist/server/review/public/views/missing-tab.js");
test.after(() => rm(privateData, { recursive: true, force: true }));

const LEGACY_REVIEW = "docs/plans/reports/review.json";
const MOVED_REVIEW = ".prism/initiatives/reports/slices/reports/review.json";
const NARRATIVE = "docs/plans/reports/slice.md";

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-stale-tabs-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, content) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  };
  await write(".prism/workflow.md", "## Paths\n- Requirements: docs/requirements/\n- Plans (scratch): docs/plans/\n");
  await write("docs/requirements/reports.md", "# Activity reports\n\nStatus: Approved\n");
  await write(NARRATIVE, "# Export reports\n");
  // An older Prism kept the review ledger beside the slice narrative.
  await write(LEGACY_REVIEW, JSON.stringify({ waves: [{ id: "audit", mode: "design-audit" }], findings: [] }));
  return { root, write };
}

function request(url, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method, headers: { "Content-Type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, text, json: () => JSON.parse(text) });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("a missing tab is named for its file or its entity", () => {
  assert.equal(missingNotice("docs/plans/x/slice.md").title, "This file no longer exists");
  assert.match(missingNotice("docs/plans/x/slice.md").tooltip, /^docs\/plans\/x\/slice\.md no longer exists/);
  const entity = missingNotice("initiative:x", { entity: true, label: "Export reports" });
  assert.equal(entity.title, "This item no longer exists");
  assert.match(entity.tooltip, /^Export reports no longer exists/);
});

test("the missing set changes only when the snapshot reports other tabs", () => {
  const current = new Set(["a.md"]);
  assert.equal(nextMissingTabs(current, ["a.md"]).changed, false);
  assert.deepEqual([...nextMissingTabs(current, ["b.md", 3]).next], ["b.md"]);
  assert.equal(nextMissingTabs(current, undefined).changed, true);
  assert.equal(nextMissingTabs(new Set(), undefined).changed, false);
});

test("missing tabs are files the review no longer lists and entities that no longer resolve", async () => {
  const available = new Set(["docs/a.md"]);
  const missing = await findMissingTabs(["docs/a.md", "docs/gone.md", "roadmap", "initiative:gone", "initiative:here"], available, async (ref) => ref !== "initiative:gone");
  assert.deepEqual(missing, ["docs/gone.md", "initiative:gone"]);
});

test("only a tab whose legacy record moved maps to the record's current path", async (context) => {
  const { root } = await fixture(context);
  assert.deepEqual([...await movedRecordTabs(root, [LEGACY_REVIEW, NARRATIVE, "roadmap"], new Set([LEGACY_REVIEW, NARRATIVE, MOVED_REVIEW]))], []);
  assert.deepEqual([...await movedRecordTabs(root, [LEGACY_REVIEW, "docs/plans/reports/gone.md"], new Set([NARRATIVE, MOVED_REVIEW]))], [[LEGACY_REVIEW, MOVED_REVIEW]]);
  // A record that has nowhere to go stays missing instead of following a guess.
  assert.deepEqual([...await movedRecordTabs(root, [LEGACY_REVIEW], new Set([NARRATIVE]))], []);
});

test("a tab follows a record that Prism moved out of its legacy location", async (context) => {
  const { root } = await fixture(context);
  const review = await startReviewServer({ projectRoot: root });
  try {
    await review.setOpenTabs([LEGACY_REVIEW]);
    assert.equal((await request(`${review.baseUrl}/api/session`, "PUT", { openTabs: [NARRATIVE, LEGACY_REVIEW], activeTab: LEGACY_REVIEW, previewTab: NARRATIVE })).status, 200);
    forgetMigrations();
    await moveLegacyRecords(root);
    const index = (await request(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.openTabs, [NARRATIVE, MOVED_REVIEW]);
    assert.equal(index.activeTab, MOVED_REVIEW);
    assert.equal(index.previewTab, NARRATIVE);
    assert.deepEqual(index.agentTabs, [MOVED_REVIEW]);
    assert.deepEqual(index.missingTabs, []);
    assert.deepEqual(review.getSession().openTabs, [NARRATIVE, MOVED_REVIEW]);
    // A page that has not yet seen the move still names the old path, and its save follows the record too.
    const saved = await request(`${review.baseUrl}/api/session`, "PUT", { openTabs: [LEGACY_REVIEW, NARRATIVE], activeTab: LEGACY_REVIEW });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.json().openTabs, saved.json().activeTab], [[MOVED_REVIEW, NARRATIVE], MOVED_REVIEW]);
  } finally {
    await review.close();
  }
});

test("a deleted file's tab stays open as missing and recovers when the file returns", async (context) => {
  const { root, write } = await fixture(context);
  const review = await startReviewServer({ projectRoot: root });
  try {
    assert.equal((await request(`${review.baseUrl}/api/session`, "PUT", { openTabs: [NARRATIVE, LEGACY_REVIEW], activeTab: NARRATIVE })).status, 200);
    await rm(path.join(root, NARRATIVE));
    const index = (await request(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.openTabs, [NARRATIVE, LEGACY_REVIEW]);
    assert.deepEqual(index.missingTabs, [NARRATIVE]);
    assert.equal((await request(`${review.baseUrl}/api/artifact?path=${encodeURIComponent(NARRATIVE)}`)).status, 404);
    // The page can still save its tabs while the missing one is open, and closing it is an ordinary save.
    assert.equal((await request(`${review.baseUrl}/api/session`, "PUT", { openTabs: [NARRATIVE, LEGACY_REVIEW], activeTab: LEGACY_REVIEW })).status, 200);
    // A missing file still cannot be opened as a new tab.
    assert.equal((await request(`${review.baseUrl}/api/session`, "PUT", { openTabs: [LEGACY_REVIEW, "docs/plans/reports/gone.md"] })).status, 400);
    await write(NARRATIVE, "# Export reports\n");
    assert.deepEqual((await request(`${review.baseUrl}/api/index`)).json().missingTabs, []);
    assert.equal((await request(`${review.baseUrl}/api/artifact?path=${encodeURIComponent(NARRATIVE)}`)).status, 200);
  } finally {
    await review.close();
  }
});

test("an entity tab whose records are removed is reported missing", async (context) => {
  const { root } = await fixture(context);
  await updateInitiative({ projectRoot: root, initiative: "orphan", expectedRevision: null, operations: [{ op: "create", slug: "orphan", title: "Orphan", requirements: ["docs/requirements/reports.md#1"] }] });
  const review = await startReviewServer({ projectRoot: root });
  try {
    await review.setOpenTabs(["initiative:orphan", "slice:orphan/orphan", "roadmap"]);
    assert.deepEqual((await request(`${review.baseUrl}/api/index`)).json().missingTabs, []);
    await rm(path.join(root, ".prism/initiatives/orphan"), { recursive: true, force: true });
    forgetWorkspace();
    assert.deepEqual((await request(`${review.baseUrl}/api/index`)).json().missingTabs, ["initiative:orphan", "slice:orphan/orphan"]);
    assert.equal((await request(`${review.baseUrl}/api/entity?ref=initiative%3Aorphan`)).status, 404);
    assert.equal((await request(`${review.baseUrl}/api/entity?ref=roadmap`)).status, 200);
  } finally {
    await review.close();
  }
});
