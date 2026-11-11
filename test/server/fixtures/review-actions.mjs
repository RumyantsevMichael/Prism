import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defer } from "./teardown.mjs";

export const INITIATIVE = "reports";
export const AUTHOR = { name: "Ada Reviewer", email: "ada@example.invalid" };

// The author that a page of this checkout records: its Git identity and its checkout label on this host.
export const authorOf = (root) => ({ ...AUTHOR, checkout: `${path.basename(root)}/main on ${os.hostname().split(".")[0] || "an unnamed host"}` });

// What the fixture's gates explain, so a test can find each in the gate answer's listing.
export const DECISION_CONTEXT = "Exports still write the old CSV layout, which two scripts read; dropping it breaks them until they move to the new one.";
export const KEEP_CONSEQUENCE = "Exports write both layouts until the scripts move.";
export const DROP_CONSEQUENCE = "Exports write only the new layout from the next release.";
export const KEEP_REASON = "Both scripts still read the old layout.";
export const RETENTION_CONTEXT = "Signed exports are kept on disk, and the window decides how long a person can download one again.";
export const RETENTION_REASON = "Thirty days covers a monthly audit.";
export const SIGNING_CONTEXT = "Signing needs a key in the operating system's key store, which only you can add.";

/**
 * A Git checkout on branch main with a local Git identity, a roadmap entry, an initiative record of one root slice, and coordination state that holds one gate of each kind.
 * components declares the repository name reports-app and one component api, so the checkout has two index targets.
 */
export async function actionProject(context, { gates = true, components = false } = {}) {
  const { updateInitiative } = await import("../../../dist/server/workflow/initiative.mjs");
  const { updateRoadmap } = await import("../../../dist/server/workflow/roadmap.mjs");
  const { updateCoordinationState } = await import("../../../dist/server/workflow/state.mjs");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-actions-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "docs/plans", INITIATIVE), { recursive: true });
  const declared = components ? "\n## Workspace\n- Repository: reports-app\n\n## Components\n- api: packages/api\n" : "";
  await writeFile(path.join(root, ".prism/workflow.md"), `## Paths\n- Requirements: docs/requirements/\n- Plans: docs/plans/\n- Roadmap: docs/roadmap.md\n${declared}`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", AUTHOR.name], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", AUTHOR.email], { cwd: root, stdio: "pipe" });
  await writeFile(path.join(root, "docs/plans", INITIATIVE, "slice.md"), "# Export reports\n");
  await updateRoadmap({ projectRoot: root, expectedRevision: null, operations: [
    { op: "add_initiative", id: INITIATIVE, title: "Export reports", intent: "Signed exports.", band: "Now" },
    { op: "add_initiative", id: "search", title: "Search", intent: "Find activity.", band: "Later" }
  ] });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Export reports", requirements: ["docs/requirements/reports.md#1"] }] });
  const gateIds = {};
  if (gates) {
    const created = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [
      { op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] },
      { op: "ask", kind: "decision", question: "Keep the old format?", context: DECISION_CONTEXT, artifacts: [], options: [{ id: "keep", label: "Keep", consequence: KEEP_CONSEQUENCE }, { id: "drop", label: "Drop", consequence: DROP_CONSEQUENCE }], recommended: { option: "keep", reason: KEEP_REASON } },
      { op: "ask", kind: "decision", question: "Which retention window?", context: RETENTION_CONTEXT, artifacts: [], recommended: { reason: RETENTION_REASON } },
      { op: "ask", kind: "assistance", question: "Install the signing key.", context: SIGNING_CONTEXT, artifacts: [] }
    ] } });
    [gateIds.review, gateIds.decision, gateIds.free, gateIds.assistance] = created.openedGates.map((gate) => gate.id);
  }
  return { root, gateIds };
}

// A per-project review server whose browser opener records what it was asked to open instead of opening anything.
export async function startActionReview(context, root, options = {}) {
  const { startReviewServer } = await import("../../../dist/server/review/review-server.mjs");
  const opened = [];
  const review = await startReviewServer({ projectRoot: root, openBrowser: async (url) => { opened.push(url); return true; }, ...options });
  defer(context, () => review.close());
  return { review, base: review.baseUrl, opened };
}

// The headers of a write session for a page that Prism opened: the grant in the opened URL's fragment is exchanged for a token.
// A server that issues no grant gives an empty header set, so the same helper serves before and after write sessions exist.
export async function writeHeaders(base, openedUrl) {
  const grant = new URLSearchParams(new URL(openedUrl).hash.slice(1)).get("write");
  if (!grant) return {};
  const exchanged = await post(base, "api/write-session", { grant });
  if (exchanged.status !== 200) throw new Error(`The grant exchange failed with ${exchanged.status}: ${exchanged.text}`);
  return { "X-Prism-Write": exchanged.json.token };
}

// Opens the review once through Prism and returns the write headers of that page.
export async function pageSession(review, opened, base = review.baseUrl) {
  await review.open([]);
  return writeHeaders(base, opened.at(-1));
}

function join(base, route) {
  return `${base.replace(/\/$/, "")}/${route}`;
}

export async function get(base, route, headers = {}) {
  const response = await fetch(join(base, route), { headers });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  return { status: response.status, text, json };
}

export async function post(base, route, body, headers = {}) {
  const response = await fetch(join(base, route), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  return { status: response.status, text, json };
}

export const listing = (base, target, headers = {}) => get(base, `api/actions?target=${encodeURIComponent(target)}`, headers);
export const apply = (base, body, headers = {}) => post(base, "api/actions/apply", body, headers);
export const actionOf = (list, id) => list.json.actions.find((action) => action.id === id);

// A history entry's identity and its place: ascending by time and then by id.
export const ENTRY_ID = /^[0-9a-f]{32}$/;
export const inHistoryOrder = (entries) => entries.every((entry, index) => index === 0 || entries[index - 1].at < entry.at || (entries[index - 1].at === entry.at && entries[index - 1].id < entry.id));
