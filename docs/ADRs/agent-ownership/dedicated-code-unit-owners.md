# Assign dedicated agents as exclusive code-unit owners

Status: Declined
Created: 2026-08-20

## Requirements

This repository has no requirement file for agent ownership or orchestration boundaries.

## Problem

Large codebases can exceed the useful context of one delivery agent.
Repeated exploration also consumes time and model tokens.
A dedicated agent for each package, module, or component could provide focused context and local responsibility.
However, observable changes often cross several code units and require system-level reasoning.

## Decision

Prism will not assign a persistent, exclusive agent owner to every code unit.
A code-unit owner MUST NOT replace the delivery agent that owns one complete outcome slice.
The orchestrator MUST remain responsible for routing, user interaction, and lifecycle gates.
The active delivery agent MUST retain responsibility for design, implementation, and end-to-end verification across affected code units.
Fresh agents MUST continue to perform independent design audits and implementation reviews.

## Rationale

Code-unit ownership would split vertical outcome slices into horizontal implementation fragments.
This split would remove complete outcome responsibility from the delivery agent.
The orchestrator would then need enough technical context to resolve conflicts between owners.
That responsibility would conflict with its bounded routing role.

Owner communication would also lose evidence, rejected alternatives, and implicit constraints.
Durable requirements, ADRs, executable contracts, tests, and code preserve this information more reliably than agent messages.

A persistent agent context does not provide stable ownership.
Long-lived contexts become stale and crowded.
Fresh contexts do not retain prior expertise.
Unit instructions, contracts, tests, and architecture rules provide the durable source of unit knowledge.

Package, module, and component boundaries do not always match architectural boundaries.
Exclusive ownership would make cross-unit refactoring, migration, integration testing, and responsibility changes harder.

## Alternatives

### Assign one exclusive owner to every code unit

Declined because most observable outcomes cross several code units.
Communication cost grows with the number of affected dependency boundaries.
No owner would retain complete responsibility for the observable outcome.

### Make the orchestrator resolve owner conflicts

Declined because the orchestrator does not hold the detailed delivery context.
Giving it architectural authority would require it to reconstruct each owner context.
That work would remove the context benefit of the ownership model.

### Use scoped unit stewards

Not selected as a general workflow rule.
Prism can reconsider this option for stable architectural boundaries with focused verification and recurring work.
A steward could provide constraints, risks, or boundary review without exclusive implementation authority.

### Keep one delivery agent for each outcome slice

Selected as the current workflow.
The delivery agent keeps design reasoning through implementation and end-to-end verification.
Independent agents audit the design and review the completed change.

## Consequences

Prism avoids mandatory owner registration and persistent owner contexts.
The orchestrator does not need an owner messaging protocol or conflict-resolution process.
One delivery agent continues to carry complete outcome responsibility across affected layers.
Large slices can still require significant context and bounded delegated exploration.
The workflow can use scoped specialists when project rules require them.
Any future ownership proposal must preserve end-to-end responsibility and independent review.

## Mechanism

The planner continues to define vertical outcome slices instead of code-unit tasks.
One delivery context carries each slice from exploration through verified implementation.
The orchestrator passes paths and compact status records between delegated agents.
Requirements, ADRs, executable contracts, tests, and code carry durable technical knowledge.

## Decision Log

2026-08-20: Declined exclusive, persistent agent ownership for packages, modules, and components.
