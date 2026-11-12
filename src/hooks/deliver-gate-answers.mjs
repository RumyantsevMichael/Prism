import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listInitiatives } from "../server/workflow/record-store.mjs";
import { readCoordinationState } from "../server/workflow/state.mjs";
import { readWorkflowConfig } from "../server/workflow/workflow-config.mjs";
import { configureRecordSync } from "../server/workflow/record-store-sync.mjs";
import { askedGates, noticeDirectory } from "../server/workflow/change-notices.mjs";
import { sessionHolder } from "../server/workflow/slice-claims.mjs";

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

// The open gates that the session asked, which are the only ones whose answers are its own: another session's gates in the same project belong to that session's work.
export async function sessionGates(projectRoot, session, directory = noticeDirectory()) {
  if (!session) return [];
  const asked = new Map();
  const mine = [];
  for (const item of await openGates(projectRoot)) {
    if (!asked.has(item.initiative)) asked.set(item.initiative, new Set(await askedGates({ projectRoot, initiative: item.initiative, session, directory }).catch(() => [])));
    if (asked.get(item.initiative).has(item.gate.id)) mine.push(item);
  }
  return mine;
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

const gateLine = ({ initiative, gate }) => `- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): "${gate.question}"`;

function bounded(lines) {
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARACTERS ? `${text.slice(0, MAX_CONTEXT_CHARACTERS - 120)}\n… More gates are recorded; read them with get_coordination_state.` : text;
}

// A resumed session no longer waits on the gates it opened before, so it learns which are open and waits on them again.
async function resumedGates(gates) {
  if (!gates.length) return null;
  const waiting = gates.filter(({ gate }) => !gate.answer), answered = gates.filter(({ gate }) => gate.answer);
  const lines = ["This session resumed while Prism user gates that it asked are open, and nothing waits on them now."];
  if (waiting.length) lines.push("For these unanswered gates, call wait_for_user_gate with their ids once you have handled the user's message, so a browser answer reaches you without another message.", ...waiting.map(gateLine));
  if (answered.length) lines.push("The user already answered these gates in the review browser; act on each answer, then remove the gate with an update_coordination_state resolve operation for its id.", ...answered.map((item) => `${gateLine(item)} Answer: ${choiceText(item.gate)}${item.gate.answer.note ? `. Note: ${item.gate.answer.note}` : ""}.`));
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: bounded(lines) } };
}

// Answers recorded in the review browser reach the agent with the user's next prompt, until the agent resolves each gate.
export async function deliverGateAnswers({ input = process.stdin, environment = process.env, directory } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const event = hookInput.hook_event_name ?? "UserPromptSubmit";
  // Only a resumed session lost a wait; a new session did not open the project's gates, and compaction keeps a running wait.
  if (event === "SessionStart" ? hookInput.source !== "resume" : event !== "UserPromptSubmit") return null;
  const folder = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!folder) return null;
  const projectRoot = await realpath(folder);
  // A host names its session in the hook input, as its tool calls name it to Prism's server, so both find the same record of the gates the session asked.
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: hookInput.session_id });
  const own = await sessionGates(projectRoot, session, directory ?? noticeDirectory(environment));
  if (event === "SessionStart") return resumedGates(own);
  const gates = own.filter(({ gate }) => gate.answer);
  if (!gates.length) return null;
  const lines = [
    "The user answered these Prism user gates in the review browser.",
    "Treat each answer as the user's reply to that question, act on it, then remove the gate with an update_coordination_state resolve operation for its id."
  ];
  for (const item of gates) {
    lines.push(`${gateLine(item)} Answer: ${choiceText(item.gate)}${item.gate.answer.note ? `. Note: ${item.gate.answer.note}` : ""}.`);
  }
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: bounded(lines) } };
}

async function main() {
  // A hook must answer within its host's time limit, so its record reads never start a store pull; the session's server keeps the store current.
  configureRecordSync({ pullOnRead: false });
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
