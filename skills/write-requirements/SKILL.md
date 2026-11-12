---
name: write-requirements
description: "Define the EARS requirement-file format and lifecycle when ideate creates a file or an Approved requirement needs a focused revision."
sdm: "0.3"
---

# Write requirements

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read [EARS authoring](references/ears-authoring.md), the glossary, related requirements, relevant Accepted ADRs, features, and any configured product strategy.
3. If durable sources conflict, stop with the conflict for user resolution.

Configured paths override `docs/Glossary.md` and `docs/requirements/`.
In a project with a store, requirement files and the glossary are [store artifacts](../workflow/SKILL.md#common-terms), read through `get_artifact` and created and edited through `update_artifact`.
Each requirement file covers one product capability, independent of components, teams, or delivery slices.

## 2. Author the proposal

- For a new capability:
  1. Select an unused readable slug that is a [portable name](../workflow/SKILL.md#common-terms) directly under the requirements directory.
  2. Create a Draft file with the shape below.
- For an existing Draft:
  1. Edit its obligations in place.
- For an Approved file:
  1. In a project with a store, write the amendment into the file, where the review browser shows it against the accepted version; otherwise, prepare a proposed diff for user review without applying changes to the Approved file.
  2. For a replacement obligation, use the next unused number.
  3. For an obligation that ends without replacement, propose `Disposition: Withdrawn`.

The [requirement format](references/requirement-format.md) states the rules that `check_artifacts` checks and a complete example.

```markdown
# <Capability>

Status: Draft
Created: <YYYY-MM-DD>
Approved: n/a

## Problem

<The user or system problem.>

## Goals

- <An intended outcome.>

## Non-goals

- <An excluded outcome.>

## Design questions

- <An unresolved architecture question, or n/a.>

<a id="1"></a>
## 1. <Requirement title>

Pattern: <Ubiquitous | State-driven | Event-driven | Optional feature | Unwanted behavior | Complex>

Disposition: Active

Requirement: <One EARS statement naming the system and using shall.>

Rationale: <Why the obligation exists.>

Related: <Requirement links, or n/a>
```

The slug and explicit anchor form the requirement identity, such as `[capability.md§1](capability.md#1)`.
Numbers are flat positive integers, starting at `1` and increasing without reuse.
Approved slugs, numbers, and obligation meaning remain unchanged, including after withdrawal or supersession.
A replacement section adds `Supersedes: <old-section link>`.
Its old section uses `Disposition: Superseded by <replacement-section link>`.
File-level statuses are `Draft`, `Approved`, `Superseded by <file link>`, and `Withdrawn`.
File-level supersession requires replacement of the whole capability.
File-level withdrawal requires no active obligations.

## 3. Check the proposal

1. Apply the EARS reference's completeness review and checklist.
2. Check unique slugs and anchors and preserved Approved identities.
3. Check that relative links resolve to files and anchors in the proposed result.
4. After integration and before approval, scan again for duplicate slugs and anchors.
5. If duplicates exist, reconcile their meaning without renumbering Approved requirements.

Unresolved internal choices belong in design questions, outside EARS statements.
Requirement files link to related obligations.
Reverse traceability uses repository link searches instead of a central backlink index.

## 4. Obtain approval

- In a project with a store:
  1. For each Draft file or amended Approved file, call `update_artifact` with an `ask_approval` operation, with the status to set when it is not `Approved` and context for a person who has not followed the work, which records an [approval gate](../workflow/SKILL.md#common-terms).
  2. Tell the user to answer each gate in the review browser.
  3. For each file, call `wait_for_user_gate` with the file as `artifact` and its gate id.
  4. When the person requests changes, revise the file from the note and ask again.
- Otherwise:
  1. Present the complete proposal through the [workflow gate rules](../workflow/SKILL.md#supporting-procedures).
  2. Request explicit user acceptance of each Draft file or Approved-file amendment.
  3. For accepted Draft files, set `Status: Approved` and `Approved: <approval date>` together.
  4. For accepted amendments, apply the approved additions, disposition changes, and reciprocal links together.
  5. For unaccepted proposals, leave Draft files Draft and preserve existing Approved content.

With a store, approving writes the file's `Status:` and `Approved:` lines, so an agent leaves them as written.

1. After approval, recommend `orchestrate` for the initiative.
2. Return the file paths, statuses, and unresolved questions.

Design consumes only Approved requirements.
Requirement approval does not start design or orchestration in this context.
