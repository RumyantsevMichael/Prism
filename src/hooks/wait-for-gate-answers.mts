import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerText, changedText, HOOK_WAIT_MINUTES, waitForUserGates } from "../server/workflow/gate-wait.mjs";
import { NOTICE_FOLDER } from "../server/workflow/change-notices.mjs";
import { sessionHolder } from "../server/workflow/slice-claims.mjs";
import { takeWaitRequest } from "../server/workflow/gate-wait-requests.mjs";
import { MAIN_AGENT, threadAgent } from "../server/workflow/call-agent.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;

async function readHookInput(input: any) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_HOOK_INPUT_BYTES) throw new Error("The hook input is too large.");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A host that cannot wait during a tool call, such as Codex, gets the wait here: wait_for_user_gate recorded it for this session,
// and blocking the stop with the answers continues the turn as if the tool call had returned them.
// Codex runs Stop when the root agent's turn ends and SubagentStop, naming the sub-agent's thread as agent_id, when a sub-agent's does, so each continues only its own agent's wait.
// Without a recorded wait, as always under Claude Code, the hook returns at once and lets the turn stop.
export async function waitForGateAnswers({ input = process.stdin, directory, pollMs, settleMs }: any = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const subagent = hookInput.hook_event_name === "SubagentStop";
  if (hookInput.hook_event_name && hookInput.hook_event_name !== "Stop" && !subagent) return null;
  const sessionId = typeof hookInput.session_id === "string" ? hookInput.session_id : null;
  const agentId = typeof hookInput.agent_id === "string" && hookInput.agent_id.trim() ? hookInput.agent_id.trim() : null;
  if (!sessionId || (subagent && !agentId)) return null;
  const request = await takeWaitRequest({ sessionId, agent: subagent ? threadAgent(agentId as string) : MAIN_AGENT, ...(directory ? { directory } : {}) });
  if (!request) return null;
  const maxWaitMinutes = Math.min(Number(request.maxWaitMinutes) || HOOK_WAIT_MINUTES, HOOK_WAIT_MINUTES);
  // A wait its session's coordinator asked ends on the person's changes that no other result of the session showed; it goes on holding the gates that the asking call held, under the same wait id.
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: sessionId });
  const notices = { session, ...(typeof request.waitId === "string" ? { waitId: request.waitId } : {}), ...(directory ? { directory: path.join(path.dirname(directory), NOTICE_FOLDER) } : {}) };
  let result;
  try {
    // An artifact wait reads the artifact's approval gates and takes no notices, which an initiative records.
    const source = typeof request.artifact === "string" ? { artifact: request.artifact, scope: request.scope, ...(directory ? { deliveredDirectory: directory } : {}) } : { initiative: request.initiative, notices, watchChanges: request.coordinates === true, ...(Array.isArray(request.knownEntries) ? { knownEntries: request.knownEntries } : {}) };
    result = await waitForUserGates({ projectRoot: request.projectRoot, ...source, gateIds: request.gateIds, maxWaitMinutes, ...(pollMs ? { pollMs } : {}), ...(settleMs === undefined ? {} : { settleMs }) });
  } catch {
    return null;
  }
  if (result.status === "changed") {
    const lines = [
      "The person changed the initiative while Prism's wait_for_user_gate call waited after your turn; this is its result.",
      changedText(result),
      "Act on each change at the point its effect names, then call wait_for_user_gate again for the gates still waiting."
    ];
    return { decision: "block", reason: lines.join("\n") };
  }
  if (result.status !== "answered") return null;
  const lines = [
    "The user answered while Prism's wait_for_user_gate call waited after your turn; this is its result.",
    ...result.answered.map(answerText),
    ...(result.waiting.length ? [`Still waiting on: ${result.waiting.join(", ")}.`] : []),
    typeof request.artifact === "string"
      ? "Act on each answer; an approval gate needs no resolve, since Prism recorded the answer in the artifact's status record."
      : "Act on each answer, then remove each answered gate with an update_coordination_state resolve operation for its id."
  ];
  return { decision: "block", reason: lines.join("\n") };
}

async function main() {
  try {
    const output = await waitForGateAnswers();
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
