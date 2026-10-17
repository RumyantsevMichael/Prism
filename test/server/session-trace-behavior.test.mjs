import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSessionTraceBehavior,
  sessionTraceBehaviorRegistry,
  validateSessionTraceBehaviorRegistry
} from "../../dist/server/session/session-trace-behavior.mjs";

test("recognizes reviewed Codex trace behavior versions and the versions they cover", () => {
  const registry = sessionTraceBehaviorRegistry();
  assert.deepEqual(registry.profiles.map((profile) => profile.match.harnessVersion), [
    "0.147.0",
    "0.163.0",
    "0.155.0-alpha.9.2"
  ]);
  for (const harnessVersion of ["0.147.0", "0.163.0", "0.155.0-alpha.9.2"]) {
    const profile = resolveSessionTraceBehavior({
      harness: "codex-cli",
      harnessVersion,
      provider: "openai"
    });
    assert.deepEqual(profile.postToolUseSuccessTools, ["apply_patch"]);
    assert.equal(profile.modelFacingResponseShape, "bounded-string");
    assert.match(profile.provenance.source, new RegExp(`rust-v${harnessVersion.replaceAll(".", "\\.")}`));
  }
  for (const [harnessVersion, profileId] of [
    ["0.155.0", "codex-cli-0.147.0-openai-trace"],
    ["0.162.1", "codex-cli-0.147.0-openai-trace"],
    ["0.164.0", "codex-cli-0.163.0-openai-trace"],
    ["1.0.0", "codex-cli-0.163.0-openai-trace"]
  ]) {
    assert.equal(resolveSessionTraceBehavior({ harness: "codex-cli", harnessVersion, provider: "openai" }).id, profileId);
  }
  for (const harnessVersion of ["0.146.0", "0.147.0-alpha.1", "unknown-version"]) {
    assert.equal(resolveSessionTraceBehavior({ harness: "codex-cli", harnessVersion, provider: "openai" }), null);
  }
  assert.equal(resolveSessionTraceBehavior({ harness: "codex-cli", harnessVersion: "0.163.0", provider: "azure" }), null);
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
  assert.throws(() => validateSessionTraceBehaviorRegistry({
    ...registry,
    profiles: [{
      ...registry.profiles[0],
      match: { ...registry.profiles[0].match, harnessVersionPolicy: "any" }
    }]
  }), /harnessVersionPolicy is invalid/);
});
