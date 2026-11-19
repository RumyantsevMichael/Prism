import { createHash } from "node:crypto";
import { ArtifactCheckError, checkTargets, contentVersion, reportedKey, resolveArtifacts, targetBytes } from "./artifact-check.mjs";
import { listFormatFindingRecords, readRecord, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Format findings that an agent reports: a break of an artifact's format that the check does not see, recorded against the artifact's version, never a change to the artifact.
// Each is a record of its own under format-findings/, in the record store when one is configured, where its sync shares it, and under .prism otherwise.

const MESSAGE_MAX = 500;

const fail = (code, message, details = {}) => new ArtifactCheckError(code, message, details);

const findingKey = (id) => ({ kind: "format-finding", id });

// A finding's id is the hash of what it reports, so a second report of the same artifact version, line, and message names the same record.
function findingId({ path, scope, version, line, message }) {
  const label = scope === null ? null : scope.label;
  return `finding-${createHash("sha256").update(JSON.stringify([path, label, version, line, message])).digest("hex").slice(0, 32)}`;
}

function checkedInput({ artifact, message, line }) {
  if (typeof message !== "string" || message.length < 1 || message.length > MESSAGE_MAX || /[\r\n\u2028\u2029]/.test(message)) {
    throw fail("invalid_input", `message must be plain text of 1 to ${MESSAGE_MAX} characters without a line break.`);
  }
  if (line !== undefined && line !== null && !(Number.isInteger(line) && line > 0)) throw fail("invalid_input", "line must be a positive whole number when it is given.");
  if (typeof artifact !== "string" && (artifact === null || typeof artifact !== "object" || Array.isArray(artifact))) {
    throw fail("invalid_input", "artifact must be a project-relative path or { path, scope, component }.");
  }
  return { artifact, message, line: line ?? null };
}

const plain = (record) => ({ path: record.path, scope: record.scope, type: record.type, rule: record.rule, line: record.line, message: record.message, version: record.version, reportedAt: record.reportedAt });

/**
 * Record a break of an artifact's format that the check does not see: { finding: { path, scope, type, rule, line, message, version, reportedAt } }.
 * The artifact is named and refused as check_artifacts names and refuses a path, and the finding holds for the artifact's current version only.
 * A second report of the same artifact version, line, and message returns the first finding.
 */
export async function reportFormatFinding({ projectRoot, artifact, message, line }) {
  const given = checkedInput({ artifact, message, line });
  const { root, store, targets } = await resolveArtifacts({ projectRoot, paths: [given.artifact] });
  const target = targets[0];
  const version = contentVersion(await targetBytes(root, target));
  const record = { path: target.path, scope: target.scope, type: target.type, rule: `${target.type}.reported`, line: given.line, message: given.message, version };
  const id = findingId(record);
  const reported = await withRecordLock(root, findingKey(id), async () => {
    const existing = await readRecord(root, findingKey(id));
    if (existing.bytes !== null) {
      try { return { finding: plain(parseStoreJson(existing.bytes.toString("utf8"))) }; }
      catch { /* A damaged record is written again. */ }
    }
    const finding = { ...record, reportedAt: new Date().toISOString() };
    await writeRecord(root, findingKey(id), `${JSON.stringify(finding, null, 2)}\n`);
    return { finding: plain(finding) };
  }, fail);
  // The reported artifact no longer conforms, so the check that follows the report starts a run for its set when no run holds it yet.
  await checkTargets(root, store, targets).catch(() => {});
  return reported;
}

/** Drop the reported findings of the given artifacts, each { path, scope }, as a format migration run that rewrote them does. */
export async function dropReportedFindings(projectRoot, artifacts) {
  if (!artifacts.length) return;
  const named = new Set(artifacts.map((artifact) => `${artifact.scope?.label ?? ""}\0${artifact.path}`));
  for (const { id, bytes } of await listFormatFindingRecords(projectRoot)) {
    let record;
    try { record = parseStoreJson(bytes.toString("utf8")); } catch { continue; }
    if (wellFormed(record) && named.has(`${record.scope?.label ?? ""}\0${record.path}`)) await removeRecord(projectRoot, findingKey(id));
  }
}

const wellFormed = (record) => record !== null && typeof record === "object" && typeof record.path === "string" && typeof record.version === "string" && typeof record.rule === "string"
  && typeof record.message === "string" && (record.line === null || Number.isInteger(record.line)) && (record.scope === null || typeof record.scope?.label === "string");

/** The reported findings of the project by artifact version, keyed as reportedKey keys them: each [{ rule, line, message }] in the order they were reported. */
export async function reportedFindings(projectRoot) {
  const found = [];
  for (const { bytes } of await listFormatFindingRecords(projectRoot)) {
    let record;
    try { record = parseStoreJson(bytes.toString("utf8")); } catch { continue; }
    if (wellFormed(record)) found.push(record);
  }
  found.sort((a, b) => String(a.reportedAt).localeCompare(String(b.reportedAt)));
  const byVersion = new Map();
  for (const record of found) {
    const key = reportedKey(record.path, record.scope, record.version);
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push({ rule: record.rule, line: record.line, message: record.message });
  }
  return byVersion;
}
