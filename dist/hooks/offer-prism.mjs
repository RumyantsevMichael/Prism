import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectCodexTranscriptMetadata } from "../server/session/host-adapters/codex-transcript.mjs";
import { readWorkflowConfig } from "../server/workflow/workflow-config.mjs";
import { openGates } from "./deliver-gate-answers.mjs";

// A new conversation learns once that Prism is available, so the agent can offer it for work that changes the
// product's documented intent instead of waiting for the person to name a skill. A resumed or compacted conversation
// already had the offer, and a child agent works on what its parent gave it.
const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const NEW_CONVERSATION = new Set(["startup", "clear"]);
const MAX_INITIATIVES_NAMED = 5;

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

const nonempty = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

const WHEN = "when the person's first request asks for code that adds or changes behavior their requirements, ADRs, or feature files describe, or should describe";
const SKIP = "Do not ask when the request is a question about the code, a change no requirement or ADR covers (a color, a typo, a rename), or already names a Prism skill, and never ask twice in this conversation; when unsure, ask, because a needless offer costs one answer";

export function offerText({ configured, initiatives }) {
  if (!configured) {
    return `Prism is installed but not set up in this project. ${WHEN[0].toUpperCase()}${WHEN.slice(1)}, ask once whether to set Prism up for it, and on yes load the prism:setup skill, then continue with the request. ${SKIP}.`;
  }
  const lines = [`Prism is set up in this project. ${WHEN[0].toUpperCase()}${WHEN.slice(1)}, ask once whether to run it through Prism, and on yes load the prism:orchestrate skill with the request. ${SKIP}.`];
  if (initiatives.length) {
    const named = initiatives.slice(0, MAX_INITIATIVES_NAMED).join(", ");
    lines.push(`Questions wait on the person in the Prism initiative${initiatives.length === 1 ? "" : "s"} ${named}${initiatives.length > MAX_INITIATIVES_NAMED ? ", and more" : ""}; when the request continues that work, offer to resume it through prism:orchestrate instead of starting new work.`);
  }
  return lines.join("\n");
}

async function isCodexSubagent(hookInput, environment, projectRoot) {
  if (Object.hasOwn(hookInput, "subagent")) return true;
  if (!nonempty(environment.CODEX_VERSION) && !nonempty(hookInput.turn_id)) return false;
  const metadata = await inspectCodexTranscriptMetadata({ transcriptPath: hookInput.transcript_path, sessionId: hookInput.session_id, projectRoot }).catch(() => null);
  return metadata?.execution === "subagent";
}

export async function offerPrism({ input = process.stdin, environment = process.env } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  if (hookInput.hook_event_name !== "SessionStart" || !NEW_CONVERSATION.has(hookInput.source)) return null;
  if (nonempty(hookInput.agent_id)) return null;
  // Prism's own headless runs and anyone who wants no offer set PRISM_SESSION_OFFER=off.
  if (/^off$/i.test(nonempty(environment.PRISM_SESSION_OFFER) ?? "")) return null;
  const directory = nonempty(hookInput.cwd) && path.isAbsolute(hookInput.cwd) ? hookInput.cwd : nonempty(environment.CLAUDE_PROJECT_DIR);
  if (!directory) return null;
  const projectRoot = await realpath(directory);
  if (await isCodexSubagent(hookInput, environment, projectRoot)) return null;
  const config = await readWorkflowConfig(projectRoot);
  if (config.exists && /^off$/i.test(nonempty(config.sections?.Interaction?.["Session offer"]) ?? "")) return null;
  const initiatives = config.exists
    ? [...new Set((await openGates(projectRoot).catch(() => [])).filter(({ gate }) => !gate.answer).map(({ initiative }) => initiative))]
    : [];
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: offerText({ configured: config.exists, initiatives }) } };
}

async function main() {
  try {
    const output = await offerPrism();
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
