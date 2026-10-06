import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACTIVE_CAPACITY_REASON,
  evaluateActiveRepositoryFit,
  evaluateRepositoryFit,
  resolveActiveSessionCapacity,
  resolveSessionCapacity,
  validateCapacityRegistry
} from "../../dist/server/session/session-capacity.mjs";

const supportedSession = {
  harness: "codex-cli",
  harnessVersion: "0.147.0",
  provider: "openai",
  model: "gpt-5.6-sol"
};

const baseCosts = {
  baseSessionContextTokens: 20000,
  featureDesignContextTokens: 10000
};
const correlationKey = "a".repeat(64);
const registry = JSON.parse(readFileSync(new URL("../../dist/server/session/session-capacity-registry.json", import.meta.url), "utf8"));

test("keeps the usable window percentage separate from automatic compaction", () => {
  for (const profile of registry.profiles) {
    assert.equal(profile.capacity.effectiveContextWindowPercent, 95);
    assert.equal(profile.capacity.autoCompactionPercent, 90);
    assert.equal(profile.capacity.compactionThresholdTokens, 244800);
  }
});

test("resolves exact registered capacity with provenance", () => {
  const result = resolveSessionCapacity(supportedSession);

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.capacity.contextWindowTokens, 272000);
  assert.equal(result.capacity.compactionThresholdTokens, 244800);
  assert.equal(result.capacity.implementationReserveTokens, 60000);
  assert.deepEqual(result.provenance.contextWindow, {
    source: "registry",
    profileId: "codex-cli-0.147.0-openai-default",
    registrySource: "codex debug models --bundled",
    sourceVersion: "codex-cli 0.147.0",
    verifiedAt: "2026-09-19",
    field: "context_window"
  });
  assert.deepEqual(result.provenance.compactionThreshold, {
    source: "registry",
    profileId: "codex-cli-0.147.0-openai-default",
    registrySource: "openai/codex codex-rs/protocol/src/openai_models.rs ModelInfo::auto_compact_token_limit",
    sourceVersion: "codex-cli 0.147.0",
    verifiedAt: "2026-09-19",
    field: "default auto_compact_token_limit (90 percent)",
    derivation: "floor(context_window * auto_compaction_percent / 100)"
  });
  assert.deepEqual(result.provenance.implementationReserve, {
    source: "registry",
    profileId: "codex-cli-0.147.0-openai-default",
    registrySource: "Prism session-fit policy",
    sourceVersion: "1",
    verifiedAt: "2026-09-19",
    field: "implementationReserveTokens"
  });
});

test("resolves the active Codex host version only for its verified model", () => {
  const result = resolveSessionCapacity({
    harness: "codex-cli",
    harnessVersion: "0.155.0-alpha.9.2",
    provider: "openai",
    model: "gpt-5.6-sol"
  });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.profileId, "codex-cli-0.155.0-alpha.9.2-openai-gpt-5.6-sol");
  assert.equal(result.capacity.compactionThresholdTokens, 244800);
  assert.equal(resolveSessionCapacity({
    harness: "codex-cli",
    harnessVersion: "0.155.0-alpha.9.2",
    provider: "openai",
    model: "gpt-5.6-terra"
  }).status, "UNSUPPORTED");
});

test("resolves the reviewed Desktop Codex alpha profile", () => {
  const result = resolveSessionCapacity({
    harness: "codex-cli",
    harnessVersion: "0.155.0-alpha.2.6",
    provider: "openai",
    model: "gpt-5.6-sol"
  });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.profileId, "codex-cli-0.155.0-alpha.2.6-openai-gpt-5.6-sol");
  assert.equal(result.capacity.compactionThresholdTokens, 244800);
});

test("uses explicit capacity overrides before registered values", () => {
  const result = resolveSessionCapacity({
    ...supportedSession,
    capacityOverrides: {
      contextWindowTokens: 300000,
      compactionThresholdTokens: 270000
    }
  });

  assert.equal(result.capacity.contextWindowTokens, 300000);
  assert.equal(result.capacity.compactionThresholdTokens, 270000);
  assert.deepEqual(result.provenance.contextWindow, {
    source: "explicit-input",
    input: "session.capacityOverrides.contextWindowTokens"
  });
  assert.deepEqual(result.provenance.compactionThreshold, {
    source: "explicit-input",
    input: "session.capacityOverrides.compactionThresholdTokens"
  });
});

test("preserves mixed registry and explicit provenance", () => {
  const result = evaluateRepositoryFit({
    session: {
      ...supportedSession,
      capacityOverrides: { compactionThresholdTokens: 250000 }
    },
    costs: { ...baseCosts, implementationReserveTokens: 70000 },
    tokenEstimate: { lower: 10, expected: 20, upper: 30 }
  });

  assert.deepEqual(result.provenance.contextWindow, {
    source: "registry",
    profileId: "codex-cli-0.147.0-openai-default",
    registrySource: "codex debug models --bundled",
    sourceVersion: "codex-cli 0.147.0",
    verifiedAt: "2026-09-19",
    field: "context_window"
  });
  assert.deepEqual(result.provenance.compactionThreshold, {
    source: "explicit-input",
    input: "session.capacityOverrides.compactionThresholdTokens"
  });
  assert.deepEqual(result.provenance.implementationReserve, {
    source: "explicit-input",
    input: "costs.implementationReserveTokens"
  });
});

test("supports explicit capacity for an unregistered model", () => {
  const result = resolveSessionCapacity({
    harness: "custom-harness",
    harnessVersion: "1.0.0",
    provider: "aws-bedrock",
    model: "vendor.model-v1",
    capacityOverrides: {
      contextWindowTokens: 200000,
      compactionThresholdTokens: 180000
    }
  });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.profileId, null);
  assert.equal(result.capacity.contextWindowTokens, 200000);
  assert.equal(result.capacity.compactionThresholdTokens, 180000);
});

test("returns unsupported for an unknown combination without complete overrides", () => {
  const result = resolveSessionCapacity({
    harness: "codex-cli",
    harnessVersion: "0.147.0",
    provider: "openai",
    model: "unknown-model"
  });

  assert.deepEqual(result, {
    status: "UNSUPPORTED",
    reason: "No exact capacity profile or complete explicit capacity was supplied."
  });
});

test("matches every registry dimension exactly", () => {
  for (const session of [
    { ...supportedSession, harness: "other" },
    { ...supportedSession, harnessVersion: "0.147.1" },
    { ...supportedSession, provider: "aws-bedrock" },
    { ...supportedSession, model: "unknown-model" }
  ]) {
    assert.equal(resolveSessionCapacity(session).status, "UNSUPPORTED");
  }
});

test("resolves aliases only inside an exact profile match", () => {
  const alias = resolveSessionCapacity({ ...supportedSession, model: "gpt-5.6" });
  const wrongVersion = resolveSessionCapacity({ ...supportedSession, harnessVersion: "0.147.1", model: "gpt-5.6" });

  assert.equal(alias.status, "SUPPORTED");
  assert.equal(alias.model.canonical, "gpt-5.6-sol");
  assert.equal(wrongVersion.status, "UNSUPPORTED");
});

test("does not classify a fit using the larger usable context window", () => {
  const result = evaluateRepositoryFit({
    session: supportedSession,
    costs: baseCosts,
    tokenEstimate: { lower: 50000, expected: 100000, upper: 160000 }
  });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.repositoryReadBudgetTokens, 154800);
  assert.equal(result.fit, "UNCERTAIN");
});

test("classifies split from the lower estimate", () => {
  const result = evaluateRepositoryFit({
    session: supportedSession,
    costs: baseCosts,
    tokenEstimate: { lower: 180000, expected: 190000, upper: 200000 }
  });

  assert.equal(result.fit, "SPLIT");
});

test("classifies an overlapping or incomplete estimate as uncertain", () => {
  const overlap = evaluateRepositoryFit({
    session: supportedSession,
    costs: baseCosts,
    tokenEstimate: { lower: 150000, expected: 160000, upper: 170000 }
  });
  const incomplete = evaluateRepositoryFit({
    session: supportedSession,
    costs: baseCosts,
    tokenEstimate: { lower: null, expected: null, upper: null }
  });

  assert.equal(overlap.fit, "UNCERTAIN");
  assert.equal(incomplete.fit, "UNCERTAIN");
});

test("applies equality boundaries deterministically", () => {
  const exactUpper = evaluateRepositoryFit({
    session: supportedSession,
    costs: baseCosts,
    tokenEstimate: { lower: 150000, expected: 152000, upper: 154800 }
  });
  const exactLower = evaluateRepositoryFit({
    session: supportedSession,
    costs: baseCosts,
    tokenEstimate: { lower: 154800, expected: 160000, upper: 180000 }
  });

  assert.equal(exactUpper.fit, "FIT");
  assert.equal(exactLower.fit, "UNCERTAIN");
});

test("uses an adjustable implementation reserve", () => {
  const result = evaluateRepositoryFit({
    session: supportedSession,
    costs: { ...baseCosts, implementationReserveTokens: 90000 },
    tokenEstimate: { lower: 140000, expected: 145000, upper: 150000 }
  });

  assert.equal(result.costs.implementationReserveTokens, 90000);
  assert.equal(result.repositoryReadBudgetTokens, 124800);
  assert.equal(result.fit, "SPLIT");
});

test("does not classify fit for an unsupported session", () => {
  const result = evaluateRepositoryFit({
    session: { ...supportedSession, model: "unknown-model" },
    costs: baseCosts,
    tokenEstimate: { lower: 10, expected: 20, upper: 30 }
  });

  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.fit, null);
  assert.equal(result.repositoryReadBudgetTokens, null);
});

test("rejects invalid capacity and cost values", () => {
  assert.throws(() => resolveSessionCapacity({
    ...supportedSession,
    capacityOverrides: { compactionThresholdTokens: 300000 }
  }), /cannot exceed/);
  assert.throws(() => evaluateRepositoryFit({
    session: supportedSession,
    costs: { ...baseCosts, implementationReserveTokens: -1 },
    tokenEstimate: { lower: 1, expected: 2, upper: 3 }
  }), /nonnegative integer/);
});

test("rejects malformed session, costs, and estimates", () => {
  for (const input of [
    { session: { ...supportedSession, extra: true }, costs: baseCosts, tokenEstimate: { lower: 1, expected: 2, upper: 3 } },
    { session: { ...supportedSession, capacityOverrides: { contextWindowTokens: 1.5 } }, costs: baseCosts, tokenEstimate: { lower: 1, expected: 2, upper: 3 } },
    { session: supportedSession, costs: { ...baseCosts, extra: 1 }, tokenEstimate: { lower: 1, expected: 2, upper: 3 } },
    { session: supportedSession, costs: { baseSessionContextTokens: 1 }, tokenEstimate: { lower: 1, expected: 2, upper: 3 } },
    { session: supportedSession, costs: baseCosts, tokenEstimate: { lower: 3, expected: 2, upper: 1 } },
    { session: supportedSession, costs: baseCosts, tokenEstimate: { lower: null, expected: 2, upper: null } },
    { session: supportedSession, costs: baseCosts, tokenEstimate: { lower: 1, expected: 2, upper: 3, extra: 4 } }
  ]) {
    assert.throws(() => evaluateRepositoryFit(input));
  }
});

test("validates the canonical registry and rejects malformed registries", () => {
  assert.equal(validateCapacityRegistry(), true);

  const baseProfile = {
    id: "test",
    match: {
      harness: "test",
      harnessVersion: "1.0.0",
      provider: "test",
      models: ["model"],
      aliases: {}
    },
    capacity: {
      contextWindowTokens: 100,
      effectiveContextWindowPercent: 95,
      autoCompactionPercent: 90,
      compactionThresholdTokens: 90,
      implementationReserveTokens: 10
    },
    provenance: {
      contextWindow: {
        source: "test",
        sourceVersion: "1.0.0",
        verifiedAt: "2026-09-19",
        field: "context_window"
      },
      compactionThreshold: {
        source: "test",
        sourceVersion: "1.0.0",
        verifiedAt: "2026-09-19",
        field: "auto_compact_token_limit",
        derivation: "floor(context_window * auto_compaction_percent / 100)"
      },
      implementationReserve: {
        source: "test policy",
        sourceVersion: "1",
        verifiedAt: "2026-09-19",
        field: "implementationReserveTokens"
      }
    }
  };

  for (const registry of [
    { schemaVersion: 2, profiles: [baseProfile] },
    { schemaVersion: 1, profiles: [baseProfile, { ...baseProfile, id: "duplicate" }] },
    { schemaVersion: 1, profiles: [{ ...baseProfile, match: { ...baseProfile.match, aliases: { alias: "missing" } } }] },
    { schemaVersion: 1, profiles: [{ ...baseProfile, capacity: { ...baseProfile.capacity, compactionThresholdTokens: 91 } }] }
  ]) {
    assert.throws(() => validateCapacityRegistry(registry));
  }

  const boundaryProfile = {
    ...baseProfile,
    id: "safe-integer-boundary",
    capacity: {
      ...baseProfile.capacity,
      contextWindowTokens: 9007199254740933,
      autoCompactionPercent: 3,
      compactionThresholdTokens: 270215977642227
    }
  };
  assert.equal(validateCapacityRegistry({ schemaVersion: 1, profiles: [boundaryProfile] }), true);
  assert.throws(() => validateCapacityRegistry({
    schemaVersion: 1,
    profiles: [{
      ...boundaryProfile,
      capacity: { ...boundaryProfile.capacity, compactionThresholdTokens: 270215977642228 }
    }]
  }), /inconsistent/);
});

test("resolves complete direct same-session host capacity and preserves provenance", async () => {
  const facts = {
    status: "SUPPORTED",
    session: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol",
      capacityOverrides: {
        contextWindowTokens: 272000,
        compactionThresholdTokens: 240000
      }
    },
    compactionScope: "total",
    provenance: {
      source: "active-host-session",
      observedAt: "2026-09-19T12:00:00.000Z",
      fields: {
        contextWindowTokens: "hook.model_context_window",
        compactionThresholdTokens: "hook.model_auto_compact_token_limit",
        compactionScope: "hook.model_auto_compact_token_limit_scope"
      }
    }
  };
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project"
  }, { readFacts: async () => facts });

  assert.equal(resolution.status, "SUPPORTED");
  assert.equal(resolution.capacity.contextWindowTokens, 272000);
  assert.equal(resolution.capacity.compactionThresholdTokens, 240000);
  assert.equal(resolution.provenance.contextWindow.source, "active-host-session");
  assert.deepEqual(resolution.provenance.compactionThreshold, {
    source: "active-host-session",
    observedAt: "2026-09-19T12:00:00.000Z",
    field: "hook.model_auto_compact_token_limit"
  });
  assert.equal(resolution.compactionScope, "total");
  assert.equal(resolution.compactionScopeProvenance.field, "hook.model_auto_compact_token_limit_scope");
});

test("lets explicit active capacity override same-session host facts", async () => {
  const facts = {
    status: "SUPPORTED",
    session: {
      harness: "codex-cli",
      harnessVersion: "unknown-version",
      provider: "custom",
      model: "custom-model",
      capacityOverrides: { contextWindowTokens: 100000, compactionThresholdTokens: 90000 }
    },
    compactionScope: "total",
    provenance: {
      source: "active-host-session",
      observedAt: "2026-09-19T12:00:00.000Z",
      fields: { compactionScope: "hook.model_auto_compact_token_limit_scope" }
    }
  };
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project",
    capacityOverrides: { contextWindowTokens: 120000, compactionThresholdTokens: 110000 }
  }, { readFacts: async () => facts });

  assert.equal(resolution.status, "SUPPORTED");
  assert.deepEqual(resolution.capacity, {
    contextWindowTokens: 120000,
    compactionThresholdTokens: 110000,
    implementationReserveTokens: null
  });
  assert.equal(resolution.provenance.contextWindow.source, "explicit-input");
  assert.equal(resolution.provenance.compactionThreshold.source, "explicit-input");
});

test("rejects partial active capacity overrides instead of merging them with host facts", async () => {
  const facts = {
    status: "SUPPORTED",
    session: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol",
      capacityOverrides: { contextWindowTokens: 272000, compactionThresholdTokens: 244800 }
    },
    compactionScope: "total",
    provenance: {
      source: "active-host-session",
      observedAt: "2026-09-19T12:00:00.000Z",
      fields: { compactionScope: "hook.model_auto_compact_token_limit_scope" }
    }
  };
  let readCount = 0;
  const readFacts = async () => {
    readCount += 1;
    return facts;
  };

  await assert.rejects(
    resolveActiveSessionCapacity({
      dataDirectory: "/plugin-data",
      correlationKey,
      projectRoot: "/project",
      capacityOverrides: { contextWindowTokens: 120000 }
    }, { readFacts }),
    /compactionThresholdTokens is required/
  );
  await assert.rejects(
    resolveActiveSessionCapacity({
      dataDirectory: "/plugin-data",
      correlationKey,
      projectRoot: "/project",
      capacityOverrides: { compactionThresholdTokens: 100000 }
    }, { readFacts }),
    /contextWindowTokens is required/
  );
  assert.equal(readCount, 0);
});

test("does not fall back to a registry threshold that the active host did not attest", async () => {
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project"
  }, {
    readFacts: async () => ({
      status: "SUPPORTED",
      session: { harness: "codex-cli", harnessVersion: "0.147.0", provider: "openai", model: "gpt-5.6-sol" },
      compactionScope: "total",
      provenance: {
        source: "active-host-session",
        observedAt: "2026-09-19T12:00:00.000Z",
        fields: { compactionScope: "hook.model_auto_compact_token_limit_scope" }
      }
    })
  });

  assert.equal(resolution.status, "UNSUPPORTED");
  assert.equal(resolution.reasonCode, ACTIVE_CAPACITY_REASON.UNATTESTED_ACTIVE_CAPACITY);
});

test("uses the exact registry threshold when effective config proves no override", async () => {
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project"
  }, {
    readFacts: async () => ({
      status: "SUPPORTED",
      session: {
        harness: "codex-cli",
        harnessVersion: "0.155.0-alpha.2.6",
        provider: "openai",
        model: "gpt-5.6-sol",
        capacityOverrides: { contextWindowTokens: 258400 }
      },
      compactionScope: "total",
      provenance: {
        source: "active-host-session",
        observedAt: "2026-09-19T12:00:00.000Z",
        fields: {
          contextWindowTokens: "transcript.event_msg.token_count.info.model_context_window",
          compactionThresholdTokens: "config.absent.model_auto_compact_token_limit",
          compactionScope: "config.default.model_auto_compact_token_limit_scope"
        }
      }
    })
  });

  assert.equal(resolution.status, "SUPPORTED");
  assert.equal(resolution.capacity.contextWindowTokens, 258400);
  assert.equal(resolution.capacity.compactionThresholdTokens, 244800);
  assert.equal(resolution.provenance.compactionThreshold.source, "registry");
});

test("rejects registry fallback when the active context does not match the exact default", async () => {
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project"
  }, {
    readFacts: async () => ({
      status: "SUPPORTED",
      session: {
        harness: "codex-cli",
        harnessVersion: "0.155.0-alpha.2.6",
        provider: "openai",
        model: "gpt-5.6-sol",
        capacityOverrides: { contextWindowTokens: 200000 }
      },
      compactionScope: "total",
      provenance: {
        source: "active-host-session",
        observedAt: "2026-09-19T12:00:00.000Z",
        fields: {
          contextWindowTokens: "transcript.event_msg.token_count.info.model_context_window",
          compactionThresholdTokens: "config.absent.model_auto_compact_token_limit",
          compactionScope: "config.default.model_auto_compact_token_limit_scope"
        }
      }
    })
  });

  assert.equal(resolution.status, "UNSUPPORTED");
  assert.equal(resolution.reasonCode, ACTIVE_CAPACITY_REASON.UNATTESTED_ACTIVE_CAPACITY);
});

test("recovers identity-matched unsupported facts with complete overrides and attested total scope", async () => {
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project",
    capacityOverrides: { contextWindowTokens: 120000, compactionThresholdTokens: 100000 }
  }, {
    readFacts: async () => ({
      status: "UNSUPPORTED",
      reasonCode: "HOST_CAPACITY_UNAVAILABLE",
      reason: "Capacity was not directly attested.",
      session: { harness: "codex-cli", harnessVersion: "0.147.0", provider: "openai", model: "gpt-5.6-sol" },
      compactionScope: "total",
      provenance: {
        source: "active-host-session",
        observedAt: "2026-09-19T12:00:00.000Z",
        fields: { compactionScope: "hook.model_auto_compact_token_limit_scope" }
      }
    })
  });

  assert.equal(resolution.status, "SUPPORTED");
  assert.equal(resolution.capacity.contextWindowTokens, 120000);
  assert.equal(resolution.capacity.compactionThresholdTokens, 100000);
  assert.equal(resolution.compactionScopeProvenance.source, "active-host-session");
});

test("requires an explicit total-scope attestation when unsupported facts have unknown scope", async () => {
  const facts = {
    status: "UNSUPPORTED",
    reasonCode: "HOST_CAPACITY_UNAVAILABLE",
    reason: "Capacity was not directly attested.",
    session: { harness: "codex-cli", harnessVersion: "0.147.0", provider: "openai", model: "gpt-5.6-sol" },
    compactionScope: null,
    provenance: { source: "active-host-session", observedAt: "2026-09-19T12:00:00.000Z", fields: {} }
  };
  const activeSession = {
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project",
    capacityOverrides: { contextWindowTokens: 120000, compactionThresholdTokens: 100000 }
  };
  const unsupported = await resolveActiveSessionCapacity(activeSession, { readFacts: async () => facts });
  const supported = await resolveActiveSessionCapacity({
    ...activeSession,
    compactionScope: "total"
  }, { readFacts: async () => facts });

  assert.equal(unsupported.reasonCode, ACTIVE_CAPACITY_REASON.TOTAL_COMPACTION_SCOPE_REQUIRED);
  assert.equal(supported.status, "SUPPORTED");
  assert.deepEqual(supported.compactionScopeProvenance, {
    source: "explicit-input",
    input: "activeSession.compactionScope"
  });
});

test("does not let active input contradict a body-after-prefix fact", async () => {
  const facts = {
    status: "UNSUPPORTED",
    reasonCode: "UNSUPPORTED_COMPACTION_SCOPE",
    reason: "The active compaction accounting scope is unsupported.",
    session: { harness: "codex-cli", harnessVersion: "0.147.0", provider: "openai", model: "gpt-5.6-sol" },
    compactionScope: "body_after_prefix",
    provenance: { source: "active-host-session", observedAt: "2026-09-19T12:00:00.000Z", fields: {} }
  };
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project",
    capacityOverrides: { contextWindowTokens: 120000, compactionThresholdTokens: 100000 },
    compactionScope: "total"
  }, { readFacts: async () => facts });

  assert.equal(resolution.status, "UNSUPPORTED");
  assert.equal(resolution.reasonCode, "UNSUPPORTED_COMPACTION_SCOPE");
});

test("does not recover an unsupported execution with capacity overrides", async () => {
  const facts = {
    status: "UNSUPPORTED",
    reasonCode: "UNSUPPORTED_EXECUTION",
    reason: "The active host execution kind is unsupported.",
    session: { harness: "codex-cli", harnessVersion: "0.147.0", provider: "openai", model: "gpt-5.6-sol" },
    compactionScope: null,
    provenance: { source: "active-host-session", observedAt: "2026-09-19T12:00:00.000Z", fields: {} }
  };
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project",
    capacityOverrides: { contextWindowTokens: 120000, compactionThresholdTokens: 100000 },
    compactionScope: "total"
  }, { readFacts: async () => facts });

  assert.equal(resolution.status, "UNSUPPORTED");
  assert.equal(resolution.reasonCode, "UNSUPPORTED_EXECUTION");
});

test("evaluates repository fit from active facts", async () => {
  const result = await evaluateActiveRepositoryFit({
    costs: { baseSessionContextTokens: 10000, featureDesignContextTokens: 10000, implementationReserveTokens: 50000 },
    tokenEstimate: { lower: 100000, expected: 120000, upper: 130000 }
  }, {
    dataDirectory: "/plugin-data",
    correlationKey,
    projectRoot: "/project"
  }, {
    readFacts: async () => ({
      status: "SUPPORTED",
      session: {
        harness: "codex-cli",
        harnessVersion: "0.147.0",
        provider: "openai",
        model: "gpt-5.6-sol",
        capacityOverrides: { contextWindowTokens: 272000, compactionThresholdTokens: 244800 }
      },
      compactionScope: "total",
      provenance: {
        source: "active-host-session",
        observedAt: "2026-09-19T12:00:00.000Z",
        fields: {
          contextWindowTokens: "hook.model_context_window",
          compactionThresholdTokens: "hook.model_auto_compact_token_limit",
          compactionScope: "hook.model_auto_compact_token_limit_scope"
        }
      }
    })
  });

  assert.equal(result.fit, "FIT");
  assert.equal(result.repositoryReadBudgetTokens, 174800);
  assert.equal(result.session.model, "gpt-5.6-sol");
});
