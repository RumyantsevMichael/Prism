# Active session capacity

Status: Approved
Created: 2026-09-19
Approved: 2026-09-19

## Problem

Prism requires callers to repeat host, provider, model, version, and capacity facts that the active host can expose more accurately.

## Goals

- Capture only allowlisted capacity facts for the active session.
- Correlate facts with the same host session through a one-way key that exposes no raw session identifier.
- Resolve effective capacity with deterministic precedence and provenance.
- Fail closed when session identity or capacity is incomplete.
- Bound local fact retention by age and aggregate bytes.

## Non-goals

- Read arbitrary host configuration keys.
- Infer active-session identity from another installed command-line executable.
- Guess capacity for an unknown host, provider, model, or version.

## Design questions

- n/a.

<a id="1"></a>
## 1. Capture allowlisted active-session facts

Pattern: Event-driven

Disposition: Active

Requirement: When an enabled host hook reports a session event, Prism shall store only the allowlisted session identity and capacity facts under a SHA-256 session correlation key in plugin-local storage and shall emit only that key as bounded additional context.

Rationale: The host event is the authoritative source for the active session, while a narrow allowlist protects unrelated configuration and secrets.

Related: [active-session-capacity.md§2](#2), [active-session-capacity.md§3](#3), [active-session-capacity.md§4](#4)

<a id="2"></a>
## 2. Resolve same-session capacity

Pattern: Event-driven

Disposition: Active

Requirement: When a caller requests active-session capacity with the hook-emitted correlation key, Prism shall apply complete explicit capacity overrides before complete directly attested same-session capacity and shall never use user configuration or a registry default as proof of the active threshold.

Rationale: A deterministic precedence order makes capacity decisions reproducible without assuming that a known default outranks an unobserved active override.

Related: [active-session-capacity.md§1](#1), [active-session-capacity.md§3](#3), [session-fit.md§1](session-fit.md#1)

<a id="3"></a>
## 3. Reject unproved active-session capacity

Pattern: Unwanted behavior

Disposition: Active

Requirement: If active-session facts are missing, stale, ambiguous, cross-project, associated with another correlation key, or insufficient for an exact total-scope capacity result, then Prism shall return `UNSUPPORTED` with a stable reason code and no fit classification.

Rationale: A shell binary or nearby session can differ from the model and settings of the active request.

Related: [active-session-capacity.md§1](#1), [active-session-capacity.md§2](#2), [session-fit.md§2](session-fit.md#2)

<a id="4"></a>
## 4. Bound local fact retention

Pattern: State-driven

Disposition: Active

Requirement: While Prism stores active-session facts, Prism shall remove records older than 30 days and shall evict the oldest eligible records deterministically before aggregate fact storage exceeds 16 MiB.

Rationale: A per-record size limit does not bound storage across an unbounded number of host sessions.

Related: [active-session-capacity.md§1](#1), [active-session-capacity.md§3](#3)
