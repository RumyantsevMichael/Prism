// Generated from src/server/workflow/artifact-status.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ARTIFACT_ACCEPTED, ARTIFACT_STATUS, artifactLocation, locationArtifact, STATUS_RECORD_NAME } from "./artifact-paths.mjs";
import { canonicalJson } from "./record-merge.mjs";
import { markdownLinkDestinations } from "./markdown-links.mjs";
import { parseStoreJson } from "./store-json.mjs";
const NEW_STATUS = Object.freeze({ requirements: "Draft", adrs: "Proposed" });
const CLOSED_KEPT = 20;
const HISTORY_KEPT = 50;
const STATUS_MAX = 200;
const GATE_TEXT_MAX = 8e3;
const NOTE_MAX = 4e3;
const APPROVAL_CHOICES = Object.freeze(["approve", "request-changes"]);
const APPROVAL_OPTIONS = Object.freeze([{ id: "approve", label: "Approve" }, { id: "request-changes", label: "Request changes" }]);
const fail = (code, message, details = {}) => Object.assign(new Error(message), { name: "ArtifactError", code, ...details });
const hasStatus = (kind) => Object.hasOwn(NEW_STATUS, kind);
const newStatus = (kind) => NEW_STATUS[kind] ?? null;
function writtenStatus(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("Status:")) return line.slice("Status:".length).trim();
  }
  return null;
}
function statusRecordLocation(scope, address) {
  return path.posix.join(ARTIFACT_STATUS, artifactLocation(scope, address), STATUS_RECORD_NAME);
}
function acceptedLocation(version) {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(version ?? "")?.[1];
  if (!hex) throw new Error(`An accepted version must be a sha256 version, not ${JSON.stringify(version)}.`);
  return path.posix.join(ARTIFACT_ACCEPTED, hex);
}
function newRecord(kind, status = null) {
  return { status: hasStatus(kind) ? status ?? newStatus(kind) : null, acceptedVersion: null, approval: null, pending: [], closed: [], history: [] };
}
function acceptedWhenMoved(kind, status) {
  return hasStatus(kind) && typeof status === "string" && status.trim() !== "" && !/[\r\n]/.test(status) && status.toLowerCase() !== newStatus(kind).toLowerCase();
}
function movedWithoutAcceptance(kind, record) {
  return acceptedWhenMoved(kind, record.status) && record.acceptedVersion === null && record.approval === null && !record.acceptance && !record.pending.length && !record.closed.length && !record.history.length;
}
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value.filter(isRecord) : [];
const VERSION = /^sha256:[0-9a-f]{64}$/;
function askableStatus(kind, status, shipped = void 0) {
  if (!(typeof status === "string" && status.length > 0 && status.length <= STATUS_MAX && status === status.trim() && !/[\r\n]/.test(status))) return false;
  if (shipped !== void 0) return kind === "adrs" && status === SHIP_STATUS && shippedAcceptance(shipped);
  return !(kind === "adrs" && /^accepted$/i.test(status));
}
function shippedAcceptance(value) {
  return isRecord(value) && typeof value.initiative === "string" && value.initiative.length > 0 && value.initiative.length <= 200 && Array.isArray(value.verifiedBy) && value.verifiedBy.length <= 1e3 && value.verifiedBy.every((item) => isRecord(item) && typeof item.slice === "string" && (item.repository === null || typeof item.repository === "string") && (item.commit === null || typeof item.commit === "string"));
}
const boundedText = (value, max) => typeof value === "string" && value.length <= max;
const optionalText = (value, max) => value === void 0 || value === null || boundedText(value, max);
const WORK_ITEM_ID = /^[A-Za-z0-9_-]{1,200}$/;
const optionalWorkItemId = (value) => value === void 0 || typeof value === "string" && WORK_ITEM_ID.test(value);
const optionalPerson = (value) => value === void 0 || value === null || isRecord(value) && boundedText(value.name, 200) && optionalText(value.host, 255);
function wellFormedGate(kind, gate) {
  if (typeof gate.id !== "string" || !gate.id || gate.id.length > 200 || !askableStatus(kind, gate.status, gate.shipped) || !VERSION.test(gate.version ?? "")) return false;
  if (!boundedText(gate.question, GATE_TEXT_MAX) || !gate.question || !optionalText(gate.context, GATE_TEXT_MAX)) return false;
  if (!optionalWorkItemId(gate.initiative) || !optionalWorkItemId(gate.slice) || gate.slice !== void 0 && gate.initiative === void 0 && gate.shipped === void 0) return false;
  if (!optionalText(gate.askedAt, 64) || !optionalText(gate.closedAt, 64) || !optionalText(gate.closed, 64) || !optionalText(gate.supersededBy, 200) || !optionalPerson(gate.by)) return false;
  if (gate.answer === void 0) return true;
  const answer = gate.answer;
  return isRecord(answer) && APPROVAL_CHOICES.includes(answer.choice) && optionalText(answer.note, NOTE_MAX) && optionalText(answer.answeredAt, 64) && optionalText(answer.via, 64) && optionalText(answer.entry, 64) && optionalPerson(answer.by);
}
function parseRecord(kind, bytes) {
  if (bytes === null || bytes === void 0) return newRecord(kind);
  let value;
  try {
    value = parseStoreJson(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
  } catch {
    return newRecord(kind);
  }
  if (!isRecord(value)) return newRecord(kind);
  const fresh = newRecord(kind);
  return {
    status: hasStatus(kind) ? typeof value.status === "string" && value.status.trim() && !/[\r\n]/.test(value.status) ? value.status : fresh.status : null,
    acceptedVersion: typeof value.acceptedVersion === "string" && VERSION.test(value.acceptedVersion) ? value.acceptedVersion : null,
    // The bounded reader refuses a record nested deeper than Prism writes, so the approval and history items it keeps never exhaust the call stack when serialized again.
    approval: isRecord(value.approval) ? value.approval : null,
    // Only a ship records an acceptance, so a record written before ships accepted ADRs, or without one, keeps no such key.
    ...isRecord(value.acceptance) ? { acceptance: value.acceptance } : {},
    // A gate that ask_approval could not have recorded is dropped, so Attention never offers it and no answer can apply it.
    pending: list(value.pending).filter((gate) => wellFormedGate(kind, gate)),
    closed: list(value.closed).filter((gate) => wellFormedGate(kind, gate)),
    history: list(value.history)
  };
}
const serializeRecord = (record) => `${JSON.stringify(record)}
`;
const keep = (entries, count) => entries.slice(-count);
const latestAnsweredGate = (record) => record.closed.findLast((gate) => gate.answer) ?? null;
const answerFields = (gate) => ({ gate: gate.id, status: gate.status, choice: gate.answer.choice, note: gate.answer.note ?? null, answeredAt: gate.answer.answeredAt ?? null, by: gate.answer.by ?? null, entry: typeof gate.answer.entry === "string" ? gate.answer.entry : null });
function statusFields(kind, record, version) {
  const answered = latestAnsweredGate(record);
  const from = acceptedFrom(record);
  return {
    ...hasStatus(kind) ? { status: record.status } : {},
    acceptedVersion: record.acceptedVersion,
    changedSinceAccepted: record.acceptedVersion !== version,
    ...from ? { acceptedFrom: from } : {},
    ...record.approval ? { approval: record.approval } : {},
    ...record.acceptance ? { acceptance: record.acceptance } : {},
    ...answered ? { latestAnswer: answerFields(answered) } : {}
  };
}
function acceptedFrom(record) {
  if (record.acceptedVersion === null) return null;
  const item = [...record.history].reverse().find((entry) => isRecord(entry) && entry.acceptedVersion === record.acceptedVersion);
  return item?.event === "migrated" && typeof item.migration === "string" ? { migration: item.migration, at: typeof item.at === "string" ? item.at : null } : null;
}
function statusMismatch(kind, file, text, record) {
  if (!hasStatus(kind)) return null;
  const written = writtenStatus(text);
  if (written === record.status) return null;
  const says = written === null ? `${file} has no Status: line before its first ## heading` : `${file} says Status: ${written}`;
  const treated = `Prism treats it as ${record.status}, its recorded status, and the write was kept.`;
  const approval = `Only a person's answer at an approval gate changes it: ask with an update_artifact ask_approval operation${written ? ` with status ${JSON.stringify(written)}` : ""}, which the person answers on Attention in the review browser, and leave the Status: line to that gate.`;
  const message = kind === "adrs" && /^accepted$/i.test(written ?? "") ? `${says}, but its recorded status is ${record.status}. An ADR becomes Accepted only when a person confirms that an initiative whose slice.md links it ships, which records the acceptance; another status changes at an approval gate. ${treated}` : `${says}, but its recorded status is ${record.status}. ${approval}${kind === "adrs" ? " An ADR becomes Accepted only when its initiative ships." : ""} ${treated}`;
  return { written, recorded: record.status, message };
}
function askApproval(kind, file, record, { status, question, context, version, shipped, initiative, slice, now = /* @__PURE__ */ new Date() }) {
  if (!hasStatus(kind)) throw notAStatusArtifact(file);
  const wanted = typeof status === "string" ? status.trim() : shipped ? SHIP_STATUS : "Approved";
  if (!wanted || wanted.length > STATUS_MAX || /[\r\n]/.test(wanted)) throw fail("validation_failed", `The status of an approval gate is one line of 1 to ${STATUS_MAX} characters, such as Approved.`);
  if (shipped) {
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
    ...typeof initiative === "string" ? { initiative } : {},
    ...typeof slice === "string" ? { slice } : {},
    ...shipped ? { shipped: { initiative: shipped.initiative, verifiedBy: shipped.verifiedBy } } : {}
  };
  const superseded = record.pending.map((earlier) => ({ ...earlier, closedAt: at, closed: "superseded", supersededBy: gate.id }));
  return { record: { ...record, pending: [gate], closed: keep([...record.closed, ...superseded], CLOSED_KEPT) }, gate };
}
const notAStatusArtifact = (file) => fail("not_a_status_artifact", `${file} is no requirement or ADR, so it has no status to approve; approval gates apply only to files under the configured Requirements and ADRs folders.`);
const STATUS_LINE = /^Status:[^\r\n]*(\r?\n|$)/;
const APPROVED_LINE = /^Approved:[^\r\n]*(\r?\n|$)/;
const FENCE = /^---\r?\n?$/;
function frontMatterEnd(lines) {
  if (!FENCE.test(lines[0] ?? "")) return 0;
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  return close < 0 ? 0 : close + 1;
}
function rewriteStatusLines(text, status, date) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const heading = lines.findIndex((line) => line.startsWith("## "));
  const head = heading < 0 ? lines.length : heading;
  const ending = (line) => /\r?\n$/.exec(line)?.[0] ?? "";
  let at = lines.slice(0, head).findIndex((line) => STATUS_LINE.test(line));
  if (at < 0) {
    const body = Math.min(frontMatterEnd(lines), head);
    const found = lines.slice(body, head).findIndex((line) => line.startsWith("# "));
    const title = found < 0 ? -1 : body + found;
    const newline = lines.map(ending).find(Boolean) ?? "\n";
    at = title < 0 ? body : title + 1;
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
    const front = frontMatterEnd(lines);
    const from = at >= front ? front : 0;
    const found = lines.slice(from, end < 0 ? lines.length : end).findIndex((line) => APPROVED_LINE.test(line));
    const approved = found < 0 ? -1 : from + found;
    const newline = ending(lines[at]) || lines.map(ending).find(Boolean) || "\n";
    if (approved >= 0) lines[approved] = `Approved: ${date}${ending(lines[approved])}`;
    else {
      const last = at + 1 >= lines.length;
      const closing = last && !ending(lines[at]) ? "" : newline;
      if (!ending(lines[at])) lines[at] += newline;
      lines.splice(at + 1, 0, `Approved: ${date}${closing}`);
    }
  }
  return lines.join("");
}
function answerApproval(kind, file, record, { id, choice, note = null, by, version, text, entry = null, now = entry?.at ? new Date(entry.at) : /* @__PURE__ */ new Date() }) {
  const gate = record.pending.find((item) => item.id === id);
  if (!gate) {
    const closed2 = record.closed.find((item) => item.id === id);
    if (closed2?.answer) throw fail("gate_answered", "The question already has an answer.");
    throw fail("unknown_gate", closed2 ? "The question was closed without an answer, so it no longer applies." : "The question is no longer open; the agent resolved or withdrew it.");
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
  const answer = { choice, note: normalizedNote, via: "browser", answeredAt: at, by, ...entry ? { entry: entry.id } : {} };
  const applied = entry ? { entry } : {};
  const closed = keep([...record.closed, { ...gate, answer }], CLOSED_KEPT);
  const pending = record.pending.filter((item) => item.id !== id);
  if (choice === "request-changes") {
    return { record: { ...record, pending, closed, history: keep([...record.history, { event: "changes_requested", gate: gate.id, at, by, ...applied }], HISTORY_KEPT) }, text: null, gate: { ...gate, answer } };
  }
  const next = rewriteStatusLines(text, gate.status, at.slice(0, 10));
  return {
    // An approval after a ship records the acceptance as a ship does, naming the shipped initiative and its verified commits, so the ADR reads as accepted by that initiative.
    record: {
      ...record,
      status: gate.status,
      pending,
      closed,
      approval: { gate: gate.id, status: gate.status, at, by },
      ...gate.shipped ? { acceptance: { gate: gate.id, initiative: gate.shipped.initiative, at, verifiedBy: gate.shipped.verifiedBy, afterShip: true } } : {},
      history: keep([...record.history, { event: "approved", gate: gate.id, status: gate.status, at, by, ...gate.shipped ? { initiative: gate.shipped.initiative } : {}, ...applied }], HISTORY_KEPT)
    },
    text: next,
    gate: { ...gate, answer }
  };
}
function withdrawApproval(record, { id, by, entry = null, now = entry?.at ? new Date(entry.at) : /* @__PURE__ */ new Date() }) {
  const gate = record.pending.find((item) => item.id === id);
  if (!gate) {
    const closed2 = record.closed.find((item) => item.id === id);
    if (closed2?.answer) throw fail("gate_answered", "The question already has an answer.");
    throw fail("unknown_gate", closed2 ? "The question was closed without an answer, so it no longer applies." : "The question is no longer open; the agent resolved or withdrew it.");
  }
  const at = now.toISOString();
  const closed = keep([...record.closed, { ...gate, closedAt: at, closed: "withdrawn", by }], CLOSED_KEPT);
  const pending = record.pending.filter((item) => item.id !== id);
  return { record: { ...record, pending, closed, history: keep([...record.history, { event: "withdrawn", gate: gate.id, at, by, ...entry ? { entry } : {} }], HISTORY_KEPT) }, gate: closed.at(-1) };
}
function withAcceptedVersion(record, version, event) {
  return { ...record, acceptedVersion: version, history: keep([...record.history, { ...event, acceptedVersion: version }], HISTORY_KEPT) };
}
function linkedPaths(text, file) {
  const targets = markdownLinkDestinations(text);
  if (targets === null) return null;
  const found = /* @__PURE__ */ new Set();
  for (const raw of targets) {
    const target = raw.replace(/[#?].*$/s, "");
    if (target === "" || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) continue;
    let decoded;
    try {
      decoded = decodeURI(target);
    } catch {
      continue;
    }
    const joined = decoded.startsWith("/") ? decoded.slice(1) : path.posix.join(path.posix.dirname(file), decoded);
    const normalized = path.posix.normalize(joined === "" ? "." : joined).replace(/\/+$/, "");
    if (normalized === "." || normalized === ".." || normalized.startsWith("../")) continue;
    found.add(normalized);
  }
  return [...found];
}
const SHIP_STATUS = "Accepted";
function acceptAtShip(record, text, { gate, initiative, verifiedBy, at, versionOf }) {
  const next = rewriteStatusLines(text, SHIP_STATUS, at.slice(0, 10));
  const version = versionOf(next);
  const closed = record.pending.map((earlier) => ({ ...earlier, closedAt: at, closed: "shipped" }));
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
const byText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function mergeStatusRecord({ path: file, base, local, upstream }) {
  const conflict = { conflict: "The status record changed on both sides." };
  const location = file.startsWith(`${ARTIFACT_STATUS}/`) && file.endsWith(`/${STATUS_RECORD_NAME}`) ? file.slice(ARTIFACT_STATUS.length + 1, -(STATUS_RECORD_NAME.length + 1)) : null;
  const kind = location === null ? null : locationArtifact(location)?.kind ?? null;
  if (!hasStatus(kind)) return conflict;
  const [was, mine, theirs] = [base, local, upstream].map((text) => parseRecord(kind, text ?? null));
  const same = (left, right) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
  const shipped = (record2) => isRecord(record2.acceptance) && record2.status === SHIP_STATUS && !same(record2.acceptance, was.acceptance);
  if (shipped(mine) === shipped(theirs)) return conflict;
  const [ship, other] = shipped(mine) ? [mine, theirs] : [theirs, mine];
  if (other.status !== was.status || other.acceptedVersion !== was.acceptedVersion || !same(other.approval, was.approval) || !same(other.acceptance, was.acceptance)) return conflict;
  const at = typeof ship.acceptance.at === "string" ? ship.acceptance.at : null;
  const held = new Set([...ship.pending, ...ship.closed].map((gate) => gate.id));
  const ended = other.pending.filter((gate) => !held.has(gate.id)).map((gate) => ({ ...gate, closedAt: at ?? gate.askedAt ?? null, closed: "shipped" }));
  const closed = /* @__PURE__ */ new Map();
  for (const gate of [...ship.closed, ...other.closed, ...ended]) if (!closed.has(gate.id)) closed.set(gate.id, gate);
  const history = /* @__PURE__ */ new Map();
  for (const entry of [...ship.history, ...other.history]) history.set(canonicalJson(entry), entry);
  const record = {
    ...ship,
    closed: keep([...closed.values()].sort((left, right) => byText(String(left.closedAt ?? ""), String(right.closedAt ?? "")) || byText(left.id, right.id)), CLOSED_KEPT),
    history: keep([...history].sort(([leftKey, left], [rightKey, right]) => byText(String(left.at ?? ""), String(right.at ?? "")) || byText(leftKey, rightKey)).map(([, entry]) => entry), HISTORY_KEPT)
  };
  return { contents: serializeRecord(record) };
}
function servedWorkItem(gate) {
  const initiative = gate.initiative ?? gate.shipped?.initiative ?? null;
  return initiative === null ? null : { initiative, slice: gate.slice ?? null };
}
function waitableGates(record) {
  const shape = (gate) => ({ id: gate.id, kind: "approval", status: gate.status, question: gate.question, context: gate.context ?? null, options: APPROVAL_OPTIONS, askedAt: gate.askedAt, ...gate.answer ? { answer: gate.answer } : {} });
  const withdrawn = (gate) => ({ ...shape(gate), withdrawn: { at: gate.closedAt ?? null, by: { name: typeof gate.by?.name === "string" ? gate.by.name : null } } });
  return [...record.pending.map(shape), ...record.closed.filter((gate) => gate.answer).map(shape), ...record.closed.filter((gate) => gate.closed === "withdrawn" && !gate.answer).map(withdrawn)];
}
export {
  APPROVAL_CHOICES,
  APPROVAL_OPTIONS,
  SHIP_STATUS,
  acceptAtShip,
  acceptedLocation,
  acceptedWhenMoved,
  answerApproval,
  answerFields,
  askApproval,
  askableStatus,
  hasStatus,
  latestAnsweredGate,
  linkedPaths,
  mergeStatusRecord,
  movedWithoutAcceptance,
  newRecord,
  newStatus,
  notAStatusArtifact,
  parseRecord,
  rewriteStatusLines,
  serializeRecord,
  servedWorkItem,
  shippedAcceptance,
  statusFields,
  statusMismatch,
  statusRecordLocation,
  waitableGates,
  withAcceptedVersion,
  withdrawApproval,
  writtenStatus
};
