import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, serveProject, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { writeText } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §46, as the approved mockup lists requirements, decisions, and diagrams in one library table each.
// The demo's signing decision supersedes the CSV decision and links two report requirements; each initiative's design links the decision it follows.

async function server(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeText(root, "docs/ADRs/retries/total-retry-deadline.puml", "@startuml Deadline flow\nTotal -> Deadline\n@enduml\n");
  await writeText(root, "docs/plans/retry-hardening/overview.puml", "@startuml\nstart\n:Retry;\nstop\n@enduml\n");
  const { base } = await serveProject(context, root);
  return { get: async (route) => (await fetch(`${base}${route}`)).json() };
}

const entity = (get, ref) => get(`/api/entity?ref=${encodeURIComponent(ref)}`);

test("a requirements file says how many requirements it holds and which slices of which initiative build each one", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const { data } = await entity(get, "requirements");
  const reports = data.entries.find((entry) => entry.path === "docs/requirements/reports.md");
  assert.equal(reports.requirements, 2);
  assert.deepEqual(reports.assignedTo.map((use) => [use.initiativeTitle, use.title, use.anchor]), [["Export activity reports", "Authorize report access", "2"], ["Export activity reports", "Download signed reports", "1"]]);
  assert.equal(data.entries.find((entry) => entry.path === "docs/requirements/search.md").requirements, 1);
});

test("a decision names what it supersedes and what superseded it, the requirements it serves, and the initiatives whose designs link it", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const { data } = await entity(get, "decisions");
  const byPath = new Map(data.entries.map((entry) => [entry.path, entry]));
  const signed = byPath.get("docs/ADRs/reporting/signed-exports.md");
  assert.deepEqual(signed.supersedes, ["docs/ADRs/reporting/csv-only-exports.md"]);
  assert.deepEqual(byPath.get("docs/ADRs/reporting/csv-only-exports.md").supersededBy, ["docs/ADRs/reporting/signed-exports.md"]);
  assert.deepEqual(signed.requirementLinks, [{ path: "docs/requirements/reports.md", anchors: ["1", "2"] }]);
  assert.deepEqual(signed.initiatives, [{ initiative: "activity-reports", title: "Export activity reports" }]);
  assert.deepEqual(byPath.get("docs/ADRs/retries/total-retry-deadline.md").initiatives, [{ initiative: "retry-hardening", title: "Harden request retries" }]);
  assert.deepEqual(byPath.get("docs/ADRs/reporting/csv-only-exports.md").initiatives, [], "no design links the superseded decision");
});

test("the diagrams page says what each diagram draws and which page it belongs to, beside the list that the places contract fixes", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const { data } = await entity(get, "knowledge:diagrams");
  assert.deepEqual(data.about, {
    "docs/ADRs/retries/total-retry-deadline.puml": { kind: "Sequence", owner: "docs/ADRs/retries/total-retry-deadline.md" },
    "docs/plans/retry-hardening/overview.puml": { kind: "Activity", owner: "initiative:retry-hardening" },
    "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml": { kind: "Class", owner: "slice:retry-hardening/timeout-retries" }
  });
  assert.deepEqual(Object.keys(data.diagrams[0]), ["path", "name", "owner"]);
});
