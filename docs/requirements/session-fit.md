# Session capacity and repository fit

Status: Approved
Created: 2026-09-19
Approved: 2026-09-19

## Problem

Prism cannot deterministically compare a repository context plan with the usable context of its target implementation session.

## Goals

- Resolve session capacity from supported host, provider, model, version, and setting facts.
- Keep every capacity result inspectable through value provenance.
- Let projects adjust the implementation reserve without changing capacity facts.
- Classify repository context plans with deterministic budget arithmetic.

## Non-goals

- Predict generated code size or general task complexity.
- Infer an unsupported model's capacity from a similar model.
- Calibrate reserve policies from implementation traces in this capability.

## Design questions

- n/a.

<a id="1"></a>
## 1. Resolve supported session capacity

Pattern: Event-driven

Disposition: Active

Requirement: When a caller supplies the target host, provider, model, version, and applicable overrides, Prism shall return the exact supported context window and compaction threshold with their provenance.

Rationale: A fit decision must use the target implementation environment instead of a generic model limit.

Related: [session-fit.md§2](#2), [session-fit.md§3](#3), [session-fit.md§4](#4)

<a id="2"></a>
## 2. Reject unsupported capacity combinations

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism cannot resolve an exact supported host, provider, model, and version combination, then Prism shall return `UNSUPPORTED` without a fit classification.

Rationale: A guessed capacity can produce an unsafe false fit decision.

Related: [session-fit.md§1](#1)

<a id="3"></a>
## 3. Classify repository context fit

Pattern: Event-driven

Disposition: Active

Requirement: When a caller supplies a complete repository context estimate and target-session costs, Prism shall return `FIT`, `SPLIT`, or `UNCERTAIN` by applying the documented budget policy.

Rationale: Design needs a repeatable decision based on repository context consumption.

Related: [session-fit.md§1](#1), [session-fit.md§4](#4)

<a id="4"></a>
## 4. Accept an adjustable implementation reserve

Pattern: Optional feature

Disposition: Active

Requirement: Where a caller supplies an implementation reserve override, Prism shall use that nonnegative value instead of the registry default.

Rationale: Different workflows and projects require different implementation headroom.

Related: [session-fit.md§1](#1), [session-fit.md§3](#3)
