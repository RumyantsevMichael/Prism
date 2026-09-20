# Refresh active Codex capacity from correlated runtime evidence

Status: Proposed
Created: 2026-09-20

## Requirements

[Refresh and resolve active Codex capacity](../../requirements/active-session-capacity.md#5) requires runtime refresh before active capacity resolution.
[Reject unproved active-session capacity](../../requirements/active-session-capacity.md#3) requires fail-closed handling for missing or conflicting evidence.

## Problem

Codex Desktop can expose the effective context window in a correlated transcript after the first model call.
Codex can also expose the effective layered settings for a working directory through its local app-server.
Prism must use these sources without asking the model for sampling or reading broad user configuration files.

## Decision

Prism MUST refresh active Codex facts on every enabled `PreToolUse` event.
The refresh MUST read only the bounded first `session_meta` record and the latest bounded `token_count` record from the correlated transcript.
The refresh MUST use the transcript `model_context_window` value as the active effective context window.
The refresh MUST query the Codex app-server effective configuration for the event working directory when active capacity is observable.
The configuration query MUST inspect effective values and layer provenance for `model_context_window`, `model_auto_compact_token_limit`, and `model_auto_compact_token_limit_scope`.
The configuration reader version MAY differ from the active harness version when the response is valid and the returned values are unambiguous.
An explicit effective compaction threshold and scope MUST take precedence over a registry default.
When the effective configuration proves that no threshold override exists, Prism MUST use the exact version, provider, and model registry default threshold policy.
When the configuration explicitly overrides the context window, Prism MUST derive the threshold from that context with the exact profile's reviewed default percentage and MUST verify the transcript effective window against the same profile.
When no context override is present, Prism MUST verify the transcript effective window against the exact profile before using its fixed default threshold.
Complete explicit caller capacity overrides MUST remain the highest precedence source.
Prism MUST reject conflicting transcript, hook, configuration, and registry values.
Prism MUST reject an explicit or effective `body_after_prefix` scope.
Prism MUST return `UNSUPPORTED` when transcript evidence or effective configuration cannot be observed within the bounded limits.
Prism MUST NOT use MCP sampling for capacity resolution.

## Rationale

The transcript proves the active effective context after the first model call.
The app-server resolves layered Codex settings for the same working directory without exposing unrelated configuration.
The registry supplies a reviewed default only after the effective configuration proves that no threshold override exists.
The fail-closed rule prevents a stale or inaccessible configuration source from hiding a runtime override.

## Alternatives

### Read user configuration files

Declined because file layers do not prove the settings applied to the active Codex process.

### Use MCP sampling

Declined because the current MCP client does not advertise sampling and capacity resolution must not add an LLM call.

### Use a registry default without configuration proof

Declined because an active threshold override could differ from the reviewed default.

## Consequences

Automatic active capacity becomes available after the first correlated model call when the app-server query succeeds.
An unavailable app-server or an ambiguous layer result keeps active capacity unsupported.
The registry remains useful for exact default thresholds and does not replace runtime identity checks.
The active capacity result can report a different effective context window from the raw registry catalog value.

## Mechanism

The `PreToolUse` hook invokes the bounded fact recorder before the trace recorder.
The fact recorder reads the correlated transcript and requests effective settings from the local Codex app-server.
The fact store keeps only the active effective values and field-level provenance under the existing correlation digest.
The capacity resolver applies caller overrides, direct runtime overrides, explicit configuration values, and exact registry defaults in that order.
The resolver returns no fit classification when a required source is missing, conflicting, stale, or outside the supported scope.

## Supersession scope

This ADR supersedes only the active-capacity source rules in [Use same-session facts and privacy-bounded local traces](same-session-facts-and-local-tracing.md).
It replaces the rule that limits Codex inspection to the first `session_meta` record.
It replaces the rule that treats user configuration as advisory for active capacity.
It replaces the rule that forbids a registry default from supplying an active threshold when no higher-precedence override is observed.
It preserves the original ADR's identity correlation, storage, retention, tracing, privacy, and lifecycle decisions.

## Decision Log

2026-09-20: Proposed bounded transcript refresh and app-server effective configuration as the active Codex capacity sources.
