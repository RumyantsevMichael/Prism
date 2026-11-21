import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { LAUNCH_ID_PATTERN, LaunchError, launchFolder, lastRunStatus, listLaunchRecords, readLaunchRecord } from "./launch-records.mjs";

// The permission requests that a launched session's host asks and that wait for the person on this machine.
// Each request lives in <launch folder>/permissions/<id>.json, private to the user, so no request or answer reaches a shared record.
// The run's supervisor, the one process that answers the host, keeps each request it asked in memory and answers the host once:
// - a refusal is written by a review server of this machine as <id>.answer.json, and the supervisor refuses the host when it reads it;
// - an approval is only an ask, <id>.ask-<nonce>.json, for the supervisor to show the request's native dialog itself; the supervisor
//   allows the request only when the person confirmed that dialog, and writes the dialog's outcome as
//   <launch folder>/permission-outcomes/<id>.<nonce>.json for the review server that asked, which removes it once read. No file approves anything, since the launched host runs as the same user and can write any of them.

export const REQUEST_ID_PATTERN = /^perm-[0-9a-f]{16}$/;
/** The most characters of a shown action or reason that a request keeps, and so that a confirmation shows in full. */
export const PERMISSION_TEXT_MAX = 1000;
const CUT_MARK = "…";
const FOLDER = "permissions";
const ANSWER_SUFFIX = ".answer.json";
const ASK_PATTERN = /^(perm-[0-9a-f]{16})\.ask-([0-9a-f]{16})\.json$/;
const DECISIONS: ReadonlySet<string> = new Set(["approve", "refuse"]);
const MAX_REQUEST_BYTES = 64 * 1024;
const OUTCOME_POLL_MS = 100;
// A review server waits this long at most for the supervisor's dialog outcome: the dialog's own limit, its backstop, and a margin.
const OUTCOME_WAIT_MS = 180 * 1000;
// After its request left the folder, the outcome that the supervisor writes next is awaited this long at most.
const OUTCOME_AFTER_REMOVAL_MS = 3000;

export type PermissionDecision = "approve" | "refuse";

/** One pending request as its file keeps it; cut is true when its action or reason was cut to PERMISSION_TEXT_MAX characters. */
export interface PermissionRequest { id: string; launch: string; run: string; host: string; hostLabel: string; action: string; reason: string; canAllow: boolean; unavailable: string | null; cut: boolean; askedAt: string }

export const newRequestId = () => `perm-${randomBytes(8).toString("hex")}`;
const permissionsFolder = (folder: string) => path.join(folder, FOLDER);
const requestFile = (folder: string, id: string) => path.join(permissionsFolder(folder), `${id}.json`);
const answerFile = (folder: string, id: string) => path.join(permissionsFolder(folder), `${id}${ANSWER_SUFFIX}`);
const askFile = (folder: string, id: string, nonce: string) => path.join(permissionsFolder(folder), `${id}.ask-${nonce}.json`);
// Outcomes sit beside the requests' folder, so an outcome written as the run ends outlives the withdrawal of its requests.
const OUTCOME_FOLDER = "permission-outcomes";
const outcomesFolder = (folder: string) => path.join(folder, OUTCOME_FOLDER);
const outcomeFile = (folder: string, id: string, nonce: string) => path.join(outcomesFolder(folder), `${id}.${nonce}.json`);

// The characters that the shown form escapes: the backslash, and every character of the categories Cc, Cf, Zl, and Zp.
const ESCAPED = /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const NAMED_ESCAPES: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** The shown form of host text: one line in which every character the host sent shows, the shown form of `ls\nrm` being `ls\\nrm`. */
export function shownForm(value: string) {
  return value.replace(ESCAPED, (character) => NAMED_ESCAPES[character] ?? `\\u{${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** The kept text of host text: its shown form, cut to its first PERMISSION_TEXT_MAX characters followed by `…` when longer. */
export function keptText(value: unknown) {
  const characters = Array.from(shownForm(typeof value === "string" ? value : ""));
  if (characters.length <= PERMISSION_TEXT_MAX) return { text: characters.join(""), cut: false };
  return { text: `${characters.slice(0, PERMISSION_TEXT_MAX).join("")}${CUT_MARK}`, cut: true };
}

// A kept text as a file holds it, never longer than a kept text can be.
const stored = (value: unknown) => (typeof value === "string" ? Array.from(value).slice(0, PERMISSION_TEXT_MAX + 1).join("") : "");

async function exists(file: string) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function readJson(file: string, maxBytes = MAX_REQUEST_BYTES) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// Only a well-formed request reaches a view or a decision, so nothing else that a file holds does.
function wellFormed(value: any): PermissionRequest | null {
  if (!value || typeof value !== "object" || !REQUEST_ID_PATTERN.test(value.id) || !LAUNCH_ID_PATTERN.test(value.launch) || typeof value.run !== "string") return null;
  if (typeof value.host !== "string" || typeof value.action !== "string" || Number.isNaN(Date.parse(value.askedAt))) return null;
  return { id: value.id, launch: value.launch, run: value.run, host: value.host, hostLabel: stored(value.hostLabel) || value.host, action: stored(value.action), reason: stored(value.reason), canAllow: value.canAllow === true, unavailable: typeof value.unavailable === "string" && value.unavailable ? value.unavailable.slice(0, UNAVAILABLE_MAX) : null, cut: value.cut === true, askedAt: value.askedAt };
}

async function readRequest(folder: string, id: string) {
  const request = wellFormed(await readJson(requestFile(folder, id)));
  return request?.id === id ? request : null;
}

/** Keeps a request of a launch's run waiting in its private folder, with its action and reason already in their kept form. */
export async function recordRequest(folder: string, request: Omit<PermissionRequest, "askedAt" | "unavailable"> & { unavailable?: string | null; askedAt?: string }) {
  await mkdir(permissionsFolder(folder), { recursive: true, mode: 0o700 });
  const kept = { ...request, unavailable: request.unavailable ?? null, askedAt: request.askedAt ?? new Date().toISOString() };
  await writeAtomically(requestFile(folder, request.id), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  return kept;
}

/** Removes one request and its refusal. */
export async function removeRequest(folder: string, id: string) {
  await rm(answerFile(folder, id), { force: true });
  await rm(requestFile(folder, id), { force: true });
}

/** Removes every request of a launch, answered or not. */
export async function withdrawRequests(folder: string) {
  await rm(permissionsFolder(folder), { recursive: true, force: true });
}

/** The refusal written for a request; any other content, an approval above all, answers nothing. */
async function refused(folder: string, id: string) {
  return (await readJson(answerFile(folder, id), 4096))?.decision === "refuse";
}

/** The requests of a launch folder that wait for an answer, oldest first, optionally only those of one run. */
export async function waitingRequests(folder: string, { run = null }: { run?: string | null } = {}) {
  let names: string[];
  try {
    names = await readdir(permissionsFolder(folder));
  } catch {
    return [];
  }
  const ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).filter((id) => REQUEST_ID_PATTERN.test(id));
  const found: PermissionRequest[] = [];
  for (const id of ids) {
    const request = await readRequest(folder, id);
    if (!request || (run !== null && request.run !== run)) continue;
    // A refused request no longer waits, though its supervisor may not have removed it yet.
    if (await refused(folder, id)) continue;
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
// Why a request cannot be approved, when its host says more than that it offers no single-use allow, is kept to this many characters.
const UNAVAILABLE_MAX = 1200;
export const approvalUnavailable = (label: string, reason: string | null = null) => new LaunchError("approval_unavailable", reason || `${label} offers no way to allow only this one request, so Prism cannot approve it.`);
export const approvalTooLong = (label: string) => new LaunchError("approval_too_long", `${label} asked for more than a confirmation shows in full, 1,000 characters, so Prism can only refuse it.`);

/** The request that waits in the running run of the launch on this machine, or a LaunchError unknown_request. */
export async function waitingRequest({ env = process.env, launch, request }: { env?: NodeJS.ProcessEnv; launch: string; request: unknown }) {
  if (typeof launch !== "string" || !LAUNCH_ID_PATTERN.test(launch) || typeof request !== "string" || !REQUEST_ID_PATTERN.test(request)) throw unknownRequest(request);
  const folder = launchFolder(env, launch);
  const found = (await launchRequests(folder, await readLaunchRecord(folder))).find((item) => item.id === request);
  if (!found) throw unknownRequest(request);
  return found;
}

/** Refuses a request that waits in the launch: the refusal is written once, exclusively, and the run's supervisor refuses the host. */
async function refuseRequest(env: NodeJS.ProcessEnv, launch: string, found: PermissionRequest) {
  const folder = launchFolder(env, launch);
  const target = answerFile(folder, found.id);
  // Written in full under a private name, then linked into place, so the supervisor never reads it half written and a second answer fails.
  const draft = `${target}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(draft, `${JSON.stringify({ decision: "refuse", at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(draft, target);
    } catch (error: any) {
      if (error?.code === "EEXIST" || error?.code === "ENOENT") throw unknownRequest(found.id);
      throw error;
    }
  } finally {
    await rm(draft, { force: true });
  }
  // A request that its supervisor withdrew meanwhile is answered by no one.
  if (!(await readRequest(folder, found.id))) {
    await rm(target, { force: true });
    throw unknownRequest(found.id);
  }
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Asks the run's supervisor to show the request's native dialog and waits for the dialog's outcome: resolves once the person allowed
 * the request there and the supervisor answered the host, or rejects with the confirmation's own LaunchError.
 */
async function askApproval(env: NodeJS.ProcessEnv, launch: string, found: PermissionRequest) {
  const folder = launchFolder(env, launch);
  const nonce = randomBytes(8).toString("hex");
  const ask = askFile(folder, found.id, nonce);
  const outcome = outcomeFile(folder, found.id, nonce);
  await writeFile(ask, `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  try {
    const deadline = Date.now() + OUTCOME_WAIT_MS;
    let goneAt: number | null = null;
    while (Date.now() < deadline) {
      const answer = await readJson(outcome, 4096);
      if (answer) {
        await rm(outcome, { force: true });
        if (answer.ok === true) return;
        const code = typeof answer.code === "string" && /^[a-z_]{1,60}$/.test(answer.code) ? answer.code : "confirmation_unavailable";
        throw new LaunchError(code, typeof answer.message === "string" ? answer.message.slice(0, 500) : "The confirmation failed, so the request still waits.");
      }
      if (!(await exists(requestFile(folder, found.id)))) {
        goneAt ??= Date.now();
        if (Date.now() - goneAt > OUTCOME_AFTER_REMOVAL_MS) throw unknownRequest(found.id);
      }
      await wait(OUTCOME_POLL_MS);
    }
    throw new LaunchError("confirmation_timeout", "The session did not show the confirmation in time, so the request still waits.");
  } finally {
    await rm(ask, { force: true });
  }
}

/**
 * Answers a request that waits in the launch. A refusal is written for the run's supervisor to answer the host. An approval is refused
 * with approval_too_long when its text was cut and with approval_unavailable when Prism cannot allow it, before any
 * dialog; otherwise it asks the supervisor for the request's dialog and answers with the dialog's outcome.
 */
export async function answerRequest({ env = process.env, launch, request, decision }: { env?: NodeJS.ProcessEnv; launch: string; request: string; decision: PermissionDecision }) {
  if (!DECISIONS.has(decision)) throw new LaunchError("invalid_input", "The decision is approve or refuse.");
  const found = await waitingRequest({ env, launch, request });
  if (decision === "refuse") {
    await refuseRequest(env, launch, found);
    return found;
  }
  if (found.cut) throw approvalTooLong(found.hostLabel);
  if (!found.canAllow) throw approvalUnavailable(found.hostLabel, found.unavailable);
  await askApproval(env, launch, found);
  return found;
}

/**
 * What a host asks: the action and reason it names, as the host sent them, and whether Prism can allow it; unavailable says why a
 * request that cannot be allowed can only be refused, when that is more than that its host offers no single-use allow.
 */
export interface PermissionAsk { action: string; reason: string; canAllow: boolean; unavailable?: string }

/** The request whose dialog the supervisor shows: its kept action and reason, which are what the dialog names. */
export interface ShownRequest { id: string; action: string; reason: string }

/**
 * The supervisor's side of a run's requests: ask() keeps a request waiting and returns the function that withdraws it, poll() refuses
 * each request whose refusal was written and shows the dialog of each request whose approval a review server asked for, and close()
 * stops answering and removes every request of the launch. confirm shows a request's native dialog and resolves only once the person
 * confirmed it; the request it allows is the one in this process's memory, never what a file says. Writes run in order, so a request
 * withdrawn right after it was asked never lingers.
 */
export function permissionBroker({ folder, launch, run, host, hostLabel, confirm }: { folder: string; launch: string; run: string; host: string; hostLabel: string; confirm: (request: ShownRequest) => Promise<unknown> }) {
  const waiting = new Map<string, { action: string; reason: string; canAllow: boolean; unavailable: string | null; cut: boolean; respond: (decision: PermissionDecision) => void }>();
  const handled = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const later = (step: () => Promise<unknown>) => {
    queue = queue.then(step).catch(() => {});
    return queue;
  };
  const writeOutcome = (id: string, nonce: string, outcome: unknown) => later(async () => {
    await mkdir(outcomesFolder(folder), { recursive: true, mode: 0o700 });
    await writeAtomically(outcomeFile(folder, id, nonce), `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  });
  const approve = async (id: string, nonce: string) => {
    const entry = waiting.get(id);
    if (!entry) return;
    let outcome: any;
    try {
      if (entry.cut) throw approvalTooLong(hostLabel);
      if (!entry.canAllow) throw approvalUnavailable(hostLabel, entry.unavailable);
      await confirm({ id, action: entry.action, reason: entry.reason });
      // The request may have been refused, withdrawn, or ended while the dialog was open, and then nothing is allowed.
      if (closed || waiting.get(id) !== entry) throw unknownRequest(id);
      entry.respond("approve");
      outcome = { ok: true };
    } catch (error: any) {
      outcome = { ok: false, code: error instanceof LaunchError ? error.code : "confirmation_unavailable", message: String(error?.message ?? error) };
    }
    // Queued after the request's removal, so a review server that reads the outcome no longer finds the request.
    await writeOutcome(id, nonce, outcome);
  };
  let polling = false;
  return {
    ask(ask: PermissionAsk, respond: (decision: PermissionDecision) => void) {
      const id = newRequestId();
      const action = keptText(ask.action);
      const reason = keptText(ask.reason);
      const unavailable = ask.canAllow ? null : ask.unavailable ? ask.unavailable.slice(0, UNAVAILABLE_MAX) : null;
      const entry = { action: action.text, reason: reason.text, canAllow: ask.canAllow, unavailable, cut: action.cut || reason.cut, respond };
      waiting.set(id, entry);
      void later(async () => { if (!closed && waiting.has(id)) await recordRequest(folder, { id, launch, run, host, hostLabel, action: entry.action, reason: entry.reason, canAllow: entry.canAllow, unavailable: entry.unavailable, cut: entry.cut }); });
      return () => {
        if (waiting.get(id) === entry) waiting.delete(id);
        void later(() => removeRequest(folder, id));
      };
    },
    async poll() {
      if (polling || closed || waiting.size === 0) return;
      polling = true;
      try {
        let names: string[] = [];
        try {
          names = await readdir(permissionsFolder(folder));
        } catch {}
        for (const name of names) {
          const match = ASK_PATTERN.exec(name);
          if (!match || handled.has(name) || !waiting.has(match[1])) continue;
          handled.add(name);
          await rm(path.join(permissionsFolder(folder), name), { force: true }).catch(() => {});
          void approve(match[1], match[2]);
        }
        for (const [id, entry] of [...waiting]) {
          if ((await refused(folder, id)) && waiting.get(id) === entry && !closed) entry.respond("refuse");
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
