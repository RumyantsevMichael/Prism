import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { askedGates, forgetAskedGates } from "../server/workflow/approval-deliveries.mjs";
import { gateWaitDirectory } from "../server/workflow/gate-wait-requests.mjs";
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

// The approval gates that this checkout asked and has not received the answer of, as this machine remembers them, each with its artifact:
// unanswered ones without an answer and answered ones with it. A gate that is gone, replaced by a later question or with its artifact, is forgotten.
// Another checkout, on this machine or another, sees the same records but asked none of these gates, so it is handed none of them.
async function approvalGates(projectRoot, environment) {
  const directory = gateWaitDirectory(environment);
  let ids;
  try {
    ids = await askedGates(projectRoot, { directory });
  } catch {
    return { items: [], receive: async () => {} };
  }
  if (!ids.size) return { items: [], receive: async () => {} };
  let items;
  try {
    const { approvalGatesWithIds } = await import("../server/workflow/store-artifacts.mjs");
    items = await approvalGatesWithIds(projectRoot, [...ids]);
  } catch {
    // An unreadable store forgets nothing, so the answers arrive once it can be read again.
    return { items: [], receive: async () => {} };
  }
  const found = new Set(items.map(({ gate }) => gate.id));
  const gone = [...ids].filter((id) => !found.has(id));
  const receive = (received) => forgetAskedGates(projectRoot, [...gone, ...received.map(({ gate }) => gate.id)], { directory }).catch(() => {});
  return { items, receive };
}

const scopeName = (scope) => scope?.label ?? scope?.kind ?? "workspace";
const approvalLine = ({ artifact, gate }) => `- Approval gate ${gate.id} (${artifact.path}, scope ${scopeName(artifact.scope)}, status ${gate.status}): "${gate.question}"`;
const approvalAnswer = (item) => `${approvalLine(item)} Answer: ${choiceText(item.gate)}.${item.gate.answer.note ? ` Note: ${item.gate.answer.note}${/[.!?]$/.test(item.gate.answer.note) ? "" : "."}` : ""}${item.gate.answer.choice === "approve" ? ` Prism recorded ${item.gate.status} and rewrote its status lines in the store.` : " Its recorded status stays as it was."}`;
const APPROVAL_ACT = "Act on each approval answer; an approval gate needs no resolve, since Prism recorded the answer in the artifact's status record, and get_artifact returns it as latestAnswer.";

const gateLine = ({ initiative, gate }) => `- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): "${gate.question}"`;

function bounded(lines) {
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARACTERS ? `${text.slice(0, MAX_CONTEXT_CHARACTERS - 120)}\n… More gates are recorded; read them with get_coordination_state.` : text;
}

// The answers whose whole line the bounded text kept, which are the ones the agent received.
const kept = (text, answers) => answers.filter((item) => text.includes(approvalAnswer(item)));

// A resumed session no longer waits on the gates it opened before, so it learns which are open and waits on them again.
// A session that starts or resumes in a checkout also learns the approval gates that checkout asked: the unanswered ones to wait on, and the answers it has not received.
async function startedGates(projectRoot, environment, resumed) {
  const gates = resumed ? await openGates(projectRoot) : [];
  const approvals = await approvalGates(projectRoot, environment);
  if (!gates.length && !approvals.items.length) {
    await approvals.receive([]);
    return null;
  }
  const waiting = gates.filter(({ gate }) => !gate.answer), answered = gates.filter(({ gate }) => gate.answer);
  const asked = approvals.items.filter(({ gate }) => !gate.answer), approved = approvals.items.filter(({ gate }) => gate.answer);
  const lines = [resumed ? "This session resumed while Prism user gates are open in this project, and nothing waits on them now." : "This session started while Prism approval gates that this checkout asked are open, and nothing waits on them now."];
  if (waiting.length) lines.push("For each unanswered gate this session asked, call wait_for_user_gate with its id once you have handled the user's message, so a browser answer reaches you without another message.", ...waiting.map(gateLine));
  if (asked.length) lines.push("This checkout asked these approval gates, which the user has not answered; call wait_for_user_gate with each id and the artifact's path as artifact once you have handled the user's message.", ...asked.map(approvalLine));
  if (answered.length) lines.push("The user already answered these gates in the review browser; act on each answer, then remove the gate with an update_coordination_state resolve operation for its id.", ...answered.map((item) => `${gateLine(item)} Answer: ${choiceText(item.gate)}${item.gate.answer.note ? `. Note: ${item.gate.answer.note}` : ""}.`));
  if (approved.length) lines.push("The user already answered these approval gates that this checkout asked, in the review browser.", ...approved.map(approvalAnswer), APPROVAL_ACT);
  const text = bounded(lines);
  await approvals.receive(kept(text, approved));
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

// Answers recorded in the review browser reach the agent with the user's next prompt, until the agent resolves each gate,
// and an approval answer reaches the checkout that asked its gate with the next prompt of any session there, once.
export async function deliverGateAnswers({ input = process.stdin, environment = process.env } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const event = hookInput.hook_event_name ?? "UserPromptSubmit";
  // A resumed session lost a wait, and a new one never had it; compaction keeps a running wait.
  const start = event === "SessionStart" && ["resume", "startup", "clear"].includes(hookInput.source);
  if (!start && event !== "UserPromptSubmit") return null;
  const directory = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!directory) return null;
  const projectRoot = await realpath(directory);
  if (start) return startedGates(projectRoot, environment, hookInput.source === "resume");
  const gates = await answeredGates(projectRoot);
  const approvals = await approvalGates(projectRoot, environment);
  const approved = approvals.items.filter(({ gate }) => gate.answer);
  if (!gates.length && !approved.length) {
    await approvals.receive([]);
    return null;
  }
  const lines = ["The user answered these Prism user gates in the review browser."];
  if (gates.length) {
    lines.push("Treat each answer as the user's reply to that question, act on it, then remove the gate with an update_coordination_state resolve operation for its id.");
    for (const item of gates) {
      lines.push(`${gateLine(item)} Answer: ${choiceText(item.gate)}${item.gate.answer.note ? `. Note: ${item.gate.answer.note}` : ""}.`);
    }
  }
  if (approved.length) lines.push("This checkout asked these approval gates.", ...approved.map(approvalAnswer), APPROVAL_ACT);
  const text = bounded(lines);
  await approvals.receive(kept(text, approved));
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
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
