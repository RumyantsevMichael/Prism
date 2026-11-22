import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { prismToolAllow } from "../../dist/server/session/host-adapters/acp.mjs";
import { INITIATIVE, TARGET, acpFixture, apply, fakeEntry, get, launches, setSettings } from "./fixtures/acp-agents.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// An ACP agent's request to call one of Prism's own tools in the run is answered with its single-use allow without a dialog, as the
// permission approvals decision says, while every other request still waits on Attention for the person.

const posixOnly = process.platform === "win32" ? "the stub agent and dialogs are POSIX scripts" : false;
const OPTIONS = [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }];
const TOOLS = new Set(["get_skill", "get_roadmap"]);
const request = (title, extra = {}) => ({ sessionId: "s1", toolCall: { toolCallId: "t1", title, kind: "other", ...extra }, options: OPTIONS });

test("prismToolAllow allows a listed Prism tool named in each separator form, and only with the request's allow_once option", () => {
  for (const title of ["prism/get_skill", "prism__get_skill", "prism.get_skill", "prism:get_skill", "mcp__prism__get_skill", " prism/get_roadmap "]) {
    assert.deepEqual(prismToolAllow(request(title, { rawInput: { name: "orchestrate" } }), TOOLS), { outcome: { outcome: "selected", optionId: "yes" } }, title);
  }
  assert.deepEqual(prismToolAllow(request("prism/get_skill"), TOOLS), { outcome: { outcome: "selected", optionId: "yes" } }, "no raw input");
  assert.deepEqual(prismToolAllow({ ...request("x"), toolCall: { toolCallId: "t1" } }, TOOLS, { title: "prism/get_skill", rawInput: {} }), { outcome: { outcome: "selected", optionId: "yes" } }, "the title from an earlier tool_call update");
});

test("prismToolAllow leaves every other request to the person", () => {
  for (const [why, params] of [
    ["a tool that Prism's server did not list", request("prism/delete_everything")],
    ["another server's tool of the same name", request("other/get_skill")],
    ["a server whose name only starts with prism", request("prismatic/get_skill")],
    ["a title with more after the tool", request("prism/get_skill; rm -rf /")],
    ["a shell command", request("rm -rf /", { kind: "execute" })],
    ["a raw input that is not an object", request("prism/get_skill", { rawInput: "rm -rf /" })],
    ["a raw input that is a list", request("prism/get_skill", { rawInput: ["a"] })],
    ["no allow_once option", { ...request("prism/get_skill"), options: [{ optionId: "always", name: "Always", kind: "allow_always" }] }],
    ["no options", { ...request("prism/get_skill"), options: undefined }]
  ]) assert.equal(prismToolAllow(params, TOOLS), null, why);
  assert.equal(prismToolAllow(request("prism/get_skill"), new Set()), null, "before the server listed its tools");
});

async function onAgent(t, permission) {
  const s = await acpFixture(t, { plans: { gemini: { permission: { options: OPTIONS, ...permission } } } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  await setSettings(s.root, INITIATIVE, { host: "acp-gemini" });
  return s;
}
const launchRun = async (s) => {
  const result = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(result.status, 200, result.text);
  return result.json.launch.id;
};
const attention = async (s) => (await get(s.base, "api/entity?ref=attention")).json.data;

test("a launched run's request to call a Prism tool is allowed once without a dialog and counted in the run's record", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { title: "prism/get_skill", kind: "other", rawInput: { name: "orchestrate", path: "SKILL.md" } });
  const id = await launchRun(s);
  const answered = await settled(() => s.entries().find((entry) => entry.kind === "permission-answer"), Boolean);
  assert.deepEqual(answered.outcome, { outcome: "selected", optionId: "yes" });
  assert.equal(s.dialogs().length, 1, "only the launch itself asked a dialog");
  assert.deepEqual((await attention(s)).permissions ?? [], []);
  const view = await settled(async () => (await launches(s)).find((item) => item.id === id), (item) => item && !["running", "waiting"].includes(item.state));
  assert.notEqual(view.state, "failed", view.reason);
  const record = JSON.parse(readFileSync(path.join(s.app, "launches", id, "launch.json"), "utf8"));
  assert.equal(record.runs.at(-1).ownToolAllows, 1);
});

test("a launched run's request for a tool that Prism's server did not list still waits on Attention", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { title: "prism/delete_everything", kind: "delete", rawInput: {} });
  await launchRun(s);
  const listed = await settled(async () => (await attention(s)).permissions ?? [], (list) => list.length > 0);
  assert.equal(listed[0].action, "prism/delete_everything {}");
  await pause(300, "checks that no answer reaches the agent without the person");
  assert.equal(s.entries().some((entry) => entry.kind === "permission-answer"), false, "nothing answered it without the person");
});
