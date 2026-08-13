---
name: write-requirements
description: "Create or revise EARS requirements for product intent before planning or design."
---

# Write requirements

Requirements state what the system must do without choosing how to build it.
They are durable product intent that planning, design, feature files, and tests cite directly.
ADRs remain the durable record for architectural decisions and rationale.

Project settings for this workflow live in `.prism/workflow.md` at the project root.
Read that file first if it exists.
It overrides the default paths below.
If it is absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

Read [the EARS authoring reference](references/ears-authoring.md) completely before you author or review a requirement file.

Before writing, read these artifacts in order:

1. Read the glossary, with `docs/Glossary.md` as the default path.
2. Read related requirement files, with `docs/requirements/` as the default directory.
3. Read relevant Accepted ADRs and feature files.
4. Read the product strategy document when the workflow configuration names one.

Stop if the proposed requirement conflicts with an Approved requirement or an Accepted ADR.
Report the conflict to the user instead of choosing which durable artifact wins.

## File boundary

Write one file for one coherent capability.
One idea can produce several requirement files when it contains several logical capabilities.
Do not use technical components or implementation tracks as the grouping rule.

Store each file directly in the requirements directory.
Use a short human-readable slug such as `validation-engine.md`.
Search the directory before you select a slug.
If another branch creates the same slug, treat the merge conflict as a content conflict that needs review.

## Artifact structure

Use this structure:

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
Use flat positive integers such as `1`, `2`, and `3`.
Do not use identifiers such as `1.1` or `2.3`.
Place an explicit HTML anchor immediately before each numbered heading.

Use the file slug and anchor as the durable requirement identity.
A normal citation looks like `[validation-engine.md§1](validation-engine.md#1)`.
Use the correct relative path from the citing artifact.

## Numbering rules

- Start a new file at `1`.
- Add each new requirement with the next unused integer.
- Never rename an Approved requirement file.
- Never renumber an Approved requirement.
- Never reuse a removed or superseded number.
- Permit gaps in the sequence.
- Reject duplicate anchors before approval.

Concurrent authors can select the same next number on separate branches.
After integration, scan the file for duplicate anchors and reconcile the meaning before approval.
Do not silently renumber an Approved requirement to resolve a conflict.

## Status lifecycle

A requirement file moves through `Draft`, `Approved`, `Superseded by <link>`, or `Withdrawn`.
Create every file as `Draft`.
Edit Draft requirements in place while the user reviews them.
Change the file to `Approved` only after the user accepts every requirement in the file.
Set `Approved` to the approval date at the same time.

Planning and design consume only Approved requirement files.
Implementation does not change a requirement file to another delivery status.
The roadmap and track files already record delivery progress.

Do not change the meaning of an Approved requirement in place.
Add a new numbered requirement when its obligation changes.
Set the old section to `Disposition: Superseded by <link>` and link the new section back with `Supersedes: <link>`.
Set a section to `Disposition: Withdrawn` when its obligation no longer applies and no replacement exists.

Use file-level `Superseded by <link>` only when another file replaces the complete capability.
Use file-level `Withdrawn` only when no active requirement remains in the file.
Preserve superseded and withdrawn content because durable links and history depend on it.

## Authoring procedure

1. Frame the problem, affected users or systems, goals, and non-goals.
2. Separate product obligations from architectural decisions and implementation tasks.
3. Group the obligations into coherent capability files.
4. Draft the wanted behavior before the unwanted behavior.
5. Select the correct EARS pattern for each obligation.
6. Write one primary obligation in each numbered section.
7. Add rationale and related requirement links outside the EARS statement.
8. Review the complete set for omissions, conflicts, duplication, and unnecessary design constraints.
9. Present every Draft file to the user for approval.
10. Change only accepted files to `Approved` and record the date.

An external platform, law, contract, or operating environment can impose a valid constraint requirement.
An internal technology choice is an architectural decision and belongs in an ADR.
Ask whether the statement would remain true after a complete implementation redesign.
If not, it is probably a design decision rather than a requirement.

## Links and traceability

Requirement files link to related, superseded, and replacement requirements.
Plans, ADRs, feature files, contracts, and handoffs link back to the requirements they serve.
Do not maintain a central backlink index because concurrent edits make it a merge-conflict hotspot.
Use repository search on the exact Markdown link or `filename.md#anchor` for reverse traceability.

## Gate

Present the Draft requirement files and the recommendation to continue, revise, or stop.
Do not approve a file without explicit user acceptance.
Do not open a plan or start design in this context.
After approval, recommend `design` for one self-contained capability or `plan` for a multi-track initiative.

## Quality checks

- Every numbered section contains one EARS requirement.
- Every EARS statement names the system and uses `shall`.
- Every trigger, state, and response is observable or measurable.
- No requirement silently chooses an internal implementation.
- Every number and explicit anchor is unique within its file.
- Approved requirement numbers remain unchanged.
- All Markdown links resolve to existing files and anchors.
- Goals, non-goals, rationale, and design questions remain outside the EARS statements.
- The file contains no copied third-party prose, examples, diagrams, or tables.
