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

const shortened = (text: string) => (text.length <= MAX_QUESTION_CHARACTERS ? text : `${text.slice(0, MAX_QUESTION_CHARACTERS).trimEnd()}…`);

// The unanswered approval gates that this session asked in this checkout, each with its artifact; an unreadable store holds none, so the question goes ahead.
async function approvalGates(projectRoot: string, session: string, environment: NodeJS.ProcessEnv) {
  const ids = await sessionAskedGates(projectRoot, session, { directory: gateWaitDirectory(environment) }).catch(() => new Set());
  if (!ids.size) return [];
  try {
    const { approvalGatesWithIds } = await import("../server/workflow/store-artifacts.mjs");
    return (await approvalGatesWithIds(projectRoot, [...ids])).filter(({ gate }: { gate: any }) => !gate.answer);
  } catch {
    return [];
  }
}

// A host's own question tool blocks the turn until the person answers in the conversation, while a Prism gate waits for an answer in the review app.
// Neither answer reaches the other wait, so while the calling session has a gate that nobody answered, the hook refuses the host question and names the gates the review app holds.
// A session without such a gate, such as a setup or ideation interview, asks through the host as before; any failure lets the question through.
export async function keepQuestionsInGates({ input = process.stdin, environment = process.env, directory }: any = {}) {
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
    ...approvals.map(({ artifact, gate }: { artifact: any; gate: any }) => `- Approval gate ${gate.id} (${artifact.path}): "${shortened(gate.question)}"`)
  ];
  if (!lines.length) return null;
  const listed = lines.slice(0, MAX_LISTED_GATES);
  const reason = [
    "Prism refused this question because the review app already asks this session's open gates, and an answer to either one does not answer the other:",
    ...listed,
    ...(lines.length > listed.length ? [`… and ${lines.length - listed.length} more open gates.`] : []),
    "If this question is one of these gates, leave it to the review app and wait for its answer with wait_for_user_gate, unless a wait for it already runs.",
    "If it is a different question, ask it in plain text in your reply."
  ].join("\n");
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

async function main() {
  // A hook must answer within its host's time limit, so its record reads never start a store pull; the session's server keeps the store current.
  configureRecordSync({ pullOnRead: false });
  try {
    const output = await keepQuestionsInGates();
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
