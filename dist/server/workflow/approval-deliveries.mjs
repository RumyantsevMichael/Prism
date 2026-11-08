import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { ASKED_GATES_FILE, gateWaitDirectory } from "./gate-wait-requests.mjs";

// The approval gates that each checkout of this machine asked and has not yet received the answer of, by its real project root.
// An approval answer reaches only the checkout that asked its gate, so this list holds local paths and stays on this machine, never in a record store.
// An entry stays until that checkout receives the answer, through a prompt, a session start, a wait result, or a get_artifact read, or until the gate is gone, however old it is.
const SCHEMA_VERSION = 1;
// A bound on the list, so that checkouts deleted with gates still unanswered cannot grow it without end; a live checkout prunes its own entries at each prompt.
const ENTRIES_KEPT = 2000;

const real = (target) => realpath(target).catch(() => path.resolve(target));
const fileOf = (directory) => path.join(directory, ASKED_GATES_FILE);
const validEntry = (entry) => entry !== null && typeof entry === "object" && typeof entry.gate === "string" && entry.gate && typeof entry.projectRoot === "string" && path.isAbsolute(entry.projectRoot);

// The listed entries, or [] for a missing, unreadable, or foreign list, which the next write replaces.
async function readEntries(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return [];
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed?.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.gates) ? parsed.gates.filter(validEntry) : [];
  } catch {
    return [];
  }
}

async function change(directory, edit) {
  const file = fileOf(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await withArtifactLock(file, () => withFileLock(file, async () => {
    const listed = await readEntries(file);
    const next = edit(listed);
    if (next === listed) return;
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, gates: next.slice(-ENTRIES_KEPT) })}\n`, { mode: 0o600 });
  }));
}

/** Remember that the checkout at projectRoot asked the approval gates gateIds, so that their answers reach it. */
export async function recordAskedGates(projectRoot, gateIds, { directory = gateWaitDirectory(), now = new Date() } = {}) {
  if (!gateIds.length) return;
  const root = await real(projectRoot);
  await change(directory, (listed) => [...listed.filter((entry) => !gateIds.includes(entry.gate)), ...gateIds.map((gate) => ({ gate, projectRoot: root, askedAt: now.toISOString() }))]);
}

/** The ids of the approval gates that the checkout at projectRoot asked and has not received the answer of. */
export async function askedGates(projectRoot, { directory = gateWaitDirectory() } = {}) {
  const root = await real(projectRoot);
  return new Set((await readEntries(fileOf(directory))).filter((entry) => entry.projectRoot === root).map((entry) => entry.gate));
}

/** Forget the checkout's approval gates gateIds: it received their answers, or the gates are gone. Gates it did not ask are left alone. */
export async function forgetAskedGates(projectRoot, gateIds, { directory = gateWaitDirectory() } = {}) {
  if (!gateIds.length) return;
  const root = await real(projectRoot);
  const held = await askedGates(root, { directory });
  if (!gateIds.some((gate) => held.has(gate))) return;
  await change(directory, (listed) => listed.filter((entry) => entry.projectRoot !== root || !gateIds.includes(entry.gate)));
}
