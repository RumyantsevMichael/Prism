import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE } from "./fixtures/review-actions.mjs";
import { TARGET, acpFixture, actionOf, listing } from "./fixtures/acp-agents.mjs";

// The launch's reason when no host can run names every host of the live host list, so a declared ACP agent that cannot run is
// named beside Claude Code and Codex rather than leaving them as the only hosts.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

test("without any host that can run, the launch names the declared ACP agents beside Claude Code and Codex", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t, { hosts: [], agents: [{ id: "gemini", label: "Gemini CLI", command: "prism-test-no-such-gemini" }] });
  const action = actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "launch.run");
  assert.equal(action.available, false);
  assert.equal(action.reason, "No host that Prism supports was found on this computer. Prism supports Claude Code, Codex, and Gemini CLI.");
});
