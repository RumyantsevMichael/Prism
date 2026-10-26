import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { locateRecord } from "./record-store.mjs";

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
  if (Object.keys(design).some((key) => !["acceptedAt", "frozenTests", "review"].includes(key))) problems.push("design holds only acceptedAt, frozenTests, and review.");
  if (typeof design.acceptedAt !== "string" || Number.isNaN(Date.parse(design.acceptedAt))) problems.push("design.acceptedAt must be an ISO timestamp.");
  if (!REVIEW_MARKS.includes(design.review)) problems.push(`design.review must be one of ${REVIEW_MARKS.join(", ")}.`);
  if (!Array.isArray(design.frozenTests) || design.frozenTests.some((item) => typeof item?.path !== "string" || !/^[0-9a-f]{64}$/.test(item?.sha256 ?? ""))) problems.push("design.frozenTests must list { path, sha256 } entries.");
  return problems;
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
