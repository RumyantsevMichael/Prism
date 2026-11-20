import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, actionOf, apply, fakeEntry, listing, runOptions } from "./fixtures/acp-agents.mjs";

// A host that the host list does not offer is refused as unknown with every host of the live list named and starts no agent, and a
// models change for an ACP agent is checked against the models the agent reports, so a model it does not offer is refused.

const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;
const KINDS = ["coordinator", "designImplementation", "codeReview", "securityReview", "gateSummary"];

test("an unknown ACP host names the live host list and starts no agent", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "gemini")]);
  const unknown = await runOptions(s, "acp-other");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, "unknown_host");
  assert.equal(unknown.json.message, "Prism supports no host acp-other; it supports claude-code, codex, and acp-gemini.");
  assert.equal(s.requests().length, 0, "no agent process is started");
});

test("a models change for an ACP agent takes a model it reports and refuses one it does not offer", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t);
  await s.declare([fakeEntry(s, "gemini")]);
  const input = (model) => ({ host: "acp-gemini", provider: null, ...Object.fromEntries(KINDS.map((kind) => [kind, null])), coordinator: { model, effort: null, typed: false } });
  const action = actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "initiative.models");
  const refused = await apply(s.base, { action: "initiative.models", target: TARGET(INITIATIVE), input: input("gemini-pro"), revision: action.revision }, s.headers);
  assert.equal(refused.status >= 400, true, JSON.stringify(refused.json));
  assert.match(refused.json.message, /Gemini agent on this computer does not offer the model gemini-pro\./);
  const taken = await apply(s.base, { action: "initiative.models", target: TARGET(INITIATIVE), input: input("fake-small"), revision: action.revision }, s.headers);
  assert.equal(taken.status, 200, JSON.stringify(taken.json));
});
