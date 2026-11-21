// Generated from src/server/workflow/slice-design.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { inArtifactStore, listRecordEntries, listSliceRecords, locateRecord, readArtifactBytes, readRecord, readStoreFileBytes, STORE_FILE_BOUNDS, writeRecord } from "./record-store.mjs";
import { parseStoreJson } from "./store-json.mjs";
const FROZEN_TEST_MAX_BYTES = 4 * 1024 * 1024;
const REVIEW_MARKS = Object.freeze(["required", "none"]);
class SliceDesignError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SliceDesignError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new SliceDesignError(code, message, details);
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function frozenBytes(root, relative) {
  const normalized = path.posix.normalize(String(relative).replaceAll("\\", "/"));
  if (!relative || normalized !== relative || path.posix.isAbsolute(normalized) || normalized.startsWith("../") || normalized === "..") {
    throw fail("invalid_path", `The frozen test path ${JSON.stringify(relative)} must be a normalized project-relative path.`);
  }
  const target = path.join(root, normalized);
  let resolved;
  try {
    resolved = await realpath(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!inside(root, resolved)) throw fail("invalid_path", `The frozen test ${relative} resolves outside the project root.`);
  const handle = await open(resolved, constants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail("invalid_path", `The frozen test ${relative} must be a regular file.`);
    if (info.size > FROZEN_TEST_MAX_BYTES) throw fail("artifact_too_large", `The frozen test ${relative} exceeds 4 MiB.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const frozenDigest = (bytes) => sha256(bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1"));
async function digestFrozenTests(projectRoot, paths) {
  const root = await realpath(projectRoot);
  const result = [];
  for (const relative of [...new Set(paths)].sort()) {
    const bytes = await frozenBytes(root, relative);
    if (bytes === null) throw fail("validation_failed", `The frozen test ${relative} does not exist.`);
    result.push({ path: relative, sha256: frozenDigest(bytes) });
  }
  return result;
}
const CONTRACT_TOKEN_BUDGET = 15e4;
const BYTES_PER_TOKEN = 4;
async function measureContract(projectRoot, paths) {
  const root = await realpath(projectRoot);
  let bytes = 0;
  const missing = [];
  for (const relative of [...new Set(paths)].sort()) {
    const content = await inArtifactStore(root, relative) ? await readArtifactBytes(root, relative) : await frozenBytes(root, relative);
    if (content === null) missing.push(relative);
    else bytes += content.length;
  }
  return { tokens: Math.ceil(bytes / BYTES_PER_TOKEN), missing };
}
async function checkFrozenTests(projectRoot, frozenTests) {
  const root = await realpath(projectRoot);
  const changed = [], missing = [];
  for (const item of frozenTests) {
    const bytes = await frozenBytes(root, item.path).catch(() => null);
    if (bytes === null) missing.push(item.path);
    else if (frozenDigest(bytes) !== item.sha256) changed.push(item.path);
  }
  return { checked: frozenTests.length, changed, missing };
}
const isText = (value) => typeof value === "string" && value.length > 0;
function recordedDeclaration(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isText(value.root) && Array.isArray(value.sharedPaths) && value.sharedPaths.every(isText) && Array.isArray(value.components) && value.components.every((item) => isText(item?.component) && isText(item?.folder));
}
function designProblems(design) {
  if (design === void 0) return [];
  if (design === null || typeof design !== "object" || Array.isArray(design)) return ["design must be an object."];
  const problems = [];
  if (Object.keys(design).some((key) => !["acceptedAt", "frozenTests", "review", "views", "baselineId", "staged", "startTree", "startRecordedAt", "startDeclaration"].includes(key))) problems.push("design holds only acceptedAt, frozenTests, review, views, baselineId, staged, startTree, startRecordedAt, and startDeclaration.");
  if (design.views !== void 0 && (!Array.isArray(design.views) || design.views.some((item) => !isText(item?.path) || !isText(item?.kind) || !Number.isInteger(item?.elements) || !Number.isInteger(item?.relations) || typeof item?.dense !== "boolean"))) problems.push("design.views must list { path, kind, elements, relations, dense } entries.");
  if (design.staged !== void 0 && design.staged !== true) problems.push("design.staged must be true when present.");
  if (design.startTree !== void 0 && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(design.startTree)) || design.staged)) problems.push("design.startTree must be a Git tree identifier on a started slice's design.");
  if (design.startRecordedAt !== void 0 && (design.startTree === void 0 || typeof design.startRecordedAt !== "string" || Number.isNaN(Date.parse(design.startRecordedAt)))) problems.push("design.startRecordedAt must be an ISO timestamp beside design.startTree.");
  if (design.startDeclaration !== void 0 && (design.startTree === void 0 || !recordedDeclaration(design.startDeclaration))) problems.push("design.startDeclaration must hold root, sharedPaths, and components as { component, folder } beside design.startTree.");
  if (design.baselineId !== void 0 && !/^[0-9a-f]{64}$/.test(String(design.baselineId))) problems.push("design.baselineId must be a snapshot identifier.");
  if (typeof design.acceptedAt !== "string" || Number.isNaN(Date.parse(design.acceptedAt))) problems.push("design.acceptedAt must be an ISO timestamp.");
  if (!REVIEW_MARKS.includes(design.review)) problems.push(`design.review must be one of ${REVIEW_MARKS.join(", ")}.`);
  if (!Array.isArray(design.frozenTests) || design.frozenTests.some((item) => typeof item?.path !== "string" || !/^[0-9a-f]{64}$/.test(item?.sha256 ?? ""))) problems.push("design.frozenTests must list { path, sha256 } entries.");
  return problems;
}
async function latestVerification(projectRoot, initiative, slice) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  const latest = entries.filter((item) => item.entry?.kind === "verification").at(-1);
  return latest ? { id: latest.id, ...latest.entry } : null;
}
async function unfinishedFrozenTestsOfOthers(projectRoot, initiative, slice) {
  const located = await locateRecord(projectRoot, { kind: "initiative", initiative });
  let raw;
  try {
    raw = parseStoreJson((await readStoreFileBytes(located.target, STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null");
  } catch {
    return [];
  }
  const paths = /* @__PURE__ */ new Set();
  for (const [key, other] of Object.entries(raw?.slices ?? {})) {
    if (key === slice || other?.status === "done" || !Array.isArray(other?.design?.frozenTests)) continue;
    for (const item of other.design.frozenTests) if (typeof item?.path === "string") paths.add(item.path);
  }
  return [...paths].sort();
}
async function latestPassingRun(projectRoot, initiative, slice) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  return entries.filter((item) => item.entry?.kind === "verification" && item.entry.passed === true).at(-1) ?? null;
}
async function verifiedCode(projectRoot, initiative, slice) {
  return (await latestPassingRun(projectRoot, initiative, slice))?.entry.checkout ?? null;
}
async function verifiedAt(projectRoot, initiative, slice) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  const finished = Date.parse(entries.filter((item) => item.entry?.kind === "verification" && item.entry.passed === true).at(-1)?.entry.finishedAt ?? "");
  return Number.isNaN(finished) ? null : finished;
}
async function latestDependentsRun(projectRoot, initiative, scope) {
  const key = { kind: "runs", initiative, slice: scope };
  const latest = (await listRecordEntries(projectRoot, key)).filter((item) => item.entry?.kind === "dependents").at(-1);
  if (!latest) return null;
  return { entry: latest.entry, path: `${(await locateRecord(projectRoot, key)).path}/${latest.id}.json` };
}
async function acceptedDesign(projectRoot, initiative, slice) {
  const located = await locateRecord(projectRoot, { kind: "initiative", initiative });
  let raw;
  try {
    raw = parseStoreJson((await readStoreFileBytes(located.target, STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null");
  } catch {
    return null;
  }
  const design = raw?.slices?.[slice]?.design;
  return design && designProblems(design).length === 0 ? design : null;
}
async function restore(root, relative, bytes) {
  const target = path.join(root, relative);
  if (bytes === null) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(target, bytes);
}
async function stageFrozenTests(projectRoot, slice, frozenTests) {
  const root = await realpath(projectRoot);
  const tests = [];
  for (const item of frozenTests) {
    const bytes = await frozenBytes(root, item.path);
    if (bytes === null || frozenDigest(bytes) !== item.sha256) throw fail("validation_failed", `The frozen test ${item.path} changed while the design was accepted.`);
    tests.push({ path: item.path, content: bytes.toString("base64") });
  }
  return { slice, tests };
}
async function withdrawFrozenTests(projectRoot, initiative, staged) {
  const root = await realpath(projectRoot);
  await writeRecord(root, { kind: "frozen-tests", initiative, slice: staged.slice }, `${JSON.stringify({ schemaVersion: 1, tests: staged.tests }, null, 2)}
`);
  for (const item of staged.tests) await restore(root, item.path, null);
  return staged.tests.map((item) => item.path);
}
async function restageFrozenTests(projectRoot, initiative, slice, frozenTests) {
  const root = await realpath(projectRoot);
  const { bytes } = await readRecord(root, { kind: "frozen-tests", initiative, slice }).catch(() => ({ bytes: null }));
  let stored = [];
  try {
    stored = bytes === null ? [] : parseStoreJson(bytes.toString("utf8")).tests ?? [];
  } catch {
    stored = [];
  }
  const byPath = new Map(stored.map((item) => [item.path, item]));
  const tests = [];
  for (const item of frozenTests) {
    const current = await frozenBytes(root, item.path);
    if (current !== null && frozenDigest(current) !== item.sha256) throw fail("frozen_tests_changed", `The frozen test ${item.path} of ${slice} changed, so the slice cannot return to not-started and stage it. Restore the file first.`);
    const kept = byPath.get(item.path);
    const content = kept && frozenDigest(Buffer.from(kept.content, "base64")) === item.sha256 ? Buffer.from(kept.content, "base64") : current;
    if (content === null) throw fail("frozen_tests_missing", `The frozen test ${item.path} of ${slice} is missing from the work tree and its records, so the slice cannot return to not-started. Restore the file first.`);
    tests.push({ path: item.path, content: content.toString("base64") });
  }
  return { slice, tests };
}
async function installFrozenTests(projectRoot, initiative, slice, frozenTests) {
  const root = await realpath(projectRoot);
  const { bytes } = await readRecord(root, { kind: "frozen-tests", initiative, slice }).catch((error) => {
    if (error.tooLarge) return { bytes: null };
    throw error;
  });
  let stored = null;
  try {
    stored = bytes === null ? null : parseStoreJson(bytes.toString("utf8"));
  } catch {
    stored = null;
  }
  const byPath = new Map((stored?.tests ?? []).map((item) => [item.path, item]));
  const contents = frozenTests.map((item) => {
    const entry = byPath.get(item.path);
    const content = entry && Buffer.from(entry.content, "base64");
    if (!content || frozenDigest(content) !== item.sha256) throw fail("frozen_tests_missing", `The staged frozen test ${item.path} of ${slice} is missing from its records. Accept the design again.`);
    return [item.path, content];
  });
  for (const [relative, content] of contents) await restore(root, relative, content);
  return contents.map(([relative]) => relative);
}
async function frozenTestContent(projectRoot, initiative, slice, relative) {
  const design = await acceptedDesign(projectRoot, initiative, slice);
  const item = design?.frozenTests.find((test) => test.path === relative);
  if (!item) return null;
  const root = await realpath(projectRoot);
  const current = await frozenBytes(root, relative);
  if (current !== null && frozenDigest(current) === item.sha256) return { path: relative, bytes: current, state: "frozen" };
  const { bytes } = await readRecord(root, { kind: "frozen-tests", initiative, slice }).catch(() => ({ bytes: null }));
  let stored = [];
  try {
    stored = bytes === null ? [] : parseStoreJson(bytes.toString("utf8")).tests ?? [];
  } catch {
    stored = [];
  }
  const kept = stored.find((entry) => entry?.path === relative && typeof entry.content === "string");
  const keptBytes = kept ? Buffer.from(kept.content, "base64") : null;
  if (keptBytes && frozenDigest(keptBytes) === item.sha256) return { path: relative, bytes: keptBytes, state: current === null ? "staged" : "kept" };
  return current === null ? null : { path: relative, bytes: current, state: "changed" };
}
async function readFrozenTestOf(projectRoot, initiative, relative) {
  const root = await realpath(projectRoot);
  const bytes = await frozenBytes(root, relative);
  if (bytes !== null) return bytes;
  for (const slice of await listSliceRecords(root, initiative)) {
    const stored = await readRecord(root, { kind: "frozen-tests", initiative, slice }).catch(() => ({ bytes: null }));
    if (stored.bytes === null) continue;
    const entry = parseStoreJson(stored.bytes.toString("utf8")).tests?.find((item) => item.path === relative);
    if (entry) return Buffer.from(entry.content, "base64");
  }
  return null;
}
export {
  CONTRACT_TOKEN_BUDGET,
  REVIEW_MARKS,
  SliceDesignError,
  acceptedDesign,
  checkFrozenTests,
  designProblems,
  digestFrozenTests,
  frozenTestContent,
  installFrozenTests,
  latestDependentsRun,
  latestPassingRun,
  latestVerification,
  measureContract,
  frozenBytes as readFrozenTest,
  readFrozenTestOf,
  restageFrozenTests,
  stageFrozenTests,
  unfinishedFrozenTestsOfOthers,
  verifiedAt,
  verifiedCode,
  withdrawFrozenTests
};
