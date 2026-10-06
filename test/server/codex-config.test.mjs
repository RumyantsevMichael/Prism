import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_CONFIG_REASON,
  inspectCodexEffectiveConfig,
  normalizeConfigResponse
} from "../../dist/server/session/host-adapters/codex-config.mjs";

const verifiedAt = "2026-09-20T12:00:00.000Z";

function response(overrides = {}) {
  return {
    config: {
      model: "gpt-5.6-sol",
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: null,
      ...overrides.config
    },
    origins: overrides.origins ?? {},
    layers: overrides.layers ?? [
      { name: { type: "user" }, version: "1", config: {} }
    ],
    serverInfo: { version: "0.155.1" }
  };
}

test("proves capacity overrides absent only with effective config and layer evidence", () => {
  const result = normalizeConfigResponse(response(), { now: () => new Date(verifiedAt) });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.provenance.sourceVersion, "0.155.1");
  assert.deepEqual(result.provenance.absent, {
    model_context_window: true,
    model_auto_compact_token_limit: true,
    model_auto_compact_token_limit_scope: true
  });
});

test("accepts an unambiguous effective threshold and scope", () => {
  const result = normalizeConfigResponse(response({
    config: {
      model_auto_compact_token_limit: 200000,
      model_auto_compact_token_limit_scope: "total"
    },
    origins: {
      model_auto_compact_token_limit: { name: { type: "user" }, version: "1" },
      model_auto_compact_token_limit_scope: { name: { type: "user" }, version: "1" }
    },
    layers: [{
      name: { type: "user" },
      version: "1",
      config: {
        model_auto_compact_token_limit: 200000,
        model_auto_compact_token_limit_scope: "total"
      }
    }]
  }), { now: () => new Date(verifiedAt) });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.config.model_auto_compact_token_limit, 200000);
  assert.equal(result.config.model_auto_compact_token_limit_scope, "total");
});

test("rejects missing provenance, conflicting presence, and body-after-prefix scope", () => {
  const missingLayers = normalizeConfigResponse({ ...response(), layers: null }, {
    now: () => new Date(verifiedAt)
  });
  const missingOrigin = normalizeConfigResponse(response({
    config: { model_auto_compact_token_limit: 200000 },
    layers: [{
      name: { type: "user" },
      version: "1",
      config: { model_auto_compact_token_limit: 200000 }
    }]
  }), { now: () => new Date(verifiedAt) });
  const bodyScope = normalizeConfigResponse(response({
    config: { model_auto_compact_token_limit_scope: "body_after_prefix" },
    origins: {
      model_auto_compact_token_limit_scope: { name: { type: "user" }, version: "1" }
    },
    layers: [{
      name: { type: "user" },
      version: "1",
      config: { model_auto_compact_token_limit_scope: "body_after_prefix" }
    }]
  }), { now: () => new Date(verifiedAt) });

  assert.equal(missingLayers.reasonCode, CODEX_CONFIG_REASON.INVALID_RESPONSE);
  assert.equal(missingOrigin.reasonCode, CODEX_CONFIG_REASON.CONFLICTING_VALUES);
  assert.equal(bodyScope.reasonCode, CODEX_CONFIG_REASON.UNSUPPORTED_SCOPE);
});

test("fails closed when the app-server request is unavailable", async () => {
  const result = await inspectCodexEffectiveConfig({
    cwd: "/project",
    request: async () => {
      throw new Error("unavailable");
    }
  });

  assert.deepEqual(result, {
    status: "UNSUPPORTED",
    reasonCode: CODEX_CONFIG_REASON.APP_SERVER_UNAVAILABLE
  });
});
