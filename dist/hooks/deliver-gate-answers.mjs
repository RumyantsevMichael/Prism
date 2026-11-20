// Generated from src/hooks/deliver-gate-answers.mts by scripts/native-build/compile.mjs.
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
async function sessionGates(projectRoot, session, directory = noticeDirectory()) {
  if (!session) return [];
  const asked = /* @__PURE__ */ new Map();
  const mine = [];
  for (const item of await openGates(projectRoot)) {
    if (!asked.has(item.initiative)) asked.set(item.initiative, new Set(await sessionAskedGates({ projectRoot, initiative: item.initiative, session, directory }).catch(() => [])));
    if (asked.get(item.initiative).has(item.gate.id)) mine.push(item);
  }
  return mine;
}
async function openGates(projectRoot) {
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
async function approvalGates(projectRoot, environment) {
  const directory = gateWaitDirectory(environment);
  let ids;
  try {
    ids = await askedGates(projectRoot, { directory });
  } catch {
    return { items: [], receive: async () => {
    } };
  }
  if (!ids.size) return { items: [], receive: async () => {
  } };
  let items;
  try {
    const { approvalGatesWithIds } = await import("../server/workflow/store-artifacts.mjs");
    items = await approvalGatesWithIds(projectRoot, [...ids]);
  } catch {
    return { items: [], receive: async () => {
    } };
  }
  const found = new Set(items.map(({ gate }) => gate.id));
  const gone = [...ids].filter((id) => !found.has(id));
  const receive = (received) => forgetAskedGates(projectRoot, [...gone, ...received.map(({ gate }) => gate.id)], { directory }).catch(() => {
  });
  return { items, receive };
}
const scopeName = (scope) => scope?.label ?? scope?.kind ?? "workspace";
const noteText = (note) => note ? ` Note: ${note}${/[.!?]$/.test(note) ? "" : "."}` : "";
const approvalLine = ({ artifact, gate }, question2 = `"${gate.question}"`) => `- Approval gate ${gate.id} (${artifact.path}, scope ${scopeName(artifact.scope)}, status ${gate.status}): ${question2}`;
const approvalAnswer = (item, question2) => `${approvalLine(item, question2)} Answer: ${choiceText(item.gate)}.${noteText(item.gate.answer.note)}${item.gate.answer.choice === "approve" ? ` Prism recorded ${item.gate.status} and rewrote its status lines in the store.` : " Its recorded status stays as it was."}`;
const APPROVAL_ACT = "Act on each approval answer; an approval gate needs no resolve, since Prism recorded the answer in the artifact's status record, and get_artifact returns it as latestAnswer.";
const gateLine = ({ initiative, gate }, question2 = `"${gate.question}"`) => `- Gate ${gate.id} (${gate.kind}, initiative ${initiative}${gate.slice ? `, slice ${gate.slice}` : ""}): ${question2}`;
const gateAnswer = (item, question2) => `${gateLine(item, question2)} Answer: ${choiceText(item.gate)}.${noteText(item.gate.answer.note)}`;
const userSection = (instruction, items, line) => ({ instruction, gates: items.map((item) => ({ item, line, read: "get_coordination_state" })) });
const approvalSection = (instruction, items, line, closing) => ({ instruction, closing, gates: items.map((item) => ({ item, line, read: `get_artifact for ${item.artifact.path}` })) });
const MIN_QUESTION_CHARACTERS = 80;
const MORE_GATES = "\u2026 More gates are open; read them with get_coordination_state, and the approval gates with get_artifact.";
const question = ({ item, read }, limit) => {
  const text = item.gate.question;
  if (text.length <= limit) return `"${text}"`;
  return `"${text.slice(0, limit).trimEnd()}\u2026" (question shortened; read the whole gate with ${read})`;
};
function render(heading, sections, limit, more) {
  const lines = [heading];
  for (const section of sections) {
    lines.push(section.instruction, ...section.gates.map((gate) => gate.line(gate.item, question(gate, limit))));
    if (section.closing) lines.push(section.closing);
  }
  if (more) lines.push(MORE_GATES);
  return lines.join("\n");
}
function bounded(heading, sections) {
  let shown = sections.filter((section) => section.gates.length);
  const count = () => shown.reduce((total, section) => total + section.gates.length, 0);
  const longest = Math.max(0, ...shown.flatMap((section) => section.gates.map((gate) => gate.item.gate.question.length)));
  const fits = (limit, more2) => render(heading, shown, limit, more2).length <= MAX_CONTEXT_CHARACTERS;
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
  return { text: render(heading, shown, low, more), shown: shown.flatMap((section) => section.gates.map((gate) => gate.item)) };
}
async function startedGates(projectRoot, environment, own, resumed) {
  const gates = resumed ? own : [];
  const approvals = await approvalGates(projectRoot, environment);
  if (!gates.length && !approvals.items.length) {
    await approvals.receive([]);
    return null;
  }
  const waiting = gates.filter(({ gate }) => !gate.answer), answered = gates.filter(({ gate }) => gate.answer);
  const asked = approvals.items.filter(({ gate }) => !gate.answer), approved = approvals.items.filter(({ gate }) => gate.answer);
  const heading = gates.length ? "This session resumed while Prism user gates that it asked are open, and nothing waits on them now." : "This session started while Prism approval gates that this checkout asked are open, and nothing waits on them now.";
  const { text, shown } = bounded(heading, [
    userSection("For these unanswered gates, call wait_for_user_gate with their ids once you have handled the user's message, so a browser answer reaches you without another message.", waiting, gateLine),
    approvalSection("This checkout asked these approval gates, which the user has not answered; call wait_for_user_gate with each id and the artifact's path as artifact once you have handled the user's message.", asked, approvalLine),
    userSection("The user already answered these gates in the review browser; act on each answer, then remove the gate with an update_coordination_state resolve operation for its id.", answered, gateAnswer),
    approvalSection("The user already answered these approval gates that this checkout asked, in the review browser.", approved, approvalAnswer, APPROVAL_ACT)
  ]);
  await approvals.receive(approved.filter((item) => shown.includes(item)));
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}
async function deliverGateAnswers({ input = process.stdin, environment = process.env, directory } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const event = hookInput.hook_event_name ?? "UserPromptSubmit";
  const start = event === "SessionStart" && ["resume", "startup", "clear"].includes(hookInput.source);
  if (!start && event !== "UserPromptSubmit") return null;
  const folder = typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : environment.CLAUDE_PROJECT_DIR;
  if (!folder) return null;
  const projectRoot = await realpath(folder);
  const resumed = start && hookInput.source === "resume";
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: hookInput.session_id });
  const own = !start || resumed ? await sessionGates(projectRoot, session, directory ?? noticeDirectory(environment)) : [];
  if (start) return startedGates(projectRoot, environment, own, resumed);
  const gates = own.filter(({ gate }) => gate.answer);
  const approvals = await approvalGates(projectRoot, environment);
  const approved = approvals.items.filter(({ gate }) => gate.answer);
  if (!gates.length && !approved.length) {
    await approvals.receive([]);
    return null;
  }
  const { text, shown } = bounded("The user answered these Prism user gates in the review browser.", [
    userSection("Treat each answer as the user's reply to that question, act on it, then remove the gate with an update_coordination_state resolve operation for its id.", gates, gateAnswer),
    approvalSection("This checkout asked these approval gates.", approved, approvalAnswer, APPROVAL_ACT)
  ]);
  await approvals.receive(approved.filter((item) => shown.includes(item)));
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
}
async function main() {
  configureRecordSync({ pullOnRead: false });
  try {
    const output = await deliverGateAnswers();
    if (output) {
      process.stdout.write(`${JSON.stringify(output)}
`);
    }
  } catch {
  }
}
const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
export {
  deliverGateAnswers,
  openGates,
  sessionGates
};
