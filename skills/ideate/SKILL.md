---
name: ideate
description: "Shape a raw idea as a roadmap work item into Approved EARS requirements before design. Use when the user brings a new capability idea, or orchestration or triage finds behavior that no Approved requirement covers; not for a defect against an existing requirement."
argument-hint: '[idea]'
sdm: "0.3"
---

# Shape a work item

Ideation defines observable obligations without choosing architecture or slices.
Rejecting an idea or recognizing existing coverage is a valid result.

## 1. Prepare

1. Read `.prism/workflow.md` when present, the [workflow](../workflow/SKILL.md), glossary, roadmap, product strategy, and related requirements, ADRs, and features.
2. If Approved requirements or Accepted ADRs conflict with the idea, stop with the conflict.

With a store, the glossary, requirements, and ADRs are [store artifacts](../workflow/SKILL.md#common-terms).

## 2. Start the item

1. When the idea has no roadmap entry, agree with the user on a [portable name](../workflow/SKILL.md#common-terms) as identifier, a title, a one-sentence intent, and a band.
2. Call `update_roadmap` with an `add_initiative` operation that cites each Approved requirement section as `<file>.md§<number>` that already applies.
3. Read the item with `get_work_item` and change it only through `update_work_item`.

## 3. Ask a question round

1. Call `ask_round` with at most five questions that narrow what the item should and should not do, each with a recommended answer, what it settles, and whether readiness needs it.
2. Wait for the answers with `wait_for_user_gate`, except that inside an orchestration you return the round as a [blocker](../workflow/SKILL.md#common-terms).
3. When answers open new questions, ask another round.

## 4. Research and record

- Record each link the user gives with `add_input`.
- Record each finding with `add_finding` and its source, or research that could not reach sources with `add_research_gap`.
- Challenge the need against doing nothing and cheaper alternatives.
- For each architecture choice, use `write-adr` for a Draft ADR with at least two options, a person's preferred solution being one option with who prefers it and why, and `cite` it.

## 5. Write requirements

1. Use `write-requirements` to author the files, one per independent capability, `cite` their sections, and approve them.
2. When they are Approved, call `request_ready` and wait for its gate.

Internal technology choices are Draft ADRs, not requirements.

## 6. Merge, split, or kill

- When the item duplicates another, holds independent parts, or is no longer wanted, call `propose_merge`, `propose_split`, or `propose_kill`, and wait for its gate.

## 7. Return

1. Report the item, requirement paths and statuses, cited ADRs, readiness, and open questions.

Ideation starts no design, orchestration, or implementation.
