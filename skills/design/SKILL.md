---
name: design
description: "Drive a feature's design session: ADR → technical design → plan + contracts + feature files → handoff, using subagents for exploration and drafting. Invoke to start the heavyweight spec-driven flow for a feature."
argument-hint: '[initiative/track]'
---

# Design a feature

Produce a **validated spec** and hand it to an implementation session.
Run **inline with the user or orchestrator** and delegate the heavy reading and drafting to **subagents**, so your own context stays coherent and lean.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project's own CLAUDE.md conventions.
The session map and lifecycle rules live in the `workflow` overview skill.

**One workflow skill per session** (the rule and its rationale live in the `workflow` overview skill).
The nuance here: never roll straight into `/implement` after this.
That session must start fresh to validate the spec fairly.

A feature is usually a **track** of an initiative plan (`/plan`).
Invoked as `/design <initiative>/<track>`, first read that initiative's spine `plan.md` and the named `<track>.md` in the plans directory (default `/docs/plans/<initiative>/`).
They carry the track's scope, dependencies, cited ADRs, and any spike findings.
A standalone feature outside an initiative skips that and is its own slug.

Read first: the glossary (default `/docs/Glossary.md`), the initiative spine and track file (if any), and skim the ADRs they cite and the relevant feature files.

## 1. Start from the right artifact

- **Mark the track started.** Flip this track `not-started → in-progress` in both places: its node class in the spine's Mermaid DAG (`plan.md`) and the `Status` in its `<track>.md`.
  Design starts when the track stops being not-started, so this is the board's `in-progress` transition.
  The implementation session owns the `→ done` flip at landing.
  If a dependency or undecided question actually blocks the track, set `blocked` or `deferred` with a one-line reason instead.
  If this is the **first** track of the initiative to enter design, also flip the initiative's roadmap node (default `/docs/roadmap.md`) `planned → in-progress` (roadmap Mode B).
  (Standalone feature: no spine to update, but the roadmap flip still applies.
  A standalone feature is an initiative of one track, so flip its node `→ in-progress`, adding the node first if it was never roadmapped.
  Mode B covers both.)
- **Track-feasibility spike first.** If the initiative plan named a feasibility spike against this track, run it now.
  Its finding shapes the ADR, so it must resolve before the design settles.
  Record the finding in the track file's *Spike findings*.
- **New feature or capability → open an ADR**, created `Proposed` (load `write-adr`).
  It stays `Proposed` through this session, and the implementation session accepts it.
  If the idea came through `/ideate`, the `Proposed` ADR **already exists**.
  Start from it and refine it as the design settles, do not open a second one.
- **Bug or unknown → investigate first.** Graduate to an ADR only if a real decision emerges.

Delegate exploration (codebase, docs, web) to subagents so file dumps stay out of your context.
You integrate their findings.

## 2. Settle the design with the user

Iterate the ADR ⇄ technical design until the invariants hold.
This is interactive, so do not rush to artifacts.
Update the glossary as new terms appear.

## 3. Draft build plan, contracts, and feature files

Once the design settles, spawn the drafters **in parallel as forks** (the Agent tool with `subagent_type: "fork"`), one per artifact, each instructed to load its skill:

- **contracts** (`write-contracts`): the boundary shapes.
  May lead the build plan.
- **build plan** (`write-build-plan`): build order, reuse map, plug points, tests, risks.
- **feature files** (`write-feature`): behavior against the contracts' structure.

A fork inherits this session's full context: the user's request, the interview answers, and every settled decision.
That inheritance is the point.
A decision that lives only in this conversation still reaches the artifact, because the drafter saw it first-hand.
The fork's tool work stays out of your context, and only the finished artifact comes back.

Integrate and reconcile their output.
A gap any artifact surfaces feeds back to the ADR, not patched locally.

## 4. Validation loop

Invoke `validate-artifacts` on the drafted bundle.
The skill runs isolated by its own `context: fork`: a cold reader with only the on-disk artifacts, which is what makes its findings predictive of the implementation session's cold read.
Then alternate: fix every finding by updating the owning artifact (a wrong invariant feeds back to the ADR), and invoke the skill again.
The loop ends when a run reports no gaps.

Keep the user in control of the loop.
After each round, report the findings and the fixes in one or two lines.
The user may stop the loop at any round and accept the residual gaps.
If the loop has not converged after five rounds, stop and put the surviving gaps to the user per "How to deliver the question" in the `workflow` overview skill.

## 5. Recommend the implementation model and effort

This is a context boundary, so choose here.
State the model and effort for implementation and why, against the alternative.

- Model: <model_name>
- Effort: <effort_level>

## 6. Write the handoff

Load `write-handoff`.
Prep the bundle (`build-plan.md`, the contracts file, and `handoff.md` under the track's plan folder) so the fresh session can read it.
(A standalone feature uses its own plan folder under the plans directory.)
The `Proposed` ADR (durable) and the prep bundle (scratch) are committed together when the user asks, and the implementation session reads both cold.
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
**Write no implementation code.**
Confirm the **right-size check** passed: the track as specified fits one fresh implementation session.
If it did not, present the **split** (a separate integration track and an updated DAG), not a single over-sized spec.
Wait for the user to accept before the work moves to an implementation session (`/implement`).
Put the acceptance question, and any fork you could not resolve from the spec, to the user per **"How to deliver the question"** in the `workflow` overview skill.

**Expect validation feedback.**
The artifacts are not done when you present them: the fresh implementation session's first act is to validate them adversarially and return gaps.
When the user relays those gaps back, clarify them here (update the ADR, contracts, or feature files) while your context is still warm.
Resolving the gap is *your* responsibility, not the implementer's, and it resumes only once you have.
