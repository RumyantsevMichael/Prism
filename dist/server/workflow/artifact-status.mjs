import { randomBytes } from "node:crypto";
import path from "node:path";
import { ARTIFACT_ACCEPTED, ARTIFACT_STATUS, artifactLocation, STATUS_RECORD_NAME } from "./artifact-paths.mjs";

// A requirement's and an ADR's status is recorded in the store beside the artifact, and only a person's answer at a gate changes it.
// The status record of an artifact lives at artifact-status/<its location>/status.json, so it moves and goes with the artifact,
// and the accepted bytes are kept once under their hash in artifact-accepted/, since an approval and a design acceptance may keep the same bytes.
// The artifact lock guards both as it guards artifacts/, so store sync commits an update's artifact and record together.
const NEW_STATUS = Object.freeze({ requirements: "Draft", adrs: "Proposed" });
const CLOSED_KEPT = 20;
const HISTORY_KEPT = 50;
const STATUS_MAX = 200;
export const APPROVAL_CHOICES = Object.freeze(["approve", "request-changes"]);
export const APPROVAL_OPTIONS = Object.freeze([{ id: "approve", label: "Approve" }, { id: "request-changes", label: "Request changes" }]);

const fail = (code, message, details = {}) => Object.assign(new Error(message), { name: "ArtifactError", code, ...details });

/** Whether an artifact kind has a recorded status: requirements and ADRs. */
export const hasStatus = (kind) => Object.hasOwn(NEW_STATUS, kind);

/** The status a new requirement or ADR is recorded with. */
export const newStatus = (kind) => NEW_STATUS[kind] ?? null;

/** The written status of a requirement or ADR: the text after Status: on the first line beginning with Status: before its first level-two heading, or null. */
export function writtenStatus(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("Status:")) return line.slice("Status:".length).trim();
  }
  return null;
}

/** The store-relative path of an artifact's status record: artifact-status/<the artifact's location>/status.json, at most 186 characters for a location of at most 120. */
export function statusRecordLocation(scope, address) {
  return path.posix.join(ARTIFACT_STATUS, artifactLocation(scope, address), STATUS_RECORD_NAME);
}

/** The store-relative path of the accepted bytes of a version, kept once for the whole store under their hash. */
export function acceptedLocation(version) {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(version ?? "")?.[1];
  if (!hex) throw new Error(`An accepted version must be a sha256 version, not ${JSON.stringify(version)}.`);
  return path.posix.join(ARTIFACT_ACCEPTED, hex);
}

/** The record of an artifact that no gate has changed yet: a new requirement is Draft and a new ADR Proposed, unless status gives the written status of a moved file. */
export function newRecord(kind, status = null) {
  return { status: hasStatus(kind) ? status ?? newStatus(kind) : null, acceptedVersion: null, approval: null, pending: [], closed: [], history: [] };
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value.filter(isRecord) : [];
const VERSION = /^sha256:[0-9a-f]{64}$/;

/** Whether a status is one that an approval gate may ask for: one line of 1 to 200 characters without surrounding spaces, and never Accepted on an ADR, which only a ship records. */
export function askableStatus(kind, status) {
  return typeof status === "string" && status.length > 0 && status.length <= STATUS_MAX && status === status.trim() && !/[\r\n]/.test(status) && !(kind === "adrs" && /^accepted$/i.test(status));
}

/**
 * Whether a stored gate is one that ask_approval could have recorded: a string id, an askable status, and a sha256 version,
 * and, once answered, a known choice with a note of at most 4000 characters.
 * A gate that a damaged file or another writer placed in a synced record otherwise could decide what an approval writes.
 */
function wellFormedGate(kind, gate) {
  if (typeof gate.id !== "string" || !gate.id || !askableStatus(kind, gate.status) || !VERSION.test(gate.version ?? "")) return false;
  if (gate.answer === undefined) return true;
  const answer = gate.answer;
  return isRecord(answer) && APPROVAL_CHOICES.includes(answer.choice) && (answer.note === null || answer.note === undefined || (typeof answer.note === "string" && answer.note.length <= 4000));
}

/**
 * The status record held in bytes, or a new record when there are none.
 * A record that does not parse counts as a new one, so a damaged file never lends an artifact a status that no gate recorded.
 */
export function parseRecord(kind, bytes) {
  if (bytes === null || bytes === undefined) return newRecord(kind);
  let value;
  try { value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); }
  catch { return newRecord(kind); }
  if (!isRecord(value)) return newRecord(kind);
  const fresh = newRecord(kind);
  return {
    status: hasStatus(kind) ? (typeof value.status === "string" && value.status.trim() && !/[\r\n]/.test(value.status) ? value.status : fresh.status) : null,
    acceptedVersion: typeof value.acceptedVersion === "string" && VERSION.test(value.acceptedVersion) ? value.acceptedVersion : null,
    approval: isRecord(value.approval) ? value.approval : null,
    // A gate that ask_approval could not have recorded is dropped, so Attention never offers it and no answer can apply it.
    pending: list(value.pending).filter((gate) => wellFormedGate(kind, gate)),
    closed: list(value.closed).filter((gate) => wellFormedGate(kind, gate)),
    history: list(value.history)
  };
}

// A record is one line, so two machines that change it before either syncs meet as a line conflict: the upstream record stays whole, and the other is saved and reported.
export const serializeRecord = (record) => `${JSON.stringify(record)}\n`;

const keep = (entries, count) => entries.slice(-count);

/** The latest answered approval gate of a record, or null. */
export const latestAnsweredGate = (record) => record.closed.findLast((gate) => gate.answer) ?? null;

/** A person's answer to an approval gate as get_artifact returns it: { gate, status, choice, note, answeredAt, by }. */
export const answerFields = (gate) => ({ gate: gate.id, status: gate.status, choice: gate.answer.choice, note: gate.answer.note ?? null, answeredAt: gate.answer.answeredAt ?? null, by: gate.answer.by ?? null });

/** The fields that get_artifact returns from a status record for an artifact whose bytes have version. */
export function statusFields(kind, record, version) {
  const answered = latestAnsweredGate(record);
  return {
    ...(hasStatus(kind) ? { status: record.status } : {}),
    acceptedVersion: record.acceptedVersion,
    changedSinceAccepted: record.acceptedVersion !== version,
    ...(record.approval ? { approval: record.approval } : {}),
    ...(answered ? { latestAnswer: answerFields(answered) } : {})
  };
}

/** A mismatch between the written and the recorded status, as { written, recorded, message }, or null when they agree or the kind has no status. */
export function statusMismatch(kind, file, text, record) {
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
export function askApproval(kind, file, record, { status = "Approved", question, context, version, now = new Date() }) {
  if (!hasStatus(kind)) throw notAStatusArtifact(file);
  const wanted = typeof status === "string" ? status.trim() : "";
  if (!wanted || wanted.length > STATUS_MAX || /[\r\n]/.test(wanted)) throw fail("validation_failed", `The status of an approval gate is one line of 1 to ${STATUS_MAX} characters, such as Approved.`);
  if (kind === "adrs" && /^accepted$/i.test(wanted)) {
    throw fail("status_by_ship", `${file} is an ADR, which becomes Accepted only when a person confirms that an initiative whose slice.md links it ships; no approval gate accepts it. Ask approval for another status, such as Superseded, or ship the initiative after its correctness gate.`);
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
    askedAt: at
  };
  const superseded = record.pending.map((earlier) => ({ ...earlier, closedAt: at, closed: "superseded", supersededBy: gate.id }));
  return { record: { ...record, pending: [gate], closed: keep([...record.closed, ...superseded], CLOSED_KEPT) }, gate };
}

export const notAStatusArtifact = (file) => fail("not_a_status_artifact", `${file} is no requirement or ADR, so it has no status to approve; approval gates apply only to files under the configured Requirements and ADRs folders.`);

const STATUS_LINE = /^Status:[^\r\n]*(\r?\n|$)/;
const APPROVED_LINE = /^Approved:[^\r\n]*(\r?\n|$)/;
const FENCE = /^---\r?\n?$/;

// The index of the first line after a YAML front matter block that opens on the file's first line, or 0 when the file has none.
function frontMatterEnd(lines) {
  if (!FENCE.test(lines[0] ?? "")) return 0;
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  return close < 0 ? 0 : close + 1;
}

/**
 * The text of a requirement or ADR with its Status: line set to status and, for Approved, its Approved: line set to the date, added after the Status: line when it has none.
 * Only lines before the first level-two heading count, as for the written status; a file with no Status: line there gains one after its title.
 */
export function rewriteStatusLines(text, status, date) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const heading = lines.findIndex((line) => line.startsWith("## "));
  const head = heading < 0 ? lines.length : heading;
  const ending = (line) => /\r?\n$/.exec(line)?.[0] ?? "";
  let at = lines.slice(0, head).findIndex((line) => STATUS_LINE.test(line));
  if (at < 0) {
    // YAML front matter stays the file's first lines, and a "# " comment inside it is no title.
    const body = Math.min(frontMatterEnd(lines), head);
    const found = lines.slice(body, head).findIndex((line) => line.startsWith("# "));
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
    const end = lines.findIndex((line, index) => index > at && line.startsWith("## "));
    // An Approved: line counts in the same part of the file as the Status: line, front matter or the text after it.
    const front = frontMatterEnd(lines);
    const from = at >= front ? front : 0;
    const found = lines.slice(from, end < 0 ? lines.length : end).findIndex((line) => APPROVED_LINE.test(line));
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
 */
export function answerApproval(kind, file, record, { id, choice, note = null, by, version, text, now = new Date() }) {
  const gate = record.pending.find((item) => item.id === id);
  if (!gate) {
    const closed = record.closed.find((item) => item.id === id);
    if (closed?.answer) throw fail("gate_answered", "The question already has an answer.");
    throw fail("unknown_gate", closed ? "The agent asked again since this question, so it no longer applies." : "The question is no longer open; the agent resolved or withdrew it.");
  }
  if (!askableStatus(kind, gate.status) || !VERSION.test(gate.version ?? "")) {
    throw fail("gate_invalid", `The approval gate on ${file} holds a status or version that no ask_approval records, so answering it would change ${file} in a way nobody asked; nothing changed. The agent asks again.`);
  }
  if (!APPROVAL_CHOICES.includes(choice)) throw fail("invalid_answer", "The answer is invalid: choice must be approve or request-changes.");
  const normalizedNote = typeof note === "string" && note.trim() ? note.trim() : null;
  if (normalizedNote !== null && normalizedNote.length > 4000) throw fail("invalid_answer", "The answer is invalid: note must be at most 4000 characters.");
  if (choice === "request-changes" && normalizedNote === null) throw fail("invalid_answer", "The answer is invalid: a request for changes needs a note.");
  if (gate.version !== version) {
    throw fail("artifact_changed", `${file} changed since this approval was asked, so the answer would approve a version nobody asked about; nothing changed. The agent asks again for the current version.`);
  }
  const at = now.toISOString();
  const answer = { choice, note: normalizedNote, via: "browser", answeredAt: at, by };
  const closed = keep([...record.closed, { ...gate, answer }], CLOSED_KEPT);
  const pending = record.pending.filter((item) => item.id !== id);
  if (choice === "request-changes") {
    return { record: { ...record, pending, closed, history: keep([...record.history, { event: "changes_requested", gate: gate.id, at, by }], HISTORY_KEPT) }, text: null, gate: { ...gate, answer } };
  }
  const next = rewriteStatusLines(text, gate.status, at.slice(0, 10));
  return {
    record: { ...record, status: gate.status, pending, closed, approval: { gate: gate.id, status: gate.status, at, by }, history: keep([...record.history, { event: "approved", gate: gate.id, status: gate.status, at, by }], HISTORY_KEPT) },
    text: next,
    gate: { ...gate, answer }
  };
}

/** A record with acceptedVersion set to version, as its accepted bytes at an approval, a design acceptance, or a ship. */
export function withAcceptedVersion(record, version, event) {
  return { ...record, acceptedVersion: version, history: keep([...record.history, { ...event, acceptedVersion: version }], HISTORY_KEPT) };
}

/** The gates of a record as a gate wait reads them: pending ones without an answer and answered ones with it; a superseded gate is gone. */
export function waitableGates(record) {
  const shape = (gate) => ({ id: gate.id, kind: "approval", status: gate.status, question: gate.question, context: gate.context ?? null, options: APPROVAL_OPTIONS, askedAt: gate.askedAt, ...(gate.answer ? { answer: gate.answer } : {}) });
  return [...record.pending.map(shape), ...record.closed.filter((gate) => gate.answer).map(shape)];
}
