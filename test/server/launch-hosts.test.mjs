import assert from "node:assert/strict";
import test from "node:test";
import { HOST_REQUEST_REFUSAL, KEPT_EARLY_COMPLETIONS, MAX_LINE_BYTES, TOOL_NAME_MAX, TRACKED_TASKS, hostArguments, hostConversation, hostEnvironment } from "../../dist/server/session/launch-hosts.mjs";

// The conversations of launched hosts over their standard input and output: which lines count, what Prism writes,
// when it closes the host's input, and what a run reports.

const UUID = "0f6b2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21";

/** A conversation with the messages it wrote and whether it closed the input. */
function talk(host, options = {}) {
  const sent = [];
  const state = { closed: 0 };
  const conversation = hostConversation(host, { initiative: "demo", checkout: "/work/demo", hostSessionId: host === "claude-code" ? UUID : null, ...options, send: (message) => sent.push(message), closeInput: () => { state.closed += 1; } });
  conversation.start();
  const feed = (...lines) => {
    for (const line of lines) conversation.push(Buffer.from(`${typeof line === "string" ? line : JSON.stringify(line)}\n`));
  };
  return { conversation, sent, state, feed, facts: conversation.facts };
}

const answer = (id, result) => ({ jsonrpc: "2.0", id, result });

// Drives a Codex conversation through initialize and the thread start, answering the thread with this id.
function codexThrough(threadId, options = {}) {
  const run = talk("codex", options);
  run.feed(answer(1, { userAgent: "codex/0" }), answer(2, { thread: { id: threadId } }));
  return run;
}

test("the host arguments are Claude Code's fixed flags with its session id, and Codex's app server alone", () => {
  assert.deepEqual(hostArguments({ host: "claude-code", hostSessionId: UUID, resume: false }), ["-p", "--verbose", "--session-id", UUID, "--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "none"]);
  assert.equal(hostArguments({ host: "claude-code", hostSessionId: UUID, resume: true })[2], "--resume");
  assert.deepEqual(hostArguments({ host: "codex", hostSessionId: "t-1", resume: true }), ["app-server"]);
  assert.throws(() => hostArguments({ host: "claude-code", hostSessionId: "--dangerously-skip-permissions", resume: true }));
});

test("the host environment drops the host session variables and names the launch", () => {
  const env = hostEnvironment({ PATH: "/bin", CLAUDECODE: "1", CODEX_THREAD_ID: "t", KEEP: "k" }, "launch-0123456789abcdef");
  assert.deepEqual(env, { PATH: "/bin", KEEP: "k", PRISM_LAUNCH: "launch-0123456789abcdef" });
});

test("a line that is no JSON object, or longer than 1 MiB, is ignored", () => {
  const long = JSON.stringify(answer(1, { pad: "x".repeat(MAX_LINE_BYTES) }));
  const { sent, feed } = talk("codex");
  feed("not json", "[1,2]", "null", long);
  assert.deepEqual(sent.map((message) => message.method), ["initialize"], "the oversized answer was not read");
  feed(answer(1, {}));
  assert.deepEqual(sent.map((message) => message.method), ["initialize", "initialized", "thread/start"]);
});

test("a line split across chunks is read whole, and the thread/start answer names the session", () => {
  const named = [];
  const { conversation, sent, facts } = talk("codex", { onSessionId: (id) => named.push(id) });
  conversation.push(Buffer.from(`${JSON.stringify(answer(1, {}))}\n`));
  const line = JSON.stringify(answer(2, { thread: { id: "t-1" } }));
  conversation.push(Buffer.from(line.slice(0, 10)));
  conversation.push(Buffer.from(`${line.slice(10)}\n`));
  assert.equal(facts.hostSessionId, "t-1");
  assert.deepEqual(named, ["t-1"]);
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "t-1", input: [{ type: "text", text: "$prism:orchestrate demo" }] } });
});

test("a Claude Code run gets its prompt, keeps its input open while a reported background task runs, and closes it at the next result", () => {
  const { sent, state, feed } = talk("claude-code");
  assert.deepEqual(sent, [{ type: "user", message: { role: "user", content: "/prism:orchestrate demo" } }]);
  feed({ type: "system", subtype: "task_started", task_id: "a" }, { type: "result", is_error: false, permission_denials: [] });
  assert.equal(state.closed, 0, "the input stays open while the task runs");
  feed({ type: "system", subtype: "task_notification", task_id: "a" });
  assert.equal(state.closed, 0, "only a result event closes the input");
  feed({ type: "result", is_error: false, permission_denials: [] }, { type: "result", is_error: false });
  assert.equal(state.closed, 1, "the input closes once");
});

test("a Claude Code refusal without its tool result has a fixed reason, a long reason is cut at 500 characters, and the last result decides", () => {
  const { facts, feed } = talk("claude-code");
  feed(
    { type: "system", subtype: "task_started", task_id: "a" },
    { type: "result", is_error: true, result: "earlier", permission_denials: [{ tool_name: "Edit", tool_use_id: "z" }] },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "y".repeat(600) }] }] } },
    { type: "result", is_error: false, permission_denials: [{ tool_name: "Bash", tool_use_id: "a" }, { tool_name: "Write", tool_use_id: "b" }] }
  );
  assert.deepEqual(facts.refusals, [{ tool: "Bash", reason: "y".repeat(500) }, { tool: "Write", reason: "Write was refused." }]);
  assert.equal(facts.hostError, null);
});

test("a Codex declined item without a command names its type", () => {
  const { facts, feed } = codexThrough("t-1");
  feed({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "fileChange", status: "declined" } } });
  assert.deepEqual(facts.refusals, [{ tool: "fileChange", reason: "Codex declined: fileChange" }]);
});

test("a Claude Code run keeps only the cut text of its 100 most recent error tool results, never a successful one", () => {
  const { facts, feed } = talk("claude-code");
  const results = Array.from({ length: 101 }, (_, index) => ({ type: "tool_result", tool_use_id: `e${index}`, is_error: true, content: `${index}:${"r".repeat(600)}` }));
  feed(
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ok", content: "allowed output" }] } },
    { type: "user", message: { content: results } },
    { type: "result", is_error: false, permission_denials: [{ tool_name: "Bash", tool_use_id: "e0" }, { tool_name: "Edit", tool_use_id: "e1" }, { tool_name: "Read", tool_use_id: "ok" }] }
  );
  assert.deepEqual(facts.refusals, [
    { tool: "Bash", reason: "Bash was refused." },
    { tool: "Edit", reason: `1:${"r".repeat(498)}` },
    { tool: "Read", reason: "Read was refused." }
  ]);
});

test("a run records its first 20 refusals with the number of all of them, for both hosts", () => {
  const claude = talk("claude-code");
  claude.feed({ type: "result", is_error: false, permission_denials: Array.from({ length: 25 }, (_, index) => ({ tool_name: `T${index}`, tool_use_id: `u${index}` })) });
  assert.equal(claude.facts.refusalCount, 25);
  assert.deepEqual(claude.facts.refusals.map((refusal) => refusal.tool), Array.from({ length: 20 }, (_, index) => `T${index}`));
  const codex = codexThrough("t-1");
  for (let index = 0; index < 22; index += 1) codex.feed({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "commandExecution", status: "declined", command: `c${index} ${"x".repeat(600)}` } } });
  assert.equal(codex.facts.refusalCount, 22);
  assert.equal(codex.facts.refusals.length, 20);
  assert.equal(codex.facts.refusals[0].reason, `Codex declined: c0 ${"x".repeat(500 - "Codex declined: c0 ".length)}`);
});

test("a Claude Code error result names its errors without a result text, and a failed turn without a message has a fixed text, cut at 500 characters", () => {
  const joined = talk("claude-code");
  joined.feed({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["first", 7, "second"], permission_denials: [] });
  assert.equal(joined.facts.hostError, "first; second");
  const preferred = talk("claude-code");
  preferred.feed({ type: "result", is_error: true, result: "the result", errors: ["ignored"] });
  assert.equal(preferred.facts.hostError, "the result");
  const empty = talk("claude-code");
  empty.feed({ type: "result", is_error: true, result: "", errors: [] });
  assert.equal(empty.facts.hostError, "The turn failed without a message.");
  const long = talk("claude-code");
  long.feed({ type: "result", is_error: true, errors: ["e".repeat(900)] });
  assert.equal(long.facts.hostError, "e".repeat(500));
  const codex = codexThrough("t-1");
  codex.feed(answer(3, { turn: { id: "turn-1" } }), { jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "failed", error: null } } });
  assert.equal(codex.facts.hostError, "The turn failed without a message.");
  const answered = talk("codex");
  answered.feed({ jsonrpc: "2.0", id: 1, error: { code: -32600 } });
  assert.equal(answered.facts.hostError, "The turn failed without a message.");
});

test("Codex requests are answered with Prism's error, and only the run's own turn completing closes the input", () => {
  const { sent, state, facts, feed } = codexThrough("t-1");
  feed(answer(3, { turn: { id: "turn-1" } }));
  assert.equal(facts.turnId, "turn-1");
  feed({ jsonrpc: "2.0", id: "ask-1", method: "item/tool/requestUserInput", params: {} });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: "ask-1", error: HOST_REQUEST_REFUSAL });
  feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-0", status: "failed", error: { message: "other" } } } });
  assert.equal(state.closed, 0);
  assert.equal(facts.hostError, null);
  feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "failed", error: { message: "The model stream ended." } } } });
  assert.equal(state.closed, 1);
  assert.equal(facts.hostError, "The model stream ended.");
  const before = sent.length;
  feed({ jsonrpc: "2.0", id: 9, method: "item/commandExecution/requestApproval", params: {} });
  assert.equal(sent.length, before, "nothing is written once the input is closed");
});

test("a Codex turn that completes before the turn/start answer still closes the input once the answer names it", () => {
  const { state, feed } = codexThrough("t-1");
  feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  assert.equal(state.closed, 0);
  feed(answer(3, { turn: { id: "turn-1" } }));
  assert.equal(state.closed, 1);
});

test("a Codex error answer to one of Prism's requests is a host error and closes the input", () => {
  const { sent, state, facts, feed } = talk("codex");
  feed(answer(1, {}), { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "The thread could not start." } });
  assert.equal(facts.hostError, "The thread could not start.");
  assert.equal(state.closed, 1);
  assert.deepEqual(sent.map((message) => message.method), ["initialize", "initialized", "thread/start"]);
});

test("a Codex resume continues the kept thread with the fixed policy", () => {
  const { sent, feed } = talk("codex", { hostSessionId: "t-9", resume: true });
  feed(answer(1, {}), answer(2, { thread: { id: "t-9" } }));
  assert.deepEqual(sent.find((message) => message.method === "thread/resume").params, { threadId: "t-9", cwd: "/work/demo", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
  assert.equal(sent.at(-1).params.threadId, "t-9");
});

test("a refusal's tool name is cut at 100 characters, for both hosts, and so is its fixed reason", () => {
  const long = "z".repeat(300 * 1024);
  const claude = talk("claude-code");
  claude.feed({ type: "result", permission_denials: [{ tool_name: long, tool_use_id: "u" }] });
  assert.deepEqual(claude.facts.refusals, [{ tool: "z".repeat(TOOL_NAME_MAX), reason: `${"z".repeat(TOOL_NAME_MAX)} was refused.` }]);
  const codex = codexThrough("t-1");
  codex.feed({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: long, status: "declined" } } });
  assert.deepEqual(codex.facts.refusals, [{ tool: "z".repeat(TOOL_NAME_MAX), reason: `Codex declined: ${"z".repeat(TOOL_NAME_MAX)}` }]);
});

test("a Codex run keeps only its most recent completions before the turn/start answer, with cut error text", () => {
  const early = codexThrough("t-1");
  early.feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "failed", error: { message: "x".repeat(2000) } } } });
  for (let index = 0; index < KEPT_EARLY_COMPLETIONS - 1; index += 1) early.feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: `other-${index}`, status: "completed" } } });
  early.feed(answer(3, { turn: { id: "turn-1" } }));
  assert.equal(early.state.closed, 1, "the run's own completion is still among the kept ones");
  assert.equal(early.facts.hostError, "x".repeat(500));
  const late = codexThrough("t-1");
  late.feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  for (let index = 0; index < KEPT_EARLY_COMPLETIONS; index += 1) late.feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: `other-${index}`, status: "completed" } } });
  late.feed(answer(3, { turn: { id: "turn-1" } }));
  assert.equal(late.state.closed, 0, "a completion pushed out by newer ones is no longer held");
  late.feed({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  assert.equal(late.state.closed, 1);
});

test("a Claude Code run past its tracked background tasks only counts further starts, and closes its input once all of them ended", () => {
  const { state, feed } = talk("claude-code");
  const result = { type: "result", is_error: false, permission_denials: [] };
  for (let index = 0; index < TRACKED_TASKS + 2; index += 1) feed({ type: "system", subtype: "task_started", task_id: `task-${index}` });
  feed({ type: "system", subtype: "task_started", task_id: "task-0" });
  for (let index = 0; index < TRACKED_TASKS + 1; index += 1) feed({ type: "system", subtype: "task_notification", task_id: `task-${index}` });
  feed(result);
  assert.equal(state.closed, 0, "one started task has not ended");
  feed({ type: "system", subtype: "task_notification", task_id: `task-${TRACKED_TASKS + 1}` }, result);
  assert.equal(state.closed, 1);
});

// Kept host text must not hold the whole line it came from alive: measured in a child with the collector exposed.
test("kept refusal text and host ids keep no more memory than their cut length", async () => {
  const { execFileSync } = await import("node:child_process");
  const module = new URL("../../dist/server/session/launch-hosts.mjs", import.meta.url).href;
  const script = `
    const { hostConversation } = await import(${JSON.stringify(module)});
    const measure = () => { globalThis.gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
    const big = "r".repeat(1000 * 1000);
    const line = (message) => Buffer.from(JSON.stringify(message) + String.fromCharCode(10));
    const results = hostConversation("claude-code", { initiative: "x", checkout: "/tmp", hostSessionId: ${JSON.stringify(UUID)}, send() {}, closeInput() {} });
    const ids = hostConversation("claude-code", { initiative: "x", checkout: "/tmp", hostSessionId: ${JSON.stringify(UUID)}, send() {}, closeInput() {} });
    const codex = hostConversation("codex", { initiative: "x", checkout: "/tmp", send() {}, closeInput() {} });
    const grown = [];
    let before = measure();
    for (let index = 0; index < 40; index += 1) results.push(line({ type: "user", message: { content: [{ type: "tool_result", is_error: true, tool_use_id: "u" + index, content: index + big }] } }));
    grown.push(measure() - before);
    before = measure();
    for (let index = 0; index < 40; index += 1) ids.push(line({ type: "user", message: { content: [{ type: "tool_result", is_error: true, tool_use_id: index + big, content: "no" }] } }));
    grown.push(measure() - before);
    before = measure();
    const half = big.slice(0, 400 * 1000);
    for (let index = 0; index < 8; index += 1) codex.push(line({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: index + half, status: "failed", error: { message: index + half } } } }));
    codex.push(line({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "small", status: "completed" } } }));
    grown.push(measure() - before);
    process.stdout.write(JSON.stringify(grown));
  `;
  const grown = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8" }));
  for (const bytes of grown) assert.ok(bytes < 7 * 1024 * 1024, `a conversation retained ${Math.round(bytes / 1048576)} MiB of host text`);
});
