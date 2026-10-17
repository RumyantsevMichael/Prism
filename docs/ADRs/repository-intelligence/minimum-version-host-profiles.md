# Cover later host versions with verified minimum profiles

Status: Proposed
Created: 2026-10-17

## Requirements

[Reject unmatched capacity profiles](../../requirements/session-fit.md#5) defines which host versions a capacity profile covers.
[Refresh and resolve active Codex capacity with covered profiles](../../requirements/active-session-capacity.md#6) applies the same coverage to active Codex capacity.
[Prove host behavior with a covering profile and stable project identity](../../requirements/session-consumption-tracing.md#12) applies the same coverage to Codex edit completion.

## Problem

Capacity and trace behavior profiles matched only the exact host version that was reviewed.
Codex ships new versions about weekly, so every current installation fell outside the bundled profiles and active capacity and consumption returned `UNSUPPORTED` on every machine.
Re-reviewing every Codex release before it can be used is not sustainable.

## Decision

Each capacity and trace behavior profile MUST declare whether its verified host version is matched exactly or as a minimum.
Harness, provider, and model MUST still match exactly.
A minimum profile MUST cover its verified version and every later semantic version, including prereleases, until a later minimum profile for the same harness, provider, and model replaces it.
When several minimum profiles cover a version, Prism MUST select the one with the newest verified version.
A version that has an exact profile MUST resolve only through exact profiles for that version.
A version that cannot be ordered as a semantic version MUST resolve only through an exact profile.
Active Codex capacity MUST keep verifying the transcript effective window against the selected profile before it uses a default threshold.
A new profile SHOULD be added when a host release changes a default that a profile records or adds a model that users select.

## Rationale

A host's capacity defaults and hook lifecycle change far less often than its version number.
The transcript cross-check detects a changed default context window at runtime, so a stale profile fails closed for the value most likely to drift.
Exact profiles keep a reviewed prerelease from inheriting facts that were deliberately not verified for it.

## Alternatives

### Add an exact profile for every release

Declined because each release leaves every user unsupported until a new plugin version ships.

### Match any version of a known harness

Declined because a profile verified on one version says nothing about earlier versions.

### Bound each minimum profile with a maximum version

Declined because an unreleased maximum cannot be verified and reproduces the per-release maintenance cost.

## Consequences

Current Codex releases resolve capacity and edit completion without a plugin update.
A later Codex release can change the default compaction percentage without detection until a new profile replaces the old one.
A model that only an older profile lists keeps that profile's facts on later versions, and the transcript cross-check still rejects a mismatched context window.

## Mechanism

Registry validation requires a version policy on every profile and requires a semantic version for a minimum policy.
Resolution filters profiles by harness, provider, and model, prefers exact profiles at the requested version, and otherwise picks the newest minimum profile at or below it.
The capacity resolver and the trace behavior resolver share the same selection rule.

## Supersession scope

This ADR supersedes the exact-version matching rules in [Refresh active Codex capacity from correlated runtime evidence](active-codex-capacity-resolution.md) and the exact-version lifecycle rule in [Use same-session facts and privacy-bounded local traces](same-session-facts-and-local-tracing.md).
It preserves every other rule in both ADRs, including fail-closed handling, precedence, transcript verification, and privacy.

## Decision Log
