// Generated from src/hooks/withdraw-launch-questions.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withdrawSessionQuestions } from "../server/session/launched-sessions.mjs";
import { configureRecordSync } from "../server/workflow/record-store-sync.mjs";
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
async function withdrawLaunchQuestions({ input = process.stdin, environment = process.env } = {}) {
  try {
    const hookInput = JSON.parse(await readHookInput(input));
    if (!hookInput || typeof hookInput !== "object") return null;
    if (hookInput.hook_event_name && hookInput.hook_event_name !== "SessionStart") return null;
    const sessionId = hookInput.session_id;
    if (typeof sessionId !== "string" || !sessionId) return null;
    await withdrawSessionQuestions({ sessionId, env: environment });
  } catch {
  }
  return null;
}
async function main() {
  configureRecordSync({ pullOnRead: false });
  try {
    await withdrawLaunchQuestions();
  } catch {
  }
}
const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
export {
  withdrawLaunchQuestions
};
