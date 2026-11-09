// Changes the demo project before its review server starts so Attention has an item of every kind it filters by:
// a failed verification, a slice whose failed run a later run fixed, a failed run of a done slice, questions answered and closed this week and earlier,
// and three initiatives off the roadmap, each with a blocked slice, so more than three initiatives have items.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { editJson, ROOT, writeText } from "./places-browser.mjs";

const DAY = 24 * 60 * 60 * 1000;
export const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

export async function prepareAttention(root) {
  const { appendRecord } = await import(pathToFileURL(path.join(ROOT, "dist/server/workflow/record-store.mjs")).href);
  const run = (passed, finishedAt, extra = {}) => ({ kind: "verification", startedAt: finishedAt, finishedAt, durationMs: 1000, exitCode: passed ? 0 : 1, signal: null, timedOut: false, passed, ...(passed ? {} : { reason: "command_failed" }), outputTail: "", ...extra });
  await appendRecord(root, { kind: "runs", initiative: "retry-hardening", slice: "connection-retries" }, "a".repeat(64), run(false, ago(0.01), { failing: ["drops connections", "retries three times"], failingCount: 2 }));
  await appendRecord(root, { kind: "runs", initiative: "retry-hardening", slice: "retry-metrics" }, "b".repeat(64), run(false, ago(0.2)));
  await appendRecord(root, { kind: "runs", initiative: "retry-hardening", slice: "retry-metrics" }, "c".repeat(64), run(true, ago(0.1)));
  await appendRecord(root, { kind: "runs", initiative: "audit-log", slice: "audit-log" }, "d".repeat(64), run(false, ago(0.1), { reason: "timed_out", timedOut: true }));
  await editJson(root, ".prism/initiatives/retry-hardening/state.json", (state) => {
    const [review, decision] = state.pending;
    review.answer = { choice: "approve", note: null, via: "browser", answeredAt: ago(1) };
    state.closed = [
      { ...decision, id: "gate-closed-recent", question: "Keep the old socket wrapper?", options: decision.options, answer: { choice: null, note: "Keep it until connection retries land.", via: "browser", answeredAt: ago(2) }, closedAt: ago(2) },
      { ...review, id: "gate-withdrawn", question: "Review the first draft of the change map.", answer: undefined, closedAt: ago(3), reason: "The design changed, so the agent withdrew it." },
      { ...review, id: "gate-closed-old", question: "Review the retry ADR draft.", answer: { choice: "approve", note: null, via: "browser", answeredAt: ago(10) }, closedAt: ago(10) }
    ].map((entry) => JSON.parse(JSON.stringify(entry)));
  });
  for (const [id, title] of [["alpha-search", "Alpha search"], ["beta-billing", "Beta billing"], ["gamma-gateway", "Gamma gateway"]]) {
    await writeText(root, `.prism/initiatives/${id}/initiative.json`, `${JSON.stringify({ schemaVersion: 1, id, slices: {
      [id]: { title, outcome: `${title}.`, status: "split", parent: null, requirements: [], dependencies: [], splitEvidence: { kind: "user_gate", gate: "g1" } },
      first: { title: `${title} first part`, outcome: "First.", status: "blocked", parent: id, requirements: [], dependencies: [] }
    }, history: [] }, null, 2)}\n`);
  }
}
