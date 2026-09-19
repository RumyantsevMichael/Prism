import { readFileSync } from "node:fs";
import { HOST_FACT_REASON, readHostSessionFacts } from "./host-session-facts.mjs";

const canonicalRegistry = JSON.parse(readFileSync(new URL("./session-capacity-registry.json", import.meta.url), "utf8"));
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const ACTIVE_CAPACITY_REASON = Object.freeze({
  NO_EXACT_CAPACITY_PROFILE: "NO_EXACT_CAPACITY_PROFILE",
  UNATTESTED_ACTIVE_CAPACITY: "UNATTESTED_ACTIVE_CAPACITY",
  TOTAL_COMPACTION_SCOPE_REQUIRED: "TOTAL_COMPACTION_SCOPE_REQUIRED"
});

const CORRELATION_KEY_PATTERN = /^[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, name) {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object.`);
  }
}

function assertExactKeys(value, allowed, required, name) {
  assertObject(value, name);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${name} contains an unknown property: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${name}.${key} is required.`);
    }
  }
}

function assertNonemptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a nonempty string.`);
  }
}

function assertTokenCount(value, name, { positive = false } = {}) {
  const valid = Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= MAX_SAFE_INTEGER;
  if (!valid) {
    const qualifier = positive ? "positive" : "nonnegative";
    throw new Error(`${name} must be a ${qualifier} integer within the safe range.`);
  }
}

function assertProvenance(value, name, threshold = false) {
  const required = ["source", "sourceVersion", "verifiedAt", "field"];
  if (threshold) {
    required.push("derivation");
  }
  assertExactKeys(value, required, required, name);
  for (const key of required) {
    assertNonemptyString(value[key], `${name}.${key}`);
  }
}

function acceptedModels(profile) {
  return [...profile.match.models, ...Object.keys(profile.match.aliases)];
}

function tupleKey(match, model) {
  return JSON.stringify([match.harness, match.harnessVersion, match.provider, model]);
}

function validateProfile(profile, index, tupleOwners, profileIds) {
  const name = `registry.profiles[${index}]`;
  assertExactKeys(profile, ["id", "match", "capacity", "provenance"], ["id", "match", "capacity", "provenance"], name);
  assertNonemptyString(profile.id, `${name}.id`);
  if (profileIds.has(profile.id)) {
    throw new Error(`Duplicate capacity profile id: ${profile.id}.`);
  }
  profileIds.add(profile.id);

  assertExactKeys(profile.match, ["harness", "harnessVersion", "provider", "models", "aliases"], ["harness", "harnessVersion", "provider", "models", "aliases"], `${name}.match`);
  for (const key of ["harness", "harnessVersion", "provider"]) {
    assertNonemptyString(profile.match[key], `${name}.match.${key}`);
  }
  if (!Array.isArray(profile.match.models) || profile.match.models.length === 0) {
    throw new Error(`${name}.match.models must be a nonempty array.`);
  }
  const models = new Set();
  for (const model of profile.match.models) {
    assertNonemptyString(model, `${name}.match.models[]`);
    if (models.has(model)) {
      throw new Error(`${name}.match.models contains a duplicate model: ${model}.`);
    }
    models.add(model);
  }
  assertObject(profile.match.aliases, `${name}.match.aliases`);
  for (const [alias, canonical] of Object.entries(profile.match.aliases)) {
    assertNonemptyString(alias, `${name}.match.aliases key`);
    assertNonemptyString(canonical, `${name}.match.aliases.${alias}`);
    if (models.has(alias)) {
      throw new Error(`${name}.match.aliases shadows a canonical model: ${alias}.`);
    }
    if (!models.has(canonical)) {
      throw new Error(`${name}.match.aliases.${alias} must reference a canonical model in the same profile.`);
    }
  }

  assertExactKeys(profile.capacity, ["contextWindowTokens", "effectiveContextWindowPercent", "autoCompactionPercent", "compactionThresholdTokens", "implementationReserveTokens"], ["contextWindowTokens", "effectiveContextWindowPercent", "autoCompactionPercent", "compactionThresholdTokens", "implementationReserveTokens"], `${name}.capacity`);
  assertTokenCount(profile.capacity.contextWindowTokens, `${name}.capacity.contextWindowTokens`, { positive: true });
  assertTokenCount(profile.capacity.effectiveContextWindowPercent, `${name}.capacity.effectiveContextWindowPercent`, { positive: true });
  if (profile.capacity.effectiveContextWindowPercent > 100) {
    throw new Error(`${name}.capacity.effectiveContextWindowPercent cannot exceed 100.`);
  }
  assertTokenCount(profile.capacity.autoCompactionPercent, `${name}.capacity.autoCompactionPercent`, { positive: true });
  if (profile.capacity.autoCompactionPercent > 100) {
    throw new Error(`${name}.capacity.autoCompactionPercent cannot exceed 100.`);
  }
  assertTokenCount(profile.capacity.compactionThresholdTokens, `${name}.capacity.compactionThresholdTokens`, { positive: true });
  assertTokenCount(profile.capacity.implementationReserveTokens, `${name}.capacity.implementationReserveTokens`);
  const expectedThreshold = Number(
    BigInt(profile.capacity.contextWindowTokens)
      * BigInt(profile.capacity.autoCompactionPercent)
      / 100n
  );
  if (profile.capacity.compactionThresholdTokens !== expectedThreshold) {
    throw new Error(`${name}.capacity.compactionThresholdTokens is inconsistent with its documented derivation.`);
  }
  if (profile.capacity.compactionThresholdTokens > profile.capacity.contextWindowTokens) {
    throw new Error(`${name}.capacity.compactionThresholdTokens cannot exceed the context window.`);
  }

  assertExactKeys(profile.provenance, ["contextWindow", "compactionThreshold", "implementationReserve"], ["contextWindow", "compactionThreshold", "implementationReserve"], `${name}.provenance`);
  assertProvenance(profile.provenance.contextWindow, `${name}.provenance.contextWindow`);
  assertProvenance(profile.provenance.compactionThreshold, `${name}.provenance.compactionThreshold`, true);
  assertProvenance(profile.provenance.implementationReserve, `${name}.provenance.implementationReserve`);

  for (const model of acceptedModels(profile)) {
    const key = tupleKey(profile.match, model);
    if (tupleOwners.has(key)) {
      throw new Error(`Ambiguous capacity profiles for session tuple: ${key}.`);
    }
    tupleOwners.set(key, profile.id);
  }
}

export function validateCapacityRegistry(registry = canonicalRegistry) {
  assertExactKeys(registry, ["schemaVersion", "profiles"], ["schemaVersion", "profiles"], "registry");
  if (registry.schemaVersion !== 1) {
    throw new Error(`Unsupported capacity registry schema version: ${registry.schemaVersion}.`);
  }
  if (!Array.isArray(registry.profiles) || registry.profiles.length === 0) {
    throw new Error("registry.profiles must be a nonempty array.");
  }
  const tupleOwners = new Map();
  const profileIds = new Set();
  registry.profiles.forEach((profile, index) => validateProfile(profile, index, tupleOwners, profileIds));
  return true;
}

function validateSession(session) {
  assertExactKeys(session, ["harness", "harnessVersion", "provider", "model", "capacityOverrides"], ["harness", "harnessVersion", "provider", "model"], "session");
  for (const key of ["harness", "harnessVersion", "provider", "model"]) {
    assertNonemptyString(session[key], `session.${key}`);
  }
  if (Object.hasOwn(session, "capacityOverrides")) {
    assertExactKeys(session.capacityOverrides, ["contextWindowTokens", "compactionThresholdTokens"], [], "session.capacityOverrides");
    for (const key of ["contextWindowTokens", "compactionThresholdTokens"]) {
      if (Object.hasOwn(session.capacityOverrides, key)) {
        assertTokenCount(session.capacityOverrides[key], `session.capacityOverrides.${key}`, { positive: true });
      }
    }
  }
}

function registryValueProvenance(profile, key) {
  const source = profile.provenance[key];
  return {
    source: "registry",
    profileId: profile.id,
    registrySource: source.source,
    sourceVersion: source.sourceVersion,
    verifiedAt: source.verifiedAt,
    field: source.field,
    ...(source.derivation ? { derivation: source.derivation } : {})
  };
}

function explicitProvenance(input) {
  return { source: "explicit-input", input };
}

function findProfile(session, registry) {
  const matches = registry.profiles.filter((profile) => {
    const match = profile.match;
    return match.harness === session.harness
      && match.harnessVersion === session.harnessVersion
      && match.provider === session.provider
      && acceptedModels(profile).includes(session.model);
  });
  if (matches.length > 1) {
    throw new Error("The session tuple matches more than one capacity profile.");
  }
  return matches[0] ?? null;
}

export function resolveSessionCapacity(session, { registry = canonicalRegistry } = {}) {
  validateSession(session);
  validateCapacityRegistry(registry);
  const profile = findProfile(session, registry);
  const overrides = session.capacityOverrides ?? {};
  const hasContextOverride = Object.hasOwn(overrides, "contextWindowTokens");
  const hasThresholdOverride = Object.hasOwn(overrides, "compactionThresholdTokens");

  if (!profile && !(hasContextOverride && hasThresholdOverride)) {
    return {
      status: "UNSUPPORTED",
      reason: "No exact capacity profile or complete explicit capacity was supplied."
    };
  }

  const contextWindowTokens = hasContextOverride ? overrides.contextWindowTokens : profile.capacity.contextWindowTokens;
  const compactionThresholdTokens = hasThresholdOverride ? overrides.compactionThresholdTokens : profile.capacity.compactionThresholdTokens;
  if (compactionThresholdTokens > contextWindowTokens) {
    throw new Error("The compaction threshold cannot exceed the context window.");
  }

  const canonicalModel = profile?.match.aliases[session.model] ?? session.model;
  return {
    status: "SUPPORTED",
    profileId: profile?.id ?? null,
    model: { requested: session.model, canonical: canonicalModel },
    capacity: {
      contextWindowTokens,
      compactionThresholdTokens,
      implementationReserveTokens: profile?.capacity.implementationReserveTokens ?? null
    },
    provenance: {
      contextWindow: hasContextOverride
        ? explicitProvenance("session.capacityOverrides.contextWindowTokens")
        : registryValueProvenance(profile, "contextWindow"),
      compactionThreshold: hasThresholdOverride
        ? explicitProvenance("session.capacityOverrides.compactionThresholdTokens")
        : registryValueProvenance(profile, "compactionThreshold"),
      implementationReserve: profile ? registryValueProvenance(profile, "implementationReserve") : null
    }
  };
}

function validateActiveSessionRequest(value) {
  assertExactKeys(value, ["dataDirectory", "correlationKey", "projectRoot", "capacityOverrides", "compactionScope"], ["correlationKey", "projectRoot"], "activeSession");
  assertNonemptyString(value.projectRoot, "activeSession.projectRoot");
  if (value.dataDirectory !== undefined) {
    assertNonemptyString(value.dataDirectory, "activeSession.dataDirectory");
  }
  if (typeof value.correlationKey !== "string" || !CORRELATION_KEY_PATTERN.test(value.correlationKey)) {
    throw new Error("activeSession.correlationKey must be a lowercase SHA-256 digest.");
  }
  if (Object.hasOwn(value, "compactionScope") && value.compactionScope !== "total") {
    throw new Error("activeSession.compactionScope must be total when supplied.");
  }
  if (Object.hasOwn(value, "capacityOverrides")) {
    assertExactKeys(
      value.capacityOverrides,
      ["contextWindowTokens", "compactionThresholdTokens"],
      ["contextWindowTokens", "compactionThresholdTokens"],
      "activeSession.capacityOverrides"
    );
    for (const key of ["contextWindowTokens", "compactionThresholdTokens"]) {
      assertTokenCount(value.capacityOverrides[key], `activeSession.capacityOverrides.${key}`, { positive: true });
    }
  }
}

export function createActiveSessionCapacityRequest(session, { dataDirectory, projectRoot } = {}) {
  assertExactKeys(
    session,
    ["mode", "correlationKey", "capacityOverrides", "compactionScope"],
    ["mode", "correlationKey"],
    "session"
  );
  if (session.mode !== "active") {
    throw new Error("session.mode must be active.");
  }
  const request = {
    dataDirectory,
    correlationKey: session.correlationKey,
    projectRoot,
    ...(Object.hasOwn(session, "capacityOverrides") ? { capacityOverrides: session.capacityOverrides } : {}),
    ...(Object.hasOwn(session, "compactionScope") ? { compactionScope: session.compactionScope } : {})
  };
  validateActiveSessionRequest(request);
  return request;
}

function activeFactProvenance(facts, field) {
  return {
    source: "active-host-session",
    observedAt: facts.provenance.observedAt,
    field: facts.provenance.fields[field]
  };
}

export async function resolveActiveSessionCapacity(activeSession, {
  registry = canonicalRegistry,
  readFacts = readHostSessionFacts,
  now,
  maxAgeMs
} = {}) {
  validateActiveSessionRequest(activeSession);
  const facts = await readFacts({
    dataDirectory: activeSession.dataDirectory,
    correlationKey: activeSession.correlationKey,
    projectRoot: activeSession.projectRoot,
    ...(now ? { now } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {})
  });
  const callerOverrides = activeSession.capacityOverrides || {};
  const callerHasCompleteCapacity = ["contextWindowTokens", "compactionThresholdTokens"]
    .every((key) => Object.hasOwn(callerOverrides, key));
  let scopeProvenance;
  if (facts.status !== "SUPPORTED") {
    if (facts.reasonCode !== HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE || !facts.session || !callerHasCompleteCapacity) {
      return facts;
    }
    if (facts.compactionScope === "body_after_prefix") {
      return facts;
    }
    if (facts.compactionScope === "total") {
      scopeProvenance = activeFactProvenance(facts, "compactionScope");
    } else if (facts.compactionScope === null && activeSession.compactionScope === "total") {
      scopeProvenance = explicitProvenance("activeSession.compactionScope");
    } else {
      return {
        ...facts,
        reasonCode: ACTIVE_CAPACITY_REASON.TOTAL_COMPACTION_SCOPE_REQUIRED,
        reason: "Total compaction accounting was not explicitly attested."
      };
    }
  } else {
    if (facts.compactionScope !== "total") {
      return {
        status: "UNSUPPORTED",
        reasonCode: ACTIVE_CAPACITY_REASON.TOTAL_COMPACTION_SCOPE_REQUIRED,
        reason: "Total compaction accounting was not explicitly attested."
      };
    }
    scopeProvenance = activeFactProvenance(facts, "compactionScope");
  }

  const hostOverrides = facts.session.capacityOverrides || {};
  const hostHasCompleteCapacity = ["contextWindowTokens", "compactionThresholdTokens"]
    .every((key) => Object.hasOwn(hostOverrides, key));
  if (!hostHasCompleteCapacity && !callerHasCompleteCapacity) {
    return {
      status: "UNSUPPORTED",
      reasonCode: ACTIVE_CAPACITY_REASON.UNATTESTED_ACTIVE_CAPACITY,
      reason: "The active host did not attest complete capacity, and complete explicit capacity was not supplied.",
      session: facts.session,
      sessionProvenance: facts.provenance
    };
  }
  const mergedOverrides = { ...hostOverrides, ...callerOverrides };
  const session = {
    harness: facts.session.harness,
    harnessVersion: facts.session.harnessVersion,
    provider: facts.session.provider,
    model: facts.session.model,
    ...(Object.keys(mergedOverrides).length ? { capacityOverrides: mergedOverrides } : {})
  };
  const resolution = resolveSessionCapacity(session, { registry });
  if (resolution.status === "UNSUPPORTED") {
    return {
      ...resolution,
      reasonCode: ACTIVE_CAPACITY_REASON.NO_EXACT_CAPACITY_PROFILE,
      session: { ...facts.session, capacityOverrides: mergedOverrides },
      sessionProvenance: facts.provenance
    };
  }

  const provenance = { ...resolution.provenance };
  const fields = [
    ["contextWindow", "contextWindowTokens"],
    ["compactionThreshold", "compactionThresholdTokens"]
  ];
  for (const [provenanceKey, capacityKey] of fields) {
    if (Object.hasOwn(callerOverrides, capacityKey)) {
      provenance[provenanceKey] = explicitProvenance(`activeSession.capacityOverrides.${capacityKey}`);
    } else if (Object.hasOwn(hostOverrides, capacityKey)) {
      provenance[provenanceKey] = activeFactProvenance(facts, capacityKey);
    }
  }
  return {
    ...resolution,
    session: {
      harness: facts.session.harness,
      harnessVersion: facts.session.harnessVersion,
      provider: facts.session.provider,
      model: facts.session.model
    },
    sessionProvenance: facts.provenance,
    compactionScope: "total",
    compactionScopeProvenance: scopeProvenance,
    provenance
  };
}

function validateCosts(costs) {
  assertExactKeys(costs, ["baseSessionContextTokens", "featureDesignContextTokens", "implementationReserveTokens"], ["baseSessionContextTokens", "featureDesignContextTokens"], "costs");
  for (const key of ["baseSessionContextTokens", "featureDesignContextTokens", "implementationReserveTokens"]) {
    if (Object.hasOwn(costs, key)) {
      assertTokenCount(costs[key], `costs.${key}`);
    }
  }
}

function validateTokenEstimate(tokenEstimate) {
  const keys = ["lower", "expected", "upper"];
  assertExactKeys(tokenEstimate, keys, keys, "tokenEstimate");
  const values = keys.map((key) => tokenEstimate[key]);
  const nullCount = values.filter((value) => value === null).length;
  if (nullCount !== 0 && nullCount !== values.length) {
    throw new Error("tokenEstimate bounds must be all null or all nonnegative safe integers.");
  }
  if (nullCount === values.length) {
    return;
  }
  keys.forEach((key) => assertTokenCount(tokenEstimate[key], `tokenEstimate.${key}`));
  if (!(tokenEstimate.lower <= tokenEstimate.expected && tokenEstimate.expected <= tokenEstimate.upper)) {
    throw new Error("tokenEstimate bounds must satisfy lower <= expected <= upper.");
  }
}

function evaluateResolvedRepositoryFit({ costs, tokenEstimate }, resolution) {
  if (resolution.status === "UNSUPPORTED") {
    return { ...resolution, fit: null, repositoryReadBudgetTokens: null };
  }

  const reserveIsExplicit = Object.hasOwn(costs, "implementationReserveTokens");
  const implementationReserveTokens = reserveIsExplicit
    ? costs.implementationReserveTokens
    : resolution.capacity.implementationReserveTokens;
  if (implementationReserveTokens === null) {
    throw new Error("costs.implementationReserveTokens is required when no registry reserve is available.");
  }
  const consumed = costs.baseSessionContextTokens
    + costs.featureDesignContextTokens
    + implementationReserveTokens;
  if (!Number.isSafeInteger(consumed)) {
    throw new Error("The combined session costs exceed the safe integer range.");
  }
  const repositoryReadBudgetTokens = resolution.capacity.compactionThresholdTokens - consumed;
  if (!Number.isSafeInteger(repositoryReadBudgetTokens)) {
    throw new Error("The repository read budget exceeds the safe integer range.");
  }

  let fit = "UNCERTAIN";
  if (tokenEstimate.upper !== null) {
    if (tokenEstimate.upper <= repositoryReadBudgetTokens) {
      fit = "FIT";
    } else if (tokenEstimate.lower > repositoryReadBudgetTokens) {
      fit = "SPLIT";
    }
  }

  return {
    ...resolution,
    capacity: { ...resolution.capacity, implementationReserveTokens },
    costs: {
      baseSessionContextTokens: costs.baseSessionContextTokens,
      featureDesignContextTokens: costs.featureDesignContextTokens,
      implementationReserveTokens
    },
    tokenEstimate: { ...tokenEstimate },
    provenance: {
      ...resolution.provenance,
      implementationReserve: reserveIsExplicit
        ? explicitProvenance("costs.implementationReserveTokens")
        : resolution.provenance.implementationReserve
    },
    repositoryReadBudgetTokens,
    fit
  };
}

export function evaluateRepositoryFit(input, options = {}) {
  assertExactKeys(input, ["session", "costs", "tokenEstimate"], ["session", "costs", "tokenEstimate"], "input");
  validateCosts(input.costs);
  validateTokenEstimate(input.tokenEstimate);
  const resolution = resolveSessionCapacity(input.session, options);
  return evaluateResolvedRepositoryFit(input, resolution);
}

export async function evaluateActiveRepositoryFit(input, activeSession, options = {}) {
  assertExactKeys(input, ["costs", "tokenEstimate"], ["costs", "tokenEstimate"], "input");
  validateCosts(input.costs);
  validateTokenEstimate(input.tokenEstimate);
  const resolution = await resolveActiveSessionCapacity(activeSession, options);
  return evaluateResolvedRepositoryFit(input, resolution);
}
