import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deliveredAnswers, gateWaitDirectory, markAnswersDelivered } from "../server/workflow/gate-wait-requests.mjs";
import { listInitiatives } from "../server/workflow/record-store.mjs";
import { readCoordinationState } from "../server/workflow/state.mjs";
import { readWorkflowConfig } from "../server/workflow/workflow-config.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_CHARACTERS = 3500;

async function readHookInput(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_HOOK_INPUT_BYTES) {
      throw new Error("The hook input is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function choiceText(gate) {
  const { choice } = gate.answer;
  if (choice === null) return "free answer";
  return gate.options?.find((option) => option.id === choice)?.label ?? choice;
}

export async function answeredGates(projectRoot) {
  return (await openGates(projectRoot)).filter(({ gate }) => gate.answer);
}

// Every gate still pending in the project's initiatives, answered or not.
export async function openGates(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  if (!config.exists) return [];
  let initiatives;
  try {
    initiatives = await listInitiatives(projectRoot);
  } catch {
    return [];
  }
  const gates = [];
  for (const initiative of initiatives) {
    let state;
    try {
      state = await readCoordinationState({ projectRoot, initiative });
    } catch {
      continue;
    }
    for (const gate of state.state?.pending ?? []) {
      if (gate && typeof gate === "object" && typeof gate.id === "string") gates.push({ initiative, gate });
    }
  }
  return gates;
}

// An approval answer older than this is no longer a reply to the user's next message, so a machine that first syncs a store is not handed every past approval.
const APPROVAL_ANSWER_DAYS = 7;

// The approval gates of the requirements and ADRs this checkout sees in its record store: each unanswered one, and the latest answer of each artifact
// that no later question replaced and that no agent of this machine has seen, from a wait or an earlier prompt.
async function approvalGates(projectRoot, environment, now = Date.now()) {
  const config = await readWorkflowConfig(projectRoot);
  if (!config.exists || !config.workspace?.store) return [];
  let gates;
  try {
    const { openApprovalGates } = await import("../server/workflow/store-artifacts.mjs");
    gates = await openApprovalGates(projectRoot);
  } catch {
    return [];
  }
  const directory = gateWaitDirectory(environment);
  const delivered = await deliveredAnswers({ directory });
  const recent = (gate) => now - Date.parse(gate.answer.answeredAt ?? "") <= APPROVAL_ANSWER_DAYS * 86400000;
  return gates.filter(({ gate }) => !gate.answer || (recent(gate) && !delivered.has(gate.id))).map((item) => ({ ...item, directory }));
}

const markDelivered = async (items) => {
  const answered = items.filter(({ gate }) => gate.answer);
  if (answered.length) await markAnswersDelivered(answered.map(({ gate }) => gate.id), { directory: answered[0].directory }).catch(() => {});
};

const scopeName = (scope) => scope?.label ?? scope?.kind ?? "workspace";
const approvalLine = ({ artifact, gate }) => `- Approval gate ${gate.id} (${artifact.path}, scope ${scopeName(artifact.scope)}, status ${gate.status}): "${gate.question}"`;
const approvalAnswer = (item) => `${approvalLine(item)} Answer: ${choiceText(item.gate)}.${item.gate.answer.note ? ` Note: ${item.gate.answer.note}${/[.!?]$/.test(item.gate.answer.note) ? "" : "."}` : ""}${item.gate.answer.choice === "approve" ? ` Prism recorded ${item.gate.status} and rewrote its status lines in the store.` : " Its recorded status stays as it was."}`;
const APPROVAL_ACT = "Act on each approval answer; an approval gate needs no resolve, since Prism recorded the answer in the artifact's status record, and get_artifact returns it as latestAnswer.";

const gateLine = ({ initiative, gate }) => `- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): "${gate.question}"`;

function bounded(lines) {
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARACTERS ? `${text.slice(0, MAX_CONTEXT_CHARACTERS - 120)}\n… More gates are recorded; read them with get_coordination_state.` : text;
}

// A resumed session no longer waits on the gates it opened before, so it learns which are open and waits on them again.
async function resumedGates(projectRoot, environment) {
  const gates = await openGates(projectRoot);
  const approvals = await approvalGates(projectRoot, environment);
  if (!gates.length && !approvals.length) return null;
  const waiting = gates.filter(({ gate }) => !gate.answer), answered = gates.filter(({ gate }) => gate.answer);
  const asked = approvals.filter(({ gate }) => !gate.answer), approved = approvals.filter(({ gate }) => gate.answer);
  const lines = ["This session resumed while Prism user gates are open in this project, and nothing waits on them now."];
  if (waiting.length) lines.push("For each unanswered gate this session asked, call wait_for_user_gate with its id once you have handled the user's message, so a browser answer reaches you without another message.", ...waiting.map(gateLine));
  if (asked.length) lines.push("For each unanswered approval gate this session asked, call wait_for_user_gate with its id and the artifact's path as artifact once you have handled the user's message.", ...asked.map(approvalLine));
  if (answered.length) lines.push("The user already answered these gates in the review browser; act on each answer, then remove the gate with an update_coordination_state resolve operation for its id.", ...answered.map((item) => `${gateLine(item)} Answer: ${choiceText(item.gate)}${item.gate.answer.note ? `. Note: ${item.gate.answer.note}` : ""}.`));
  if (approved.length) lines.push("The user already answered these approval gates in the review browser.", ...approved.map(approvalAnswer), APPROVAL_ACT);
  await markDelivered(approved);
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: bounded(lines) } };
}

// Answers recorded in the review browser reach the agent with the user's next prompt, until the agent resolves each gate.
export async function deliverGateAnswers({ input = process.stdin, environment = process.env } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const event = hookInput.hook_event_name ?? "UserPromptSubmit";
  // Only a resumed session lost a wait; a new session did not open the project's gates, and compaction keeps a running wait.
  if (event === "SessionStart" ? hookInput.source !== "resume" : event !== "UserPromptSubmit") return null;
  const directory = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!directory) return null;
  const projectRoot = await realpath(directory);
  if (event === "SessionStart") return resumedGates(projectRoot, environment);
  const gates = await answeredGates(projectRoot);
  const approved = (await approvalGates(projectRoot, environment)).filter(({ gate }) => gate.answer);
  if (!gates.length && !approved.length) return null;
  const lines = ["The user answered these Prism user gates in the review browser."];
  if (gates.length) {
    lines.push("Treat each answer as the user's reply to that question, act on it, then remove the gate with an update_coordination_state resolve operation for its id.");
    for (const item of gates) {
      lines.push(`${gateLine(item)} Answer: ${choiceText(item.gate)}${item.gate.answer.note ? `. Note: ${item.gate.answer.note}` : ""}.`);
    }
  }
  if (approved.length) lines.push(...approved.map(approvalAnswer), APPROVAL_ACT);
  await markDelivered(approved);
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: bounded(lines) } };
}

async function main() {
  try {
    const output = await deliverGateAnswers();
    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
