import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, actionOf, apply, fakeEntry, listing, runOptions } from "./fixtures/acp-agents.mjs";

// A listed ACP agent's run options are not read yet, so the run options report and a models change that needs them say so for that
// agent, and never call Claude Code and Codex the only hosts; a host that the host list does not offer is still refused as unknown,
// with every host of the live list named.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const PENDING = "Prism does not read the run options of Gemini agent yet, so only its host defaults can be chosen.";
const KINDS = ["coordinator", "designImplementation", "codeReview", "securityReview", "gateSummary"];

test("a listed ACP agent's run options answer that they are not read yet, and an unknown host names the live host list", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "gemini")]);
  for (const purpose of ["coordinator", "agents"]) {
    const report = await runOptions(s, "acp-gemini", purpose);
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.deepEqual(report.json, { host: "acp-gemini", label: "Gemini agent", state: "unavailable", reason: PENDING, options: [] });
  }
  const unknown = await runOptions(s, "acp-other");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, "unknown_host");
  assert.equal(unknown.json.message, "Prism supports no host acp-other; it supports claude-code, codex, and acp-gemini.");
  assert.equal(s.requests().length, 0, "no agent process is started");
});

test("a models change for a listed ACP agent with a reported model is refused with the not-yet reason", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "gemini")]);
  const action = actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "initiative.models");
  const input = { host: "acp-gemini", provider: null, ...Object.fromEntries(KINDS.map((kind) => [kind, null])), coordinator: { model: "gemini-pro", effort: null, typed: false } };
  const refused = await apply(s.base, { action: "initiative.models", target: TARGET(INITIATIVE), input, revision: action.revision }, s.headers);
  assert.equal(refused.status >= 400, true, JSON.stringify(refused.json));
  assert.equal(refused.json.message.includes(PENDING), true, refused.json.message);
  assert.doesNotMatch(refused.json.message, /supports claude-code and codex/);
});
