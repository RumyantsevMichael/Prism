# Preserve design through ADRs and executable artifacts

Status: Proposed
Created: 2026-08-23

## Requirements

No Approved requirement currently covers this workflow decision.

## Problem

Design prose can describe a complete architecture that implementation does not follow.
One delivery context reduces handoff loss but can still lose design detail during context compaction.
An executable artifact can enforce selected behavior but cannot preserve architectural rationale.

## Decision

Prism MUST preserve every architectural decision that constrains future changes or explains a lasting boundary in an ADR.
The durable handoff from design to implementation is the recorded decisions and executable boundary artifacts, not a prose design summary.
Design MUST author slice-scoped artifacts only after the fit checkpoint passes.
When design returns SPLIT or BLOCKED, it MUST leave those slice-scoped artifacts unwritten.
An executable slice test MUST observe the required result or failure through the selected starting surface instead of a private helper.
An executable contract MUST have a production, generated, or verification consumer.
After the fit checkpoint passes, Design MAY create a shape-only scaffold when the selected surface does not yet exist.
A shape-only scaffold MUST NOT add production behavior or make the executable slice test pass.
Feature files MUST express intended acceptance behavior in domain language.
Step definitions MUST remain implementation-owned bindings when a BDD harness exists.
Implementation MUST preserve design-created tests, contracts, and feature files unless it returns to the design fit checkpoint.
Implementation review MAY add a finding-scoped regression test for a concrete defect through a public or system surface.
Design MUST NOT create a prose design summary, a slice-named design file, or step definitions.

## Rationale

ADRs preserve architectural decisions, rationale, alternatives, and consequences at the correct abstraction level.
Executable tests and contracts make selected boundary behavior available to implementation and independent review.
Feature files make intended observable behavior and examples available without becoming a prose handoff.
Review probes turn concrete findings into executable evidence without giving reviewers production authorship.
Deferring slice-scoped artifacts until fit passes prevents a later SPLIT or BLOCKED result from leaving artifacts attached to a slice that no longer exists as designed.
The same delivery context can continue from design into implementation without relying on latent memory alone.
A fresh design audit can inspect the decisions, executable artifacts, code surfaces, and verification paths without the delivery conversation.

## Alternatives

### Use a prose design file as the handoff

Declined because implementation can ignore a prose design file and context compaction can still lose its meaning.

### Use executable tests without ADRs

Declined because tests cannot preserve architectural rationale, alternatives, lifecycle rules, or security decisions completely.

### Split design and implementation into separate delivery contexts

Not selected as the default because one delivery context still reduces avoidable handoff loss.
The executable artifacts make the design recoverable when context compaction or an explicit replacement occurs.

## Consequences

Design can author tests, contracts, feature files, diagrams, and shape-only scaffolds after fit passes and before production behavior exists.
A split cannot leave those artifacts attached to the rejected slice.
The design audit checks executable artifacts as well as the ADRs and planned behavior.
Implementation starts from a red executable test when the slice has a testable boundary and binds feature steps when a BDD harness exists.
Implementation preserves or promotes a review probe after its finding is fixed.
Simple slices can return no executable test or contract when no such artifact is needed.

## Mechanism

The design result reports the recorded artifact paths and red checkpoint for implementation and review.
The orchestrator owns user gates and accepts Proposed ADRs only after the complete slice is verified.

## Decision Log

2026-08-23: Proposed executable design artifacts as the recoverable boundary between design and implementation.
