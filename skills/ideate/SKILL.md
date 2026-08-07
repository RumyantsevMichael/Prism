---
name: ideate
description: "Shape a raw idea into Proposed ADRs by challenging it and fitting it into the system. Use before plan or design."
disable-model-invocation: true
argument-hint: '[idea]'
---

# Ideate on a fresh idea

This is **ideation**: the origination step one rung below `plan` and `design`.
It turns an idea with no concrete shape into Proposed ADRs that a later `plan` or `design` task reads cold.
Run inline with the user and delegate read-heavy work to child agents when available.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

The job is **shaping and challenging, not specifying.** You decide *what the idea is, whether it should exist, and how it fits the system*, not how to build it.
There is **no technical design, no contracts, no feature files, no build plan** here.
Those belong to `design`.
The single durable output is the ADR(s).

`ideate` is **optional**, the same way a self-contained feature skips `plan`.
Use it only when the idea is genuinely shapeless and needs brainstorming before it can be specced.
If you already know the decision, use `plan` for a multi-ADR initiative or `design` for a self-contained feature.

**One workflow skill per context** (the rule and its rationale live in the `workflow` overview skill).
Do not run `plan` or `design` in this context after the user accepts the shaping.
Reading the ADR cold in a fresh context keeps the shaping honest.

Read the glossary (default `docs/Glossary.md`), the product strategy document if present, and the roadmap (default `docs/roadmap.md`).
Skim the ADR index (default `docs/ADRs/`) because the idea must fit the existing decision chain.

## 1. Frame the raw idea

Settle with the user, inline: what itch or problem this scratches, who it is for, and what would observably change if it existed.
Keep it loose, because this is the one place in the workflow where the shape is still open.
Do not jump to a solution.
Name the problem first.

## 2. Fit it into the existing system

Delegate these checks to child agents when available.
Pass paths, never inlined contents, and run them in parallel only when safe:

- **Does it conflict with a settled (`Accepted`) ADR?** A conflict is a stop: the idea either yields to the invariant or becomes a deliberate supersession, which is a much bigger decision to surface to the user, not paper over.
- **Does it duplicate or already live inside an existing ADR?**
  If so, recommend an **amendment** that `design` can take up.
  You do **not** edit an `Accepted` ADR here.
- **Which strategy pillar does it serve?** An idea that serves none is a flag, not necessarily a kill, so surface it.
  (If the project has no strategy document, weigh it against the product's stated purpose instead.)

Integrate their findings inline.
This is the "fit it into what exists" half of the session and the reason it is read-heavy.

## 3. Challenge it

Apply adversarial pressure, inline, before committing anything to an ADR: why *not* build it, what the cheaper non-build alternative is, what it breaks or complicates, whether the problem is real or assumed.
A **legitimate outcome is killing the idea**, or folding it into an existing decision.
In that case the task produces **no new ADR**, and that is a successful `ideate` result.
Do not manufacture an ADR to justify the session.

## 4. Shape into Proposed ADR(s)

If the idea survives, distill it into **one or more** ADRs (load `write-adr`, create each `Proposed`).

The judgment here:

- **One decision → one ADR.**
  Recommend `design` for a self-contained feature.
- **Several distinct decisions → several ADRs.**
  Recommend `plan` for an initiative that needs track decomposition.

Each ADR is a complete decision record (Problem, Goals, Non-Goals, Decision, Rationale, Consequences), with the alternatives you challenged in step 3 captured in its Rationale and Non-Goals.
It stays `Proposed` because `ideate` never settles a decision.
Stop at the decision.
Do **not** drift into technical design or contracts.

## The artifact

Proposed ADRs in the ADR directory (default `docs/ADRs/`) are **the only durable output**.
`ideate` writes **no scratch folder**.
It **does not touch the roadmap**: it shapes *what* the idea is, and the roadmap decides *when*, downstream.
Update the glossary if shaping the idea introduced a genuinely new term.

## Gate

Stop and present the Proposed ADR(s), or the reasoned recommendation to **not** build, with no ADR.
**Open no plan, design no track, write no code.** Put the acceptance, and any build-or-kill fork you reached, to the user per **"How to deliver the question"** in the `workflow` overview skill.
Wait for the user to accept the shaping, then **recommend the next step** and why:

- **Self-contained feature** (one ADR) → `design`.
- **Initiative** (an ADR cluster) → `plan`.
  Note when `roadmap` should place it among other initiatives first.

The recommended session starts fresh and reads the ADR cold.
