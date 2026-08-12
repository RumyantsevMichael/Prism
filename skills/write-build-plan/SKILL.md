---
name: write-build-plan
description: "Author or update a track's build plan in the plans directory: build order, reuse map, plug points, tests, risks. Use when planning how to build one track of an initiative."
argument-hint: '[initiative/track]'
---

# Write build plan

A build plan is the **build order** for one track: how to get from a settled design to working code without surprises.
It is one of three artifacts in a track's prep bundle under the plans directory (default `docs/plans/<initiative>/<track>/`).
("Plan" unqualified means the initiative plan at `docs/plans/<initiative>/plan.md`, which is a different artifact.
This skill authors the per-track **build plan**.)

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

The build plan and the contracts are **mutually validating** and authored in parallel.
The contracts own *shapes*, and the build plan owns *sequence, reuse, and risk*.
The build plan **references** the contracts rather than restating types.
If you find yourself pasting interfaces in, move them to the contracts file and link instead.

The build plan is **scratch**, deleted in the commit that lands the track's implementation.
So it may name internal labels (workstream IDs, "steps") freely *within itself*, but nothing durable may reference those labels (see the durable-artifacts rule in the `workflow` overview skill).
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

## Build order

Link `[Build order](build-order.puml)` to a PlantUML activity diagram.
The diagram owns workstream order, branches, gates, parallel work, and the critical path.
Use one or two prose sentences for the load-bearing sequence constraint and its risks.

## Reuse map

Link `[Reuse map](reuse-map.puml)` to a PlantUML component diagram.
The diagram owns dependency direction and each workstream's reuse, mirror, or new classification.
Use `<<reuse>>`, `<<mirror>>`, and `<<new>>` stereotypes.
Show the existing component or pattern that supports reuse or mirroring.

Use standard PlantUML activity and component syntax.
Keep labels short and put paths or `file:symbol` plug points in notes when labels become hard to scan.

## Workstreams

One subsection per workstream. For each:
- **What & where**: the change with destination paths for new files and
  `file:symbol` or `file:line` for plug points into existing code.
- **Tests**: the unit / integration / acceptance tests this workstream owes, as a
  sub-bullet here - not deferred to a separate section.
- Requirement links for product obligations and ADR citations for decisions.

## Risks & open questions

Bounded risks and owed decisions with an owner - not design ambiguities (those
were resolved above, or feed back to the ADR).

## Execution profile

- Complexity: standard | high
- Context: fresh
- Parallelism: sequential | independent
- Focus: <specific risk areas>

Explain where judgment is required and where mechanical mirroring is safe.

## Critical files

A short `file:symbol` callout list the implementer will touch first.
```

---

## Conventions

- **Cite requirements for obligations and ADRs for decisions.** Never cite a build-plan label as durable rationale.
  The build plan's own labels stay inside it.
- **Express build order as a PlantUML activity diagram.** Do not repeat its sequence as a numbered list.
- **Express the reuse map as a PlantUML component diagram.** Do not repeat its relations as a prose list.
- **Pin plug points with `file:symbol`.** Line numbers when precision matters, and full destination paths for new files.
- **Tests live with their workstream**, as sub-bullets, so the implementer sees the test obligation next to the work.
- **Concentrate judgment.** Flag which workstreams are mechanical (mirror existing code) and which need care.
  This directs implementation attention.
- State typing/naming conventions the project uses at boundaries (for example Result types for expected failures, schema validation at parse boundaries, domain aliases) once, up front, where they apply.
  Do not repeat per workstream.

---

## Quality checks before finishing

- Build order shows parallelism and the critical path, not just a sequence.
- The activity diagram owns the build order.
- The component diagram owns each reuse, mirror, or new classification.
- Every workstream has a destination or plug point.
- Every obligation links to an Approved requirement.
- Every architectural decision cites an ADR.
- No rationale points at the build plan's own labels.
- Each workstream lists the tests it owes.
- A justified execution profile for implementation is present.
- Shapes live in the contracts file, and the build plan links to them, not restates them.
- `build-order.puml` and `reuse-map.puml` are linked from the build plan.
- No rendered diagram image is present.
