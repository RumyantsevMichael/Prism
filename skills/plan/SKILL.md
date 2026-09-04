---
name: plan
description: "Decompose Approved requirements into dependency-ordered vertical outcome slices when one delivery context cannot safely complete the initiative."
argument-hint: '[initiative]'
sdm: "0.3"
---

# Plan outcome slices

The result is the smallest useful initiative plan.

## 1. Prepare

1. Read `.prism/workflow.md`.
2. Use the definitions for [initiative](../workflow/SKILL.md#common-terms), [initiative plan](../workflow/SKILL.md#common-terms), [Approved requirement](../workflow/SKILL.md#common-terms), [slice](../workflow/SKILL.md#common-terms), and [delivery context](../workflow/SKILL.md#common-terms).
3. Use the definitions for [starting surface](../workflow/SKILL.md#common-terms), [frontier](../workflow/SKILL.md#common-terms), [Proposed ADR](../workflow/SKILL.md#common-terms), and [orchestrator](../workflow/SKILL.md#common-terms).
4. Read the glossary, Approved requirements, and relevant ADRs.
5. When project rules require delegated exploration, read [delegation.md](../workflow/references/delegation.md) before delegating exploration.
6. Inspect only the project structure and likely user-visible or system surfaces needed to estimate slices.

- Don't
  - Perform the detailed architecture and code-path exploration owned by `design`.

## 2. Identify observable outcomes

- Split the initiative into vertical outcomes.
- Include every required layer for one observable result in each slice.
- Target the largest coherent outcome that one `Develop <slice>` task can complete safely.
- Avoid slices that change no independently observable behavior.
- Avoid slices whose verification depends on unfinished later work.

- Don't
  - Split by component, team, frontend, backend, tests, contracts, or documentation.

## 3. Apply the admission test

A slice probably fits one delivery context when all these properties are true:

| Property | Probable fit |
| --- | --- |
| Outcome | The slice has one observable outcome. |
| Change path | The changes form one connected path from an initiating input to that outcome. |
| Boundaries | The boundaries and compatibility effects are identifiable. |
| Decisions | At most one consequential architectural decision remains unresolved. |
| Verification | The slice has one end-to-end verification path. |
| Safety | Every changed path has a safe complete state. |
| Dependencies | The slice uses only existing dependencies or dependencies from earlier slices. |

- Split the slice or add a bounded investigation when it has several starting surfaces, migrations, integrations, security boundaries, or architectural questions.
- Split the slice when many unrelated consumers change.
- Split the slice when no single verification scenario exists.
- When applicable, choose one or more of these split patterns:
  - Build a walking skeleton before adding more behavior.
  - Separate migration states that keep the repository valid and reversible.
  - Introduce a boundary with one representative consumer before other consumer groups.
  - Prove the highest risk with code and tests before ordinary behavior.
  - Separate independent happy-path, authorization, validation, recovery, concurrency, or durability outcomes.

- Don't
  - Create a prose spike when executable proof is possible.

## 4. Order the slices

Every intermediate state must be buildable, verifiable, and safe.

1. Create a dependency DAG.
2. Add an edge only when one slice needs code or behavior from another slice.
3. Use `map.puml` as the human-readable projection of the accepted slice graph and live status.
4. Use `not-started`, `in-progress`, `done`, `blocked`, or `deferred` stereotypes.

- Don't
  - Use priority to invent a dependency.

## 5. Write compact slice records

1. Write one `plan.md` under the configured plans directory.
2. Link `map.puml` from the plan.
3. Give each slice exactly these implementation-free fields:

```markdown
## <slice slug>

**Outcome:** <one observable result>
**Requirement links:** <Approved requirement links>
**Starting surface:** <command, route, public function, event, job, or user action>
**Dependencies:** <slice slugs or none>
**Done signal:** <one executable command or end-to-end observation>
```

The orchestrator creates validated `state.json` after plan acceptance.
The orchestrator creates one `findings.md` file under each slice before its first audit.
The orchestrator creates lane findings files only when it assigns review lanes.
The orchestrator generates `map.puml` from the accepted state.

- Do
  - Link a Proposed ADR only when a consequential cross-slice decision already exists.
- Don't
  - Add architecture, interfaces, task lists, implementation instructions, estimates, or handoff prose.
  - Add coordination state or review findings to a slice record.

## 6. Check the plan

- Confirm that every applicable Approved requirement statement belongs to at least one slice.
- Confirm that every dependency edge is necessary.
- Confirm that each slice can ship without unfinished behavior in its changed path.
- Confirm that the first frontier contains at least one executable slice.
- When the review server is available, use [visual-review.md](../workflow/references/visual-review.md).

## 7. Gate

- Return `PLAN READY` with the plan paths and first frontier.
- In standalone use, present the same plan directly to the user.

The orchestrator presents the plan and records explicit acceptance.

- Don't
  - Design or implement a slice during planning.
