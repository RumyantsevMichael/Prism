import path from "node:path";
import { fileURLToPath } from "node:url";
import { withdrawSessionQuestions } from "../server/session/launched-sessions.mjs";
import { configureRecordSync } from "../server/workflow/record-store-sync.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;

async function readHookInput(input: any) {
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

/**
 * The SessionStart hook of Claude Code and Codex: when the starting session is the host session of a Claude Code or Codex launch on this
 * machine, as when the person continues a launched session in a terminal, it resolves that launch's unanswered no-result gate, since the
 * session runs again. An answered gate stays for the run to act on, and any other session, or a read or parse failure, changes nothing.
 * It writes no hook output.
 */
export async function withdrawLaunchQuestions({ input = process.stdin, environment = process.env }: any = {}) {
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
  // A hook must answer within its host's time limit, so its record reads never start a store pull; the session's server keeps the store current.
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
