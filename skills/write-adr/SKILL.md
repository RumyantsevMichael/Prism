---
name: write-adr
description: "Write or update an Architectural Decision Record in the project's ADR directory. Use when documenting, amending, or superseding an architectural decision or invariant."
---

# Write ADR

ADRs document architectural decisions with their rationale.
An `Accepted` ADR is settled: decided, not explored.
Its invariants constrain feature files and contracts without overriding Approved requirements.
A `Proposed` ADR is the decision *under design*, not yet settled (see the status lifecycle below).

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

Before writing, read:
1. The glossary (default `docs/Glossary.md`): use established terms exactly as defined there.
2. The Approved requirements that the decision serves.
3. Sibling ADRs in the same directory: understand the existing decision chain.

Stop if the proposed decision contradicts an Approved requirement or Accepted ADR.
Do not change product intent inside an ADR.

---

## Status lifecycle

An ADR moves `Proposed` → `Accepted`, and each transition is owned across sessions.
The authoritative rule lives in the `workflow` overview skill ("Cross-session lifecycles").
Here is what you act on while writing one:

- **Create it `Proposed`.** Every new ADR starts `Proposed`, whether opened by a planning or design session.
  It is a proposal, not a settled record.
- **Edit the body in place while `Proposed`.** The body is the working draft, so refine the decision directly.
  Do **not** add Decision Log entries to a `Proposed` ADR, because there is no settled record to amend against yet (see below).
- **Do not flip it to `Accepted` in design or planning.** It stays `Proposed` through design and through validation.
  Only the **implementation session** flips it to `Accepted`, at the moment the user confirms the implementation is correct.
  The flip is a file edit and does not wait for a commit.
  Acceptance means the decision survived being built and validated.
- **Once `Accepted`**, the amendment rules below apply: clarify via the Decision Log, or write a new superseding ADR for a meaningful change.

---

## File location and naming

ADRs live in the ADR directory (default `docs/ADRs/<topic-slug>/`).
Each significant topic gets its own directory.
Multiple related decisions on the same topic share a directory.

Name the file descriptively: a short imperative title works well.
Example: `event-driven-order-pipeline.md`.

---

## New ADR vs amending an existing one

The amendment rules below apply only to ADRs in `Accepted` (or `Superseded`) status.
An ADR still in `Proposed` status is not yet settled, so edit its body directly to refine the decision.
Do not add Decision Log entries to a Proposed ADR, because the body is the working draft until the status flips to `Accepted`.

**Create a new ADR when:**
- The decision changes a settled (Accepted) design in a meaningful way
- The new decision would contradict or supersede a prior one
- A reader would need to understand both the old and new decision to understand the current state

**Amend an Accepted ADR with a decision log entry when:**
- The decision clarifies or refines without contradicting
- It resolves an open question left explicit in the original ADR
- It corrects a minor gap that does not change the core design

**Edit the body directly when:**
- The ADR is still in `Proposed` status: the decision is not yet settled, so there is no settled record to amend against.

When creating a new ADR that supersedes an old one, update the old ADR's `Status` field to `Superseded by <new-adr-filename>` and add a one-line note at the top pointing to the replacement.
Do not delete old ADRs, because the history of decisions is intentionally preserved.

---

## Document structure

```markdown
# <Title>

Status: <Proposed | Accepted | Superseded by X>   # new ADRs start Proposed
Created: <YYYY-MM-DD>

## Requirements

Direct Markdown links to the Approved requirements that this decision serves.

## Problem Statement

One or two paragraphs. What is broken, missing, or ambiguous that this
decision resolves? Be specific. Do not describe the solution here.

## Goals

Bulleted list. What must the decision achieve?

## Non-Goals

Bulleted list. What is explicitly out of scope? This prevents scope creep
and tells future readers what not to read into the decision.

## Decision

The settled answer. State it plainly in one paragraph before expanding.
Use RFC 2119 language for invariants (see below).

## Mechanism
Link each related PlantUML source file.
Use C4 for a complex architecture context and a state diagram for a lifecycle.

## Rationale

Why this option over the alternatives? Address each significant alternative
considered. For each: what it was, why it was rejected.

## Consequences

What becomes easier, harder, or different as a result of this decision?
Include negative consequences honestly.

## Decision Log

Entries are ordered oldest to newest - append new entries at the bottom.
Each entry is a dated section. For decisions that change the design meaningfully,
create a new ADR instead.
```

---

## RFC 2119 invariants

Architectural invariants MUST be written using RFC 2119 vocabulary.
This vocabulary is unambiguous and has a large training corpus, so agents and humans interpret it consistently.

- **MUST / REQUIRED / SHALL**: absolute requirement, no exceptions.
- **MUST NOT / SHALL NOT**: absolute prohibition, no exceptions.
- **SHOULD / RECOMMENDED**: strong preference, deviation requires a documented reason.
- **SHOULD NOT / NOT RECOMMENDED**: strong discouragement, deviation requires a documented reason.
- **MAY / OPTIONAL**: permitted but not required.

**Correct:**
> An order MUST NOT transition to `shipped` except through the fulfillment phase.
> The pipeline MUST cancel the outstanding reservation before releasing inventory back to stock.

**Incorrect**, avoid hedging or natural language equivalents:
> An order should ideally not be shipped outside the fulfillment phase.

State invariants at the architectural level.
Do not reference class names, file paths, or method signatures.
Those belong in code comments or module docs, not ADRs.

---

## Diagrams

Store each PlantUML source file beside the ADR and link it from `## Mechanism`.
Use a descriptive name such as `context.puml`, `containers.puml`, or `lifecycle.puml`.
Never create or commit a rendered image.

Use a C4 Context or Container diagram only when architecture relationships need visual review.
Small contexts below about 15 relationships need a specific reviewability reason because C4 usually costs more tokens there.
The C4 diagram complements the decision and does not replace its rationale or consequences.

Use a PlantUML state diagram when the ADR defines a lifecycle or state invariant.
The state diagram replaces the prose transition list and owns the allowed transition set.
Keep RFC 2119 prose for guards, prohibitions, and invariants that the transition labels cannot state precisely.

Do not diagram the decision, alternatives, rationale, or consequences.
These sections stay as prose.
Read the `.puml` source during agent review and never read a rendered image.

## Decision log entries

When amending an `Accepted` ADR, append a dated section at the **bottom** of the Decision Log.
Entries are ordered oldest to newest, so a reader follows the history forward in time.
(For `Proposed` ADRs, edit the body directly instead, see the section above.)

```markdown
## Decision Log - YYYY-MM-DD  <Short title>

### What changed

Describe the clarification or refinement concisely.

### Why

The reason. Be honest about what was incomplete in the prior decision.
```

Do not edit the body of a settled ADR to retroactively reflect an amendment.
New understanding goes in the log, not silently into the original text.

---

## Quality checks before finishing

- Every invariant uses RFC 2119 vocabulary
- Every ADR links to the Approved requirements that it serves
- No decision contradicts an Approved requirement
- No class names, file paths, or method names in Problem Statement, Decision, or Rationale sections
- Every alternative considered has an explicit rejection reason
- Non-Goals section exists and is non-empty
- All terms match definitions in the project glossary
- If superseding a prior ADR, the old ADR's Status field is updated
- Each diagram is a linked sibling `.puml` source file
- Each lifecycle uses a state diagram instead of a prose transition list
- No rendered diagram image is present
