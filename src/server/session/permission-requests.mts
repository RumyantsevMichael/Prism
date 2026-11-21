import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { LAUNCH_ID_PATTERN, LaunchError, launchFolder, lastRunStatus, listLaunchRecords, readLaunchRecord } from "./launch-records.mjs";

// The permission requests that a launched session's host asks and that wait for the person on this machine.
// Each request lives in <launch folder>/permissions/<id>.json, private to the user, and its answer in <id>.answer.json beside it, which
// only a review server of this machine writes and only the run's supervisor reads, so no request or answer reaches a shared record.
// The supervisor answers the host once, with the host's single-use allow or its refusal, and then removes both files.

export const REQUEST_ID_PATTERN = /^perm-[0-9a-f]{16}$/;
export const PERMISSION_TEXT_MAX = 500;
const FOLDER = "permissions";
const ANSWER_SUFFIX = ".answer.json";
const DECISIONS: ReadonlySet<string> = new Set(["approve", "refuse"]);
const MAX_REQUEST_BYTES = 64 * 1024;

export type PermissionDecision = "approve" | "refuse";

/** One pending request as its file keeps it. */
export interface PermissionRequest { id: string; launch: string; run: string; host: string; hostLabel: string; action: string; reason: string; canAllow: boolean; askedAt: string }

export const newRequestId = () => `perm-${randomBytes(8).toString("hex")}`;
const permissionsFolder = (folder: string) => path.join(folder, FOLDER);
const requestFile = (folder: string, id: string) => path.join(permissionsFolder(folder), `${id}.json`);
const answerFile = (folder: string, id: string) => path.join(permissionsFolder(folder), `${id}${ANSWER_SUFFIX}`);
const text = (value: unknown) => (typeof value === "string" ? value.slice(0, PERMISSION_TEXT_MAX) : "");

async function exists(file: string) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

// Only a well-formed request reaches a view or a decision, so nothing else that a file holds does.
function wellFormed(value: any): PermissionRequest | null {
  if (!value || typeof value !== "object" || !REQUEST_ID_PATTERN.test(value.id) || !LAUNCH_ID_PATTERN.test(value.launch) || typeof value.run !== "string") return null;
  if (typeof value.host !== "string" || typeof value.action !== "string" || Number.isNaN(Date.parse(value.askedAt))) return null;
  return { id: value.id, launch: value.launch, run: value.run, host: value.host, hostLabel: text(value.hostLabel) || value.host, action: text(value.action), reason: text(value.reason), canAllow: value.canAllow === true, askedAt: value.askedAt };
}

async function readRequest(folder: string, id: string) {
  try {
    const file = requestFile(folder, id);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_REQUEST_BYTES) return null;
    const request = wellFormed(JSON.parse(await readFile(file, "utf8")));
    return request?.id === id ? request : null;
  } catch {
    return null;
  }
}

/** Keeps a request of a launch's run waiting in its private folder; the action and the reason are cut to PERMISSION_TEXT_MAX characters. */
export async function recordRequest(folder: string, request: Omit<PermissionRequest, "askedAt"> & { askedAt?: string }) {
  await mkdir(permissionsFolder(folder), { recursive: true, mode: 0o700 });
  const kept = { ...request, action: text(request.action), reason: text(request.reason), askedAt: request.askedAt ?? new Date().toISOString() };
  await writeAtomically(requestFile(folder, request.id), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  return kept;
}

/** Removes one request and its answer. */
export async function removeRequest(folder: string, id: string) {
  await rm(answerFile(folder, id), { force: true });
  await rm(requestFile(folder, id), { force: true });
}

/** Removes every request of a launch, answered or not. */
export async function withdrawRequests(folder: string) {
  await rm(permissionsFolder(folder), { recursive: true, force: true });
}

/** The requests of a launch folder that wait for an answer, oldest first, optionally only those of one run. */
export async function waitingRequests(folder: string, { run = null }: { run?: string | null } = {}) {
  let names: string[];
  try {
    names = await readdir(permissionsFolder(folder));
  } catch {
    return [];
  }
  const ids = names.filter((name) => name.endsWith(".json") && !name.endsWith(ANSWER_SUFFIX)).map((name) => name.slice(0, -".json".length)).filter((id) => REQUEST_ID_PATTERN.test(id));
  const found: PermissionRequest[] = [];
  for (const id of ids) {
    const request = await readRequest(folder, id);
    if (!request || (run !== null && request.run !== run)) continue;
    // An answered request no longer waits, though its supervisor may not have removed it yet.
    if (await exists(answerFile(folder, id))) continue;
    found.push(request);
  }
  return found.sort((left, right) => Date.parse(left.askedAt) - Date.parse(right.askedAt) || left.id.localeCompare(right.id));
}

/** The requests that wait in a launch's running run on this machine, oldest first; a launch that does not run has none. */
export async function launchRequests(folder: string, record: any, now = Date.now()) {
  if (!record || lastRunStatus(record, now) !== "running") return [];
  return waitingRequests(folder, { run: record.runs.at(-1).token });
}

/**
 * Every request that waits in a running launched session of this machine whose record store is `store`, oldest first:
 * [{ id, launch, initiative, host: { id, label }, action, reason, askedAt }], with initiative the initiative's id.
 */
export async function pendingRequests({ env = process.env, store }: { env?: NodeJS.ProcessEnv; store: string }) {
  const now = Date.now();
  const found = [];
  for (const { folder, record } of await listLaunchRecords(env).catch(() => [])) {
    if (!record || record.store !== store) continue;
    for (const request of await launchRequests(folder, record, now)) {
      found.push({ id: request.id, launch: record.id, initiative: record.initiative, host: { id: request.host, label: request.hostLabel }, action: request.action, reason: request.reason, askedAt: request.askedAt });
    }
  }
  return found.sort((left, right) => Date.parse(left.askedAt) - Date.parse(right.askedAt) || left.id.localeCompare(right.id));
}

const unknownRequest = (id: unknown) => new LaunchError("unknown_request", `No permission request ${String(id)} waits in this session.`);

/** The request that waits in the running run of the launch on this machine, or a LaunchError unknown_request. */
export async function waitingRequest({ env = process.env, launch, request }: { env?: NodeJS.ProcessEnv; launch: string; request: unknown }) {
  if (typeof launch !== "string" || !LAUNCH_ID_PATTERN.test(launch) || typeof request !== "string" || !REQUEST_ID_PATTERN.test(request)) throw unknownRequest(request);
  const folder = launchFolder(env, launch);
  const found = (await launchRequests(folder, await readLaunchRecord(folder))).find((item) => item.id === request);
  if (!found) throw unknownRequest(request);
  return found;
}

/**
 * Answers a request that waits in the launch: the answer is written once, exclusively, so a request is answered at most once whichever
 * review server of this machine answers it, and the run's supervisor answers the host. An approval of a request that offers no single-use
 * allow is refused with approval_unavailable. The caller confirms an approval with the person before it calls this.
 */
export async function answerRequest({ env = process.env, launch, request, decision }: { env?: NodeJS.ProcessEnv; launch: string; request: string; decision: PermissionDecision }) {
  if (!DECISIONS.has(decision)) throw new LaunchError("invalid_input", "The decision is approve or refuse.");
  const found = await waitingRequest({ env, launch, request });
  if (decision === "approve" && !found.canAllow) throw approvalUnavailable(found.hostLabel);
  const folder = launchFolder(env, launch);
  const target = answerFile(folder, request);
  // Written in full under a private name, then linked into place, so the supervisor never reads it half written and a second answer fails.
  const draft = `${target}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(draft, `${JSON.stringify({ decision, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(draft, target);
    } catch (error: any) {
      if (error?.code === "EEXIST" || error?.code === "ENOENT") throw unknownRequest(request);
      throw error;
    }
  } finally {
    await rm(draft, { force: true });
  }
  // A request that its supervisor withdrew meanwhile is answered by no one.
  if (!(await readRequest(folder, request))) {
    await rm(target, { force: true });
    throw unknownRequest(request);
  }
  return found;
}

export const approvalUnavailable = (label: string) => new LaunchError("approval_unavailable", `${label} offers no way to allow only this one request, so Prism cannot approve it.`);

/** The decision answered for a request, or null while none is; the supervisor reads it. */
export async function readAnswer(folder: string, id: string): Promise<PermissionDecision | null> {
  try {
    const value = JSON.parse(await readFile(answerFile(folder, id), "utf8"));
    return DECISIONS.has(value?.decision) ? value.decision : null;
  } catch {
    return null;
  }
}

/** What a host asks: the action and reason it names, and whether it offers a single-use allow. */
export interface PermissionAsk { action: string; reason: string; canAllow: boolean }

/**
 * The supervisor's side of a run's requests: ask() keeps a request waiting and returns the function that withdraws it, poll() answers each
 * request whose answer was written, and close() stops answering and removes every request of the launch. Writes run in order, so a request
 * withdrawn right after it was asked never lingers.
 */
export function permissionBroker({ folder, launch, run, host, hostLabel }: { folder: string; launch: string; run: string; host: string; hostLabel: string }) {
  const waiting = new Map<string, (decision: PermissionDecision) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const later = (step: () => Promise<unknown>) => {
    queue = queue.then(step).catch(() => {});
    return queue;
  };
  let polling = false;
  return {
    ask(ask: PermissionAsk, respond: (decision: PermissionDecision) => void) {
      const id = newRequestId();
      waiting.set(id, respond);
      void later(async () => { if (!closed && waiting.has(id)) await recordRequest(folder, { id, launch, run, host, hostLabel, action: ask.action, reason: ask.reason, canAllow: ask.canAllow }); });
      return () => {
        waiting.delete(id);
        void later(() => removeRequest(folder, id));
      };
    },
    async poll() {
      if (polling || closed || waiting.size === 0) return;
      polling = true;
      try {
        for (const [id, respond] of [...waiting]) {
          const decision = await readAnswer(folder, id);
          if (decision && waiting.has(id) && !closed) respond(decision);
        }
      } finally {
        polling = false;
      }
    },
    async close() {
      closed = true;
      waiting.clear();
      await later(() => withdrawRequests(folder));
    }
  };
}
