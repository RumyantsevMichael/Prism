import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { actionOf, apply, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

// Review finding (gate-resume, correctness): clause 21 says launch.stop and launch.resume act on a resumed asker as on any launched
// session, also for an approval gate that names no initiative, whose launch record has initiative null.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-no-initiative-resume-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;

test("a resumed asker of an approval gate that names no initiative stops and resumes as a launched session", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { dialog: { code: 0 }, plans: { claude: [{ hold: "forever" }, { hold: "forever" }] } });
  fixture.useAsProcessEnv();
  const { review, base, opened } = await startActionReview(t, fixture.root);
  const headers = await pageSession(review, opened);
  const { startAskerResume } = await import("../../dist/server/session/launched-sessions.mjs");
  const resume = { gate: "approval-0123abcd0123", initiative: null, artifact: "docs/requirements/billing.md" };
  const { launch } = await startAskerResume({ checkout: fixture.root, host: "claude-code", hostSessionId: "5b1d7e2a-6c3f-4a8e-9d21-7f0c3b9e4a16", resume, env: process.env });
  const state = (id) => waitFor(async () => (await get(base, "api/launches")).json.launches.find((item) => item.id === id), { what: "the launch to list" });
  await state(launch.id);
  const stop = actionOf(await listing(base, `launch:${launch.id}`, headers), "launch.stop");
  const stopped = await apply(base, { action: "launch.stop", target: `launch:${launch.id}`, input: {}, revision: stop.revision }, headers);
  assert.equal(stopped.status, 200, stopped.text);
  await waitFor(async () => (await get(base, "api/launches")).json.launches.find((item) => item.id === launch.id && item.state !== "running"), { ms: 20000, what: "the launch to end" });
  const again = actionOf(await listing(base, `launch:${launch.id}`, headers), "launch.resume");
  assert.equal(again.available, true, again.reason);
  const resumed = await apply(base, { action: "launch.resume", target: `launch:${launch.id}`, input: {}, revision: again.revision }, headers);
  assert.equal(resumed.status, 200, resumed.text);
});
