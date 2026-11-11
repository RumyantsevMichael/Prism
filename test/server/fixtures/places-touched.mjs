// Changes the demo project before its review server starts so the slice Retry timed-out requests until a total deadline has a contract of two clauses,
// a design view that lists both, links to a decision and a diagram, and Changes lines that name a decision and the glossary.
// The contract's first clause names the glossary term Retry deadline and its second names Attempt timeout.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, writeText } from "./places-browser.mjs";

export const TOUCHED_SLICE = "retry-hardening/timeout-retries";

export async function prepareTouched(root) {
  await writeText(root, "docs/plans/retry-hardening/timeout-retries/slice.md", [
    "# Retry timed-out requests until a total deadline",
    "",
    "The design follows [the deadline decision](../../../ADRs/retries/total-retry-deadline.md) and draws the strategy in [its diagram](timeout-retries.puml).",
    "",
    "## Contract",
    "",
    "1. A timed-out attempt is retried while the retry deadline allows another attempt.",
    "2. Each attempt timeout restarts the clock of the next attempt.",
    "",
    "## Changes",
    "",
    "- change `docs/ADRs/retries/total-retry-deadline.md`: records how the deadline is measured (§1)",
    "- change `docs/Glossary.md`: defines the attempt clock (§2)",
    "- change `src/retry.mjs`: `retryUntilDeadline` retries until the deadline (§1, §2)",
    ""
  ].join("\n"));
  await writeText(root, "test/retry.test.mjs", "import test from \"node:test\";\ntest(\"retries until the deadline\", () => {});\ntest(\"restarts the attempt clock\", () => {});\n");
  const { updateDesignView } = await import(pathToFileURL(path.join(ROOT, "dist/server/workflow/design-view.mjs")).href);
  await updateDesignView({ projectRoot: root, initiative: "retry-hardening", slice: "timeout-retries", examples: [
    { clause: 1, file: "test/retry.test.mjs", test: "retries until the deadline", example: "an attempt times out with time left, and it is retried" },
    { clause: 2, file: "test/retry.test.mjs", test: "restarts the attempt clock", example: "a retried attempt gets a full attempt timeout" }
  ] });
}
