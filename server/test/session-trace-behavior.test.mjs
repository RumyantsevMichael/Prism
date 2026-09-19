import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSessionTraceBehavior,
  sessionTraceBehaviorRegistry,
  validateSessionTraceBehaviorRegistry
} from "../session-trace-behavior.mjs";

test("recognizes only the reviewed Codex trace behavior versions", () => {
  const registry = sessionTraceBehaviorRegistry();
  assert.deepEqual(registry.profiles.map((profile) => profile.match.harnessVersion), [
    "0.147.0",
    "0.155.0-alpha.9.2"
  ]);
  for (const harnessVersion of ["0.147.0", "0.155.0-alpha.9.2"]) {
    const profile = resolveSessionTraceBehavior({
      harness: "codex-cli",
      harnessVersion,
      provider: "openai"
    });
    assert.deepEqual(profile.postToolUseSuccessTools, ["apply_patch"]);
    assert.equal(profile.modelFacingResponseShape, "bounded-string");
    assert.match(profile.provenance.source, new RegExp(`rust-v${harnessVersion.replaceAll(".", "\\.")}`));
  }
  assert.equal(resolveSessionTraceBehavior({
    harness: "codex-cli",
    harnessVersion: "0.155.0",
    provider: "openai"
  }), null);
});

test("rejects ambiguous or widened trace behavior registries", () => {
  const registry = sessionTraceBehaviorRegistry();
  assert.throws(() => validateSessionTraceBehaviorRegistry({
    ...registry,
    profiles: [...registry.profiles, structuredClone(registry.profiles[0])]
  }), /Duplicate trace behavior profile id/);
  assert.throws(() => validateSessionTraceBehaviorRegistry({
    ...registry,
    profiles: [{
      ...registry.profiles[0],
      modelFacingResponseShape: "json"
    }]
  }), /modelFacingResponseShape is invalid/);
  assert.throws(() => validateSessionTraceBehaviorRegistry({
    ...registry,
    profiles: [{
      ...registry.profiles[0],
      provenance: {
        ...registry.profiles[0].provenance,
        source: "https://github.com/openai/codex/tree/main/codex-rs/core/src/tools"
      }
    }]
  }), /exact reviewed source/);
});
