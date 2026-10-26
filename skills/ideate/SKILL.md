---
name: ideate
description: "Shape a raw idea into Approved EARS requirements and a roadmap entry before design."
argument-hint: '[idea]'
sdm: "0.3"
disable-model-invocation: true
---

# Shape product intent

Ideation defines observable obligations, without choosing architecture or delivery slices.
Rejecting an idea or recognizing existing coverage is a valid result.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the [workflow](../workflow/SKILL.md), glossary, roadmap, product strategy when present, and related requirements, ADRs, and features.

Configured paths override `docs/Glossary.md`, `docs/roadmap.md`, and `docs/requirements/`.

## 2. Test the idea

1. Establish the problem, affected actors, current workaround, and intended observable change with the user.
2. Separate evidence from assumptions.
3. Use [delegation.md](../workflow/references/delegation.md) to check existing coverage, durable conflicts, capability ownership, and strategy alignment.
4. If Approved requirements or Accepted ADRs conflict with the idea, stop with the conflict for user resolution.
5. Challenge the need against doing nothing and cheaper process, policy, documentation, or removal alternatives.
6. Test problem evidence, frequency, importance, and what the idea complicates or prevents.
7. If no new obligation survives, return the reason to stop or the existing requirement links.

## 3. Write requirements

1. Group surviving obligations by coherent product capability, using separate files when capabilities can change independently.
2. Use `write-requirements` to author and review the files through its approval procedure.
3. If a necessary new product term appears, update the glossary.

Existing capabilities use amendments under the requirement supersession rules.
External constraints can be requirements, but internal technology choices are design decisions.

## 4. Add the roadmap entry

1. When the approved requirements start a new initiative, read the roadmap with `get_roadmap` and keep its revision.
2. Agree with the user on a stable initiative identifier, a title, a one-sentence intent, and a band of `Now`, `Next`, `Later`, or `Parked`.
3. Call `update_roadmap` with an `add_initiative` operation that links the Approved requirements.
4. When the requirements amend an existing initiative, link them through the `update_roadmap` operation `update_initiative` instead.

The identifier uses letters, digits, hyphens, or underscores, never changes, and names the initiative's plans folder.

## 5. Return the result

1. Report requirement paths, approval status, the roadmap entry, and any unresolved product question.

Ideation does not create coordination files or start design, orchestration, or implementation.
