import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { listRecordEntries, listSliceRecords, locateRecord, readRecord, writeRecord } from "./record-store.mjs";

const FROZEN_TEST_MAX_BYTES = 4 * 1024 * 1024;
export const REVIEW_MARKS = Object.freeze(["required", "none"]);

export class SliceDesignError extends Error {
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

// A frozen test is a regular file inside the project, named by a normalized project-relative path.
async function frozenBytes(root, relative) {
  const normalized = path.posix.normalize(String(relative).replaceAll("\\", "/"));
  if (!relative || normalized !== relative || path.posix.isAbsolute(normalized) || normalized.startsWith("../") || normalized === "..") {
    throw fail("invalid_path", `The frozen test path ${JSON.stringify(relative)} must be a normalized project-relative path.`);
  }
  const target = path.join(root, normalized);
  let resolved;
  try { resolved = await realpath(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!inside(root, resolved)) throw fail("invalid_path", `The frozen test ${relative} resolves outside the project root.`);
  const handle = await open(resolved, constants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail("invalid_path", `The frozen test ${relative} must be a regular file.`);
    if (info.size > FROZEN_TEST_MAX_BYTES) throw fail("artifact_too_large", `The frozen test ${relative} exceeds 4 MiB.`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export { frozenBytes as readFrozenTest };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Digest each frozen test at design acceptance; a missing file cannot be frozen. */
export async function digestFrozenTests(projectRoot, paths) {
  const root = await realpath(projectRoot);
  const result = [];
  for (const relative of [...new Set(paths)].sort()) {
    const bytes = await frozenBytes(root, relative);
    if (bytes === null) throw fail("validation_failed", `The frozen test ${relative} does not exist.`);
    result.push({ path: relative, sha256: sha256(bytes) });
  }
  return result;
}

/** Compare the frozen tests of an accepted design with the files on disk. */
export async function checkFrozenTests(projectRoot, frozenTests) {
  const root = await realpath(projectRoot);
  const changed = [], missing = [];
  for (const item of frozenTests) {
    const bytes = await frozenBytes(root, item.path).catch(() => null);
    if (bytes === null) missing.push(item.path);
    else if (sha256(bytes) !== item.sha256) changed.push(item.path);
  }
  return { checked: frozenTests.length, changed, missing };
}

/** Problems with a stored slice design, or an empty list. */
export function designProblems(design) {
  if (design === undefined) return [];
  if (design === null || typeof design !== "object" || Array.isArray(design)) return ["design must be an object."];
  const problems = [];
  if (Object.keys(design).some((key) => !["acceptedAt", "frozenTests", "review", "baselineId", "staged"].includes(key))) problems.push("design holds only acceptedAt, frozenTests, review, baselineId, and staged.");
  if (design.staged !== undefined && design.staged !== true) problems.push("design.staged must be true when present.");
  if (design.baselineId !== undefined && !/^[0-9a-f]{64}$/.test(String(design.baselineId))) problems.push("design.baselineId must be a snapshot identifier.");
  if (typeof design.acceptedAt !== "string" || Number.isNaN(Date.parse(design.acceptedAt))) problems.push("design.acceptedAt must be an ISO timestamp.");
  if (!REVIEW_MARKS.includes(design.review)) problems.push(`design.review must be one of ${REVIEW_MARKS.join(", ")}.`);
  if (!Array.isArray(design.frozenTests) || design.frozenTests.some((item) => typeof item?.path !== "string" || !/^[0-9a-f]{64}$/.test(item?.sha256 ?? ""))) problems.push("design.frozenTests must list { path, sha256 } entries.");
  return problems;
}

/** The latest verification run of a slice, or null. */
export async function latestVerification(projectRoot, initiative, slice) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  const latest = entries.filter((item) => item.entry?.kind === "verification").at(-1);
  return latest ? { id: latest.id, ...latest.entry } : null;
}

/** The accepted design of a slice, read from its initiative record, or null for a slice designed before verification runs existed. */
export async function acceptedDesign(projectRoot, initiative, slice) {
  const located = await locateRecord(projectRoot, { kind: "initiative", initiative });
  let raw;
  try { raw = JSON.parse(await readFile(located.target, "utf8")); }
  catch { return null; }
  const design = raw?.slices?.[slice]?.design;
  return design && designProblems(design).length === 0 ? design : null;
}

async function restore(root, relative, bytes) {
  const target = path.join(root, relative);
  if (bytes === null) { await rm(target, { force: true }); return; }
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(target, bytes);
}

/** Read the frozen tests of a slice that has not started, so the update can keep them once its record is written. */
export async function stageFrozenTests(projectRoot, slice, frozenTests) {
  const root = await realpath(projectRoot);
  const tests = [];
  for (const item of frozenTests) {
    const bytes = await frozenBytes(root, item.path);
    if (bytes === null || sha256(bytes) !== item.sha256) throw fail("validation_failed", `The frozen test ${item.path} changed while the design was accepted.`);
    tests.push({ path: item.path, content: bytes.toString("base64") });
  }
  return { slice, tests };
}

/**
 * Keep staged frozen tests in the slice's records, then take them out of the work tree, so the test command of an earlier slice never runs them.
 * A staged file leaves the work tree whole until its slice starts, which is why each slice owns its own test files.
 */
export async function withdrawFrozenTests(projectRoot, initiative, staged) {
  const root = await realpath(projectRoot);
  await writeRecord(root, { kind: "frozen-tests", initiative, slice: staged.slice }, `${JSON.stringify({ schemaVersion: 1, tests: staged.tests }, null, 2)}\n`);
  for (const item of staged.tests) await restore(root, item.path, null);
  return staged.tests.map((item) => item.path);
}

/** Put a staged slice's frozen tests in place when the slice starts. */
export async function installFrozenTests(projectRoot, initiative, slice, frozenTests) {
  const root = await realpath(projectRoot);
  const { bytes } = await readRecord(root, { kind: "frozen-tests", initiative, slice });
  const stored = bytes === null ? null : JSON.parse(bytes.toString("utf8"));
  const byPath = new Map((stored?.tests ?? []).map((item) => [item.path, item]));
  const contents = frozenTests.map((item) => {
    const entry = byPath.get(item.path);
    const content = entry && Buffer.from(entry.content, "base64");
    if (!content || sha256(content) !== item.sha256) throw fail("frozen_tests_missing", `The staged frozen test ${item.path} of ${slice} is missing from its records. Accept the design again.`);
    return [item.path, content];
  });
  for (const [relative, content] of contents) await restore(root, relative, content);
  return contents.map(([relative]) => relative);
}

/** A frozen test's bytes from the work tree, or from the staged tests of a slice that has not started; null when neither holds it. */
export async function readFrozenTestOf(projectRoot, initiative, relative) {
  const root = await realpath(projectRoot);
  const bytes = await frozenBytes(root, relative);
  if (bytes !== null) return bytes;
  for (const slice of await listSliceRecords(root, initiative)) {
    const stored = await readRecord(root, { kind: "frozen-tests", initiative, slice }).catch(() => ({ bytes: null }));
    if (stored.bytes === null) continue;
    const entry = JSON.parse(stored.bytes.toString("utf8")).tests?.find((item) => item.path === relative);
    if (entry) return Buffer.from(entry.content, "base64");
  }
  return null;
}
