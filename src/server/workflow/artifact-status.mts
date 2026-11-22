import { randomBytes } from "node:crypto";
import path from "node:path";
import { ARTIFACT_ACCEPTED, ARTIFACT_STATUS, artifactLocation, locationArtifact, STATUS_RECORD_NAME } from "./artifact-paths.mjs";
import { canonicalJson } from "./record-merge.mjs";
import { markdownLinkDestinations } from "./markdown-links.mjs";
import { parseStoreJson } from "./store-json.mjs";

// A requirement's and an ADR's status is recorded in the store beside the artifact, and only a person's answer at a gate changes it.
// The status record of an artifact lives at artifact-status/<its location>/status.json, so it moves and goes with the artifact,
// and the accepted bytes are kept once under their hash in artifact-accepted/, since an approval and a design acceptance may keep the same bytes.
// The artifact lock guards both as it guards artifacts/, so store sync commits an update's artifact and record together.
const NEW_STATUS = Object.freeze({ requirements: "Draft", adrs: "Proposed" });
const CLOSED_KEPT = 20;
const HISTORY_KEPT = 50;
const STATUS_MAX = 200;
// The longest question and context that ask_approval records: its question input holds at most 4096 characters and its context at most 8000,
// and a question it writes itself names the file and the status, so 8000 bounds both.
const GATE_TEXT_MAX = 8000;
const NOTE_MAX = 4000;
export const APPROVAL_CHOICES = Object.freeze(["approve", "request-changes"]);
export const APPROVAL_OPTIONS = Object.freeze([{ id: "approve", label: "Approve" }, { id: "request-changes", label: "Request changes" }]);

const fail = (code: any, message: any, details = {}) => Object.assign(new Error(message), { name: "ArtifactError", code, ...details });

/** Whether an artifact kind has a recorded status: requirements and ADRs. */
export const hasStatus = (kind: any) => Object.hasOwn(NEW_STATUS, kind);

/** The status a new requirement or ADR is recorded with. */
export const newStatus = (kind: string): string | null => (NEW_STATUS as Record<string, string>)[kind] ?? null;

/** The written status of a requirement or ADR: the text after Status: on the first line beginning with Status: before its first level-two heading, or null. */
export function writtenStatus(text: string) {
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("Status:")) return line.slice("Status:".length).trim();
  }
  return null;
}

/** The store-relative path of an artifact's status record: artifact-status/<the artifact's location>/status.json, at most 186 characters for a location of at most 120. */
export function statusRecordLocation(scope: any, address: any) {
  return path.posix.join(ARTIFACT_STATUS, artifactLocation(scope, address), STATUS_RECORD_NAME);
}

/** The store-relative path of the accepted bytes of a version, kept once for the whole store under their hash. */
export function acceptedLocation(version: any) {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(version ?? "")?.[1];
  if (!hex) throw new Error(`An accepted version must be a sha256 version, not ${JSON.stringify(version)}.`);
  return path.posix.join(ARTIFACT_ACCEPTED, hex);
}

/** The record of an artifact that no gate has changed yet: a new requirement is Draft and a new ADR Proposed, unless status gives the written status of a moved file. */
export function newRecord(kind: string, status = null) {
  return { status: hasStatus(kind) ? status ?? newStatus(kind) : null, acceptedVersion: null, approval: null, pending: [], closed: [], history: [] };
}

/**
 * Whether a move records a written status as accepted in the moved bytes: any status of one line but the one a new requirement or ADR starts with, in any letter case,
 * since a file that reached it before the move did so as an approval gate would have taken it there.
 */
export function acceptedWhenMoved(kind: string, status: any) {
  return hasStatus(kind) && typeof status === "string" && status.trim() !== "" && !/[\r\n]/.test(status) && status.toLowerCase() !== newStatus(kind)!.toLowerCase();
}

/** Whether a record is one that a move made, before moves kept an accepted version, for a status that counts as accepted: no gate, approval, acceptance, or history has touched it since. */
export function movedWithoutAcceptance(kind: string, record: any) {
  return acceptedWhenMoved(kind, record.status) && record.acceptedVersion === null && record.approval === null && !record.acceptance && !record.pending.length && !record.closed.length && !record.history.length;
}

const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: any) => Array.isArray(value) ? value.filter(isRecord) : [];
const VERSION = /^sha256:[0-9a-f]{64}$/;

/** Whether a status is one that an approval gate may ask for: one line of 1 to 200 characters without surrounding spaces, and never Accepted on an ADR, which only a ship records. */
export function askableStatus(kind: string, status: any, shipped = undefined) {
  if (!(typeof status === "string" && status.length > 0 && status.length <= STATUS_MAX && status === status.trim() && !/[\r\n]/.test(status))) return false;
  if (shipped !== undefined) return kind === "adrs" && status === SHIP_STATUS && shippedAcceptance(shipped);
  return !(kind === "adrs" && /^accepted$/i.test(status));
}

/**
 * Whether a value names what an approval that accepts an ADR after its initiative shipped records: { initiative, verifiedBy },
 * the shipped initiative and the slice, repository, and commit of each slice its ship recorded.
 */
export function shippedAcceptance(value: any) {
  return isRecord(value) && typeof value.initiative === "string" && value.initiative.length > 0 && value.initiative.length <= 200 && Array.isArray(value.verifiedBy) && value.verifiedBy.length <= 1000
    && value.verifiedBy.every((item: any) => isRecord(item) && typeof item.slice === "string" && (item.repository === null || typeof item.repository === "string") && (item.commit === null || typeof item.commit === "string"));
}

const boundedText = (value: any, max: any) => typeof value === "string" && value.length <= max;
const optionalText = (value: any, max: any) => value === undefined || value === null || boundedText(value, max);
const WORK_ITEM_ID = /^[A-Za-z0-9_-]{1,200}$/;
const optionalWorkItemId = (value: any) => value === undefined || (typeof value === "string" && WORK_ITEM_ID.test(value));
const optionalPerson = (value: any) => value === undefined || value === null || (isRecord(value) && boundedText(value.name, 200) && optionalText(value.host, 255));

/**
 * Whether a stored gate is one that ask_approval could have recorded: a string id, an askable status, a sha256 version, a question of 1 to 8000 characters, a context of at most 8000 or none,
 * and the ids of the initiative and slice it serves or none, a slice only with an initiative,
 * with its times and closing reason as text, and, once answered, a known choice with a note of at most 4000 characters and the person who answered as { name, host }.
 * A gate that a damaged file or another writer placed in a synced record otherwise could decide what an approval writes, or what Attention shows.
 */
function wellFormedGate(kind: string, gate: any) {
  if (typeof gate.id !== "string" || !gate.id || gate.id.length > 200 || !askableStatus(kind, gate.status, gate.shipped) || !VERSION.test(gate.version ?? "")) return false;
  if (!boundedText(gate.question, GATE_TEXT_MAX) || !gate.question || !optionalText(gate.context, GATE_TEXT_MAX)) return false;
  if (!optionalWorkItemId(gate.initiative) || !optionalWorkItemId(gate.slice) || (gate.slice !== undefined && gate.initiative === undefined && gate.shipped === undefined)) return false;
  if (!optionalText(gate.askedAt, 64) || !optionalText(gate.closedAt, 64) || !optionalText(gate.closed, 64) || !optionalText(gate.supersededBy, 200) || !optionalPerson(gate.by)) return false;
  if (gate.answer === undefined) return true;
  const answer = gate.answer;
  return isRecord(answer) && APPROVAL_CHOICES.includes(answer.choice) && optionalText(answer.note, NOTE_MAX) && optionalText(answer.answeredAt, 64) && optionalText(answer.via, 64)
    && optionalText(answer.entry, 64) && optionalPerson(answer.by);
}

/**
 * The status record held in bytes, or a new record when there are none.
 * A record that does not parse counts as a new one, so a damaged file never lends an artifact a status that no gate recorded.
 */
export function parseRecord(kind: string, bytes: any): any {
  if (bytes === null || bytes === undefined) return newRecord(kind);
  let value;
  try { value = parseStoreJson(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); }
  catch { return newRecord(kind); }
  if (!isRecord(value)) return newRecord(kind);
  const fresh = newRecord(kind);
  return {
    status: hasStatus(kind) ? (typeof value.status === "string" && value.status.trim() && !/[\r\n]/.test(value.status) ? value.status : fresh.status) : null,
    acceptedVersion: typeof value.acceptedVersion === "string" && VERSION.test(value.acceptedVersion) ? value.acceptedVersion : null,
    // The bounded reader refuses a record nested deeper than Prism writes, so the approval and history items it keeps never exhaust the call stack when serialized again.
    approval: isRecord(value.approval) ? value.approval : null,
    // Only a ship records an acceptance, so a record written before ships accepted ADRs, or without one, keeps no such key.
    ...(isRecord(value.acceptance) ? { acceptance: value.acceptance } : {}),
    // A gate that ask_approval could not have recorded is dropped, so Attention never offers it and no answer can apply it.
    pending: list(value.pending).filter((gate) => wellFormedGate(kind, gate)),
    closed: list(value.closed).filter((gate) => wellFormedGate(kind, gate)),
    history: list(value.history)
  };
}

// A record is one line, so two machines that change it before either syncs meet as a line conflict: the upstream record stays whole, and the other is saved and reported.
export const serializeRecord = (record: any) => `${JSON.stringify(record)}\n`;

const keep = (entries: any, count: number) => entries.slice(-count);

/** The latest answered approval gate of a record, or null. */
export const latestAnsweredGate = (record: any) => record.closed.findLast((gate: any) => gate.answer) ?? null;

/** A person's answer to an approval gate as get_artifact returns it: { gate, status, choice, note, answeredAt, by, entry }, where entry is the id of the review app's history entry that applied it. */
export const answerFields = (gate: any) => ({ gate: gate.id, status: gate.status, choice: gate.answer.choice, note: gate.answer.note ?? null, answeredAt: gate.answer.answeredAt ?? null, by: gate.answer.by ?? null, entry: typeof gate.answer.entry === "string" ? gate.answer.entry : null });

/** The fields that get_artifact returns from a status record for an artifact whose bytes have version. */
export function statusFields(kind: string, record: any, version: any) {
  const answered = latestAnsweredGate(record);
  return {
    ...(hasStatus(kind) ? { status: record.status } : {}),
    acceptedVersion: record.acceptedVersion,
    changedSinceAccepted: record.acceptedVersion !== version,
    ...(record.approval ? { approval: record.approval } : {}),
    ...(record.acceptance ? { acceptance: record.acceptance } : {}),
    ...(answered ? { latestAnswer: answerFields(answered) } : {})
  };
}

/** A mismatch between the written and the recorded status, as { written, recorded, message }, or null when they agree or the kind has no status. */
export function statusMismatch(kind: string, file: string, text: string, record: any) {
  if (!hasStatus(kind)) return null;
  const written = writtenStatus(text);
  if (written === record.status) return null;
  const says = written === null ? `${file} has no Status: line before its first ## heading` : `${file} says Status: ${written}`;
  const treated = `Prism treats it as ${record.status}, its recorded status, and the write was kept.`;
  const approval = `Only a person's answer at an approval gate changes it: ask with an update_artifact ask_approval operation${written ? ` with status ${JSON.stringify(written)}` : ""}, which the person answers on Attention in the review browser, and leave the Status: line to that gate.`;
  const message = kind === "adrs" && /^accepted$/i.test(written ?? "")
    ? `${says}, but its recorded status is ${record.status}. An ADR becomes Accepted only when a person confirms that an initiative whose slice.md links it ships, which records the acceptance; another status changes at an approval gate. ${treated}`
    : `${says}, but its recorded status is ${record.status}. ${approval}${kind === "adrs" ? " An ADR becomes Accepted only when its initiative ships." : ""} ${treated}`;
  return { written, recorded: record.status, message };
}

/**
 * Record a pending approval gate on a requirement or ADR at its current version: { record, gate }.
 * A new question replaces the artifact's earlier pending ones, which close as superseded, so one artifact waits on one approval at a time.
 */
export function askApproval(kind: string, file: string, record: any, { status, question, context, version, shipped, initiative, slice, now = new Date() }: { status: any; question: any; context: any; version: any; shipped?: any; initiative?: any; slice?: any; now?: any }) {
  if (!hasStatus(kind)) throw notAStatusArtifact(file);
  const wanted = typeof status === "string" ? status.trim() : shipped ? SHIP_STATUS : "Approved";
  if (!wanted || wanted.length > STATUS_MAX || /[\r\n]/.test(wanted)) throw fail("validation_failed", `The status of an approval gate is one line of 1 to ${STATUS_MAX} characters, such as Approved.`);
  if (shipped) {
    // An approval that names a shipped initiative accepts a Proposed ADR that its ship left Proposed, and nothing else.
    if (kind !== "adrs" || wanted !== SHIP_STATUS) throw fail("validation_failed", `An approval that names the shipped initiative ${shipped.initiative} accepts an ADR, so its status is Accepted and its file is an ADR.`);
    if (record.status !== "Proposed") throw fail("validation_failed", `${file} is ${record.status}, and an approval after a ship accepts only a Proposed ADR.`);
  } else if (kind === "adrs" && /^accepted$/i.test(wanted)) {
    throw fail("status_by_ship", `${file} is an ADR, which becomes Accepted when a person confirms that an initiative whose slice.md links it ships, or approves it afterwards for the shipped initiative that realized it; ask approval with shipped naming that initiative, or for another status, such as Superseded, or ship the initiative after its correctness gate.`);
  }
  if (wanted === record.status && version === record.acceptedVersion) {
    throw fail("nothing_to_approve", `${file} is already ${record.status}, and its bytes are the version a person accepted, so there is nothing to approve; change the artifact first, or ask for another status.`);
  }
  const at = now.toISOString();
  const gate = {
    id: `approval-${randomBytes(6).toString("hex")}`,
    status: wanted,
    version,
    question: typeof question === "string" && question.trim() ? question.trim() : `Approve ${file} as ${wanted}?`,
    context: typeof context === "string" && context.trim() ? context.trim() : null,
    askedAt: at,
    // The work item the gate serves, so Attention can link the card to it; an acceptance after a ship serves its shipped initiative.
    ...(typeof initiative === "string" ? { initiative } : {}),
    ...(typeof slice === "string" ? { slice } : {}),
    ...(shipped ? { shipped: { initiative: shipped.initiative, verifiedBy: shipped.verifiedBy } } : {})
  };
  const superseded = record.pending.map((earlier: any) => ({ ...earlier, closedAt: at, closed: "superseded", supersededBy: gate.id }));
  return { record: { ...record, pending: [gate], closed: keep([...record.closed, ...superseded], CLOSED_KEPT) }, gate };
}

export const notAStatusArtifact = (file: string) => fail("not_a_status_artifact", `${file} is no requirement or ADR, so it has no status to approve; approval gates apply only to files under the configured Requirements and ADRs folders.`);

const STATUS_LINE = /^Status:[^\r\n]*(\r?\n|$)/;
const APPROVED_LINE = /^Approved:[^\r\n]*(\r?\n|$)/;
const FENCE = /^---\r?\n?$/;

// The index of the first line after a YAML front matter block that opens on the file's first line, or 0 when the file has none.
function frontMatterEnd(lines: string[]) {
  if (!FENCE.test(lines[0] ?? "")) return 0;
  const close = lines.findIndex((line: string, index: number) => index > 0 && FENCE.test(line));
  return close < 0 ? 0 : close + 1;
}

/**
 * The text of a requirement or ADR with its Status: line set to status and, for Approved, its Approved: line set to the date, added after the Status: line when it has none.
 * Only lines before the first level-two heading count, as for the written status; a file with no Status: line there gains one after its title.
 */
export function rewriteStatusLines(text: string, status: any, date: any) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const heading = lines.findIndex((line: string) => line.startsWith("## "));
  const head = heading < 0 ? lines.length : heading;
  const ending = (line: string) => /\r?\n$/.exec(line)?.[0] ?? "";
  let at = lines.slice(0, head).findIndex((line: string) => STATUS_LINE.test(line));
  if (at < 0) {
    // YAML front matter stays the file's first lines, and a "# " comment inside it is no title.
    const body = Math.min(frontMatterEnd(lines), head);
    const found = lines.slice(body, head).findIndex((line: string) => line.startsWith("# "));
    const title = found < 0 ? -1 : body + found;
    const newline = lines.map(ending).find(Boolean) ?? "\n";
    // A title gets a blank line between it and the status lines, and a file without one gets them at its top, after any front matter.
    at = title < 0 ? body : title + 1;
    // Lines added at the end of a file without a final newline leave it without one.
    const closing = at >= lines.length && at > 0 && !ending(lines[at - 1]) ? "" : newline;
    const insert = title < 0 ? [`Status: ${status}${closing}`] : [newline, `Status: ${status}${closing}`];
    if (title >= 0 && !ending(lines[title])) lines[title] += newline;
    if (title < 0 && body > 0 && !ending(lines[body - 1])) lines[body - 1] += newline;
    lines.splice(at, 0, ...insert);
    at += insert.length - 1;
  } else {
    lines[at] = `Status: ${status}${ending(lines[at]) || (at === lines.length - 1 ? "" : "\n")}`;
  }
  if (status === "Approved") {
    const end = lines.findIndex((line: string, index: number) => index > at && line.startsWith("## "));
    // An Approved: line counts in the same part of the file as the Status: line, front matter or the text after it.
    const front = frontMatterEnd(lines);
    const from = at >= front ? front : 0;
    const found = lines.slice(from, end < 0 ? lines.length : end).findIndex((line: string) => APPROVED_LINE.test(line));
    const approved = found < 0 ? -1 : from + found;
    const newline = ending(lines[at]) || lines.map(ending).find(Boolean) || "\n";
    if (approved >= 0) lines[approved] = `Approved: ${date}${ending(lines[approved])}`;
    else {
      // The Approved: line ends as the Status: line did, so a file keeps its final newline, or its lack of one.
      const last = at + 1 >= lines.length;
      const closing = last && !ending(lines[at]) ? "" : newline;
      if (!ending(lines[at])) lines[at] += newline;
      lines.splice(at + 1, 0, `Approved: ${date}${closing}`);
    }
  }
  return lines.join("");
}

/**
 * Apply a person's answer to a pending approval gate: { record, text }, where text is the artifact's new text, or null when the answer leaves the artifact as it is.
 * Approving rewrites the status lines, records the status, the accepted version of the new bytes, and the approval with the gate, the time, and who approved;
 * a request for changes keeps the recorded status. version is the artifact's current version, which must be the one the gate asked about.
 * entry is the review app's history entry of the gate.answer action that applies the answer: the record keeps it, since an approval belongs to no initiative's history, and the answer names its id.
 */
export function answerApproval(kind: string, file: string, record: any, { id, choice, note = null, by, version, text, entry = null, now = entry?.at ? new Date(entry.at) : new Date() }: { id: string; choice: any; note?: any; by: any; version: any; text: string; entry?: any; now?: any }) {
  const gate = record.pending.find((item: any) => item.id === id);
  if (!gate) {
    const closed = record.closed.find((item: any) => item.id === id);
    if (closed?.answer) throw fail("gate_answered", "The question already has an answer.");
    // The review browser answers only a pending gate, so a closed one, whether a later ask or a ship ended it, reads as no longer open.
    throw fail("unknown_gate", closed ? "The question was closed without an answer, so it no longer applies." : "The question is no longer open; the agent resolved or withdrew it.");
  }
  if (!askableStatus(kind, gate.status, gate.shipped) || !VERSION.test(gate.version ?? "")) {
    throw fail("gate_invalid", `The approval gate on ${file} holds a status or version that no ask_approval records, so answering it would change ${file} in a way nobody asked; nothing changed. The agent asks again.`);
  }
  if (!APPROVAL_CHOICES.includes(choice)) throw fail("invalid_answer", "The answer is invalid: choice must be approve or request-changes.");
  const normalizedNote = typeof note === "string" && note.trim() ? note.trim() : null;
  if (normalizedNote !== null && normalizedNote.length > NOTE_MAX) throw fail("invalid_answer", "The answer is invalid: note must be at most 4000 characters.");
  if (choice === "request-changes" && normalizedNote === null) throw fail("invalid_answer", "The answer is invalid: a request for changes needs a note.");
  if (gate.version !== version) {
    throw fail("artifact_changed", `${file} changed since this approval was asked, so the answer would approve a version nobody asked about; nothing changed. The agent asks again for the current version.`);
  }
  const at = now.toISOString();
  const answer = { choice, note: normalizedNote, via: "browser", answeredAt: at, by, ...(entry ? { entry: entry.id } : {}) };
  const applied = entry ? { entry } : {};
  const closed = keep([...record.closed, { ...gate, answer }], CLOSED_KEPT);
  const pending = record.pending.filter((item: any) => item.id !== id);
  if (choice === "request-changes") {
    return { record: { ...record, pending, closed, history: keep([...record.history, { event: "changes_requested", gate: gate.id, at, by, ...applied }], HISTORY_KEPT) }, text: null, gate: { ...gate, answer } };
  }
  const next = rewriteStatusLines(text, gate.status, at.slice(0, 10));
  return {
    // An approval after a ship records the acceptance as a ship does, naming the shipped initiative and its verified commits, so the ADR reads as accepted by that initiative.
    record: {
      ...record, status: gate.status, pending, closed, approval: { gate: gate.id, status: gate.status, at, by },
      ...(gate.shipped ? { acceptance: { gate: gate.id, initiative: gate.shipped.initiative, at, verifiedBy: gate.shipped.verifiedBy, afterShip: true } } : {}),
      history: keep([...record.history, { event: "approved", gate: gate.id, status: gate.status, at, by, ...(gate.shipped ? { initiative: gate.shipped.initiative } : {}), ...applied }], HISTORY_KEPT)
    },
    text: next,
    gate: { ...gate, answer }
  };
}

/**
 * A record whose pending approval gate id the person withdrew in the review browser: the gate moves to the closed gates as closed "withdrawn" with closedAt and by,
 * who withdrew it as { name, host }, and the status, the accepted version, and the approval stay as they were.
 * entry is the review app's history entry of the gate.withdraw action, which the record's history keeps beside the withdrawal.
 */
export function withdrawApproval(record: any, { id, by, entry = null, now = entry?.at ? new Date(entry.at) : new Date() }: { id: string; by: any; entry?: any; now?: any }) {
  const gate = record.pending.find((item: any) => item.id === id);
  if (!gate) {
    const closed = record.closed.find((item: any) => item.id === id);
    if (closed?.answer) throw fail("gate_answered", "The question already has an answer.");
    throw fail("unknown_gate", closed ? "The question was closed without an answer, so it no longer applies." : "The question is no longer open; the agent resolved or withdrew it.");
  }
  const at = now.toISOString();
  const closed = keep([...record.closed, { ...gate, closedAt: at, closed: "withdrawn", by }], CLOSED_KEPT);
  const pending = record.pending.filter((item: any) => item.id !== id);
  return { record: { ...record, pending, closed, history: keep([...record.history, { event: "withdrawn", gate: gate.id, at, by, ...(entry ? { entry } : {}) }], HISTORY_KEPT) }, gate: closed.at(-1) };
}

/** A record with acceptedVersion set to version, as its accepted bytes at an approval, a design acceptance, or a ship. */
export function withAcceptedVersion(record: any, version: any, event: any) {
  return { ...record, acceptedVersion: version, history: keep([...record.history, { ...event, acceptedVersion: version }], HISTORY_KEPT) };
}

/**
 * The project-relative paths that the Markdown links of a file name, as CommonMark reads them, in the order they first appear: inline and reference links,
 * each resolved against the file's folder, or against the project root for a target that begins with "/", without its fragment or query.
 * A link to another site, a fragment of the file itself, and a target that leaves the project name no path, and neither does text that CommonMark shows as code, raw HTML, or escaped characters, or an image.
 * A text whose syntax would make the read look at its characters many times over gives null.
 */
export function linkedPaths(text: string, file: string) {
  const targets = markdownLinkDestinations(text);
  if (targets === null) return null;
  const found = new Set();
  for (const raw of targets) {
    const target = raw.replace(/[#?].*$/s, "");
    if (target === "" || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) continue;
    let decoded;
    try { decoded = decodeURI(target); } catch { continue; }
    const joined = decoded.startsWith("/") ? decoded.slice(1) : path.posix.join(path.posix.dirname(file), decoded);
    const normalized = path.posix.normalize(joined === "" ? "." : joined).replace(/\/+$/, "");
    if (normalized === "." || normalized === ".." || normalized.startsWith("../")) continue;
    found.add(normalized);
  }
  return [...found];
}

export const SHIP_STATUS = "Accepted";

/**
 * Accept a Proposed ADR when the initiative whose slice.md links it ships: { record, text }, where text has its Status: line set to Accepted.
 * The record keeps the status, the accepted version of the new bytes, which versionOf gives, and acceptance with the ship's correctness gate, the initiative, the time,
 * and verifiedBy, the slice, repository, and commit of each leaf slice's latest passing verification run; a pending approval gate closes, since it asked about bytes the ship rewrote.
 */
export function acceptAtShip(record: any, text: string, { gate, initiative, verifiedBy, at, versionOf }: { gate: any; initiative: string; verifiedBy: any; at: any; versionOf: any }) {
  const next = rewriteStatusLines(text, SHIP_STATUS, at.slice(0, 10));
  const version = versionOf(next);
  const closed = record.pending.map((earlier: any) => ({ ...earlier, closedAt: at, closed: "shipped" }));
  return {
    text: next,
    record: {
      ...record,
      status: SHIP_STATUS,
      acceptedVersion: version,
      pending: [],
      closed: keep([...record.closed, ...closed], CLOSED_KEPT),
      acceptance: { gate, initiative, at, verifiedBy },
      history: keep([...record.history, { event: "shipped", gate, initiative, status: SHIP_STATUS, at, acceptedVersion: version }], HISTORY_KEPT)
    }
  };
}

const byText = (left: any, right: any) => left < right ? -1 : left > right ? 1 : 0;

/**
 * The structural merge of a status record that changed on two machines, as store sync takes it: { path, base, local, upstream } as UTF-8 text, base null for a record new on both sides,
 * answering { contents } or { conflict }, which keeps the upstream record and saves this machine's.
 * Where one side's ship accepted the ADR and the other side only asked an approval or answered one without approving, the acceptance stays, so the file that the ship rewrote and the recorded status agree.
 * Gates merge by id: each approval still pending on the other side whose id the ship's record holds neither pending nor closed ends as closed "shipped",
 * a closed gate that both sides hold keeps the ship's copy, and history entries merge by their content; both sides' closed gates and history stay.
 * The merge reads only what the three records say, so every machine merges the same versions to the same bytes.
 */
export function mergeStatusRecord({ path: file, base, local, upstream }: { path: any; base: string; local: any; upstream: any }) {
  const conflict = { conflict: "The status record changed on both sides." };
  const location = file.startsWith(`${ARTIFACT_STATUS}/`) && file.endsWith(`/${STATUS_RECORD_NAME}`) ? file.slice(ARTIFACT_STATUS.length + 1, -(STATUS_RECORD_NAME.length + 1)) : null;
  const kind = location === null ? null : locationArtifact(location)?.kind ?? null;
  if (!hasStatus(kind)) return conflict;
  const [was, mine, theirs] = [base, local, upstream].map((text) => parseRecord(kind as string, text ?? null));
  const same = (left: any, right: any) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
  const shipped = (record: any) => isRecord(record.acceptance) && record.status === SHIP_STATUS && !same(record.acceptance, was.acceptance);
  if (shipped(mine) === shipped(theirs)) return conflict;
  const [ship, other] = shipped(mine) ? [mine, theirs] : [theirs, mine];
  if (other.status !== was.status || other.acceptedVersion !== was.acceptedVersion || !same(other.approval, was.approval) || !same(other.acceptance, was.acceptance)) return conflict;
  const at = typeof ship.acceptance.at === "string" ? ship.acceptance.at : null;
  const held = new Set([...ship.pending, ...ship.closed].map((gate) => gate.id));
  const ended = other.pending.filter((gate: any) => !held.has(gate.id)).map((gate: any) => ({ ...gate, closedAt: at ?? gate.askedAt ?? null, closed: "shipped" }));
  const closed = new Map();
  for (const gate of [...ship.closed, ...other.closed, ...ended]) if (!closed.has(gate.id)) closed.set(gate.id, gate);
  const history = new Map();
  for (const entry of [...ship.history, ...other.history]) history.set(canonicalJson(entry), entry);
  const record = {
    ...ship,
    closed: keep([...closed.values()].sort((left, right) => byText(String(left.closedAt ?? ""), String(right.closedAt ?? "")) || byText(left.id, right.id)), CLOSED_KEPT),
    history: keep([...history].sort(([leftKey, left], [rightKey, right]) => byText(String(left.at ?? ""), String(right.at ?? "")) || byText(leftKey, rightKey)).map(([, entry]) => entry), HISTORY_KEPT)
  };
  return { contents: serializeRecord(record) };
}

/** The work item an approval gate serves as { initiative, slice }: the initiative it names, else the shipped initiative an acceptance names, and the slice or null; null when it names none. */
export function servedWorkItem(gate: any) {
  const initiative = gate.initiative ?? gate.shipped?.initiative ?? null;
  return initiative === null ? null : { initiative, slice: gate.slice ?? null };
}

/**
 * The gates of a record as a gate wait reads them: pending ones without an answer, answered ones with it, and withdrawn ones with withdrawn { at, by: { name } };
 * a superseded gate is gone.
 */
export function waitableGates(record: any) {
  const shape = (gate: any) => ({ id: gate.id, kind: "approval", status: gate.status, question: gate.question, context: gate.context ?? null, options: APPROVAL_OPTIONS, askedAt: gate.askedAt, ...(gate.answer ? { answer: gate.answer } : {}) });
  const withdrawn = (gate: any) => ({ ...shape(gate), withdrawn: { at: gate.closedAt ?? null, by: { name: typeof gate.by?.name === "string" ? gate.by.name : null } } });
  return [...record.pending.map(shape), ...record.closed.filter((gate: any) => gate.answer).map(shape), ...record.closed.filter((gate: any) => gate.closed === "withdrawn" && !gate.answer).map(withdrawn)];
}
