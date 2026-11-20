// Launched sessions and claims for the agent activity tests: a launch project with stub hosts, a review server over it with a write
// session, gates asked as a launched session's own Prism server asks them, and claims written as a Prism server writes them.
import { createHash } from "node:crypto";
import { INITIATIVE, launchFixture, waitFor, CODEX_THREAD } from "./launched-sessions.mjs";
import { get, pageSession, startActionReview } from "./review-actions.mjs";
import { writeClaim } from "./kit-browser.mjs";

export { CODEX_THREAD, INITIATIVE, waitFor, writeClaim };

/** The claim holder of a host session, as a Prism server of that session names it in every claim it takes. */
export const holderOf = (hostSessionId) => `session-${createHash("sha256").update(hostSessionId).digest("hex").slice(0, 16)}`;

/**
 * A launch project whose review server reads this test's launches: `plans` drive the stub hosts, and `start` launches one initiative.
 * It returns the fixture with `base` (the review server's URL without a trailing slash), write-session `headers`, `opened` (the URLs
 * the server asked the browser to open, the first with its write grant), and readers of `/api/launches` and `/api/agents`.
 */
export async function agentsProject(t, { plans = {}, gates = false, before = null } = {}) {
  const fixture = await launchFixture(t, { plans, gates, dialog: { code: 0 } });
  fixture.useAsProcessEnv();
  if (before) await before(fixture);
  const { startLaunch } = await import("../../../dist/server/session/launched-sessions.mjs");
  const start = async (initiative = INITIATIVE, host = "claude-code") => (await startLaunch({ projectRoot: fixture.root, initiative, host, env: fixture.env })).launch.id;
  const { review, base, opened } = await startActionReview(t, fixture.root);
  const headers = await pageSession(review, opened);
  const trimmed = base.replace(/\/$/, "");
  const launches = async () => (await get(trimmed, "api/launches")).json.launches;
  const launchView = async (id) => (await launches()).find((launch) => launch.id === id) ?? null;
  const agents = async () => (await get(trimmed, "api/agents"));
  const settledLaunch = (id, accept) => waitFor(async () => {
    const view = await launchView(id);
    return view && accept(view) ? view : null;
  }, { what: `launch ${id}` });
  /** The host session id of a launch's first run: the Claude Code stub's --session-id, or the Codex stub's thread. */
  const sessionOf = (host) => (host === "codex" ? CODEX_THREAD : fixture.runs("claude")[0].argv[3]);
  return { ...fixture, review, base: trimmed, headers, opened, start, launches, launchView, agents, settledLaunch, sessionOf };
}

/** Asks a gate as the launched session's own Prism server would, its environment naming the launch, and returns the gate's id. */
export async function askAsLaunch(root, launchId, question = "Which retention window?", initiative = INITIATIVE) {
  const { updateCoordinationState, readCoordinationState } = await import("../../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative });
  const previous = process.env.PRISM_LAUNCH;
  process.env.PRISM_LAUNCH = launchId;
  try {
    const written = await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: read.exists ? read.revision : null, changes: { gateOperations: [{ op: "ask", kind: "decision", question, context: "Signed exports stay on disk for a while.", artifacts: [], recommended: { reason: "A month covers an audit." } }] } });
    return written.openedGates[0].id;
  } finally {
    if (previous === undefined) delete process.env.PRISM_LAUNCH;
    else process.env.PRISM_LAUNCH = previous;
  }
}

/** Splits the initiative's root slice into planned slices, so claims can sit on several slices of it. */
export async function plannedSlices(root, slices, initiative = INITIATIVE) {
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { getInitiative, updateInitiative } = await import("../../../dist/server/workflow/initiative.mjs");
  // The split's evidence quotes an Unprobed assumption of the scope's contract, which the first part settles.
  const assumption = "Unprobed: the signing service accepts batches.";
  await writeFile(path.join(root, "docs/plans", initiative, "slice.md"), `# Export reports\n\n## Assumptions\n- ${assumption}\n`);
  const read = await getInitiative({ projectRoot: root, initiative });
  const children = slices.map(([slug, title]) => ({ slug, title, requirements: ["docs/requirements/reports.md#1"] }));
  await updateInitiative({ projectRoot: root, initiative, expectedRevision: read.revision, operations: [{ op: "split", parent: initiative, children, evidence: { kind: "unfrozen", assumption, settledBy: slices[0][0] } }] });
}
