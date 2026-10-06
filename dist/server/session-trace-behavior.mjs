import { readFileSync } from "node:fs";

const registry = JSON.parse(readFileSync(
  new URL("./session-trace-behavior-registry.json", import.meta.url),
  "utf8"
));

const PROFILE_KEYS = [
  "id",
  "match",
  "postToolUseSuccessTools",
  "modelFacingResponseShape",
  "provenance"
];
const MATCH_KEYS = ["harness", "harnessVersion", "provider"];
const PROVENANCE_KEYS = ["source", "sourceVersion", "verifiedAt"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, name) {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has invalid properties.`);
  }
}

function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a nonempty string.`);
  }
}

export function validateSessionTraceBehaviorRegistry(value) {
  assertExactKeys(value, ["schemaVersion", "profiles"], "traceBehaviorRegistry");
  if (value.schemaVersion !== 1 || !Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error("The trace behavior registry is invalid.");
  }
  const ids = new Set();
  const tuples = new Set();
  for (const [index, profile] of value.profiles.entries()) {
    const name = `traceBehaviorRegistry.profiles[${index}]`;
    assertExactKeys(profile, PROFILE_KEYS, name);
    assertString(profile.id, `${name}.id`);
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate trace behavior profile id: ${profile.id}.`);
    }
    ids.add(profile.id);
    assertExactKeys(profile.match, MATCH_KEYS, `${name}.match`);
    for (const key of MATCH_KEYS) {
      assertString(profile.match[key], `${name}.match.${key}`);
    }
    const tuple = JSON.stringify(MATCH_KEYS.map((key) => profile.match[key]));
    if (tuples.has(tuple)) {
      throw new Error(`Duplicate trace behavior match: ${tuple}.`);
    }
    tuples.add(tuple);
    if (
      !Array.isArray(profile.postToolUseSuccessTools)
      || profile.postToolUseSuccessTools.length === 0
      || profile.postToolUseSuccessTools.some((tool) => (
        typeof tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool)
      ))
      || new Set(profile.postToolUseSuccessTools).size !== profile.postToolUseSuccessTools.length
    ) {
      throw new Error(`${name}.postToolUseSuccessTools is invalid.`);
    }
    if (profile.modelFacingResponseShape !== "bounded-string") {
      throw new Error(`${name}.modelFacingResponseShape is invalid.`);
    }
    assertExactKeys(profile.provenance, PROVENANCE_KEYS, `${name}.provenance`);
    for (const key of PROVENANCE_KEYS) {
      assertString(profile.provenance[key], `${name}.provenance.${key}`);
    }
    let source;
    try {
      source = new URL(profile.provenance.source);
    } catch {
      throw new Error(`${name}.provenance.source is invalid.`);
    }
    const expectedTag = `/openai/codex/tree/rust-v${profile.match.harnessVersion}/`;
    if (
      source.protocol !== "https:"
      || source.hostname !== "github.com"
      || !source.pathname.startsWith(expectedTag)
      || profile.provenance.sourceVersion !== `codex-cli ${profile.match.harnessVersion}`
      || !/^\d{4}-\d{2}-\d{2}$/.test(profile.provenance.verifiedAt)
    ) {
      throw new Error(`${name}.provenance does not identify the exact reviewed source.`);
    }
  }
  return true;
}

validateSessionTraceBehaviorRegistry(registry);

export function resolveSessionTraceBehavior({ harness, harnessVersion, provider } = {}) {
  const profile = registry.profiles.find((candidate) => (
    candidate.match.harness === harness
    && candidate.match.harnessVersion === harnessVersion
    && candidate.match.provider === provider
  ));
  return profile ? structuredClone(profile) : null;
}

export function sessionTraceBehaviorRegistry() {
  return structuredClone(registry);
}
