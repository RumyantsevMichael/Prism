// Generated from src/hooks/keep-orchestrator-role.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const ORCHESTRATE = "orchestrate";
const CHILD_SKILLS = /* @__PURE__ */ new Set(["setup", "design", "implement", "review", "triage", "ideate"]);
const MARKER_FOLDER = "orchestrator-executions";
const MARKER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1e3;
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
const nonempty = (value) => typeof value === "string" && value.trim() ? value : null;
function prismSkill(name) {
  const value = nonempty(name)?.trim().replace(/^\//, "");
  if (!value) return null;
  const match = /^prism:([a-z][a-z0-9-]*)$/.exec(value);
  return match ? match[1] : null;
}
function promptSkill(prompt) {
  const match = /^\s*\/prism:([a-z][a-z0-9-]*)(?:\s|$)/.exec(typeof prompt === "string" ? prompt : "");
  return match ? match[1] : null;
}
function markerPath(dataDirectory, hookInput) {
  const sessionId = nonempty(hookInput.session_id);
  if (!sessionId) return null;
  const execution = nonempty(hookInput.agent_id) ? `agent:${hookInput.agent_id}` : "root";
  const digest = createHash("sha256").update(`${sessionId}
${execution}`).digest("hex");
  return path.join(dataDirectory, MARKER_FOLDER, digest);
}
async function isOrchestrating(marker) {
  try {
    return Date.now() - (await stat(marker)).mtimeMs < MARKER_LIFETIME_MS;
  } catch {
    return false;
  }
}
async function markOrchestrating(marker) {
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, "");
}
const deny = (skill) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `This session orchestrates a Prism initiative, so it never runs ${skill} itself. Start a fresh child agent whose prompt asks it to use the prism:${skill} skill, and pass it the identifiers and folders orchestrate names.`
  }
});
async function keepOrchestratorRole({ input = process.stdin, environment = process.env } = {}) {
  const hookInput = JSON.parse(await readHookInput(input));
  const dataDirectory = nonempty(environment.PLUGIN_DATA) || nonempty(environment.CLAUDE_PLUGIN_DATA);
  if (!dataDirectory) return null;
  const marker = markerPath(dataDirectory, hookInput);
  if (!marker) return null;
  const event = hookInput.hook_event_name;
  if (event === "SessionStart") {
    if (hookInput.source === "startup" || hookInput.source === "clear") await rm(marker, { force: true });
    return null;
  }
  if (event === "SessionEnd") {
    await rm(marker, { force: true });
    return null;
  }
  if (event === "UserPromptSubmit") {
    const skill2 = promptSkill(hookInput.prompt);
    if (skill2 === ORCHESTRATE) await markOrchestrating(marker);
    else if (CHILD_SKILLS.has(skill2)) await rm(marker, { force: true });
    return null;
  }
  if (event !== "PreToolUse" || hookInput.tool_name !== "Skill") return null;
  const skill = prismSkill(hookInput.tool_input?.skill);
  if (skill === ORCHESTRATE) {
    await markOrchestrating(marker);
    return null;
  }
  if (CHILD_SKILLS.has(skill) && await isOrchestrating(marker)) return deny(skill);
  return null;
}
async function main() {
  try {
    const output = await keepOrchestratorRole();
    if (output) process.stdout.write(`${JSON.stringify(output)}
`);
  } catch {
  }
}
const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === path.resolve(process.argv[1])) {
  await main();
}
export {
  CHILD_SKILLS,
  keepOrchestratorRole,
  prismSkill,
  promptSkill
};
