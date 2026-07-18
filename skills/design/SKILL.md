---
name: design
description: Drive a feature's design session — ADR → technical design → plan + contracts + feature files → handoff — using subagents for exploration and drafting. Invoke to start the heavyweight spec-driven flow for a feature.
argument-hint: '[initiative/track]'
---

# Design a feature

This is **design**: produce a **validated spec** and hand it to an implementation session.
You run **inline with the user** and delegate the heavy reading and drafting to **subagents**, keeping your own context coherent and lean.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill). Read it first if it exists — it overrides the default paths and stack assumptions below. If absent, use the defaults and the project's own CLAUDE.md conventions. The session map and lifecycle rules live in the `workflow` overview skill.

For a small change that needs no spec, don't run this — make the change directly
under the project's baseline conventions.

**One workflow skill per session** (the rule and its rationale live in the `workflow` overview skill).
The nuance here: never roll straight into `/implement` after this — that session must be fresh to validate the spec fairly.

A feature is usually a **track** of an initiative plan (`/plan`).
Invoked as `/design <initiative>/<track>`, read that initiative's spine `plan.md` and the named `<track>.md` in the plans directory (default `/docs/plans/<initiative>/`) first — they carry the track's scope, dependencies, cited ADRs, and any spike findings.
A standalone feature outside an initiative skips that and is its own slug.

Read first: the glossary (default `/docs/Glossary.md`), the initiative spine + track file (if any), and skim the ADRs they cite and the relevant feature files.

## 1. Start from the right artifact

- **Mark the track started.**
  Flip this track `not-started → in-progress` — both its node class in the spine's Mermaid DAG (`plan.md`) and the `Status` in its `<track>.md`.
  Design beginning is when the track stops being not-started, so this is the board's `in-progress` transition; the implementation session owns the `→ done` flip at landing.
  If a dependency or undecided question actually blocks the track, set `blocked`/`deferred` with a one-line reason instead.
  If this is the **first** track of the initiative to enter design, also flip the initiative's roadmap node (default `/docs/roadmap.md`) `planned → in-progress` (roadmap Mode B).
  (Standalone feature: no spine to update, but the roadmap flip still applies — a standalone feature is an initiative of one track, so flip its node `→ in-progress`, adding the node first if it was never roadmapped; Mode B covers both.)
- **Track-feasibility spike first.**
  If the initiative plan named a feasibility spike against this track, run it now — its finding shapes the ADR, so it must resolve before the design settles.
  Record the finding in the track file's *Spike findings*.
- **New feature/capability → open an ADR**, created `Proposed` (load `write-adr`).
  It stays `Proposed` through this session — the implementation session accepts it.
  If the idea came through `/ideate`, the `Proposed` ADR **already exists** — start from it and refine it as the design settles, do not open a second one.
- **Bug/unknown → investigate first**;
  graduate to an ADR only if a real decision emerges.

Delegate exploration (codebase, docs, web) to subagents so file dumps stay out of your context; you integrate their findings.

## 2. Settle the design with the user

Iterate the ADR ⇄ technical design until the invariants hold.
This is interactive — do not rush to artifacts.
Update the glossary as new terms appear.

## 3. Draft build plan, contracts, and feature files

Once the design settles, spawn subagents **in parallel**, each loading its skill
and given the ADR and sibling-artifact paths (not inlined contents):

- **contracts** (`write-contracts`) — the boundary shapes; may lead the build plan.
- **build plan** (`write-build-plan`) — build order, reuse map, plug points, tests, risks.
- **feature files** (`write-feature`) — behavior against the contracts' structure.

Integrate and reconcile their output.
A gap any artifact surfaces feeds back to the ADR, not patched locally.

## 4. Pre-validate

Spawn a subagent, instruct it to load `validate-artifacts` and run pre-validation to catch gaps early.
Close the gaps.

## 5. Recommend the implementation model and effort

This is a context boundary, so choose here: state the model + effort for implementation and why, against the alternative.

| Model | Effort |
| :---: | :---: |
| <model_name> | <effort_level> |

## 6. Write the handoff

Load `write-handoff`.
Prep bundle — `build-plan.md`, the contracts file, `handoff.md` under the track's plan folder — so the fresh session can read it.
(A standalone feature uses its own plan folder under the plans directory.)
The `Proposed` ADR (durable) and the prep bundle (scratch) are committed together when the user asks — the implementation session reads both cold.
Do not propose that commit on your own.

## Hand future tracks what this session decided

A design session often settles something that doesn't touch *this* track but constrains or unblocks a **later** one — work deferred downstream, a shape a future track must honor, an open question this design answered on its behalf, a spike finding with reach beyond here.
The future design session reads its `<track>.md` cold; a decision left only in this session's context is lost to it.

So whenever a decision lands outside this track's scope, **carry it forward into the affected track's file** — edit the future track's `<track>.md` (and the spine's open-questions/cross-cutting notes in `plan.md` when it spans several).
Record only what that track needs: the decision and its rationale (cite the ADR if one exists), not this track's full reasoning.
These are scratch plan files cross-referencing each other, which is allowed; do **not** promote the decision into a durable artifact before the future track settles its own ADR.
Updating the spine and a sibling track file does not violate the one-skill-per-session boundary — like the status flips in step 1, these are one-line plan edits, not a second design.

## Gate

Stop and present the artifacts.
**Write no implementation code.**
Confirm the **right-size check** passed — the track as specified fits one fresh implementation session;
if it didn't, present the **split** (a separate integration track + an updated
DAG), not a single over-sized spec.
Wait for the user to accept before the work moves to an implementation session (`/implement`).
Put the acceptance question — and any fork you could not resolve from the spec — to the user per **"How to deliver the question"** in the `workflow` overview skill.

**Expect validation feedback.**
The artifacts are not done when you present them — the fresh implementation session's first act is to validate them adversarially and return gaps.
Stay available: when the user relays those gaps back, clarify them here (update the ADR/contracts/feature files) while your context is still warm.
Resolving the gap is *your* responsibility, not the implementer's; it resumes only once you have.
