import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
      if (gate && typeof gate === "object" && gate.answer) gates.push({ initiative, gate });
    }
  }
  return gates;
}

// Answers recorded in the review browser reach the agent with the user's next prompt, until the agent resolves each gate.
export async function deliverGateAnswers({ input = process.stdin, environment = process.env } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  if (hookInput.hook_event_name && hookInput.hook_event_name !== "UserPromptSubmit") return null;
  const directory = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!directory) return null;
  const projectRoot = await realpath(directory);
  const gates = await answeredGates(projectRoot);
  if (!gates.length) return null;
  const lines = [
    "The user answered these Prism user gates in the review browser.",
    "Treat each answer as the user's reply to that question, act on it, then remove the gate with an update_coordination_state resolve operation for its id."
  ];
  for (const { initiative, gate } of gates) {
    lines.push(`- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): "${gate.question}" Answer: ${choiceText(gate)}${gate.answer.note ? `. Note: ${gate.answer.note}` : ""}.`);
  }
  let additionalContext = lines.join("\n");
  if (additionalContext.length > MAX_CONTEXT_CHARACTERS) {
    additionalContext = `${additionalContext.slice(0, MAX_CONTEXT_CHARACTERS - 120)}\n… More answers are recorded; read them with get_coordination_state.`;
  }
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
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
