# Support autonomous and inline orchestration modes

Status: Proposed
Created: 2026-09-13

## Requirements

No Approved requirement currently covers this plugin workflow decision.

## Problem

Prism currently delegates slice delivery while the orchestrator coordinates workers and lifecycle gates.
Small initiatives can use one context for lower coordination cost.
Some runs also need the orchestrator to continue through internal decisions without repeated user prompts.

## Decision

Prism MUST persist decision autonomy and agent flow as initiative run settings.
Decision autonomy MUST support `conservative`, `broad`, and `full`.
Agent flow MUST support `multi` and `mono`, with `multi` as the default.
Mono flow MUST keep planning, design, implementation, and corrections in the orchestrator context and workspace.
Multi flow MUST preserve delegated slice delivery and isolated workspaces where concurrency requires them.
Both flows MUST use fresh independent contexts for design and implementation review.
Full autonomy MAY resolve internal requirements, architecture, workflow, and completion decisions.
Full autonomy MUST NOT invent external facts, override project constraints, bypass independent review, or enable push without explicit permission.
An explicit commit or continuation setting MUST override its autonomy default.
Agent flow MUST NOT change after active work starts.

## Rationale

The setting changes delegation without changing artifact ownership or review assurance.
The three autonomy levels provide a gradual choice between user control and uninterrupted execution.
Keeping review fresh preserves an independent check on work created by the orchestrator or delivery context.

## Alternatives

### Make mono flow skip independent review

Declined because self-review does not provide the same assurance as a fresh context.

### Make full autonomy enable every side effect

Declined because committing and pushing have different recovery and external-impact risks.

### Add a second skill set for autonomous execution

Declined because shared skills should describe the workflow, while the orchestrator should select the execution mode.

## Consequences

Mono flow reduces worker and workspace coordination overhead.
Mono flow has a larger context and cannot complete when fresh review capability is unavailable.
Full autonomy can change durable intent, so its decisions must remain in the owning requirements, ADR, roadmap, or map artifacts.
Existing state files continue with conservative autonomy and multi flow when the new settings are absent.

## Mechanism

The orchestrator reads the compact [run-settings reference](../../../skills/orchestrate/references/run-settings.md) before resolving settings.
The coordination-state capability validates the setting values and preserves them in `state.json`.
The orchestrator passes the resolved settings to delegated contexts and applies them directly in mono flow.

## Decision Log

2026-09-13: Proposed three-level autonomy and two-flow orchestration with independent review in every flow.
