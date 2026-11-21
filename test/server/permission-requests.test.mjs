import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, apply, fakeEntry, get, launches, setSettings } from "./fixtures/acp-agents.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launched-sessions.md §29, §30, §31, and §32.
// Contract clauses 32 to 41 of docs/plans/harness-client-protocol/slice.md: every host's permission request waits on Attention,
// an approval applies only after a native confirmation on this machine and only for that one request, a refusal needs none,
// and a request whose session ends is withdrawn.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const PERMISSION_FLAGS = ["--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];

// A Claude Code stub that asks one can_use_tool permission in its turn and ends the turn once Prism answers it.
const CLAUDE_ASKING = String.raw`#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.PRISM_STUB_LOG, JSON.stringify({ host: "claude", pid: process.pid, ...entry }) + "\n");
log({ kind: "run", argv, cwd: process.cwd(), env: {}, children: [] });
const write = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const id = argv[argv.indexOf("--session-id") + 1];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    log({ kind: "input", message });
    if (message.type === "user") {
      write({ type: "system", subtype: "init", session_id: id, model: "claude-opus-5-5" });
      write({ type: "control_request", request_id: "ask-1", request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write", input: { file_path: ".claude/settings.local.json", content: "{}" }, description: ".claude/settings.local.json", decision_reason: "Claude requested permissions to write to .claude/settings.local.json.", tool_use_id: "toolu_1" } });
    }
    if (message.type === "control_response" && message.response?.request_id === "ask-1") write({ type: "result", subtype: "success", is_error: false, result: "done", session_id: id, permission_denials: [] });
  }
});
process.stdin.on("end", () => { log({ kind: "closed", results: 1, interrupted: false }); setTimeout(() => process.exit(0), 20); });
`;

const attention = async (s) => (await get(s.base, "api/entity?ref=attention")).json.data;
const pending = (s) => settled(async () => (await attention(s)).permissions ?? [], (list) => list.length > 0);
const decide = (s, launch, request, decision) => apply(s.base, { action: "launch.permission", target: `launch:${launch}`, input: { request, decision }, revision: null }, s.headers);
const launchRun = async (s) => {
  const result = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(result.status, 200, result.text);
  return result.json.launch.id;
};

async function onAgent(t, plan) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  await setSettings(s.root, INITIATIVE, { host: "acp-gemini" });
  return s;
}
async function onClaude(t) {
  const s = await acpFixture(t, { hosts: ["claude"] });
  const file = path.join(s.bin, "claude");
  await writeFile(file, CLAUDE_ASKING);
  chmodSync(file, 0o755);
  await setSettings(s.root, INITIATIVE, { host: "claude-code" });
  return s;
}
async function onCodex(t) {
  const s = await acpFixture(t, { hosts: ["codex"] });
  await s.setPlans({ codex: [{ askApproval: true, hold: "forever" }] });
  await setSettings(s.root, INITIATIVE, { host: "codex" });
  return s;
}
const inputsOf = (s, host) => s.runs(host).flatMap((run) => s.inputs(run.pid));
const claudeAnswer = (s) => settled(() => inputsOf(s, "claude").find((message) => message.type === "control_response"), Boolean);
const codexAnswer = (s) => settled(() => inputsOf(s, "codex").find((message) => message.id === "approval-1" && message.method === undefined), Boolean);

test("clause 32: Claude Code runs in auto mode with its permission prompts sent to Prism over its input", { skip: posixOnly }, async (t) => {
  const s = await onClaude(t);
  await launchRun(s);
  const [run] = await settled(() => s.runs("claude"), (runs) => runs.length === 1);
  for (let index = 0; index < PERMISSION_FLAGS.length; index += 2) {
    const at = run.argv.indexOf(PERMISSION_FLAGS[index]);
    assert.ok(at >= 0, `${PERMISSION_FLAGS[index]} is passed`);
    assert.equal(run.argv[at + 1], PERMISSION_FLAGS[index + 1]);
  }
  assert.ok(!run.argv.includes("none"), "no prompt is denied without the person");
});

test("clauses 33, 34: an ACP request waits on Attention with its initiative, host, and action, and counts as a question, in no shared record", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: { title: "Write probe.txt", kind: "edit" } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.match(request.id, /^perm-[0-9a-f]{16}$/);
  assert.deepEqual({ launch: request.launch, initiative: request.initiative.id, host: request.host, action: request.action }, { launch: id, initiative: INITIATIVE, host: { id: "acp-gemini", label: "Gemini CLI" }, action: "Write probe.txt" });
  assert.ok(!Number.isNaN(Date.parse(request.askedAt)));
  assert.equal((await get(s.base, "api/attention")).json.gates, 1);
  const shared = readFileSync(path.join(s.root, ".prism/initiatives", INITIATIVE, "state.json"), "utf8");
  assert.doesNotMatch(shared, /perm-|Write probe\.txt/);
  const viewed = await settled(async () => (await launches(s)).find((item) => item.id === id), (item) => item?.state === "waiting");
  assert.equal(viewed.reason, "Asks you to allow: Write probe.txt.");
});

test("clauses 35, 39: a decision on a request id that is not pending in the launch is refused", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: {} });
  const id = await launchRun(s);
  await pending(s);
  const refused = await decide(s, id, "perm-0000000000000000", "approve");
  assert.deepEqual([refused.status, refused.json.code], [404, "unknown_request"]);
  const other = await decide(s, "launch-0000000000000000", (await attention(s)).permissions[0].id, "refuse");
  assert.equal(other.status >= 400, true, "a request of another launch is not answered through this one");
});

test("clauses 36, 37: an approval asks a native dialog every time, naming the action, and answers the ACP agent allow_once", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: { title: "Write probe.txt" } });
  const id = await launchRun(s);
  assert.equal(s.dialogs().length, 1, "the launch itself was confirmed");
  const [request] = await pending(s);
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  assert.equal(s.dialogs().length, 2, "the open launch window does not skip the approval's dialog");
  const text = s.dialogs()[1].argv.join(" ");
  for (const part of ["Write probe.txt", "Gemini CLI", "Export reports"]) assert.match(text, new RegExp(part.replace(".", "\\.")));
  const answered = await settled(() => s.entries().find((entry) => entry.kind === "permission-answer"), Boolean);
  assert.deepEqual(answered.outcome, { outcome: "selected", optionId: "yes" });
  assert.deepEqual((await attention(s)).permissions, []);
});

test("clause 36: a declined dialog keeps the request waiting and answers nothing", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: {} });
  const id = await launchRun(s);
  const [request] = await pending(s);
  await s.setDialog({ code: 1 });
  const declined = await decide(s, id, request.id, "approve");
  assert.equal(declined.json.code, "confirmation_declined");
  assert.equal((await attention(s)).permissions.length, 1);
  assert.equal(s.entries().some((entry) => entry.kind === "permission-answer"), false);
});

test("clause 37: a request that offers no single-use allow cannot be approved", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: { options: [{ optionId: "always", name: "Always allow", kind: "allow_always" }] } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  const refused = await decide(s, id, request.id, "approve");
  assert.equal(refused.json.code, "approval_unavailable");
  assert.equal(s.entries().some((entry) => entry.kind === "permission-answer"), false);
});

test("clauses 37, 38: Claude Code gets allow with the request's own input, or deny with the fixed message", { skip: posixOnly }, async (t) => {
  const allow = await onClaude(t);
  const id = await launchRun(allow);
  const [request] = await pending(allow);
  assert.deepEqual([request.host.id, request.action, request.reason], ["claude-code", "Write .claude/settings.local.json", "Claude requested permissions to write to .claude/settings.local.json."]);
  await decide(allow, id, request.id, "approve");
  const allowed = await claudeAnswer(allow);
  assert.deepEqual(allowed.response, { subtype: "success", request_id: "ask-1", response: { behavior: "allow", updatedInput: { file_path: ".claude/settings.local.json", content: "{}" } } });
  const deny = await onClaude(t);
  const other = await launchRun(deny);
  const [asked] = await pending(deny);
  const before = deny.dialogs().length;
  await decide(deny, other, asked.id, "refuse");
  assert.equal(deny.dialogs().length, before, "a refusal asks no dialog");
  const denied = await claudeAnswer(deny);
  assert.deepEqual(denied.response.response, { behavior: "deny", message: "The person refused this on Attention." });
});

test("clauses 37, 38: Codex gets accept for an approval and decline for a refusal", { skip: posixOnly }, async (t) => {
  for (const [decision, expected] of [["approve", "accept"], ["refuse", "decline"]]) {
    const s = await onCodex(t);
    const id = await launchRun(s);
    const [request] = await pending(s);
    assert.deepEqual([request.host.id, request.action], ["codex", "touch /etc/hosts"]);
    await decide(s, id, request.id, decision);
    const answered = await codexAnswer(s);
    assert.deepEqual(answered.result, { decision: expected });
  }
});

test("clause 38: a refusal answers an ACP agent with its reject_once option, else cancelled", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: {} });
  const id = await launchRun(s);
  await decide(s, id, (await pending(s))[0].id, "refuse");
  assert.deepEqual((await settled(() => s.entries().find((entry) => entry.kind === "permission-answer"), Boolean)).outcome, { outcome: "selected", optionId: "no" });
  const bare = await onAgent(t, { permission: { options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } });
  const other = await launchRun(bare);
  await decide(bare, other, (await pending(bare))[0].id, "refuse");
  assert.deepEqual((await settled(() => bare.entries().find((entry) => entry.kind === "permission-answer"), Boolean)).outcome, { outcome: "cancelled" });
});

test("clause 40: stopping a session withdraws its waiting request and refuses it to the host", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: {}, hold: true });
  const id = await launchRun(s);
  await pending(s);
  const stopped = await apply(s.base, { action: "launch.stop", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(stopped.status, 200, stopped.text);
  await settled(async () => (await attention(s)).permissions.length, 0);
  assert.deepEqual((await attention(s)).permissions, []);
  const answered = await settled(() => s.entries().find((entry) => entry.kind === "permission-answer"), Boolean);
  assert.deepEqual(answered.outcome, { outcome: "selected", optionId: "no" });
});

test("clause 41: each decision is recorded in the initiative's history with its decision and action", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: { title: "Write probe.txt" } });
  const id = await launchRun(s);
  await decide(s, id, (await pending(s))[0].id, "refuse");
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const history = (await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE })).state.history ?? [];
  const entry = history.find((item) => item.action === "launch.permission");
  assert.ok(entry, "the decision is in the history");
  assert.match(JSON.stringify(entry), /refuse/);
  assert.match(JSON.stringify(entry), /Write probe\.txt/);
});
