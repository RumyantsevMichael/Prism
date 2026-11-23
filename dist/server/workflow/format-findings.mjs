// Generated from src/server/workflow/format-findings.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { ArtifactCheckError, checkTargets, contentVersion, reportedKey, resolveArtifacts, targetBytes } from "./artifact-check.mjs";
import { listFormatFindingRecords, readRecord, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { parseStoreJson } from "./store-json.mjs";
const MESSAGE_MAX = 500;
const fail = (code, message, details = {}) => new ArtifactCheckError(code, message, details);
const findingKey = (id) => ({ kind: "format-finding", id });
function findingId({ path, scope, version, line, message }) {
  const label = scope === null ? null : scope.label;
  return `finding-${createHash("sha256").update(JSON.stringify([path, label, version, line, message])).digest("hex").slice(0, 32)}`;
}
function checkedInput({ artifact, message, line }) {
  if (typeof message !== "string" || message.length < 1 || message.length > MESSAGE_MAX || /[\r\n\u2028\u2029]/.test(message)) {
    throw fail("invalid_input", `message must be plain text of 1 to ${MESSAGE_MAX} characters without a line break.`);
  }
  if (line !== void 0 && line !== null && !(Number.isInteger(line) && line > 0)) throw fail("invalid_input", "line must be a positive whole number when it is given.");
  if (typeof artifact !== "string" && (artifact === null || typeof artifact !== "object" || Array.isArray(artifact))) {
    throw fail("invalid_input", "artifact must be a project-relative path or { path, scope, component }.");
  }
  return { artifact, message, line: line ?? null };
}
const plain = (record) => ({ path: record.path, scope: record.scope, type: record.type, rule: record.rule, line: record.line, message: record.message, version: record.version, reportedAt: record.reportedAt });
async function reportFormatFinding({ projectRoot, artifact, message, line }) {
  const given = checkedInput({ artifact, message, line });
  const { root, store, targets } = await resolveArtifacts({ projectRoot, paths: [given.artifact] });
  const target = targets[0];
  const version = contentVersion(await targetBytes(root, target));
  const record = { path: target.path, scope: target.scope, type: target.type, rule: `${target.type}.reported`, line: given.line, message: given.message, version };
  const id = findingId(record);
  const reported = await withRecordLock(root, findingKey(id), async () => {
    const existing = await readRecord(root, findingKey(id));
    if (existing.bytes !== null) {
      try {
        return { finding: plain(parseStoreJson(existing.bytes.toString("utf8"))) };
      } catch {
      }
    }
    const finding = { ...record, reportedAt: (/* @__PURE__ */ new Date()).toISOString() };
    await writeRecord(root, findingKey(id), `${JSON.stringify(finding, null, 2)}
`);
    return { finding: plain(finding) };
  }, fail);
  await checkTargets(root, store, targets).catch(() => {
  });
  return reported;
}
async function dropReportedFindings(projectRoot, artifacts) {
  if (!artifacts.length) return;
  const named = new Set(artifacts.map((artifact) => `${artifact.scope?.label ?? ""}\0${artifact.path}`));
  for (const { id, bytes } of await listFormatFindingRecords(projectRoot)) {
    let record;
    try {
      record = parseStoreJson(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (wellFormed(record) && named.has(`${record.scope?.label ?? ""}\0${record.path}`)) await removeRecord(projectRoot, findingKey(id));
  }
}
const wellFormed = (record) => record !== null && typeof record === "object" && typeof record.path === "string" && typeof record.version === "string" && typeof record.rule === "string" && typeof record.message === "string" && (record.line === null || Number.isInteger(record.line)) && (record.scope === null || typeof record.scope?.label === "string");
async function reportedFindings(projectRoot) {
  const found = [];
  for (const { bytes } of await listFormatFindingRecords(projectRoot)) {
    let record;
    try {
      record = parseStoreJson(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (wellFormed(record)) found.push(record);
  }
  found.sort((a, b) => String(a.reportedAt).localeCompare(String(b.reportedAt)));
  const byVersion = /* @__PURE__ */ new Map();
  for (const record of found) {
    const key = reportedKey(record.path, record.scope, record.version);
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push({ rule: record.rule, line: record.line, message: record.message });
  }
  return byVersion;
}
export {
  dropReportedFindings,
  reportFormatFinding,
  reportedFindings
};
