// Generated from src/hooks/wait-for-gate-answers.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerText, changedText, HOOK_WAIT_MINUTES, waitForUserGates } from "../server/workflow/gate-wait.mjs";
import { NOTICE_FOLDER } from "../server/workflow/change-notices.mjs";
import { sessionHolder } from "../server/workflow/slice-claims.mjs";
import { takeWaitRequest } from "../server/workflow/gate-wait-requests.mjs";
const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
async function readHookInput(input) {
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
async function waitForGateAnswers({ input = process.stdin, directory, pollMs, settleMs } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  if (hookInput.hook_event_name && hookInput.hook_event_name !== "Stop") return null;
  const sessionId = typeof hookInput.session_id === "string" ? hookInput.session_id : null;
  if (!sessionId) return null;
  const request = await takeWaitRequest({ sessionId, ...directory ? { directory } : {} });
  if (!request) return null;
  const maxWaitMinutes = Math.min(Number(request.maxWaitMinutes) || HOOK_WAIT_MINUTES, HOOK_WAIT_MINUTES);
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: sessionId });
  const notices = { session, ...typeof request.waitId === "string" ? { waitId: request.waitId } : {}, ...directory ? { directory: path.join(path.dirname(directory), NOTICE_FOLDER) } : {} };
  let result;
  try {
    const source = typeof request.artifact === "string" ? { artifact: request.artifact, scope: request.scope, ...directory ? { deliveredDirectory: directory } : {} } : { initiative: request.initiative, notices, watchChanges: request.coordinates === true, ...Array.isArray(request.knownEntries) ? { knownEntries: request.knownEntries } : {} };
    result = await waitForUserGates({ projectRoot: request.projectRoot, ...source, gateIds: request.gateIds, maxWaitMinutes, ...pollMs ? { pollMs } : {}, ...settleMs === void 0 ? {} : { settleMs } });
  } catch {
    return null;
  }
  if (result.status === "changed") {
    const lines2 = [
      "The person changed the initiative while Prism's wait_for_user_gate call waited after your turn; this is its result.",
      changedText(result),
      "Act on each change at the point its effect names, then call wait_for_user_gate again for the gates still waiting."
    ];
    return { decision: "block", reason: lines2.join("\n") };
  }
  if (result.status !== "answered") return null;
  const lines = [
    "The user answered while Prism's wait_for_user_gate call waited after your turn; this is its result.",
    ...result.answered.map(answerText),
    ...result.waiting.length ? [`Still waiting on: ${result.waiting.join(", ")}.`] : [],
    typeof request.artifact === "string" ? "Act on each answer; an approval gate needs no resolve, since Prism recorded the answer in the artifact's status record." : "Act on each answer, then remove each answered gate with an update_coordination_state resolve operation for its id."
  ];
  return { decision: "block", reason: lines.join("\n") };
}
async function main() {
  try {
    const output = await waitForGateAnswers();
    if (output) process.stdout.write(`${JSON.stringify(output)}
`);
  } catch {
  }
}
const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
export {
  waitForGateAnswers
};
