---
name: write-build-plan
description: "Define a designed track's implementation tasks, dependencies, interfaces, tests, and completion conditions."
argument-hint: '[initiative/track]'
---

# Write build plan

A build plan is the **implementation-task graph** for one track: how to get from a settled design to working code without changing the design.
It is one of three artifacts in a track's prep bundle under the plans directory (default `docs/plans/<initiative>/<track>/`).
("Plan" unqualified means the initiative plan at `docs/plans/<initiative>/plan.md`, which is a different artifact.
This skill authors the per-track **build plan**.)

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

The build plan and the contracts are **mutually validating** and authored in parallel.
The contracts own *shapes*, and the build plan owns *task boundaries, sequence, reuse, and risk*.
The build plan **references** the contracts rather than restating types.
If you find yourself pasting interfaces in, move them to the contracts file and link instead.

The build plan is **scratch**, deleted in the commit that lands the track's implementation.
It can use task identifiers inside itself, but durable artifacts cannot reference them.
Cite requirements for obligations and ADRs for rationale.
Do not use the build plan's own labels as durable references.

Before writing, read the project glossary, Approved requirements, governing ADRs, and paired contracts.

---

## Where it lives

`<plans-dir>/<initiative>/<track>/build-plan.md`, alongside the contracts file and `handoff.md` for the same track.
`<track>` is the track's handle within its initiative: prefer a descriptive slug (for example `V2-streaming-notifications`) over a bare ordinal.
`<initiative>` is a short slug for the body of work.

---

## Structure

Adapt to the track, but this skeleton has earned its keep:

```markdown
# <Initiative> / <Track> - build plan

<One-paragraph executive summary: the single load-bearing fact that shapes the
design (e.g. "an existing seam already carries the delivery channel"), so the
reader knows what everything hangs on.>

## Resolved decisions / open items

What is settled (with a one-line each) versus what the implementer still owes a
decision on. Put this first so the reader sees the solid ground before the detail.

## Task graph

Link `[Task graph](build-order.puml)` to a PlantUML activity diagram.
The diagram owns task dependencies, branches, gates, eligible parallel frontiers, and the critical path.
Use one or two prose sentences for the load-bearing sequence constraint and its risks.

## Reuse map

Link `[Reuse map](reuse-map.puml)` to a PlantUML component diagram.
The diagram owns dependency direction and each task's reuse, mirror, or new classification.
Use `<<reuse>>`, `<<mirror>>`, and `<<new>>` stereotypes.
Show the existing component or pattern that supports reuse or mirroring.

Use standard PlantUML activity and component syntax.
Keep labels short and put paths or `file:symbol` plug points in notes when labels become hard to scan.

## Implementation tasks

One subsection per independently testable task.
Give each task a stable scratch identifier that no durable artifact references.
For each task, specify these fields:

- **Deliverable**: one independently testable result.
- **Depends on**: exact predecessor task identifiers, or `none`.
- **Consumes**: the settled interfaces and artifacts that the task reads.
- **Produces**: the exact interfaces, files, or behavior that later tasks use.
- **Write surface**: destination paths and `file:symbol` or `file:line` plug points.
- **Tests**: the unit, integration, and acceptance tests that the task owns.
- **Verification**: exact commands or live checks with the expected result.
- **Completion**: the observable condition that lets the controller accept the task.
- Requirement links for obligations and ADR citations for decisions.

Fold setup, scaffolding, generated output, documentation, and configuration into the task whose deliverable needs them.
Split tasks where the controller can approve one independently and reject its neighbor.
Do not split one test cycle into artificial tasks.
Declare every produced interface precisely enough for a fresh worker on a dependent task.
Declare write surfaces precisely enough for the controller to reject unsafe parallel execution.

## Risks & open questions

Bounded risks and owed decisions with an owner - not design ambiguities (those
were resolved above, or feed back to the ADR).

## Controller execution profile

- Complexity: standard | high
- Context: fresh
- Parallelism: sequential | independent
- Focus: <specific risk areas>

Explain where judgment is required and where mechanical mirroring is safe.
State which task frontiers can run concurrently when isolated workspaces exist.

## Critical files

A short `file:symbol` callout list the implementer will touch first.
```

---

## Conventions

- **Cite requirements for obligations and ADRs for decisions.** Never cite a build-plan label as durable rationale.
  The build plan's own labels stay inside it.
- **Express the task graph as a PlantUML activity diagram.** Do not repeat its dependencies as a numbered list.
- **Express the reuse map as a PlantUML component diagram.** Do not repeat its relations as a prose list.
- **Pin plug points with `file:symbol`.** Line numbers when precision matters, and full destination paths for new files.
- **Tests live with their task**, so each worker sees the test obligation next to the deliverable.
- **Concentrate judgment.** Flag which tasks are mechanical and which need care.
  This directs implementation attention.
- State typing/naming conventions the project uses at boundaries (for example Result types for expected failures, schema validation at parse boundaries, domain aliases) once, up front, where they apply.
  Do not repeat per task.

---

## Quality checks before finishing

- The task graph shows dependencies, parallel frontiers, and the critical path.
- The activity diagram owns task dependencies.
- The component diagram owns each reuse, mirror, or new classification.
- Every task has one independently testable deliverable.
- Every task declares predecessors, consumed interfaces, and produced interfaces.
- Every task has a complete write surface.
- Every task has exact verification and a completion condition.
- Every obligation links to an Approved requirement.
- Every architectural decision cites an ADR.
- No rationale points at the build plan's own labels.
- Each task lists the tests it owns.
- A justified controller execution profile is present.
- Shapes live in the contracts file, and the build plan links to them, not restates them.
- `build-order.puml` and `reuse-map.puml` are linked from the build plan.
- No rendered diagram image is present.
