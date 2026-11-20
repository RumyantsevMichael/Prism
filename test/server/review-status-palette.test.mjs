import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_CLASSES, STATUSES, statusOf } from "../../dist/server/review/public/kit/statuses.js";
import { SLICE_STATUSES } from "../../dist/server/workflow/initiative-graph.mjs";
import { ROADMAP_STATES } from "../../dist/server/workflow/roadmap.mjs";
import { FINDING_STATUSES, LANE_RESULTS } from "../../dist/server/review/review-ledger.mjs";

// The statuses the review app derives on top of the records: an initiative with a record but no roadmap entry, a slice whose design waits on a person, and a reviewer lane with no result yet.
const DERIVED = ["unlisted", "design-review", "pending"];
// The file statuses the requirement and decision formats define; a person may write another, which shows as written in the not started look.
const RECORD_STATUSES = ["Draft", "Approved", "Proposed", "Accepted", "Superseded", "Withdrawn"];

test("kit clause 20: every status word Prism defines has a class in the status palette", () => {
  const words = [...ROADMAP_STATES, ...SLICE_STATUSES, ...FINDING_STATUSES, ...LANE_RESULTS, ...DERIVED, ...RECORD_STATUSES];
  const missing = words.filter((word) => !statusOf(word).known);
  assert.deepEqual(missing, [], `the status palette has no class for ${missing.join(", ")}`);
});

test("kit clause 19: each status class owns one look, and every palette entry names one", () => {
  for (const [word, [cls, label]] of Object.entries(STATUSES)) {
    assert.ok(Object.hasOwn(STATUS_CLASSES, cls), `${word} belongs to a known class`);
    assert.ok(label.trim(), `${word} has a word to show`);
  }
  assert.deepEqual(Object.keys(STATUS_CLASSES), ["idle", "ready", "active", "waiting", "problem", "done", "retired"]);
  assert.deepEqual([statusOf("IN PROGRESS").cls, statusOf("design review").cls, statusOf("Superseded").cls], ["active", "waiting", "retired"], "a word matches however it is cased or spaced");
  assert.deepEqual(statusOf("parked by hand"), { key: "parked-by-hand", cls: "idle", label: "Parked by hand", known: false }, "an unknown word is idle and shows as written");
});
