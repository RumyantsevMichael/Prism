---
name: triage
description: "Triage a reported defect before design: reproduce it, find the Approved requirement it breaks, and add the fix with those requirements to the initiative whose unshipped done work it breaks, or to the roadmap as a new initiative that corrects shipped work, or hand behavior that no requirement states to ideate. Use when an issue or the user reports that existing behavior is wrong."
argument-hint: '[issue or defect]'
sdm: "0.3"
---

# Triage a defect

Triage decides whether a reported problem breaks an obligation that already exists, so that a fix reuses its requirements instead of writing new ones.

## 1. Reproduce

1. Read `.prism/workflow.md`, the project instructions, the glossary, and the report.
2. Reproduce the defect through its starting surface with the smallest command, input, or test you can, and record the steps and what you observed.
3. When it does not reproduce, return `NOT_REPRODUCED` with what you tried.

## 2. Find the broken obligation

1. Read the Approved requirements, relevant ADRs, and feature files for the behavior.
2. Find each Approved requirement whose stated behavior the reproduction contradicts, and cite it as `<file>.md§<number>`.
3. When that file does not follow the `write-requirements` format, such as having no numbered sections, return `BLOCKED` with the file and what does not conform.
4. When no Approved requirement states the behavior the report expects, the report is not a defect.
5. When Approved requirements or Accepted ADRs conflict about the behavior, return `BLOCKED` with the conflict.

Take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite a shipped initiative's contracts, slice documents, frozen tests, and reviews only as history.

## 3. Add the fix

1. Read the roadmap with `get_roadmap` and keep its revision, and find the initiative and done slice whose work holds the defect through `get_initiative`.
2. When that initiative has not shipped, call `update_initiative` with a `report_defect` operation on the done slice with its slug, the requirement references, and a one-sentence summary, then read the defect id that Prism gave it with `get_initiative`.
3. When that initiative has shipped, call `update_roadmap` with an `add_initiative` operation in band `Now`, an identifier and title that name the defect, a one-sentence intent, the requirement references, and `corrects` with the shipped initiative and each of its slices whose work the fix corrects.
4. When no done slice holds the defect, call `update_roadmap` with that `add_initiative` operation without `corrects`.

## 4. Return the result

- `DEFECT`: the initiative identifier, the slice and defect id for a reported defect, the requirement references, the issue, and the reproduction steps.
- `NOT_A_DEFECT`: what the report expects that no requirement states, for `ideate`.
- `NOT_REPRODUCED` or `BLOCKED`: what you tried, the nonconforming file, or a [blocker](../workflow/SKILL.md#common-terms).

- Don't
  - Fix the defect or add tests to the project.
  - Write new requirements or edit a requirement file.
