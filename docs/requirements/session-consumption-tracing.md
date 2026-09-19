# Session consumption tracing

Status: Approved
Created: 2026-09-19
Approved: 2026-09-19

## Problem

Prism cannot compare planned repository context with the repository context that an implementation session consumes before its first successful edit.

## Goals

- Record privacy-bounded local events for repository reads and edit milestones.
- Summarize unique source consumption before the first successful edit.
- Report instrumentation coverage and compaction timing.
- Keep collection disabled until the user enables host hooks.

## Non-goals

- Upload telemetry.
- Persist prompts, source text, command text, model responses, credentials, or transcripts.
- Train or calibrate a prediction model in this capability.

## Design questions

- n/a.

<a id="1"></a>
## 1. Record allowlisted session events

Pattern: Event-driven

Disposition: Active

Requirement: When enabled host instrumentation observes a supported session or tool event, Prism shall record only its one-way session digest, event type, relative source location, numeric counts, hashes, and provenance.

Rationale: Calibration needs durable measurements without storing user content.

Related: [session-consumption-tracing.md§2](#2), [session-consumption-tracing.md§3](#3), [session-consumption-tracing.md§4](#4), [session-consumption-tracing.md§5](#5), [session-consumption-tracing.md§7](#7), [session-consumption-tracing.md§8](#8)

<a id="2"></a>
## 2. Identify the first successful edit

Pattern: State-driven

Disposition: Active

Requirement: While a traced session has no confirmed successful repository mutation, Prism shall keep the pre-edit measurement window open and shall close it exactly once after the first confirmed successful mutation.

Rationale: An attempted or failed edit does not mark the start of meaningful implementation.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§3](#3), [session-consumption-tracing.md§5](#5), [session-consumption-tracing.md§9](#9), [session-consumption-tracing.md§10](#10)

<a id="3"></a>
## 3. Summarize pre-edit repository consumption

Pattern: Event-driven

Disposition: Active

Requirement: When a caller requests a session consumption summary with the hook-emitted correlation key, Prism shall return deduplicated source ranges and rendered token counts before the first successful edit, compaction timing, and coverage as `exact`, `partial`, or `unavailable`.

Rationale: Coverage-aware summaries can support later calibration without representing missing events as zero consumption.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§2](#2), [session-consumption-tracing.md§4](#4), [session-consumption-tracing.md§7](#7), [session-consumption-tracing.md§8](#8)

<a id="4"></a>
## 4. Isolate and limit traces

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an event is malformed, oversized, duplicated, or belongs to another session, then Prism shall ignore or isolate it without blocking the host action or corrupting another session summary.

Rationale: Instrumentation must not disrupt implementation or cross session boundaries.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§3](#3), [session-consumption-tracing.md§6](#6), [session-consumption-tracing.md§8](#8)

<a id="5"></a>
## 5. Isolate root execution observations

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a Codex hook event belongs to a subagent or Prism cannot prove that it belongs to the root execution for the active session and canonical project root, then Prism shall exclude the action details and shall reduce root-trace coverage when the stable root identity remains provable, otherwise Prism shall ignore the event.

Rationale: Codex subagents share the parent session identifier, so session identity alone cannot prevent unrelated tool observations from entering the root summary.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§2](#2), [session-consumption-tracing.md§4](#4)

<a id="6"></a>
## 6. Bound aggregate trace retention

Pattern: Event-driven

Disposition: Active

Requirement: When Prism appends a session trace event, Prism shall remove traces older than 30 days, remove owned stale temporary trace files, count owned active temporary trace files, and then evict the oldest eligible traces deterministically before aggregate trace storage exceeds 64 MiB.

Rationale: Per-session limits do not bound total local storage across many sessions.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§4](#4), [session-consumption-tracing.md§11](#11)

<a id="7"></a>
## 7. Mark approximate rendered-token observations

Pattern: Event-driven

Disposition: Active

Requirement: When a supported Codex repository read or search response lacks a rendered token count and its documented model-facing response is a string within the one MiB bound, Prism shall report a deterministic approximate numeric count with partial coverage without retaining response content.

Rationale: A content-free approximation is more useful than an unavailable count, but it is not an exact model tokenizer result.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§3](#3), [session-consumption-tracing.md§5](#5)

<a id="8"></a>
## 8. Resolve traces by session correlation key

Pattern: Event-driven

Disposition: Active

Requirement: When a caller requests a session consumption summary with a valid hook-emitted correlation key and canonical project root, Prism shall read only the trace that matches both identities.

Rationale: MCP callers receive the session digest instead of the private raw host session identifier.

Related: [session-consumption-tracing.md§3](#3), [session-consumption-tracing.md§4](#4), [session-consumption-tracing.md§5](#5)

<a id="9"></a>
## 9. Prove host behavior and stable project identity

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism cannot correlate a Codex hook to a root transcript with an exact supported behavior profile and canonical transcript project root, then Prism shall not infer mutation success, while a correlated Codex transcript shall take precedence over compatibility environment values and Claude shall use only its canonical `CLAUDE_PROJECT_DIR` as project identity.

Rationale: Host-like environment aliases and changing working directories do not prove either host identity or repository identity.

Related: [session-consumption-tracing.md§1](#1), [session-consumption-tracing.md§2](#2), [session-consumption-tracing.md§5](#5), [session-consumption-tracing.md§8](#8)

<a id="10"></a>
## 10. Order observations by occurrence

Pattern: State-driven

Disposition: Active

Requirement: While trace observations arrive in any delivery order, Prism shall order them by event time and a stable tie breaker before deriving the first successful edit and the pre-edit summary.

Rationale: Delayed hooks must not exclude earlier reads or preserve a later edit boundary.

Related: [session-consumption-tracing.md§2](#2), [session-consumption-tracing.md§3](#3), [session-consumption-tracing.md§4](#4)

<a id="11"></a>
## 11. Protect trace storage authority

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a trace directory, record, temporary file, or lock cannot be proven to be an owned regular path beneath the canonical plugin data directory, or if a writer loses its token-owned lock, then Prism shall fail closed without following the path, acknowledging the append, or replacing a successor record.

Rationale: Local instrumentation must not turn symbolic links, hard links, stale locks, or concurrent writers into cross-boundary writes.

Related: [session-consumption-tracing.md§4](#4), [session-consumption-tracing.md§6](#6)
