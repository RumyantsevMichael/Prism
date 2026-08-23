---
name: write-adr
description: "Create or revise an ADR for an architectural decision or invariant."
---

# Write an ADR

When called from `design`, use this skill only after the slice fit checkpoint passes.
Use an ADR only for a decision that constrains future changes or explains a lasting system boundary.
Do not use an ADR for a private helper, local data structure, task sequence, or other code-level choice.

Read `.prism/workflow.md` when it exists.
Read the glossary, applicable Approved requirements, and related Accepted ADRs.
Stop when the proposed decision conflicts with an Approved requirement or Accepted ADR.
Do not change product intent in an ADR.

## Select the ADR action

Create a new ADR when the decision adds or changes a lasting architectural rule.
Create a superseding ADR when the decision contradicts an Accepted ADR.
Append a decision-log entry when an Accepted ADR needs a clarification that preserves its meaning.
Edit a Proposed ADR directly because it is not settled.

Do not create a duplicate ADR when an existing ADR already records the decision sufficiently.

## Status

Create every new ADR with `Status: Proposed`.
Keep it Proposed through design, implementation, and review.
Only `orchestrate` changes an implemented ADR to `Accepted` after the user confirms the complete slice.
When a new ADR supersedes another ADR, update the old status and link both files.
Never delete an ADR that has been Accepted or Superseded.

## Location

Use the configured ADR directory, with `docs/ADRs/<topic>/` as the default.
Use a short descriptive file name.
Keep related decisions in the same topic directory.

## Content

Use this structure:

```markdown
# <Decision title>

Status: Proposed
Created: <YYYY-MM-DD>

## Requirements

<Direct links to applicable Approved requirements>

## Problem

<The architecture problem without the solution>

## Decision

<The selected architecture and its invariants>

## Rationale

<Why this option was selected>

## Alternatives

<Important rejected options and rejection reasons>

## Consequences

<Positive and negative effects>

## Mechanism

<Architecture mechanism without code-level detail>

## Decision Log

<Dated clarifications after acceptance>
```

Use RFC 2119 terms for architectural invariants.
Use `MUST` and `MUST NOT` only for absolute rules.
Use `SHOULD` when a deviation can have a documented reason.
Do not use class names, methods, file paths, or task identifiers as architecture rules.

## Diagrams

Create a PlantUML decision diagram when relationships, lifecycle, or call order are material to the ADR.
Use a C4 context or component diagram for architecture relationships.
Use a state diagram for a lifecycle decision.
Use a sequence diagram when cross-boundary call order affects correctness.
Store the PlantUML source beside the ADR and link it from `Mechanism`.
Keep rationale, alternatives, and consequences in prose.
After code verification, update the diagram when implementation evidence changes its structure.
Do not create or commit rendered images.

## Decision-log entry

Append a dated entry to an Accepted ADR only when its original decision remains valid.
State what changed and why.
Create a superseding ADR when the architecture meaning changes.

## Result

Check requirement links, conflicts, invariant wording, rejected alternatives, and negative consequences.
Return the ADR path and its status.
