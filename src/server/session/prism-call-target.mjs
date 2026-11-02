import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { initiativeDirectory, parseWorkflowConfig, runStatisticsCollection } from "../workflow/workflow-config.mjs";

// Reads the Prism target a tool call names and the shared workflow facts at that call, for run-cost attribution.
// Records are read where Prism keeps them under .prism, or where an older Prism kept them before the first write moved them.
// The hook runs under a host time limit, so every read is bounded, lock-free, no-follow, and checked against the deadline.

const CONFIG_MAX_BYTES = 256 * 1024;
const RECORD_MAX_BYTES = 8 * 1024 * 1024;
const MAX_SLUG_LENGTH = 120;
const MAX_ACTIVE_SLICES = 32;
const WAVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const ROLES = new Set(["coordinator", "delivery", "reviewer"]);
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSlug(value) {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A Prism call is "mcp__<server>__<tool>" whose server is "prism-review" or ends with "_prism-review".
function isPrismTool(toolName) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return false;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) return false;
  const server = rest.slice(0, separator);
  return server === "prism-review" || server.endsWith("_prism-review");
}

// Reads one complete regular file within its bound, or reports why it cannot: absent, unreadable, oversized, or late.
// Oversize is decided from the handle's size and from one extra byte read from offset 0, never from parsed text.
async function readBoundedRecord(filePath, maxBytes, deadline) {
  if (performance.now() > deadline) return { status: "late" };
  let handle;
  try {
    handle = await open(filePath, OPEN_FLAGS);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "unreadable" };
    if (info.size > maxBytes) return { status: "oversized" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { status: "oversized" };
    if (performance.now() > deadline) return { status: "late" };
    return { status: "read", text: buffer.subarray(0, length).toString("utf8") };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readJsonRecord(filePath, deadline) {
  const record = await readBoundedRecord(filePath, RECORD_MAX_BYTES, deadline);
  if (record.status === "absent") return { status: "absent", value: null };
  if (record.status !== "read") return { status: "partial", value: null };
  try {
    const value = JSON.parse(record.text);
    return isObject(value) ? { status: "read", value } : { status: "partial", value: null };
  } catch {
    return { status: "partial", value: null };
  }
}

// The project whose records a call reads: its absolute projectRoot argument when that is a directory, else the hook's.
async function recordRoot(toolInput, hookProjectRoot) {
  const argument = nonemptyString(toolInput.projectRoot);
  if (argument && path.isAbsolute(argument)) {
    try {
      if ((await stat(argument)).isDirectory()) return await realpath(argument);
    } catch {
      // A project root that is not a directory falls back to the hook's project root.
    }
  }
  return hookProjectRoot;
}

// Reads a project's workflow config within its bound: { collection, config }, where an unreadable config is "unknown".
async function readProjectConfig(root, deadline) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return { collection: "unknown", config: null };
  const configRecord = await readBoundedRecord(path.join(root, ".prism", "workflow.md"), CONFIG_MAX_BYTES, deadline);
  if (configRecord.status !== "read" && configRecord.status !== "absent") return { collection: "unknown", config: null };
  const config = parseWorkflowConfig(configRecord.status === "read" ? configRecord.text : "");
  return { collection: runStatisticsCollection(config), config };
}

/** Returns a project's run-statistics switch, "on", "off", or "unknown", through a bounded no-follow config read. */
export async function readRunStatisticsCollection(projectRoot, { deadline = Number.POSITIVE_INFINITY } = {}) {
  try {
    return (await readProjectConfig(projectRoot, deadline)).collection;
  } catch {
    return "unknown";
  }
}

const recordFolder = (initiative) => path.join(".prism", "initiatives", initiative);

// Reads a record from .prism, or from its legacy location when .prism has none; an absent legacy location reads as absent.
async function readCurrentOrLegacy(root, current, legacy, deadline) {
  const record = await readJsonRecord(path.join(root, current), deadline);
  return record.status !== "absent" || !legacy ? record : readJsonRecord(path.join(root, legacy), deadline);
}

// The legacy initiative folder under the configured plans path, or null when the path is unusable.
function legacyInitiativeFolder(config, initiative) {
  const plans = config.paths.plans === null ? null : path.posix.normalize(config.paths.plans).replace(/\/+$/, "");
  if (!plans || plans === "." || plans.startsWith("../") || path.posix.isAbsolute(plans)) return null;
  return initiativeDirectory(config, initiative);
}

// The root slice of an initiative's record, or the initiative identifier when the record has no single readable root.
async function rootSlice(root, initiative, legacyFolder, deadline) {
  const record = await readCurrentOrLegacy(root, path.join(recordFolder(initiative), "initiative.json"), legacyFolder && path.join(legacyFolder, "initiative.json"), deadline);
  const slices = isObject(record.value?.slices) ? Object.entries(record.value.slices) : [];
  const roots = slices.filter(([, slice]) => isObject(slice) && slice.parent === null).map(([slug]) => slug);
  return roots.length === 1 && validSlug(roots[0]) ? roots[0] : initiative;
}

function resolveRecordPath(value, root) {
  const raw = nonemptyString(value);
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.join(root, raw);
}

// Top-level arguments name a target: slice or activeSlice with initiative, else the initiative's root slice.
async function namedTarget(toolInput, root, legacyFolder, deadline) {
  const initiative = nonemptyString(toolInput.initiative);
  if (!initiative || !validSlug(initiative)) return null;
  const explicitSlice = nonemptyString(toolInput.slice) ?? nonemptyString(toolInput.activeSlice);
  if (explicitSlice) return { initiative, slice: explicitSlice, namesSlice: true };
  return { initiative, slice: await rootSlice(root, initiative, legacyFolder, deadline), namesSlice: false };
}

/**
 * Returns the content-free prismCall facts of a Prism tool call that names a target, or null when there is nothing to record.
 * Returns null when the call names no target or its project switches run statistics off.
 * Returns `{ collected: false }` when the call names a target whose project config cannot be read, so the caller can record
 * a content-free collection gap.
 */
export async function readPrismCallTarget({ toolName, toolInput, projectRoot, deadline = Number.POSITIVE_INFINITY } = {}) {
  if (!isPrismTool(toolName) || !isObject(toolInput)) return null;
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) return null;
  if (!nonemptyString(toolInput.initiative)) return null;
  const root = await recordRoot(toolInput, projectRoot);

  const { collection, config } = await readProjectConfig(root, deadline);
  if (collection === "unknown") return { collected: false };
  if (collection !== "on") return null;

  const legacyFolder = legacyInitiativeFolder(config, nonemptyString(toolInput.initiative));
  const target = await namedTarget(toolInput, root, legacyFolder, deadline);
  if (!target || !validSlug(target.initiative) || !validSlug(target.slice)) return null;
  const role = isObject(toolInput.actor) && ROLES.has(toolInput.actor.role) ? toolInput.actor.role : null;
  const folder = recordFolder(target.initiative);

  let facts = "exact";
  let activeSlices = null;
  let entry = null;
  const state = await readCurrentOrLegacy(root, path.join(folder, "state.json"), legacyFolder && path.join(legacyFolder, "state.json"), deadline);
  if (state.status === "partial" || (state.status === "read" && !Array.isArray(state.value.active ?? []))) {
    facts = "partial";
  } else {
    const active = (state.value?.active ?? []).filter(isObject);
    entry = active.find((candidate) => candidate.slice === target.slice) ?? null;
    const slugs = [...new Set(active.map((candidate) => candidate.slice).filter(validSlug))].sort();
    activeSlices = active.length > MAX_ACTIVE_SLICES ? null : slugs;
  }

  let openWave = null;
  let designRun = null;
  if (facts === "exact") {
    const legacySliceFolder = legacyFolder && (!target.namesSlice || target.slice === target.initiative ? legacyFolder : path.join(legacyFolder, target.slice));
    const legacyLedger = resolveRecordPath(entry?.reviewPath, root) ?? (legacySliceFolder && path.join(root, legacySliceFolder, "review.json"));
    const ledger = await readCurrentOrLegacy(root, path.join(folder, "slices", target.slice, "review.json"), legacyLedger && path.relative(root, legacyLedger), deadline);
    const waves = ledger.value?.waves ?? [];
    if (ledger.status === "partial" || !Array.isArray(waves) || !waves.every(isObject)) {
      facts = "partial";
    } else {
      const latest = waves.at(-1);
      if (latest && (latest.accepted === undefined || latest.accepted === null)) {
        if (typeof latest.id === "string" && WAVE_ID_PATTERN.test(latest.id)) openWave = latest.id;
        else facts = "partial";
      }
      if (facts === "exact" && entry?.activity === "design") {
        designRun = waves.filter((wave) => wave.mode === "design-audit").length + 1;
      }
    }
  }
  if (facts === "partial") {
    openWave = null;
    designRun = null;
  }
  return {
    projectRoot: root,
    initiative: target.initiative,
    slice: target.slice,
    role,
    namesSlice: target.namesSlice,
    openWave,
    designRun,
    activeSlices,
    facts
  };
}
