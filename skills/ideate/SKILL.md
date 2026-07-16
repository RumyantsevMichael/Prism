---
name: ideate
description: Shape a raw, shapeless idea into one or more Proposed ADRs — brainstorm it, challenge it, and fit it into the existing system — so a later /plan or /design session can take it up. Use when the user floats a shapeless idea.
disable-model-invocation: true
argument-hint: [idea]
---

# Ideate on a fresh idea

This is **ideation**: the origination step one rung *below* `/plan` and `/design`.
It takes an idea that has **no concrete shape yet** — a feature or a whole initiative — and works it into one or more **Proposed ADRs**: the seed a later
`/plan` or `/design` session picks up cold.
You run **inline with the user** and delegate the read-heavy integration work to **subagents**, keeping your context lean.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill). Read it first if it exists; it overrides the default paths below. If absent, use the defaults and the project's own CLAUDE.md conventions.

The job is **shaping and challenging, not specifying.**
You decide *what the idea is, whether it should exist, and how it fits the system* — not how to build it.
There is **no technical design, no contracts, no feature files, no build plan**
here; those belong to `/design`. The single durable output is the ADR(s).

`/ideate` is **optional**, the same way a self-contained feature skips `/plan`. Use it only when the idea is genuinely shapeless and needs brainstorming before it can be specced.
If you already know the decision, skip straight to `/plan` (multi-ADR initiative) or `/design` (self-contained feature) and open the ADR there.

**One workflow skill per session** (the rule and its rationale live in the `workflow` overview skill).
The nuance here: do not roll into `/plan` or `/design` once the user accepts the shaping — reading the ADR cold in a fresh session is what keeps the shaping honest.

Read first: the glossary (default `/docs/Glossary.md`), the product strategy document if the project has one (the pillars an idea must serve), and the roadmap (default `/docs/roadmap.md` — what is already envisioned or shipped).
Skim the ADR index (default `/docs/ADRs/`) — the idea must fit the existing decision chain, not reopen it.

## 1. Frame the raw idea

Settle with the user, inline: what itch or problem this scratches, who it is for, and what would observably change if it existed.
Keep it loose — this is the one place in the workflow where the shape is still open.
Do not jump to a solution; name the problem first.

## 2. Fit it into the existing system

Delegate to subagents (pass paths, never inlined contents) to answer, in parallel:

- **Does it conflict with a settled (`Accepted`) ADR?**
  A conflict is a stop — the idea either yields to the invariant or becomes a deliberate supersession, which is a much bigger decision to surface to the user, not paper over.
- **Does it duplicate or already live inside an existing ADR?**
  If so the idea needs no new decision — recommend it as an **amendment** to that ADR, taken up by `/design`.
  You do **not** edit an `Accepted` ADR here.
- **Which strategy pillar does it serve?**
  An idea that serves none is a flag, not necessarily a kill — surface it.
  (If the project has no strategy document, weigh it against the product's stated purpose instead.)

Integrate their findings inline.
This is the "fit it into what exists" half of the session and the reason it is read-heavy.

## 3. Challenge it

Apply adversarial pressure, inline, before committing anything to an ADR: why
*not* build it, what the cheaper non-build alternative is, what it breaks or
complicates, whether the problem is real or assumed.
A **legitimate outcome is killing the idea** — or folding it into an existing decision — in which case the session produces **no new ADR**, and that is a successful `/ideate`.
Do not manufacture an ADR to justify the session.

## 4. Shape into Proposed ADR(s)

If the idea survives, distil it into **one or more** ADRs (load `write-adr`, create each `Proposed`).

The judgment here:

- **One decision → one ADR.**
  Smells like a self-contained feature → recommend `/design`.
- **Several distinct decisions → several ADRs.**
  An idea that fragments into a cluster of decisions is an **initiative** → recommend `/plan` (which decomposes it into tracks and handles its roadmap node — `/ideate` does not).

Each ADR is a complete decision record — Problem, Goals, Non-Goals, Decision,
Rationale, Consequences — with the alternatives you challenged in step 3 captured in its Rationale and Non-Goals.
It stays `Proposed`: `/ideate` never settles a decision, and the implementation session is what eventually flips it `Accepted`.
Stop at the decision; do **not** drift into technical design or contracts.

## The artifact

Proposed ADR(s) in the ADR directory (default `/docs/ADRs/`) — **the only durable output**.
`/ideate` writes **no scratch folder** (the conversation is the ideation; the challenged alternatives distil into the ADR) and **does not touch the roadmap** (it shapes *what* the idea is; the roadmap decides *when*, downstream).
Update the glossary if shaping the idea introduced a genuinely new term.

## Gate

Stop and present the Proposed ADR(s) — or the reasoned recommendation to **not**
build, with no ADR.
**Open no plan, design no track, write no code.**
Wait for the user to accept the shaping, then **recommend the next step** and why:

- **Self-contained feature** (one ADR) → `/design`.
- **Initiative** (an ADR cluster) → `/plan`; note if it wants a `/roadmap` banding pass first to place it among the other initiatives.

The recommended session starts fresh and reads the ADR cold — that is the boundary.
