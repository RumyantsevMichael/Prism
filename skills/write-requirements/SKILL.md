---
name: write-requirements
description: "Define the EARS requirement-file format and lifecycle when ideate creates a file or an Approved requirement needs a focused revision."
sdm: "0.3"
---

# Write requirements

Requirements state what the system must do without selecting an implementation.
They preserve product intent for planning, design, feature files, and tests.
ADRs preserve architectural decisions and rationale.

## 1. Prepare

Project settings live in `.prism/workflow.md` at the project root.
These settings override the default paths in this skill.
The `workflow` skill defines the context map and lifecycle rules.

1. If `.prism/workflow.md` exists, read it.
2. If `.prism/workflow.md` is absent, use the default paths and applicable project instructions.
3. Read [the EARS authoring reference](references/ears-authoring.md) completely.
4. Read the glossary, with `docs/Glossary.md` as the default path.
5. Read related requirement files, with `docs/requirements/` as the default directory.
6. Read relevant Accepted ADRs and feature files.
7. When the workflow names a product strategy document, read it.
8. If the proposal conflicts with an Approved requirement or Accepted ADR:
   1. Report the conflict to the user.
   2. Stop.

- Don't
  - Choose which durable artifact wins when durable sources conflict.

## 2. File boundary

Each file covers one coherent capability.
One idea can require multiple files when it contains multiple logical capabilities.
Technical components and delivery slices do not define the file boundary.

- Store each file directly in the requirements directory.
- Use a short human-readable slug such as `validation-engine.md`.
- Search the directory before selecting a slug.
- Treat a concurrent duplicate slug as a content conflict that needs review.

## 3. Artifact structure

- Use this structure.

```markdown
# <Capability name>

Status: Draft
Created: <YYYY-MM-DD>
Approved: n/a

## Problem

State the user or system problem without describing a solution.

## Goals

- State each intended outcome.

## Non-goals

- State each excluded outcome.

## Design questions

- Record unresolved design questions without choosing an answer.
- Write `n/a` when no design question is known.

<a id="1"></a>
## 1. <Short requirement title>

Pattern: <Ubiquitous | State-driven | Event-driven | Optional feature | Unwanted behavior | Complex>

Disposition: Active

Requirement: <one EARS statement>

Rationale: <why this obligation exists, without implementation rationale>

Related: <Markdown links to related requirements, or `n/a`>
```

Each requirement is a top-level numbered section.
Identifiers such as `1.1` and `2.3` are invalid.
An explicit HTML anchor appears immediately before each numbered heading.

- Use flat positive integers such as `1`, `2`, and `3`.

The file slug and anchor form the durable requirement identity.
A normal citation is `[validation-engine.md§1](validation-engine.md#1)`.
The citation path is relative to the citing artifact.

## 4. Numbering

- Start a new file at `1`.
- Give each new requirement the next unused integer.
- Preserve the name of every Approved requirement file.
- Preserve the number of every Approved requirement.
- Never reuse a removed or superseded number.
- Permit gaps in the sequence.
- Reject duplicate anchors before approval.
- After integration, scan for duplicate anchors and reconcile their meaning before approval.
- Never renumber an Approved requirement to resolve a conflict.

Concurrent authors can select the same next number on separate branches.

## 5. Lifecycle

A requirement file has one of these statuses: `Draft`, `Approved`, `Superseded by <link>`, or `Withdrawn`.
Every new file starts as `Draft`.
Design consumes only Approved requirement files.
The roadmap and initiative state record delivery progress.

- While the user reviews a Draft file, edit its Draft requirements in place.
- After the user accepts every requirement in a file, update its approval metadata in one edit:
  1. Set `Status` to `Approved`.
  2. Set `Approved` to the approval date.
- When an Approved obligation changes:
  1. Add a new numbered requirement.
  2. Mark the old section as `Disposition: Superseded by <link>`.
  3. Link the replacement back with `Supersedes: <link>`.
- When an obligation ends without replacement, mark its section as `Disposition: Withdrawn`.
- Use file-level `Superseded by <link>` only when another file replaces the complete capability.
- Use file-level `Withdrawn` only when the file has no active requirement.
- Preserve superseded and withdrawn content because durable links and history depend on it.

- Don't
  - Change the meaning of an Approved requirement in place.
  - Use implementation status as a requirement status.

## 6. Author requirements

1. Frame the problem, affected users or systems, goals, and non-goals.
2. Separate product requirements from architectural decisions and implementation tasks.
3. Group obligations into coherent capability files.
4. Draft wanted behavior before unwanted behavior.
5. Select the correct EARS pattern for each obligation.
6. Write one primary obligation in each numbered section.
7. Add rationale and related links outside the EARS statement.
8. Review the complete set for omissions, conflicts, duplication, and unnecessary design constraints.
9. Present every Draft file to the user for approval.
10. For each accepted file, apply the [Lifecycle approval sequence](#5-lifecycle).

An external platform, law, contract, or operating environment can impose a valid constraint requirement.
An internal technology choice belongs in an ADR.
A statement that does not remain true after a complete implementation redesign is probably an architectural decision.

- Ask whether the statement remains true after a complete implementation redesign.

## 7. Traceability

Requirement files link to related, superseded, and replacement requirements.
Slice records, ADRs, feature files, executable contracts, and diagrams link to the requirements they serve.

- For reverse traceability, search the repository for exact Markdown links or `filename.md#anchor` values.
- Don't
  - Maintain a central backlink index because concurrent edits create merge conflicts.

## 8. Gate

- Present the Draft files and recommend continuing, revising, or stopping.
- Require explicit user acceptance before approving a file.
- After approval, recommend `design` for one self-contained outcome.
- After approval, recommend `roadmap` and then `orchestrate` for a multi-slice initiative.

- Don't
  - Start initiative orchestration in this context.
  - Start design in this context.

## 9. Quality checks

- Confirm that every numbered section contains one EARS requirement.
- Confirm that every EARS statement names the system and uses `shall`.
- Confirm that every trigger, state, and response is observable or measurable.
- Confirm that no requirement silently selects an internal implementation.
- Confirm that each number and anchor is unique within its file.
- Confirm that Approved requirement numbers remain unchanged.
- Confirm that all Markdown links resolve to existing files and anchors.
- Keep goals, non-goals, rationale, and design questions outside EARS statements.
- Exclude copied third-party prose, examples, diagrams, and tables.
