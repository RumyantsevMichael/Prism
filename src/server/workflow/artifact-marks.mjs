import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { locateRecord, readRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Legacy marks: sets of nonconforming artifacts that a person chose to leave as they are, one record per set under legacy-marks/,
// in the record store when one is configured and in .prism/ otherwise. A removed set keeps its record with who removed it and when.

const SCHEMA_VERSION = 1;
const SET_ID = /^legacy-[0-9a-f]{8,32}$/;
const TYPES = new Set(["requirements", "adr", "glossary", "feature"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const person = (value) => isRecord(value) && (value.name === null || typeof value.name === "string") ? { name: value.name ?? null, email: typeof value.email === "string" ? value.email : null, checkout: typeof value.checkout === "string" ? value.checkout : null } : null;

/** The scope label an artifact's scope names in a legacy set: its label for a store artifact, or null for a checkout file. */
export const scopeLabelOf = (scope) => scope === null || scope === undefined ? null : typeof scope === "string" ? scope : scope.label ?? null;

/** The artifact key the review app names an artifact by: its path for a checkout file, or <scope label>:<path> for a store artifact. */
export const artifactKey = ({ path: file, scope }) => scopeLabelOf(scope) === null ? file : `${scopeLabelOf(scope)}:${file}`;

// A record read into a set, or null for anything that is not one.
function setOf(id, value) {
  if (!isRecord(value) || value.id !== id || !TYPES.has(value.type) || !Array.isArray(value.artifacts) || typeof value.at !== "string") return null;
  const artifacts = value.artifacts.filter((entry) => isRecord(entry) && typeof entry.path === "string" && (entry.scope === null || typeof entry.scope === "string")).map((entry) => ({ path: entry.path, scope: entry.scope }));
  const removed = isRecord(value.removed) && typeof value.removed.at === "string" ? { by: person(value.removed.by), at: value.removed.at } : null;
  return { id, type: value.type, artifacts, by: person(value.by), at: value.at, removed };
}

// The folder that holds the sets, in the store or in .prism, located through any set's key.
async function marksFolder(projectRoot) {
  return path.dirname((await locateRecord(projectRoot, { kind: "legacy-mark", id: "legacy-00000000" })).target);
}

/** Every legacy set of the project, oldest first, removed ones included when `removed` is true: [{ id, type, artifacts: [{ path, scope }], by, at, removed }]. */
export async function readLegacySets(projectRoot, { removed = false } = {}) {
  const folder = await marksFolder(projectRoot);
  let names = [];
  try { names = (await readdir(folder)).filter((name) => name.endsWith(".json") && SET_ID.test(name.slice(0, -5))); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const sets = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    let set = null;
    try {
      const { bytes } = await readRecord(projectRoot, { kind: "legacy-mark", id });
      set = bytes === null ? null : setOf(id, parseStoreJson(bytes.toString("utf8")));
    } catch { set = null; }
    if (set && (removed || set.removed === null)) sets.push(set);
  }
  return sets.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : 1));
}

/** A lookup over the active sets: legacyOf(path, type, scope) gives { set, by, at } of the earliest set that covers the artifact, or null. */
export function legacyLookup(sets) {
  const covering = new Map();
  for (const set of sets) {
    if (set.removed) continue;
    for (const artifact of set.artifacts) {
      const key = `${set.type}\0${artifact.scope ?? ""}\0${artifact.path}`;
      if (!covering.has(key)) covering.set(key, set);
    }
  }
  return (file, type, scope) => {
    const set = covering.get(`${type}\0${scopeLabelOf(scope) ?? ""}\0${file}`);
    return set ? { set: set.id, by: set.by, at: set.at } : null;
  };
}

/** Records a new legacy set of one type's artifacts, each { path, scope } with scope its label or null, by the given author: the set. */
export async function markLegacy(projectRoot, { type, artifacts, by }) {
  const set = { schemaVersion: SCHEMA_VERSION, id: `legacy-${randomBytes(8).toString("hex")}`, type, artifacts: artifacts.map((entry) => ({ path: entry.path, scope: scopeLabelOf(entry.scope) })), by, at: new Date().toISOString(), removed: null };
  await writeRecord(projectRoot, { kind: "legacy-mark", id: set.id }, `${JSON.stringify(set, null, 2)}\n`);
  const { schemaVersion, ...shown } = set;
  return shown;
}

/** Removes a legacy set: its record keeps who removed it and when, and its artifacts count again; returns the set, or null when no active set has that id. */
export async function removeLegacy(projectRoot, { id, by }) {
  if (typeof id !== "string" || !SET_ID.test(id)) return null;
  return withRecordLock(projectRoot, { kind: "legacy-mark", id }, async () => {
    const { bytes } = await readRecord(projectRoot, { kind: "legacy-mark", id });
    let value = null;
    try { value = bytes === null ? null : parseStoreJson(bytes.toString("utf8")); } catch { value = null; }
    const set = setOf(id, value);
    if (!set || set.removed) return null;
    const removed = { by, at: new Date().toISOString() };
    await writeRecord(projectRoot, { kind: "legacy-mark", id }, `${JSON.stringify({ ...value, removed }, null, 2)}\n`);
    return { ...set, removed };
  });
}
