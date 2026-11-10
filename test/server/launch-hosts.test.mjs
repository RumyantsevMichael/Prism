import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LINE_BYTES, hostArguments, hostEnvironment, streamReader } from "../../dist/server/session/launch-hosts.mjs";

// The stream readers of launched hosts: which lines count, and what a run reports from them.

const feed = (reader, lines) => {
  for (const line of lines) reader.push(Buffer.from(`${line}\n`));
  reader.end();
  return reader.facts;
};

test("a line that is no JSON object, or longer than 1 MiB, is ignored", () => {
  const long = JSON.stringify({ type: "turn.failed", error: { message: "x".repeat(MAX_LINE_BYTES) } });
  const facts = feed(streamReader("codex"), ["not json", "[1,2]", "null", long, JSON.stringify({ type: "thread.started", thread_id: "t-1" })]);
  assert.equal(facts.hostError, null);
  assert.equal(facts.hostSessionId, "t-1");
});

test("a line split across chunks is read whole, and the first thread names the session", () => {
  const reader = streamReader("codex");
  const line = JSON.stringify({ type: "thread.started", thread_id: "t-1" });
  reader.push(Buffer.from(line.slice(0, 10)));
  reader.push(Buffer.from(`${line.slice(10)}\n${JSON.stringify({ type: "thread.started", thread_id: "t-2" })}\n`));
  reader.end();
  assert.equal(reader.facts.hostSessionId, "t-1");
});

test("a Claude Code refusal without its tool result has a fixed reason, and a long reason is cut at 500 characters", () => {
  const facts = feed(streamReader("claude-code"), [
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "y".repeat(600) }] }] } }),
    JSON.stringify({ type: "result", is_error: false, permission_denials: [{ tool_name: "Bash", tool_use_id: "a" }, { tool_name: "Write", tool_use_id: "b" }] })
  ]);
  assert.deepEqual(facts.refusals, [{ tool: "Bash", reason: "y".repeat(500) }, { tool: "Write", reason: "Write was refused." }]);
});

test("a Codex declined item without a command names its type", () => {
  const facts = feed(streamReader("codex"), [JSON.stringify({ type: "item.completed", item: { type: "file_change", status: "declined" } })]);
  assert.deepEqual(facts.refusals, [{ tool: "file_change", reason: "Codex declined: file_change" }]);
});

test("the host environment drops the host session variables and names the launch", () => {
  const env = hostEnvironment({ PATH: "/bin", CLAUDECODE: "1", CODEX_THREAD_ID: "t", KEEP: "k" }, "launch-0123456789abcdef");
  assert.deepEqual(env, { PATH: "/bin", KEEP: "k", PRISM_LAUNCH: "launch-0123456789abcdef" });
  assert.deepEqual(hostArguments({ host: "codex", initiative: "a", hostSessionId: null, resume: false }).at(-1), "$prism:orchestrate a");
});
