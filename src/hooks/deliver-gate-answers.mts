import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { askedGates, forgetAskedGates } from "../server/workflow/approval-deliveries.mjs";
import { gateWaitDirectory } from "../server/workflow/gate-wait-requests.mjs";
import { listInitiatives } from "../server/workflow/record-store.mjs";
import { readCoordinationState } from "../server/workflow/state.mjs";
import { readWorkflowConfig } from "../server/workflow/workflow-config.mjs";
import { configureRecordSync } from "../server/workflow/record-store-sync.mjs";
import { askedGates as sessionAskedGates, noticeDirectory } from "../server/workflow/change-notices.mjs";
import { sessionHolder } from "../server/workflow/slice-claims.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_CHARACTERS = 3500;

async function readHookInput(input: any) {
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

function choiceText(gate: any) {
  const { choice } = gate.answer;
  if (choice === null) return "free answer";
  return gate.options?.find((option: any) => option.id === choice)?.label ?? choice;
}

// The open gates that the session asked, which are the only ones whose answers are its own: another session's gates in the same project belong to that session's work.
export async function sessionGates(projectRoot: string, session: any, directory = noticeDirectory()) {
  if (!session) return [];
  const asked = new Map();
  const mine = [];
  for (const item of await openGates(projectRoot)) {
    if (!asked.has(item.initiative)) asked.set(item.initiative, new Set(await sessionAskedGates({ projectRoot, initiative: item.initiative, session, directory }).catch(() => [])));
    if (asked.get(item.initiative).has(item.gate.id)) mine.push(item);
  }
  return mine;
}

// Every gate still pending in the project's initiatives, answered or not.
export async function openGates(projectRoot: string) {
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
async function approvalGates(projectRoot: string, environment: NodeJS.ProcessEnv) {
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
  const found = new Set(items.map(({ gate }: { gate: any }) => gate.id));
  const gone = [...ids].filter((id) => !found.has(id));
  const receive = (received: any) => forgetAskedGates(projectRoot, [...gone, ...received.map(({ gate }: { gate: any }) => gate.id)], { directory }).catch(() => {});
  return { items, receive };
}

const scopeName = (scope: any) => scope?.label ?? scope?.kind ?? "workspace";
const noteText = (note: any) => (note ? ` Note: ${note}${/[.!?]$/.test(note) ? "" : "."}` : "");
// A gate line takes the question text to show, so that the bound can shorten the question and keep the rest of the line whole.
const approvalLine = ({ artifact, gate }: { artifact: any; gate: any }, question = `"${gate.question}"`) => `- Approval gate ${gate.id} (${artifact.path}, scope ${scopeName(artifact.scope)}, status ${gate.status}): ${question}`;
const approvalAnswer = (item: any, question: any) => `${approvalLine(item, question)} Answer: ${choiceText(item.gate)}.${noteText(item.gate.answer.note)}${item.gate.answer.choice === "approve" ? ` Prism recorded ${item.gate.status} and rewrote its status lines in the store.` : " Its recorded status stays as it was."}`;
const APPROVAL_ACT = "Act on each approval answer; an approval gate needs no resolve, since Prism recorded the answer in the artifact's status record, and get_artifact returns it as latestAnswer.";

const gateLine = ({ initiative, gate }: { initiative: string; gate: any }, question = `"${gate.question}"`) => `- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): ${question}`;
const gateAnswer = (item: any, question: any) => `${gateLine(item, question)} Answer: ${choiceText(item.gate)}.${noteText(item.gate.answer.note)}`;

// The context is a heading and sections, each an instruction, its gates, and an optional closing line.
// A gate entry renders its line with the question text that the bound allows.
const userSection = (instruction: any, items: any, line: string) => ({ instruction, gates: items.map((item: any) => ({ item, line, read: "get_coordination_state" })) });
const approvalSection = (instruction: any, items: any, line: any, closing?: any) => ({ instruction, closing, gates: items.map((item: any) => ({ item, line, read: `get_artifact for ${item.artifact.path}` })) });

const MIN_QUESTION_CHARACTERS = 80;
const MORE_GATES = "… More gates are open; read them with get_coordination_state, and the approval gates with get_artifact.";

const question = ({ item, read }: { item: any; read: any }, limit: number) => {
  const text = item.gate.question;
  if (text.length <= limit) return `"${text}"`;
  return `"${text.slice(0, limit).trimEnd()}…" (question shortened; read the whole gate with ${read})`;
};

function render(heading: string, sections: any, limit: number, more: any) {
  const lines = [heading];
  for (const section of sections) {
    lines.push(section.instruction, ...section.gates.map((gate: any) => gate.line(gate.item, question(gate, limit))));
    if (section.closing) lines.push(section.closing);
  }
  if (more) lines.push(MORE_GATES);
  return lines.join("\n");
}

// The context stays within the bound by shortening question text only, so every gate line it lists keeps its id and its whole answer.
// When even short questions do not fit, the last gates are left out, with their section once it has none left, and a closing line says more are open.
// The first gate always stays, so a gate whose answer alone fills the bound still reaches the agent.
function bounded(heading: string, sections: any) {
  let shown = sections.filter((section: any) => section.gates.length);
  const count = () => shown.reduce((total: any, section: any) => total + section.gates.length, 0);
  const longest = Math.max(0, ...shown.flatMap((section: any) => section.gates.map((gate: any) => gate.item.gate.question.length)));
  const fits = (limit: number, more: any) => render(heading, shown, limit, more).length <= MAX_CONTEXT_CHARACTERS;
  const shortest = Math.min(longest, MIN_QUESTION_CHARACTERS);
  let more = false;
  while (!fits(shortest, more) && count() > 1) {
    const last = shown[shown.length - 1];
    const gates = last.gates.slice(0, -1);
    shown = gates.length ? [...shown.slice(0, -1), { ...last, gates }] : shown.slice(0, -1);
    more = true;
  }
  let low = shortest, high = longest;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle, more)) low = middle;
    else high = middle - 1;
  }
  return { text: render(heading, shown, low, more), shown: shown.flatMap((section: any) => section.gates.map((gate: any) => gate.item)) };
}

// A resumed session no longer waits on the gates it asked before, so it learns which of them are open and waits on them again.
// A session that starts or resumes in a checkout also learns the approval gates that checkout asked: the unanswered ones to wait on, and the answers it has not received.
async function startedGates(projectRoot: string, environment: NodeJS.ProcessEnv, own: any, resumed: any) {
  const gates = resumed ? own : [];
  const approvals = await approvalGates(projectRoot, environment);
  if (!gates.length && !approvals.items.length) {
    await approvals.receive([]);
    return null;
  }
  const waiting = gates.filter(({ gate }: { gate: any }) => !gate.answer), answered = gates.filter(({ gate }: { gate: any }) => gate.answer);
  const asked = approvals.items.filter(({ gate }: { gate: any }) => !gate.answer), approved = approvals.items.filter(({ gate }: { gate: any }) => gate.answer);
  const heading = gates.length ? "This session resumed while Prism user gates that it asked are open, and nothing waits on them now." : "This session started while Prism approval gates that this checkout asked are open, and nothing waits on them now.";
  const { text, shown } = bounded(heading, [
    userSection("For these unanswered gates, call wait_for_user_gate with their ids once you have handled the user's message, so a browser answer reaches you without another message.", waiting, (gateLine as any)),
    approvalSection("This checkout asked these approval gates, which the user has not answered; call wait_for_user_gate with each id and the artifact's path as artifact once you have handled the user's message.", asked, approvalLine),
    userSection("The user already answered these gates in the review browser; act on each answer, then remove the gate with an update_coordination_state resolve operation for its id.", answered, (gateAnswer as any)),
    approvalSection("The user already answered these approval gates that this checkout asked, in the review browser.", approved, approvalAnswer, APPROVAL_ACT)
  ]);
  await approvals.receive(approved.filter((item: any) => shown.includes(item)));
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

// Answers recorded in the review browser reach the session that asked each gate with its next prompt, until the agent resolves the gate,
// and an approval answer reaches the checkout that asked its gate with the next prompt of any session there, once.
export async function deliverGateAnswers({ input = process.stdin, environment = process.env, directory }: any = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const event = hookInput.hook_event_name ?? "UserPromptSubmit";
  // A resumed session lost a wait, and a new one never had it; compaction keeps a running wait.
  const start = event === "SessionStart" && ["resume", "startup", "clear"].includes(hookInput.source);
  if (!start && event !== "UserPromptSubmit") return null;
  const folder = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!folder) return null;
  const projectRoot = await realpath(folder);
  // A host names its session in the hook input, as its tool calls name it to Prism's server, so both find the same record of the gates the session asked.
  // A new session asked no user gate yet, so only a resumed one or a prompt reads that record.
  const resumed = start && hookInput.source === "resume";
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: hookInput.session_id });
  const own = !start || resumed ? await sessionGates(projectRoot, session, directory ?? noticeDirectory(environment)) : [];
  if (start) return startedGates(projectRoot, environment, own, resumed);
  const gates = own.filter(({ gate }) => gate.answer);
  const approvals = await approvalGates(projectRoot, environment);
  const approved = approvals.items.filter(({ gate }: { gate: any }) => gate.answer);
  if (!gates.length && !approved.length) {
    await approvals.receive([]);
    return null;
  }
  const { text, shown } = bounded("The user answered these Prism user gates in the review browser.", [
    userSection("Treat each answer as the user's reply to that question, act on it, then remove the gate with an update_coordination_state resolve operation for its id.", gates, (gateAnswer as any)),
    approvalSection("This checkout asked these approval gates.", approved, approvalAnswer, APPROVAL_ACT)
  ]);
  await approvals.receive(approved.filter((item: any) => shown.includes(item)));
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
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
