// Generated from src/hooks/record-call-agent.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordCallAgent } from "../server/workflow/call-agent.mjs";
import { sessionHolder } from "../server/workflow/slice-claims.mjs";
const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
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
async function recordCallAgentHook({ input = process.stdin, directory } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  if (hookInput.hook_event_name && hookInput.hook_event_name !== "PreToolUse") return false;
  const session = sessionHolder({ CLAUDE_CODE_SESSION_ID: hookInput.session_id });
  if (!session) return false;
  return recordCallAgent({ session, toolUseId: hookInput.tool_use_id, agentId: hookInput.agent_id, ...directory ? { directory } : {} });
}
async function main() {
  try {
    await recordCallAgentHook();
  } catch {
  }
}
const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
export {
  recordCallAgentHook
};
