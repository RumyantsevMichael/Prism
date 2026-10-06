# Use same-session facts and privacy-bounded local traces

Status: Accepted
Created: 2026-09-19

## Requirements

[Capture allowlisted active-session facts](../../requirements/active-session-capacity.md#1) requires narrow host fact collection.
[Resolve same-session capacity](../../requirements/active-session-capacity.md#2) requires deterministic source precedence.
[Reject unproved active-session capacity](../../requirements/active-session-capacity.md#3) requires fail-closed identity handling.
[Bound local fact retention](../../requirements/active-session-capacity.md#4) requires deterministic fact cleanup.
[Record allowlisted session events](../../requirements/session-consumption-tracing.md#1) requires local privacy boundaries.
[Identify the first successful edit](../../requirements/session-consumption-tracing.md#2) requires confirmed mutation evidence.
[Summarize pre-edit repository consumption](../../requirements/session-consumption-tracing.md#3) requires coverage-aware measurement.
[Isolate root execution observations](../../requirements/session-consumption-tracing.md#5) requires root and subagent separation.
[Bound aggregate trace retention](../../requirements/session-consumption-tracing.md#6) requires deterministic cleanup.
[Mark approximate rendered-token observations](../../requirements/session-consumption-tracing.md#7) requires explicit approximation coverage.
[Resolve traces by session correlation key](../../requirements/session-consumption-tracing.md#8) requires digest-based MCP lookup.
[Prove host behavior and stable project identity](../../requirements/session-consumption-tracing.md#9) requires versioned behavior evidence and canonical host roots.
[Order observations by occurrence](../../requirements/session-consumption-tracing.md#10) requires deterministic chronology.
[Protect trace storage authority](../../requirements/session-consumption-tracing.md#11) requires contained records and fenced writers.

## Problem

The active host can know its model and effective capacity settings, but the MCP process cannot safely infer those facts from another shell process or broad configuration reads.
Future calibration also needs pre-edit measurements without retaining user content.

## Decision

Prism MUST accept active-session facts only through enabled host hooks or complete explicit input.
The fact hook MUST hash the raw host session identifier locally and MUST expose the resulting SHA-256 correlation key plus the absolute plugin data directory as bounded additional context.
Stored facts and traces MUST use the same digest, and active MCP tools MUST require that digest instead of reading private request metadata.
The raw session identifier MUST NOT leave the hook boundary through MCP input, stored public output, or additional context.
Stored facts MUST be matched as one identity block by correlation key and canonical project root.
Codex facts MUST use the canonical project root from correlated transcript metadata, and subagent executions MUST NOT write capacity facts under the parent session identity.
Prism MUST NOT combine identity or capacity fields from different sessions.
Prism MUST allowlist stored fields and MUST ignore unknown host configuration and environment values.
Prism MUST inspect only the bounded first `session_meta` transcript record for correlated Codex version, provider, root-execution, session, and project classification.
Prism MUST NOT persist transcript paths or transcript content.
User configuration inspection MUST remain advisory and MUST NOT establish effective active-session capacity.
Complete explicit capacity overrides MUST take precedence over complete directly attested same-session host overrides.
Partial active capacity override objects MUST be rejected rather than merged with directly attested values.
An exact registry profile MUST NOT establish an active threshold when a higher-precedence active override could exist.
Complete active overrides MAY recover an identity-matched unsupported record only when total compaction scope is attested by the stored facts or the active input and MUST NOT contradict a stored `body_after_prefix` scope.
Missing, stale, ambiguous, or insufficient active-session facts MUST return `UNSUPPORTED` with a stable reason code.
Fact retention MUST remove records older than 30 days and MUST evict the oldest eligible records before aggregate fact storage exceeds 16 MiB.
Fact replacement quota checks MUST include the existing target and candidate temporary record for the full interval in which both files coexist.
Fact observations for one session MUST advance monotonically, with older observations rejected and equal-time material conflicts treated as invalid.
The fact store MUST resolve its directory beneath the canonical plugin data directory, reject symbolic-link or multiply linked fact records, and use no-follow file opens where the platform supports them.
Each fact-retention lock owner MUST persist an unguessable ownership token and process identifier, and an aged lock MUST be reclaimed only after its matching owner is confirmed dead.
An active or unknown fact-retention lock owner MUST keep the store unavailable to another writer regardless of lock age.
A fact writer MUST prepare complete ownership in a private directory before atomically publishing the public lock and MUST atomically unpublish that lock before removing its owner record.
An aged empty public lock left before owner publication MAY be quarantined because conforming writers never mutate shared facts before complete ownership is published.
A fact writer MUST verify lock ownership before cleanup and commit, and all shared fact-store mutation MUST remain serialized under that ownership.
Session tracing MUST remain local and disabled until the user enables the applicable hooks.
Trace storage MUST NOT contain prompts, source text, command text, model responses, credentials, or transcripts.
Codex trace events MUST be associated with the root execution by reading only the bounded allowlisted `session_meta` record from the event transcript.
Codex classification MUST use a correlated transcript before environment compatibility aliases, even when the host exports Claude compatibility variables.
Codex-specific markers such as `CODEX_VERSION`, `turn_id`, or the Codex `subagent` field without a root-correlated transcript MUST fail closed.
When no Codex marker or correlated Codex transcript exists, a canonical `CLAUDE_PROJECT_DIR` MUST establish Claude project identity without requiring `CLAUDE_VERSION`.
Subagent action details MUST be excluded, and subagent exclusion or uncertain execution classification MUST reduce root-trace coverage when stable root identity remains provable and otherwise MUST be ignored.
Codex edit completion MUST close the pre-edit window only for root-correlated `PostToolUse` events whose exact harness version, provider, and exact `apply_patch` tool name match `src/server/session-trace-behavior-registry.json`.
The initial trace behavior registry MUST support only Codex `0.147.0` and `0.155.0-alpha.9.2` with provider `openai` under the tagged upstream sources recorded in each profile.
Unknown Codex versions and unknown host edit completion MUST fail closed regardless of response fields.
Claude project identity MUST use the canonical `CLAUDE_PROJECT_DIR`, and Codex project identity MUST use the canonical root from correlated transcript metadata.
Prism MUST NOT hash an unresolved or noncanonical hook project root.
Built-in and provider tool classification MUST use exact allowlisted names, and an available edit path MUST resolve beneath the canonical project root.
When Codex omits a rendered token count and the exact supported behavior profile documents a string response within the one mebibyte bound, Prism MUST estimate a count in memory, MUST persist only the count, and MUST mark the observation partial.
Object responses, oversized strings, and response shapes without an exact behavior profile MUST produce a missing-token coverage gap without serialization.
The JavaScript event validator in `src/server/session-trace.mjs` MUST be the canonical persisted-event contract.
Trace retention MUST remove files older than 30 days, remove owned stale temporary records, count owned active temporary records, and evict the oldest eligible traces before aggregate trace storage exceeds 64 MiB.
Derived event identities MUST include the host event phase so pre-tool and post-tool observations do not suppress each other.
Persisted events and summaries MUST use event time with a stable event-type and event-identity tie breaker before deriving the first edit.
When an approximate or unproved observation requires a paired coverage gap, Prism MUST store the gap first and MUST skip the dependent observation if the gap cannot be stored.
The trace store MUST resolve its directory beneath the canonical plugin data directory, reject symbolic-link or multiply linked records, and use no-follow file opens where the platform supports them.
Each trace lock owner MUST persist an unguessable token and process identifier, and a stale lock MUST be reclaimed only after its matching owner is confirmed dead.
A trace writer MUST verify token ownership before cleanup and commit, and loss of ownership MUST prevent both commit acknowledgement and replacement of a successor record.
MCP trace reads MUST validate the hook-emitted session correlation key and match its session digest with the canonical project identity.
Pre-edit summaries MUST deduplicate overlapping source ranges and MUST report instrumentation coverage.
Unsupported mutation paths MUST reduce coverage instead of producing a misleading zero.
Hook failures MUST NOT block the host action.

## Rationale

One-way same-session correlation avoids using the version or model of another execution without exposing the raw host session identifier to the model or MCP server.
Bounded transcript classification proves the session metadata source while treating the remaining unstable transcript format as untrusted.
Stable reason codes make unsupported capacity actionable without unsafe inference.
Content-free local traces provide enough evidence for later calibration while limiting privacy exposure.
Deterministic age and byte limits bound aggregate local storage across sessions.

## Alternatives

### Read complete host configuration

Declined because host configuration can contain secrets and layered overrides that are not effective in the active session.

### Run the host executable to inspect its defaults

Declined because the installed executable can differ from the active host process.

### Store complete tool inputs and outputs

Declined because calibration requires counts and source identities, not user content.

## Consequences

Automatic capacity is unavailable until compatible hooks are enabled and produce same-session facts.
Old fact records can be removed on the next write after they exceed the retention age or aggregate quota.
Host versions without reliable model-switch events remain unsupported for automatic resolution.
Trace summaries can be partial when a host or tool does not expose rendered token counts or a reviewed mutation lifecycle.
Approximate Codex response counts use the shared `utf8-bytes-divided-by-3` estimator and remain partial because they are not tokenizer-exact.
Old trace files can be removed on the next append after they exceed the retention age or aggregate quota.

## Mechanism

Host hooks write validated facts and events to plugin-local storage with restrictive permissions, canonical path containment, link rejection, and atomic replacement.
The hook writes the SHA-256 correlation key and absolute plugin data directory as additional developer context after a fact record is stored successfully.
The MCP server resolves active capacity and consumption only when the caller supplies that same correlation key and data directory and the canonical project root matches.
The trace behavior registry binds exact reviewed Codex versions to the lifecycle and response-shape facts that tracing may trust.
The session trace store appends idempotent bounded events, orders them by occurrence, and derives a content-free summary on request.
The fact store serializes cleanup and commit under a token-owned lock, reclaims an aged lock only for a confirmed-dead matching process, and treats active or unknown owners as busy.
The trace store serializes cleanup with token-owned directory locks and evicts eligible traces by modification time and then by file name.

## Decision Log

2026-09-19: Accepted same-session hook facts and opt-in local traces after the user approved automatic capacity and pre-edit instrumentation.
2026-09-19: Replaced private MCP metadata correlation with a hook-emitted SHA-256 key and required direct total-scope capacity attestation for active fit decisions.
2026-09-19: Bounded active-session fact retention to 30 days and 16 MiB with deterministic oldest-first eviction.
2026-09-19: Required root execution classification, structural Codex mutation success, canonical project roots, approximate-count coverage, a canonical JavaScript validator, and aggregate trace retention.
2026-09-19: Rejected partial active overrides and hardened fact storage against symbolic-link traversal and stale-owner lock release.
2026-09-19: Replaced response-text success inference with exact versioned Codex lifecycle evidence, stable host roots, chronological derivation, bounded string token estimation, and token-owned trace storage.
2026-09-19: Clarified that fact-store mutation remains under exclusive ownership and that aged locks are reclaimed only after the matching owner is confirmed dead.
