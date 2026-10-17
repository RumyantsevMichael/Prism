import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClaudeCodeHostAdapter } from "../server/session/host-adapters/claude-code.mjs";
import { createCodexHostAdapter } from "../server/session/host-adapters/codex.mjs";
import {
  HOST_FACT_REASON,
  createSessionCorrelationKey,
  writeHostSessionFacts
} from "../server/session/host-session-facts.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

async function readHookInput(input = process.stdin) {
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

export async function recordSessionFacts({
  input = process.stdin,
  environment = process.env,
  adapter = null
} = {}) {
  const inputText = await readHookInput(input);
  const parsedInput = JSON.parse(inputText);
  const hookInput = { ...parsedInput };
  if (typeof hookInput.cwd === "string" && path.isAbsolute(hookInput.cwd)) {
    try {
      hookInput.cwd = await realpath(hookInput.cwd);
    } catch {
    }
  }
  let capture = await (adapter || createCodexHostAdapter()).capture({ hookInput, environment });
  let claudeCodeSessionDigest = null;
  if (
    !adapter
    && !capture.record
    && capture.reasonCode === HOST_FACT_REASON.HOST_METADATA_UNAVAILABLE
    && typeof environment.CLAUDE_PROJECT_DIR === "string"
    && environment.CLAUDE_PROJECT_DIR.trim()
    && !environment.CODEX_VERSION
    && !Object.hasOwn(hookInput, "turn_id")
    && !Object.hasOwn(hookInput, "subagent")
  ) {
    capture = await createClaudeCodeHostAdapter().capture({ hookInput, environment });
    // A new Claude Code session has no transcript until its first model call, and the PreToolUse refresh
    // before each Prism tool call records the facts, so the key is announced before any record exists.
    if (typeof hookInput.session_id === "string" && hookInput.session_id.trim() && !hookInput.agent_id) {
      claudeCodeSessionDigest = createSessionCorrelationKey(hookInput.session_id);
    }
  }
  const dataDirectory = environment.PLUGIN_DATA || environment.CLAUDE_PLUGIN_DATA;
  let hookOutput = null;
  if (dataDirectory && (capture.record || claudeCodeSessionDigest)) {
    if (capture.record) await writeHostSessionFacts(capture.record, { dataDirectory });
    const sessionDigest = capture.record?.sessionDigest ?? claudeCodeSessionDigest;
    const hookEventName = typeof hookInput.hook_event_name === "string" ? hookInput.hook_event_name : null;
    if (CONTEXT_EVENTS.has(hookEventName)) {
      hookOutput = {
        hookSpecificOutput: {
          hookEventName,
          additionalContext: `Prism session correlation key: ${sessionDigest}. Prism plugin data directory: ${dataDirectory}. Pass both exact values to Prism active-session capacity and consumption tools.`
        }
      };
    }
  }
  return { ...capture, hookOutput };
}

async function main() {
  try {
    const result = await recordSessionFacts();
    if (result.hookOutput) {
      process.stdout.write(`${JSON.stringify(result.hookOutput)}\n`);
    }
  } catch {
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
