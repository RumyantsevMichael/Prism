// Generated from src/server/workflow/shipped-history.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { artifactPathTest, inArtifactStore, readArtifactText, readRecord, listClaimRecords, withRecordLock, writeArtifactText, writeRecord } from "./record-store.mjs";
import { isLive, parseClaim } from "./slice-claims.mjs";
import { readCoordinationState } from "./state.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
class ShippedHistoryError extends Error {
  constructor(initiative, shippedAt) {
    super(`Initiative ${initiative} shipped at ${shippedAt}, so its state is history and this change was not applied; start new work as a new initiative that references it.`);
    this.name = "ShippedHistoryError";
    this.code = "initiative_shipped";
    this.initiative = initiative;
    this.shippedAt = shippedAt;
  }
}
class UnreadableRoadmapError extends Error {
  constructor(initiative, reason) {
    super(`The roadmap record cannot be read (${reason}), so Prism cannot tell whether initiative ${initiative} shipped and this change was not applied; repair the roadmap record and try again.`);
    this.name = "UnreadableRoadmapError";
    this.code = "invalid_roadmap";
    this.initiative = initiative;
  }
}
const shipDate = (decision) => String(decision.at).slice(0, 10);
const entryShippedDecision = (entry) => entry?.decision?.kind === "shipped" && typeof entry.decision.at === "string" ? entry.decision : null;
async function roadmapEntry(projectRoot, initiative) {
  let record;
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
    if (!bytes) return { entry: void 0 };
    record = parseStoreJson(bytes.toString("utf8"));
  } catch (error) {
    return { problem: error instanceof SyntaxError ? "it is not valid JSON" : error.message, error };
  }
  const entries = Array.isArray(record?.initiatives) ? record.initiatives : [];
  return { entry: entries.find((entry) => entry?.id === initiative) };
}
async function shippedDecision(projectRoot, initiative) {
  const { entry } = await roadmapEntry(projectRoot, initiative);
  return entryShippedDecision(entry);
}
const SYSTEM_CODE = /^(E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/;
async function refuseShipped(projectRoot, initiative) {
  const { entry, problem, error } = await roadmapEntry(projectRoot, initiative);
  if (error && typeof error.code === "string" && !SYSTEM_CODE.test(error.code)) throw error;
  if (problem) throw new UnreadableRoadmapError(initiative, problem);
  const decision = entryShippedDecision(entry);
  if (decision) throw new ShippedHistoryError(initiative, decision.at);
}
async function pendingProposals(projectRoot, initiative, record) {
  if (record === void 0) {
    const { bytes } = await readRecord(projectRoot, { kind: "initiative", initiative });
    record = bytes ? parseStoreJson(bytes.toString("utf8")) : null;
  }
  const proposals = record?.proposals;
  return proposals && typeof proposals === "object" && !Array.isArray(proposals) ? Object.keys(proposals).sort() : [];
}
async function openWork(projectRoot, initiative, { record, state, now = Date.now() } = {}) {
  const coordination = state === void 0 ? await readCoordinationState({ projectRoot, initiative }) : state;
  const pending = Array.isArray(coordination?.state?.pending) ? coordination.state.pending : [];
  const gates = pending.filter((gate) => gate && typeof gate === "object" && typeof gate.id === "string").map((gate) => ({ id: gate.id, slice: gate.slice ?? null, question: gate.question ?? null, answered: Boolean(gate.answer) }));
  const claims = [];
  for (const { slice, bytes } of await listClaimRecords(projectRoot, initiative)) {
    const { claim } = parseClaim(slice, bytes);
    if (isLive(claim, now)) claims.push({ slice, label: claim.label, activity: claim.activity, expiresAt: claim.expiresAt });
  }
  claims.sort((left, right) => left.slice < right.slice ? -1 : left.slice > right.slice ? 1 : 0);
  return { gates, claims, proposals: await pendingProposals(projectRoot, initiative, record) };
}
const hasOpenWork = (work) => work.gates.length > 0 || work.claims.length > 0 || work.proposals.length > 0;
function openWorkMessage(initiative, work) {
  const parts = [];
  if (work.gates.length) parts.push(`pending user gates ${work.gates.map((gate) => `${gate.id} (${[gate.slice ? `slice ${gate.slice}` : null, gate.answered ? "answered" : "unanswered"].filter(Boolean).join(", ")})`).join(", ")}`);
  if (work.claims.length) parts.push(`live claims on ${work.claims.map((claim) => `${claim.slice} (${claim.activity} by ${claim.label} until ${claim.expiresAt})`).join(", ")}`);
  if (work.proposals.length) parts.push(`pending design proposals for ${work.proposals.join(", ")}`);
  return `Initiative ${initiative} cannot ship while work is open: ${parts.join("; ")}. Resolve each gate, finish or release each claim, and accept or replace each proposal first, because no agent can finish this work once the initiative is history.`;
}
const MARK_FIRST = /^> Shipped history: initiative `[^`]+` shipped on \d{4}-\d{2}-\d{2}, so this document records finished work\.$/;
const MARK_SECOND = "> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.";
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const historyMark = (initiative, date) => `> Shipped history: initiative \`${initiative}\` shipped on ${date}, so this document records finished work.
${MARK_SECOND}
`;
const shippedHistoryMessage = (initiative, decision) => `Initiative ${initiative} shipped on ${shipDate(decision)} and its state is history: take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite this initiative only as history.`;
function markLines(lines) {
  if (/^# /.test(lines[0] ?? "") && lines[1] === "" && MARK_FIRST.test(lines[2] ?? "") && lines[3] === MARK_SECOND) return { start: 1, end: 4 };
  if (MARK_FIRST.test(lines[0] ?? "") && lines[1] === MARK_SECOND && lines[2] === "") return { start: 0, end: 3 };
  return null;
}
function unmarkedContent(content) {
  const lines = content.split("\n");
  const found = markLines(lines);
  if (!found) return content;
  lines.splice(found.start, found.end - found.start);
  return lines.join("\n");
}
function markDocument(content, initiative, date) {
  if (markLines(content.split("\n"))) return content;
  const mark = historyMark(initiative, date);
  const end = content.indexOf("\n");
  if (/^# /.test(content) && end !== -1) return `${content.slice(0, end + 1)}
${mark}${content.slice(end + 1)}`;
  if (/^# /.test(content)) return `${content}

${mark.slice(0, -1)}`;
  return `${mark}
${content}`;
}
function insideInitiativePlans(plans, initiative, relative) {
  if (typeof relative !== "string" || path.posix.isAbsolute(relative) || path.isAbsolute(relative)) return false;
  const folder = path.posix.join(plans, initiative);
  const normalized = path.posix.normalize(relative);
  return normalized === relative && normalized.startsWith(`${folder}/`) && !normalized.split("/").includes("..");
}
async function sliceDocumentPaths(projectRoot, initiative) {
  if (!SLUG_PATTERN.test(initiative ?? "")) return [];
  let slices;
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "initiative", initiative });
    if (!bytes) return [];
    slices = parseStoreJson(bytes.toString("utf8"))?.slices;
  } catch {
    return [];
  }
  if (!slices || typeof slices !== "object" || Array.isArray(slices)) return [];
  const plans = (await readWorkflowConfig(projectRoot)).paths.plans;
  if (!plans) return [];
  const folders = Object.keys(slices).filter((slug) => SLUG_PATTERN.test(slug)).map((slug) => slices[slug]?.parent === null ? `${plans}/${initiative}` : `${plans}/${initiative}/${slug}`);
  const files = [...new Set(folders.map((folder) => path.posix.join(folder, "slice.md")))];
  return files.filter((file) => insideInitiativePlans(plans, initiative, file)).sort();
}
async function readDocument(projectRoot, relative) {
  try {
    if (await inArtifactStore(projectRoot, relative)) {
      const content = await readArtifactText(projectRoot, relative);
      return content === null ? { absent: true } : { content };
    }
    return { content: await readFile(path.join(projectRoot, relative), "utf8") };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { absent: true };
    return { problem: error.message };
  }
}
async function readSliceDocuments(projectRoot, initiative) {
  const documents = [];
  const problems = [];
  for (const relative of await sliceDocumentPaths(projectRoot, initiative)) {
    const read = await readDocument(projectRoot, relative);
    if (read.problem) problems.push({ path: relative, reason: read.problem });
    else if (!read.absent) documents.push({ path: relative, content: read.content, unmarked: unmarkedContent(read.content) });
  }
  return { documents, problems };
}
const documentDigests = (documents) => documents.map((document) => ({ path: document.path, sha256: sha256(document.unmarked) }));
async function writeHistoryMarks(projectRoot, initiative, decision, documents) {
  const marked = [];
  const problems = [];
  for (const document of documents) {
    const next = markDocument(document.content, initiative, shipDate(decision));
    if (next === document.content) continue;
    try {
      const current = await readDocument(projectRoot, document.path);
      if (current.content !== document.content) {
        const markedMeanwhile = current.content !== void 0 && markLines(current.content.split("\n")) !== null && unmarkedContent(current.content) === document.unmarked;
        if (!markedMeanwhile) problems.push({ path: document.path, reason: current.problem ?? (current.absent ? "it was removed after it was read, so it was not marked" : "it changed after it was read, so it was not marked and its recorded content is the content read") });
        continue;
      }
      if (await inArtifactStore(projectRoot, document.path)) {
        const { written } = await writeArtifactText(projectRoot, document.path, (stored) => stored === document.content ? next : void 0);
        if (!written) {
          problems.push({ path: document.path, reason: "it changed after it was read, so it was not marked and its recorded content is the content read" });
          continue;
        }
      } else await writeAtomically(path.join(projectRoot, document.path), next);
      marked.push(document.path);
    } catch (error) {
      problems.push({ path: document.path, reason: error.message });
    }
  }
  return { marked, problems };
}
async function readRoadmapBytes(projectRoot) {
  const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
  return bytes;
}
async function recordShipDocuments(projectRoot, initiative) {
  try {
    const before = await readRoadmapBytes(projectRoot);
    if (!before) return null;
    const revision = sha256(before);
    const decision = entryShippedDecision(parseStoreJson(before.toString("utf8"))?.initiatives?.find?.((entry) => entry?.id === initiative));
    if (!decision || Array.isArray(decision.documents)) return null;
    const { documents } = await readSliceDocuments(projectRoot, initiative);
    if (!documents.length) return null;
    const recorded = { ...decision, documents: documentDigests(documents), documentsRecordedAt: (/* @__PURE__ */ new Date()).toISOString(), documentsFrom: "first-read" };
    const written = await withRecordLock(projectRoot, { kind: "roadmap" }, async () => {
      const current = await readRoadmapBytes(projectRoot);
      if (!current || sha256(current) !== revision) return false;
      const record = parseStoreJson(current.toString("utf8"));
      const entry = record.initiatives.find((item) => item?.id === initiative);
      entry.decision = recorded;
      await writeRecord(projectRoot, { kind: "roadmap" }, `${JSON.stringify(record, null, 2)}
`);
      return true;
    });
    if (!written) return null;
    const { marked } = await writeHistoryMarks(projectRoot, initiative, recorded, documents);
    return { decision: recorded, marked };
  } catch {
    return null;
  }
}
async function recordEarlierShips(projectRoot, entries) {
  const results = [];
  for (const entry of entries) {
    const decision = entryShippedDecision(entry);
    if (!decision || Array.isArray(decision.documents)) continue;
    const recorded = await recordShipDocuments(projectRoot, entry.id);
    if (recorded) results.push({ initiative: entry.id, marked: recorded.marked });
  }
  return results;
}
async function documentChanges(projectRoot, initiative, recorded) {
  const changes = [];
  const known = new Set(recorded.map((item) => item.path));
  for (const item of recorded) {
    const read = await readDocument(projectRoot, item.path);
    if (read.absent) changes.push({ path: item.path, change: "removed" });
    else if (read.problem || sha256(unmarkedContent(read.content)) !== item.sha256) changes.push({ path: item.path, change: "changed" });
  }
  const { documents } = await readSliceDocuments(projectRoot, initiative);
  for (const document of documents) if (!known.has(document.path)) changes.push({ path: document.path, change: "added" });
  return changes.sort(byPath);
}
async function laterFixes(projectRoot, initiative) {
  const bytes = await readRoadmapBytes(projectRoot);
  if (!bytes) return [];
  const entries = parseStoreJson(bytes.toString("utf8"))?.initiatives;
  const fixes = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.corrects?.initiative === initiative && Array.isArray(entry.corrects.slices));
  if (!fixes.length) return [];
  const { deriveInitiative } = await import("./roadmap.mjs");
  const config = await readWorkflowConfig(projectRoot);
  const results = [];
  for (const entry of fixes) {
    const state = await deriveInitiative(projectRoot, config, entry).then((derived) => derived.state).catch(() => "envisioned");
    results.push({ initiative: entry.id, title: entry.title, state, slices: [...entry.corrects.slices] });
  }
  return results;
}
async function shippedHistory(projectRoot, initiative) {
  let decision = await shippedDecision(projectRoot, initiative);
  if (!decision) return null;
  let marked = [];
  if (!Array.isArray(decision.documents)) {
    const recorded2 = await recordShipDocuments(projectRoot, initiative);
    if (recorded2) ({ decision, marked } = recorded2);
    else decision = await shippedDecision(projectRoot, initiative) ?? decision;
  }
  const plans = Array.isArray(decision.documents) ? await readWorkflowConfig(projectRoot).then((config) => config.paths.plans).catch(() => null) : null;
  const recorded = Array.isArray(decision.documents) && plans && SLUG_PATTERN.test(initiative ?? "") ? decision.documents.filter((item) => insideInitiativePlans(plans, initiative, item?.path)).sort(byPath) : [];
  const changedAfterShip = Array.isArray(decision.documents) ? await documentChanges(projectRoot, initiative, recorded).catch(() => []) : [];
  return {
    initiative,
    shippedAt: decision.at,
    message: shippedHistoryMessage(initiative, decision),
    documents: recorded.map((item) => item.path),
    changedAfterShip,
    laterFixes: await laterFixes(projectRoot, initiative).catch(() => []),
    ...marked.length ? { marked } : {}
  };
}
const shippedHistoryLabel = (initiative, decision) => `Shipped history: ${initiative} shipped on ${shipDate(decision)}; this page records finished work.`;
const shippedActionReason = (decision) => `The initiative shipped on ${shipDate(decision)}, so its state is history.`;
async function historyMarksText(projectRoot, initiative, marked) {
  const inStore = await artifactPathTest(projectRoot).catch(() => () => false);
  const shared = marked.filter((file) => inStore(file));
  const local = marked.filter((file) => !inStore(file));
  return [
    ...local.length ? [`Prism marked these slice documents of shipped initiative ${initiative} as history: ${local.join(", ")}. Commit them in a commit of their own, apart from this task's changes.`] : [],
    ...shared.length ? [`Prism marked these slice documents of shipped initiative ${initiative} as history in the record store, which shares them with every checkout, so there is nothing to commit: ${shared.join(", ")}.`] : []
  ].join(" ");
}
export {
  ShippedHistoryError,
  UnreadableRoadmapError,
  documentDigests,
  entryShippedDecision,
  hasOpenWork,
  historyMark,
  historyMarksText,
  markDocument,
  openWork,
  openWorkMessage,
  readSliceDocuments,
  recordEarlierShips,
  recordShipDocuments,
  refuseShipped,
  roadmapEntry,
  shipDate,
  shippedActionReason,
  shippedDecision,
  shippedHistory,
  shippedHistoryLabel,
  shippedHistoryMessage,
  unmarkedContent,
  writeHistoryMarks
};
