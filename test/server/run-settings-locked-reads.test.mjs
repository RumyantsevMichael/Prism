import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, actionOf, apply, listing, runOptionsReview } from "./fixtures/run-options-hosts.mjs";

// A models change checks its values once on the state as read and again under the state lock; the second check reuses the first
// check's host reads, so no host process starts while the lock is held, even for a report that Prism does not keep.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const TARGET = `initiative:${INITIATIVE}`;
const KINDS = ["coordinator", "designImplementation", "codeReview", "securityReview", "gateSummary"];

test("a models change reads its host once, also when the host's report is not kept", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const catalog = await s.readCatalog();
  // A refused model list leaves the report unkept, so only the apply's own reader can spare the check under the lock a second read.
  await s.setCatalog({ ...catalog, codex: { ...catalog.codex, modelListError: "Authentication required" } });
  const current = actionOf(await listing(s.base, TARGET, s.headers), "initiative.models");
  const input = { host: "codex", provider: "local", ...Object.fromEntries(KINDS.map((kind) => [kind, null])) };
  const answer = await apply(s.base, { action: "initiative.models", target: TARGET, input, revision: current.revision }, s.headers);
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.ok(answer.json.applied, "the provider change applied");
  assert.equal(s.optionReads("codex").length, 1, "the check under the state lock started no second host read");
});
