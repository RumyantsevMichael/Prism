import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_ID_PATTERN, launchFolder, readLaunchRecord, readResultMarks } from "../server/session/launch-records.mjs";
import { runHasResult } from "../server/session/run-result.mjs";
import { configureRecordSync } from "../server/workflow/record-store-sync.mjs";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;

/** The reason that keeps a launched Claude Code turn going once when it would end without a result. */
export const TURN_CHECK_REASON = [
  "Prism launched this session headless, so no person reads your reply, and this turn would end without a result.",
  "If you need the person, record a gate with update_coordination_state and wait for its answer with wait_for_user_gate.",
  "If the work must stop for now, record a pause with checkpoint_pause.",
  "Otherwise continue the work."
].join("\n");

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

const ACTIVE_TASK = new Set(["running", "pending"]);

/**
 * Claude Code's Stop hook for a launched run: it keeps the turn going once with TURN_CHECK_REASON when PRISM_LAUNCH names a Claude Code
 * launch on this machine whose host session is this session, the stop does not follow a block, no background task runs or waits, and the
 * current run has no result. Every other stop, and any read or parse failure, ends the turn.
 */
export async function keepRunsToAResult({ input = process.stdin, environment = process.env }: any = {}) {
  try {
    const hookInput = JSON.parse(await readHookInput(input));
    if (!hookInput || typeof hookInput !== "object") return null;
    if (hookInput.hook_event_name && hookInput.hook_event_name !== "Stop") return null;
    const id = environment.PRISM_LAUNCH;
    if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
    const sessionId = hookInput.session_id;
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (hookInput.stop_hook_active === true) return null;
    const tasks = Array.isArray(hookInput.background_tasks) ? hookInput.background_tasks : [];
    if (tasks.some((task: any) => ACTIVE_TASK.has(task?.status))) return null;
    const folder = launchFolder(environment, id);
    const record = await readLaunchRecord(folder);
    if (!record || record.host !== "claude-code" || record.hostSessionId !== sessionId) return null;
    const run = record.runs.at(-1);
    if (!run || typeof run.startedAt !== "string" || typeof record.checkout !== "string" || typeof record.initiative !== "string") return null;
    const marks = await readResultMarks(folder);
    if (await runHasResult({ checkout: record.checkout, initiative: record.initiative, since: run.startedAt, pauses: marks.pauses })) return null;
    return { decision: "block", reason: TURN_CHECK_REASON };
  } catch {
    return null;
  }
}

async function main() {
  // A hook must answer within its host's time limit, so its record reads never start a store pull; the session's server keeps the store current.
  configureRecordSync({ pullOnRead: false });
  try {
    const output = await keepRunsToAResult();
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
