// Generated from src/server/session/permission-requests.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { LAUNCH_ID_PATTERN, LaunchError, launchFolder, lastRunStatus, listLaunchRecords, readLaunchRecord } from "./launch-records.mjs";
const REQUEST_ID_PATTERN = /^perm-[0-9a-f]{16}$/;
const PERMISSION_TEXT_MAX = 1e3;
const CUT_MARK = "\u2026";
const FOLDER = "permissions";
const ANSWER_SUFFIX = ".answer.json";
const ASK_PATTERN = /^(perm-[0-9a-f]{16})\.ask-([0-9a-f]{16})\.json$/;
const DECISIONS = /* @__PURE__ */ new Set(["approve", "refuse"]);
const MAX_REQUEST_BYTES = 64 * 1024;
const OUTCOME_POLL_MS = 100;
const OUTCOME_WAIT_MS = 180 * 1e3;
const OUTCOME_AFTER_REMOVAL_MS = 3e3;
const newRequestId = () => `perm-${randomBytes(8).toString("hex")}`;
const permissionsFolder = (folder) => path.join(folder, FOLDER);
const requestFile = (folder, id) => path.join(permissionsFolder(folder), `${id}.json`);
const answerFile = (folder, id) => path.join(permissionsFolder(folder), `${id}${ANSWER_SUFFIX}`);
const askFile = (folder, id, nonce) => path.join(permissionsFolder(folder), `${id}.ask-${nonce}.json`);
const OUTCOME_FOLDER = "permission-outcomes";
const outcomesFolder = (folder) => path.join(folder, OUTCOME_FOLDER);
const outcomeFile = (folder, id, nonce) => path.join(outcomesFolder(folder), `${id}.${nonce}.json`);
const ESCAPED = /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const NAMED_ESCAPES = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "	": "\\t" };
function shownForm(value) {
  return value.replace(ESCAPED, (character) => NAMED_ESCAPES[character] ?? `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}}`);
}
function keptText(value) {
  const characters = Array.from(shownForm(typeof value === "string" ? value : ""));
  if (characters.length <= PERMISSION_TEXT_MAX) return { text: characters.join(""), cut: false };
  return { text: `${characters.slice(0, PERMISSION_TEXT_MAX).join("")}${CUT_MARK}`, cut: true };
}
const stored = (value) => typeof value === "string" ? Array.from(value).slice(0, PERMISSION_TEXT_MAX + 1).join("") : "";
async function exists(file) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}
async function readJson(file, maxBytes = MAX_REQUEST_BYTES) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
function wellFormed(value) {
  if (!value || typeof value !== "object" || !REQUEST_ID_PATTERN.test(value.id) || !LAUNCH_ID_PATTERN.test(value.launch) || typeof value.run !== "string") return null;
  if (typeof value.host !== "string" || typeof value.action !== "string" || Number.isNaN(Date.parse(value.askedAt))) return null;
  return { id: value.id, launch: value.launch, run: value.run, host: value.host, hostLabel: stored(value.hostLabel) || value.host, action: stored(value.action), reason: stored(value.reason), canAllow: value.canAllow === true, unavailable: typeof value.unavailable === "string" && value.unavailable ? value.unavailable.slice(0, UNAVAILABLE_MAX) : null, cut: value.cut === true, askedAt: value.askedAt };
}
async function readRequest(folder, id) {
  const request = wellFormed(await readJson(requestFile(folder, id)));
  return request?.id === id ? request : null;
}
async function recordRequest(folder, request) {
  await mkdir(permissionsFolder(folder), { recursive: true, mode: 448 });
  const kept = { ...request, unavailable: request.unavailable ?? null, askedAt: request.askedAt ?? (/* @__PURE__ */ new Date()).toISOString() };
  await writeAtomically(requestFile(folder, request.id), `${JSON.stringify(kept, null, 2)}
`, { mode: 384 });
  return kept;
}
async function removeRequest(folder, id) {
  await rm(answerFile(folder, id), { force: true });
  await rm(requestFile(folder, id), { force: true });
}
async function withdrawRequests(folder) {
  await rm(permissionsFolder(folder), { recursive: true, force: true });
}
async function refused(folder, id) {
  return (await readJson(answerFile(folder, id), 4096))?.decision === "refuse";
}
async function waitingRequests(folder, { run = null } = {}) {
  let names;
  try {
    names = await readdir(permissionsFolder(folder));
  } catch {
    return [];
  }
  const ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).filter((id) => REQUEST_ID_PATTERN.test(id));
  const found = [];
  for (const id of ids) {
    const request = await readRequest(folder, id);
    if (!request || run !== null && request.run !== run) continue;
    if (await refused(folder, id)) continue;
    found.push(request);
  }
  return found.sort((left, right) => Date.parse(left.askedAt) - Date.parse(right.askedAt) || left.id.localeCompare(right.id));
}
async function launchRequests(folder, record, now = Date.now()) {
  if (!record || lastRunStatus(record, now) !== "running") return [];
  return waitingRequests(folder, { run: record.runs.at(-1).token });
}
async function pendingRequests({ env = process.env, store }) {
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
const unknownRequest = (id) => new LaunchError("unknown_request", `No permission request ${String(id)} waits in this session.`);
const UNAVAILABLE_MAX = 1200;
const approvalUnavailable = (label, reason = null) => new LaunchError("approval_unavailable", reason || `${label} offers no way to allow only this one request, so Prism cannot approve it.`);
const approvalTooLong = (label) => new LaunchError("approval_too_long", `${label} asked for more than a confirmation shows in full, 1,000 characters, so Prism can only refuse it.`);
async function waitingRequest({ env = process.env, launch, request }) {
  if (typeof launch !== "string" || !LAUNCH_ID_PATTERN.test(launch) || typeof request !== "string" || !REQUEST_ID_PATTERN.test(request)) throw unknownRequest(request);
  const folder = launchFolder(env, launch);
  const found = (await launchRequests(folder, await readLaunchRecord(folder))).find((item) => item.id === request);
  if (!found) throw unknownRequest(request);
  return found;
}
async function refuseRequest(env, launch, found) {
  const folder = launchFolder(env, launch);
  const target = answerFile(folder, found.id);
  const draft = `${target}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(draft, `${JSON.stringify({ decision: "refuse", at: (/* @__PURE__ */ new Date()).toISOString() })}
`, { mode: 384, flag: "wx" });
    try {
      await link(draft, target);
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOENT") throw unknownRequest(found.id);
      throw error;
    }
  } finally {
    await rm(draft, { force: true });
  }
  if (!await readRequest(folder, found.id)) {
    await rm(target, { force: true });
    throw unknownRequest(found.id);
  }
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function askApproval(env, launch, found) {
  const folder = launchFolder(env, launch);
  const nonce = randomBytes(8).toString("hex");
  const ask = askFile(folder, found.id, nonce);
  const outcome = outcomeFile(folder, found.id, nonce);
  await writeFile(ask, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString() })}
`, { mode: 384, flag: "wx" });
  try {
    const deadline = Date.now() + OUTCOME_WAIT_MS;
    let goneAt = null;
    while (Date.now() < deadline) {
      const answer = await readJson(outcome, 4096);
      if (answer) {
        await rm(outcome, { force: true });
        if (answer.ok === true) return;
        const code = typeof answer.code === "string" && /^[a-z_]{1,60}$/.test(answer.code) ? answer.code : "confirmation_unavailable";
        throw new LaunchError(code, typeof answer.message === "string" ? answer.message.slice(0, 500) : "The confirmation failed, so the request still waits.");
      }
      if (!await exists(requestFile(folder, found.id))) {
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
async function answerRequest({ env = process.env, launch, request, decision }) {
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
function permissionBroker({ folder, launch, run, host, hostLabel, confirm }) {
  const waiting = /* @__PURE__ */ new Map();
  const handled = /* @__PURE__ */ new Set();
  let queue = Promise.resolve();
  let closed = false;
  const later = (step) => {
    queue = queue.then(step).catch(() => {
    });
    return queue;
  };
  const writeOutcome = (id, nonce, outcome) => later(async () => {
    await mkdir(outcomesFolder(folder), { recursive: true, mode: 448 });
    await writeAtomically(outcomeFile(folder, id, nonce), `${JSON.stringify(outcome)}
`, { mode: 384 });
  });
  const approve = async (id, nonce) => {
    const entry = waiting.get(id);
    if (!entry) return;
    let outcome;
    try {
      if (entry.cut) throw approvalTooLong(hostLabel);
      if (!entry.canAllow) throw approvalUnavailable(hostLabel, entry.unavailable);
      await confirm({ id, action: entry.action, reason: entry.reason });
      if (closed || waiting.get(id) !== entry) throw unknownRequest(id);
      entry.respond("approve");
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, code: error instanceof LaunchError ? error.code : "confirmation_unavailable", message: String(error?.message ?? error) };
    }
    await writeOutcome(id, nonce, outcome);
  };
  let polling = false;
  return {
    ask(ask, respond) {
      const id = newRequestId();
      const action = keptText(ask.action);
      const reason = keptText(ask.reason);
      const unavailable = ask.canAllow ? null : ask.unavailable ? ask.unavailable.slice(0, UNAVAILABLE_MAX) : null;
      const entry = { action: action.text, reason: reason.text, canAllow: ask.canAllow, unavailable, cut: action.cut || reason.cut, respond };
      waiting.set(id, entry);
      void later(async () => {
        if (!closed && waiting.has(id)) await recordRequest(folder, { id, launch, run, host, hostLabel, action: entry.action, reason: entry.reason, canAllow: entry.canAllow, unavailable: entry.unavailable, cut: entry.cut });
      });
      return () => {
        if (waiting.get(id) === entry) waiting.delete(id);
        void later(() => removeRequest(folder, id));
      };
    },
    async poll() {
      if (polling || closed || waiting.size === 0) return;
      polling = true;
      try {
        let names = [];
        try {
          names = await readdir(permissionsFolder(folder));
        } catch {
        }
        for (const name of names) {
          const match = ASK_PATTERN.exec(name);
          if (!match || handled.has(name) || !waiting.has(match[1])) continue;
          handled.add(name);
          await rm(path.join(permissionsFolder(folder), name), { force: true }).catch(() => {
          });
          void approve(match[1], match[2]);
        }
        for (const [id, entry] of [...waiting]) {
          if (await refused(folder, id) && waiting.get(id) === entry && !closed) entry.respond("refuse");
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
export {
  PERMISSION_TEXT_MAX,
  REQUEST_ID_PATTERN,
  answerRequest,
  approvalTooLong,
  approvalUnavailable,
  keptText,
  launchRequests,
  newRequestId,
  pendingRequests,
  permissionBroker,
  recordRequest,
  removeRequest,
  shownForm,
  waitingRequest,
  waitingRequests,
  withdrawRequests
};
