---
name: design
description: "Design a feature from Approved requirements through ADRs, contracts, build plan, feature files, validation, and handoff. Use for a defined capability."
argument-hint: '[initiative/track]'
---

# Design a feature

Produce a **validated spec** and hand it to a fresh implementation context.
Run inline with the user or orchestrator and delegate heavy reading and drafting to child agents when available.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

**One workflow skill per context** (the rule and its rationale live in the `workflow` overview skill).
Never run `implement` in this context after design.
Implementation must start in a fresh context to read the specification independently.

A feature is usually a **track** of an initiative plan created by `plan`.
When the target is `<initiative>/<track>`, first read the initiative spine and named track file under `docs/plans/<initiative>/`.
They carry the track's scope, dependencies, requirement links, cited ADRs, and spike findings.
A standalone feature outside an initiative skips that and is its own slug.

Read the glossary first, with `docs/Glossary.md` as the default path.
Then read the initiative files when present, the Approved requirements, relevant ADRs, and feature files.
Use `docs/requirements/`, `docs/ADRs/`, and `docs/Features/` as the default directories.

Design consumes only Approved requirement files.
If no Approved requirement defines the capability, stop and recommend `ideate` for a shapeless idea or `write-requirements` for settled intent.
Do not create or approve product requirements inside a design context.

## 1. Start from the right artifact

- **Mark the track started.** Flip this track `not-started → in-progress` in both places: its stereotype in `tracks.puml` and the `Status` in its `<track>.md`.
  Design starts when the track stops being not-started, so this is the board's `in-progress` transition.
  The implementation session owns the `→ done` flip at landing.
  If a dependency or undecided question actually blocks the track, set `blocked` or `deferred` with a one-line reason instead.
  If this is the **first** track to enter design, also flip its roadmap node to `in-progress`.
  A planned initiative uses `planned → in-progress`.
  A standalone Approved requirement can use `envisioned → in-progress` because it has no plan gate.
  (Standalone feature: no spine to update, but the roadmap flip still applies.
  A standalone feature is an initiative of one track, so flip its node `→ in-progress`, adding the node first if it was never roadmapped.
  Mode B covers both.)
- **Track-feasibility spike first.** If the initiative plan named a feasibility spike against this track, run it now.
  Its finding shapes the design and any ADR, so it must resolve before the design settles.
  Record the finding in the track file's *Spike findings*.
- **Start from the Approved requirements.** Preserve each obligation and direct link without changing its meaning.
- **Open an ADR only for an architectural decision or invariant.** Create it as `Proposed` by loading `write-adr`.
  Link every new ADR to the requirements it serves.
  It stays `Proposed` through this session, and the implementation session accepts it.
  Do not create an ADR only because a feature exists.
- **Bug or unknown → investigate first.** Graduate to an ADR only if a real decision emerges.

Delegate exploration to child agents when available so large file results stay out of your context.
You integrate their findings.

## 2. Settle the design with the user

Iterate the technical design against the requirements and ADRs until every obligation and invariant holds.
Do not change an Approved requirement's meaning in this context.
If a requirement is wrong, missing, or ambiguous, stop and route it back to `write-requirements` for user approval.
This is interactive, so do not rush to artifacts.
Update the glossary as new terms appear.

## 3. Draft build plan, contracts, and feature files

Once the design settles, draft the artifacts through the safest capabilities the host provides.
If context-inheriting child agents and isolated workspaces are available, start one per artifact and run independent drafts in parallel.
After each draft finishes, integrate its artifact through the host's isolated-workspace integration capability.
Integrate one artifact at a time before reconciliation.
If either capability is unavailable, draft the artifacts sequentially in the current context.

- **contracts** (`write-contracts`): the boundary shapes.
  May lead the build plan.
- **build plan** (`write-build-plan`): build order, reuse map, plug points, tests, risks.
- **feature files** (`write-feature`): behavior against the contracts' structure.
  Each Rule links to the Approved requirements that it specifies.

An inheriting child context receives the user's request, the interview answers, and every settled decision.
Pass artifact paths and the scoped drafting task.
Do not inline file contents.

Integrate and reconcile their output.
Route a product-obligation gap to the requirement file.
Route an architectural gap to the ADR.
Do not patch either gap only in a downstream artifact.

## 4. Validation loop

Invoke `validate-artifacts` on the drafted bundle.
Run it in an isolated child context with only the on-disk artifacts.
If the host cannot create that context, ask the user to run `validate-artifacts` in a separate fresh task and relay its findings.
Then alternate between fixing every finding in its owning artifact and starting a new isolated validation run.
A wrong product obligation feeds back to `write-requirements` and user approval.
A wrong architectural invariant feeds back to the ADR.
The loop ends when a run reports no gaps.

Keep the user in control of the loop.
After each round, report the findings and the fixes in one or two lines.
The user may stop the loop at any round and accept the residual gaps.
If the loop has not converged after five rounds, stop and put the surviving gaps to the user per "How to deliver the question" in the `workflow` overview skill.

## 5. Recommend the implementation execution profile

This is a context boundary, so choose here.
State the execution profile for implementation and explain the risk areas.

- Complexity: standard | high
- Context: fresh
- Parallelism: sequential | independent
- Focus: <specific risk areas>

## 6. Write the handoff

Load `write-handoff`.
Prep the bundle (`build-plan.md`, the contracts file, and `handoff.md` under the track's plan folder) so the fresh session can read it.
(A standalone feature uses its own plan folder under the plans directory.)
The Approved requirements, any Proposed ADRs, and the prep bundle form the implementation input.
The implementation session reads them cold.
Do not propose that commit on your own.

## Hand future tracks what this session decided

A design session often settles something that does not touch *this* track but constrains or unblocks a **later** one: work deferred downstream, a shape a future track must honor, an open question this design answered on its behalf, or a spike finding with reach beyond here.
The future design session reads its `<track>.md` cold, so a decision left only in this session's context is lost to it.

So whenever a decision lands outside this track's scope, **carry it forward into the affected track's file**.
Edit the future track's `<track>.md` (and the spine's open-questions or cross-cutting notes in `plan.md` when it spans several).
Record only what that track needs: the decision and its rationale (cite the ADR if one exists), not this track's full reasoning.
These are scratch plan files that cross-reference each other, which is allowed.
Do **not** promote the decision into a durable artifact before the future track settles its own ADR.
Updating the spine and a sibling track file does not violate the one-skill-per-session boundary.
Like the status flips in step 1, these are one-line plan edits, not a second design.

## Gate

Stop and present the artifacts.
When `present_review` is available, open the returned URL in the host internal browser and inspect the handoff page before asking for acceptance.
**Write no implementation code.**
Confirm the **right-size check** passed: the track as specified fits one fresh implementation session.
If it did not, present the **split** (a separate integration track and an updated DAG), not a single over-sized spec.
Wait for the user to accept before the work moves to `implement` in a fresh context.
Put the acceptance question, and any fork you could not resolve from the spec, to the user per **"How to deliver the question"** in the `workflow` overview skill.

**Expect cold-read feedback.**
The fresh implementation context reads the artifacts without the design conversation and can still surface a specification gap.
When the user relays those gaps back, update the owning ADR, contracts, or feature files while this context remains available.
Route a requirement gap back to `write-requirements` instead of changing product intent here.
Resolving the gap is *your* responsibility, not the implementer's, and it resumes only once you have.
