---
name: write-adr
description: Write or update an Architectural Decision Record in the project's ADR directory. Use when documenting, amending, or superseding an architectural decision or invariant.
---

# Write ADR

ADRs document architectural decisions with their rationale. An `Accepted` ADR is
settled — decided, not explored — and its invariants take precedence over
behavioral invariants in feature files. A `Proposed` ADR is the decision *under
design*, not yet settled (see the status lifecycle below).

Project settings for this workflow live in `.claude/workflow-config.md` at the
project root (created by the `workflow-init` skill). Read it first if it exists;
it overrides the default paths below. If absent, use the defaults and the
project's own CLAUDE.md conventions.

Before writing, read:
1. The glossary (default `/docs/Glossary.md`) — use established terms exactly as defined there
2. Sibling ADRs in the same directory — understand the existing decision chain

---

## Status lifecycle

An ADR moves `Proposed` → `Accepted`, and each transition is owned across sessions.
The authoritative rule lives in the `workflow` overview skill ("Cross-session
lifecycles"); what you act on while writing one:

- **Create it `Proposed`.** Every new ADR starts `Proposed`, whether opened by an
  ideation, planning, or design session. It is a proposal, not a settled record.
- **Edit the body in place while `Proposed`.** The body is the working draft —
  refine the decision directly. Do **not** add Decision Log entries to a `Proposed`
  ADR; there is no settled record to amend against yet (see below).
- **Do not flip it to `Accepted` in design or planning.** It stays `Proposed`
  through design and through validation. Only the **implementation session** flips
  it to `Accepted`, in the commit that lands the code — acceptance means the
  decision survived being built and validated.
- **Once `Accepted`**, the amendment rules below apply: clarify via the Decision
  Log, or write a new superseding ADR for a meaningful change.

---

## File location and naming

ADRs live in the ADR directory (default `/docs/ADRs/<topic-slug>/`). Each
significant topic gets its own directory. Multiple related decisions on the same
topic share a directory.

Name the file descriptively: a short imperative title works well.
Example: `event-driven-order-pipeline.md`.

---

## New ADR vs amending an existing one

The amendment rules below apply only to ADRs in `Accepted` (or `Superseded`)
status. An ADR still in `Proposed` status is not yet settled — edit its body
directly to refine the decision. Do not add Decision Log entries to a Proposed
ADR; the body is the working draft until the status flips to `Accepted`.

**Create a new ADR when:**
- The decision changes a settled (Accepted) design in a meaningful way
- The new decision would contradict or supersede a prior one
- A reader would need to understand both the old and new decision to understand
  the current state

**Amend an Accepted ADR with a decision log entry when:**
- The decision clarifies or refines without contradicting
- It resolves an open question left explicit in the original ADR
- It corrects a minor gap that does not change the core design

**Edit the body directly when:**
- The ADR is still in `Proposed` status — the decision is not yet settled, so
  there is no settled record to amend against.

When creating a new ADR that supersedes an old one, update the old ADR's
`Status` field to `Superseded by <new-adr-filename>` and add a one-line note
at the top pointing to the replacement. Do not delete old ADRs — the history
of decisions is intentionally preserved.

---

## Document structure

```markdown
# <Title>

Status: <Proposed | Accepted | Superseded by X>   # new ADRs start Proposed
Created: <YYYY-MM-DD>

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
Mechanism diagrams. Mermaid, never hand-authored SVG (diffable, renderer-native).

## Rationale

Why this option over the alternatives? Address each significant alternative
considered. For each: what it was, why it was rejected.

## Consequences

What becomes easier, harder, or different as a result of this decision?
Include negative consequences honestly.

## Decision Log

Entries are ordered oldest to newest — append new entries at the bottom.
Each entry is a dated section. For decisions that change the design meaningfully,
create a new ADR instead.
```

---

## RFC 2119 invariants

Architectural invariants MUST be written using RFC 2119 vocabulary. This
vocabulary is unambiguous and has a large training corpus — agents and humans
interpret it consistently.

| Keyword | Meaning |
|---|---|
| MUST / REQUIRED / SHALL | Absolute requirement. No exceptions. |
| MUST NOT / SHALL NOT | Absolute prohibition. No exceptions. |
| SHOULD / RECOMMENDED | Strong preference. Deviation requires documented reason. |
| SHOULD NOT / NOT RECOMMENDED | Strong discouragement. Deviation requires documented reason. |
| MAY / OPTIONAL | Permitted but not required. |

**Correct:**
> An order MUST NOT transition to `shipped` except through the fulfillment
> phase. The pipeline MUST cancel the outstanding reservation before releasing
> inventory back to stock.

**Incorrect** — avoid hedging or natural language equivalents:
> An order should ideally not be shipped outside the fulfillment phase.

State invariants at the architectural level. Do not reference class names,
file paths, or method signatures — those belong in code comments or module
docs, not ADRs.

---

## Diagrams

When the decision involves a non-trivial cross-component flow, sequence, topology, or lifecycle, include a Mermaid diagram — sequenceDiagram for an interaction, flowchart for topology, stateDiagram-v2 for a lifecycle — in a ## Mechanism section (or a sibling diagrams.md when large).
Mermaid, never hand-authored SVG (diffable, renderer-native, like the roadmap/plan DAGs).
Illustrative, not authoritative: the RFC-2119 prose and feature files remain the source of truth; keep the diagram in sync, and on conflict the prose wins.
Label the steps that carry an invariant ("verified independently here", "approval prompt fires") so the picture teaches the boundary, not just call order.

## Decision log entries

When amending an `Accepted` ADR, append a dated section at the **bottom** of the
Decision Log — entries are ordered oldest to newest so a reader follows the history
forward in time. (For `Proposed` ADRs, edit the body directly instead — see the
section above.)

```markdown
## Decision Log — YYYY-MM-DD  <Short title>

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
- No class names, file paths, or method names in Problem Statement,
  Decision, or Rationale sections
- Every alternative considered has an explicit rejection reason
- Non-Goals section exists and is non-empty
- All terms match definitions in the project glossary
- If superseding a prior ADR, the old ADR's Status field is updated
