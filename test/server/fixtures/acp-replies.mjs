// The fake ACP agent of acp-agents.mjs, made to send session updates before each prompt answer, for the headless-run-questions tests.
// A plan's `updates` lists the `update` objects of the `session/update` notifications that the agent sends, in order, directly
// before it answers each `session/prompt`, so a test gives a run agent message chunks and tool calls without any model.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acpFixture, apply, fakeEntry, INITIATIVE, launches, setSettings, TARGET } from "./acp-agents.mjs";
import { settled } from "./wait.mjs";

const ANSWER = "const answer = (id, result) => out({ jsonrpc: \"2.0\", id, result });";
const ANSWER_WITH_UPDATES = "const answer = (id, result) => { if (typeof result?.stopReason === \"string\") for (const update of plan.updates ?? []) out({ jsonrpc: \"2.0\", method: \"session/update\", params: { sessionId: \"fake-session-1\", update } }); out({ jsonrpc: \"2.0\", id, result }); };";

/** An agent message chunk of text, as ACP agents such as OpenCode send it. */
export const chunk = (text, messageId = "m1") => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
/** A tool call update of the run. */
export const toolCall = (toolCallId = "t1") => ({ sessionUpdate: "tool_call", toolCallId, title: "Read slice.md", kind: "read", status: "completed" });

/**
 * acpFixture with one declared agent `gemini` labelled `Gemini CLI` as the initiative's host, whose fake agent sends the plan's
 * `updates` before each prompt answer; launch() runs it as the review page does and answers the launch id.
 */
export async function geminiWithReplies(t, plan = {}) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  const source = await readFile(s.agent, "utf8");
  assert.ok(source.includes(ANSWER), "the fake ACP agent still answers through the function that this fixture extends");
  await writeFile(s.agent, source.replace(ANSWER, ANSWER_WITH_UPDATES));
  // The fixture's dialog stub is zenity, so on macOS an osascript stub on the test PATH confirms each launch dialog instead of a real one.
  const osascript = path.join(s.bin, "osascript");
  await writeFile(osascript, `#!${process.execPath}\nprocess.stdout.write("button returned:Launch, gave up:false\\n");\n`);
  await chmod(osascript, 0o755);
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  await setSettings(s.root, INITIATIVE, { host: "acp-gemini" });
  const launch = async () => {
    const result = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
    assert.equal(result.status, 200, result.text);
    return result.json.launch.id;
  };
  const view = async (id) => (await launches(s)).find((item) => item.id === id) ?? null;
  const ended = (id, runs = 1) => settled(() => view(id), (item) => item && item.runs === runs && !["running", "waiting"].includes(item.state));
  // The launched runs' log: the agent processes whose PRISM_LAUNCH is set, since a read of run options starts the agent without it.
  const sent = (method) => {
    const all = s.entries();
    const pids = new Set(all.filter((entry) => entry.kind === "start" && entry.env.PRISM_LAUNCH !== null).map((entry) => entry.pid));
    return all.filter((entry) => pids.has(entry.pid) && entry.kind === "input" && entry.message.method === method).map((entry) => entry.message);
  };
  return { ...s, launch, view, ended, sent };
}
