// Generated from src/server/workflow/approval-deliveries.mts by scripts/native-build/compile.mjs.
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { ASKED_GATES_FILE, gateWaitDirectory } from "./gate-wait-requests.mjs";
import { parseStoreJson } from "./store-json.mjs";
const SCHEMA_VERSION = 1;
const ENTRIES_KEPT = 2e3;
const real = (target) => realpath(target).catch(() => path.resolve(target));
const fileOf = (directory) => path.join(directory, ASKED_GATES_FILE);
const validEntry = (entry) => entry !== null && typeof entry === "object" && typeof entry.gate === "string" && entry.gate && typeof entry.projectRoot === "string" && path.isAbsolute(entry.projectRoot);
async function readEntries(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return [];
    const parsed = parseStoreJson(await readFile(file, "utf8"));
    return parsed?.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.gates) ? parsed.gates.filter(validEntry) : [];
  } catch {
    return [];
  }
}
async function change(directory, edit) {
  const file = fileOf(directory);
  await mkdir(directory, { recursive: true, mode: 448 });
  await withArtifactLock(file, () => withFileLock(file, async () => {
    const listed = await readEntries(file);
    const next = edit(listed);
    if (next === listed) return;
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, gates: next.slice(-ENTRIES_KEPT) })}
`, { mode: 384 });
  }));
}
async function recordAskedGates(projectRoot, gateIds, { directory = gateWaitDirectory(), now = /* @__PURE__ */ new Date(), session = null } = {}) {
  if (!gateIds.length) return;
  const root = await real(projectRoot);
  await change(directory, (listed) => [...listed.filter((entry) => !gateIds.includes(entry.gate)), ...gateIds.map((gate) => ({ gate, projectRoot: root, askedAt: now.toISOString(), ...typeof session === "string" && session ? { session } : {} }))]);
}
async function sessionAskedGates(projectRoot, session, { directory = gateWaitDirectory() } = {}) {
  if (typeof session !== "string" || !session) return /* @__PURE__ */ new Set();
  const root = await real(projectRoot);
  return new Set((await readEntries(fileOf(directory))).filter((entry) => entry.projectRoot === root && entry.session === session).map((entry) => entry.gate));
}
async function askedGates(projectRoot, { directory = gateWaitDirectory() } = {}) {
  const root = await real(projectRoot);
  return new Set((await readEntries(fileOf(directory))).filter((entry) => entry.projectRoot === root).map((entry) => entry.gate));
}
async function forgetAskedGates(projectRoot, gateIds, { directory = gateWaitDirectory() } = {}) {
  if (!gateIds.length) return;
  const root = await real(projectRoot);
  const held = await askedGates(root, { directory });
  if (!gateIds.some((gate) => held.has(gate))) return;
  await change(directory, (listed) => listed.filter((entry) => entry.projectRoot !== root || !gateIds.includes(entry.gate)));
}
export {
  askedGates,
  forgetAskedGates,
  recordAskedGates,
  sessionAskedGates
};
