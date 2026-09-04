---
name: write-adr
description: "Create or revise an ADR for an architectural decision or invariant."
sdm: "0.3"
---

# Write an ADR

An ADR records a decision that constrains future changes or explains a lasting system boundary.
An ADR must not record a private helper, local data structure, task sequence, or other code-level choice.
An ADR must not change product intent.
When `design` calls this skill, the [fit checkpoint](../workflow/SKILL.md#common-terms) must have passed.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the glossary.
3. Read the applicable [Approved requirements](../workflow/SKILL.md#common-terms).
4. Read the related Accepted ADRs.
5. If the proposed decision conflicts with an Approved requirement or Accepted ADR, stop and report the conflict.

## 2. Select the ADR action

- When the decision adds or changes a lasting architectural rule, create a new ADR.
- When the decision contradicts an Accepted ADR, create a superseding ADR.
- When an Accepted ADR needs a clarification that preserves its meaning, append a decision-log entry.
- When a [Proposed ADR](../workflow/SKILL.md#common-terms) is not settled, edit it directly.

An existing ADR that records the decision sufficiently must not have a duplicate.

## 3. Status

Every new ADR must have `Status: Proposed`.
The ADR must remain Proposed through design, implementation, and review.
Only `orchestrate` can change an implemented ADR to `Accepted` after the user confirms the complete slice.
When a new ADR supersedes another ADR, set the old ADR status to `Superseded` and link both ADR files.
An Accepted or Superseded ADR must never be deleted.

## 4. Location

The ADR must use the configured ADR directory.
When no ADR directory is configured, the default is `docs/ADRs/<topic>/`.
The ADR must have a short descriptive file name.
Related decisions must stay in the same topic directory.

## 5. Content

The ADR must use this structure.

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

Architectural invariants must use RFC 2119 terms.
`MUST` and `MUST NOT` apply only to absolute rules.
`SHOULD` applies when a deviation can have a documented reason.
Architecture rules must not use class names, methods, file paths, or task identifiers.

## 6. Diagrams

- When relationships, lifecycle, or call order are material, create a PlantUML decision diagram.
- For architecture relationships, use a C4 context or component diagram.
- For a lifecycle decision, use a state diagram.
- When cross-boundary call order affects correctness, use a sequence diagram.
- Store the PlantUML source beside the ADR.
- Link the PlantUML source from `Mechanism`.
- Keep rationale, alternatives, and consequences in prose.
- After code verification, update the diagram when implementation evidence changes its structure.

- Don't
  - Create or commit rendered images.

## 7. Decision-log entry

- When an Accepted ADR's original decision remains valid, append a dated entry.
- State what changed and why.
- When the architecture meaning changes, create a superseding ADR.

## 8. Result

1. Check requirement links, conflicts, invariant wording, rejected alternatives, and negative consequences.
2. Return the ADR path and its status.
