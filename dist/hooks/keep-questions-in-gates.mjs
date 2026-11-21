// Generated from src/hooks/keep-questions-in-gates.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sessionAskedGates } from "../server/workflow/approval-deliveries.mjs";
import { gateWaitDirectory } from "../server/workflow/gate-wait-requests.mjs";
import { configureRecordSync } from "../server/workflow/record-store-sync.mjs";
import { noticeDirectory } from "../server/workflow/change-notices.mjs";
import { sessionHolder } from "../server/workflow/slice-claims.mjs";
import { sessionGates } from "./deliver-gate-answers.mjs";
const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_LISTED_GATES = 5;
const MAX_QUESTION_CHARACTERS = 160;
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
const shortened = (text) => text.length <= MAX_QUESTION_CHARACTERS ? text : `${text.slice(0, MAX_QUESTION_CHARACTERS).trimEnd()}\u2026`;
async function approvalGates(projectRoot, session, environment) {
  const ids = await sessionAskedGates(projectRoot, session, { directory: gateWaitDirectory(environment) }).catch(() => /* @__PURE__ */ new Set());
  if (!ids.size) return [];
  try {
    const { approvalGatesWithIds } = await import("../server/workflow/store-artifacts.mjs");
    return (await approvalGatesWithIds(projectRoot, [...ids])).filter(({ gate }) => !gate.answer);
  } catch {
    return [];
  }
}
async function keepQuestionsInGates({ input = process.stdin, environment = process.env, directory } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  if (hookInput.hook_event_name && hookInput.hook_event_name !== "PreToolUse") return null;
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: hookInput.session_id });
  if (!session) return null;
  const folder = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!folder) return null;
  const projectRoot = await realpath(folder);
  const user = (await sessionGates(projectRoot, session, directory ?? noticeDirectory(environment))).filter(({ gate }) => !gate.answer);
  const approvals = await approvalGates(projectRoot, session, environment);
  const lines = [
    ...user.map(({ initiative, gate }) => `- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): "${shortened(gate.question)}"`),
    ...approvals.map(({ artifact, gate }) => `- Approval gate ${gate.id} (${artifact.path}): "${shortened(gate.question)}"`)
  ];
  if (!lines.length) return null;
  const listed = lines.slice(0, MAX_LISTED_GATES);
  const reason = [
    "Prism refused this question because the review app already asks this session's open gates, and an answer to either one does not answer the other:",
    ...listed,
    ...lines.length > listed.length ? [`\u2026 and ${lines.length - listed.length} more open gates.`] : [],
    "If this question is one of these gates, leave it to the review app and wait for its answer with wait_for_user_gate, unless a wait for it already runs.",
    "If it is a different question, ask it in plain text in your reply."
  ].join("\n");
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
async function main() {
  configureRecordSync({ pullOnRead: false });
  try {
    const output = await keepQuestionsInGates();
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
  keepQuestionsInGates
};
