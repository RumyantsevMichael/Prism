---
name: write-adr
description: "Create or revise an ADR for an architectural decision or invariant."
sdm: "0.3"
---

# Write an ADR

An ADR records a lasting architectural decision or invariant, not product intent, implementation tasks, or local code choices.
Design can record shared decisions before [atomic fit](../workflow/SKILL.md#common-terms).

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the glossary, applicable Approved requirements, and related ADRs.
3. If the decision conflicts with requirements, stop and return the conflict.
4. If the decision contradicts an Accepted ADR without an authorized supersession, stop and return the required decision.

## 2. Record the decision

- If a Proposed ADR needs correction, edit it in place.
- If an Accepted ADR needs clarification without changed meaning, append a dated explanation to its Decision Log.
- If an existing ADR sufficiently records the decision, reuse it.
- If the decision is new or an authorized supersession:
  1. Create a Proposed ADR with a descriptive filename in the configured ADR directory, defaulting to `docs/ADRs/<topic>/`.
  2. Keep related decisions in the same topic.
  3. For supersession, link the replacement and original without changing the original status.

New ADRs use this shape:

```markdown
# <Decision title>

Status: Proposed
Created: <YYYY-MM-DD>

## Requirements

<Direct links to applicable Approved requirements>

## Problem

<The architecture problem>

## Decision

<Selected architecture and invariants>

## Rationale

<Why this option>

## Alternatives

<Rejected options and reasons>

## Consequences

<Positive and negative effects>

## Mechanism

<How the architecture works, without code-level detail>

## Decision Log

<Dated clarifications after acceptance>
```

Invariants use `MUST`/`MUST NOT` for absolute rules and `SHOULD` for justified exceptions.
Architecture rules do not use code names, paths, or task identifiers.
Orchestration alone accepts implemented ADRs after user correctness confirmation and marks replaced ADRs Superseded.
Accepted and Superseded ADRs remain preserved.

## 3. Explain and check

1. When lifecycle or call order is material, write a PlantUML state or sequence diagram beside the ADR.
2. Link decision diagram source from Mechanism.
3. Keep C4 views in the current slice folder through `design`.
4. After implementation verification, correct decision diagrams against that evidence.
5. Check requirement links, conflicts, invariant wording, alternatives, and negative consequences.
6. Return the ADR path, status, and any diagram paths.

Rendered images are not committed.
