---
name: plan
description: "Decompose Approved requirements into dependency-ordered vertical outcome slices when one delivery context cannot safely complete the initiative."
argument-hint: '[initiative]'
---

# Plan outcome slices

Create the smallest useful initiative plan.

Read `.prism/workflow.md`, the glossary, Approved requirements, and relevant ADRs.
Inspect only project structure and likely user-visible or system surfaces needed to estimate slices.
Use [delegation.md](../workflow/references/delegation.md) when project rules require delegated exploration.
Leave detailed architecture and code-path exploration to `design`.

## 1. Identify observable outcomes

Split the initiative into vertical outcomes.
Each slice must include every required layer for one observable result.
Do not split by component, team, frontend, backend, tests, contracts, or documentation.

Target the largest coherent outcome that one `Develop <slice>` task can complete safely.
Avoid a slice that changes no independently observable behavior.
Avoid a slice whose verification depends on unfinished later work.

## 2. Apply the admission test

A slice probably fits one delivery context when it has:

1. one observable outcome.
2. one connected set of changes from an initiating input to that outcome.
3. identifiable boundaries and compatibility effects.
4. at most one unresolved consequential architectural decision.
5. one end-to-end verification path.
6. a safe complete state for every changed path.
7. only existing dependencies or dependencies from earlier slices.

Split or add a bounded investigation when the slice has several starting surfaces, migrations, integrations, security boundaries, or architectural questions.
Also split when many unrelated consumers change or no single verification scenario exists.

Prefer these split patterns:

- Build a walking skeleton before additional behavior.
- Separate migration states that leave the repository valid and reversible.
- Introduce a boundary with one representative consumer before other consumer groups.
- Prove the highest risk with code and tests before ordinary behavior.
- Separate independent happy-path, authorization, validation, recovery, concurrency, or durability outcomes.

Do not create a prose spike when executable proof is possible.

## 3. Order the slices

Create a dependency DAG.
Add an edge only when one slice needs code or behavior from another slice.
Do not use priority to invent a dependency.
Every intermediate state must build, verify, and remain safe.

Use `slices.puml` for the DAG and live status.
Use `not-started`, `in-progress`, `done`, `blocked`, or `deferred` stereotypes.

## 4. Write compact slice records

Write one `plan.md` under the configured plans directory.
Link `slices.puml` from the plan.
The orchestrator creates `state.md` after plan acceptance and creates one `findings.md` file under each slice before its first audit.
Give each slice exactly these implementation-free fields:

```markdown
## <slice slug>

**Outcome:** <one observable result>
**Requirement links:** <Approved requirement links>
**Starting surface:** <command, route, public function, event, job, or user action>
**Dependencies:** <slice slugs or none>
**Done signal:** <one executable command or end-to-end observation>
```

Do not add architecture, interfaces, task lists, implementation instructions, estimates, or handoff prose.
Do not add coordination state or review findings to the slice record.
Link a Proposed ADR only when a consequential cross-slice decision already exists.

## 5. Check the plan

Confirm every applicable Approved requirement statement belongs to at least one slice.
Confirm every dependency edge is necessary.
Confirm each slice can ship without unfinished behavior in its changed path.
Confirm the first frontier contains at least one executable slice.

Use [visual-review.md](../workflow/references/visual-review.md) when the review server is available.

## Gate

Return `PLAN READY` with the plan paths and first frontier.
The orchestrator presents the plan and records explicit acceptance.
In standalone use, present the same plan directly to the user.
Do not design or implement a slice in this phase.
