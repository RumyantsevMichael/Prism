---
name: validate-artifacts
description: "Validate one specification lane during an isolated design review."
argument-hint: '[initiative/track]'
context: fork
background: false
---

# Validate artifacts

This is the **adversarial pre-implementation check**: before a line of code, a fresh reader tries to *break* the spec on paper, where fixing a gap costs a sentence instead of a refactor.
Run this skill in an **isolated context** with no authoring conversation history.
Host metadata can enforce isolation, but the caller must still guarantee an isolated context.
Use an isolated child context or a separate fresh user-started task.
Read everything you need from the files.

The design validation wave invokes this skill once per focused lane against one unchanged bundle.
Each lane must use a fresh isolated reader.
The design session combines all lane reports before it edits any artifact.
Implementation does not repeat this pass.

It is not implementation, and it is not the final code review.
Keep the three distinct:

- **This pass** validates the *spec*, before code.
- **Acceptance tests** validate the *implementation* against the spec, after code.
- **Live verification** validates the *running system*, after code, for what tests cannot capture.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

Read the handoff first (default `docs/plans/<initiative>/<track>/handoff.md`).
It names the authoritative inputs and their precedence.
Then read the Approved requirement files that the track cites.
They are the source obligations that every downstream artifact must satisfy.
Read the track file and recorded plan notes for scope and orientation only.

## Select one validation lane

The caller assigns exactly one lane:

1. **Obligations and contracts** checks requirements, behavior, links, names, and contract implementability.
2. **Architecture and cutover** checks ADR consistency, migration order, public surfaces, and replacement boundaries.
3. **Security and containment** checks trust boundaries, attacker paths, failure behavior, privilege, and isolation.
4. **Delivery feasibility** checks integration dependencies, UI obligations, operations, task dependencies, write surfaces, and independently testable completion.

Read every authoritative artifact needed for the assigned lane.
Do not claim that the other lanes passed.
Report a cross-lane dependency when your finding also affects another lane.

---

## What to do

Work through the assigned lane adversarially, not approvingly.
Your goal is to find the gap the design session is too close to see.

For the **obligations and contracts** lane:

1. Implement each interface and seam on paper.
2. Trace every active requirement to its contract, feature Rule, task obligation, or justified non-executable check.
3. Try to falsify each requirement through a missing state, actor, boundary, failure, or measurable condition.
4. Check names, keywords, formats, commands, error strings, requirement links, and explicit anchors exactly.
5. Reject Draft requirements and invented capabilities as authoritative inputs.
6. Confirm that each `// OPEN:` seam is a local implementation choice.
7. Find unmarked shape gaps and feature examples that cannot become clear tests.

For the **architecture and cutover** lane:

1. Try to violate each ADR invariant through a path, input, or order.
2. Check that contracts and feature behavior preserve every applicable invariant.
3. Check migration order, compatibility periods, public cutover, rollback, and removal boundaries.
4. Check that all artifacts use one name for each public surface.
5. Read each needed `.puml` source and compare it with its owning artifact.
6. Never inspect a rendered diagram.
7. Reject a prose table or list that duplicates diagram-owned relationships or order.

For the **security and containment** lane:

1. Identify secrets, network access, privilege, isolation, untrusted input, and IPC.
2. Trace attacker-controlled data to each sensitive sink.
3. Check authorization, least privilege, failure containment, cleanup, and recovery behavior.
4. Find trust rules that contracts or invariants do not enforce.
5. Route a missing product obligation to its requirement file.
6. Route a missing architectural invariant to its ADR.
7. State the security surface explicitly, including `security surface: none`.

For the **delivery feasibility** lane:

1. Check every integration dependency, UI obligation, operational prerequisite, generated output, and migration.
2. Check that each task has one independently testable deliverable and an exact completion condition.
3. Check every task dependency, consumed interface, produced interface, write surface, test, and verification command.
4. Confirm that the task graph covers the complete design without changing the specification.
5. Reject an eligible parallel frontier when tasks share files, interfaces, generated outputs, migrations, or lock files.
6. Report an implementation-size problem as a task split, not a track split.

## What to produce

Name the assigned lane first.
List each gap against its owning requirement, ADR, or specification artifact.
Give the design session enough detail to act on each gap.
Classify each gap as `editorial`, `actionable`, or `structural`.
Use `structural` only for an independent design capability, an incompatible architectural boundary, a missing prerequisite, or an impossible task graph.
State each affected adjacent lane.
The security lane also states the track's security surface for the final code review.
**Report the findings and stop.**
Do not resolve gaps, recommend resolutions, or proceed past them.
Clarifying the specification is the design task's responsibility.
The design task updates the owning artifact while its context is still available.
Your job here is to find the gap, not to fill it.

When the assigned lane holds up, say so plainly and return the clean lane result to design.
The point is a real attempt to break them, not a rubber stamp.
But a spec that survives a genuine attempt is cleared to build.

---

## Quality checks before finishing

- Every check that belongs to the assigned lane was completed.
- Every gap names its owner, classification, and adjacent lanes.
- Every linked PlantUML source needed for the lane was checked without reading a rendered image.
- No conclusion claims coverage from an unassigned lane.
- The security lane states the security surface in one line, and `none` is valid.
- Wrong product obligations route to `write-requirements`, and wrong architectural invariants route to the ADR.
