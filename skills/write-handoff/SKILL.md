---
name: write-handoff
description: Author a track's implementation handoff in the plans directory — authoritative inputs, locked constraints, model/effort. Use when wrapping up a design session.
argument-hint: '[initiative/track]'
---

# Write handoff

The handoff is the **prompt that starts implementation**. It hands a validated spec to a
fresh implementation session that has none of the design session's context, so
it must be self-contained: point at the authoritative artifacts, fix what must not
drift, and say how to begin. One of three prep-bundle artifacts under the plans
directory (default `/docs/plans/<initiative>/<track>/`).

Project settings for this workflow live in `.claude/workflow-config.md` at the
project root (created by the `workflow-init` skill). Read it first if it exists;
it overrides the default paths below.

Keep it **short** — it points at the ADR, contracts, build plan, the initiative
spine, and feature files; it does not restate them. Its job is precedence, scope, and the non-negotiables, not a
re-derivation of the design.

The handoff is written at the **end of the design session**, before the user-acceptance
gate. The fresh session's *first* act is to validate these same artifacts
(`validate-artifacts`) and feed gaps back — so the handoff should make that easy by
naming the inputs precisely.

---

## Where it lives

`<plans-dir>/<initiative>/<track>/handoff.md`, alongside `build-plan.md` and
the contracts file.

---

## Structure

```markdown
# <Feature> — implementation handoff

<One line: paste this to start the implementation session.>

## Authoritative inputs

In precedence order; on any conflict, the higher source wins and you stop and
report rather than resolving silently:
1. `<adr-dir>/<...>` — the decision and invariants
2. `<plans-dir>/<initiative>/<track>/contracts.<ext>` — the shapes
3. `<plans-dir>/<initiative>/<track>/build-plan.md` — build order and reuse map
4. `<features-dir>/<...>.feature` — behavior
5. `<plans-dir>/<initiative>/plan.md` + `<track>.md` — the track's place in the
   initiative (dependencies, release context); scratch, for orientation only
6. The project glossary — vocabulary

## Scope

What is in, and explicitly what is out (deferred / reserved seams).

## Locked design constraints

The immutable facts the implementer must not re-derive — each a single bullet,
each citing its ADR. These prevent design drift mid-implementation.

## Process

- Follow the project's code-style rules and conventions.
- Reuse / mirror existing patterns named in the build plan — do not reinvent.
- Validate the spec first; report any gaps to the design session and wait for it to
  clarify — do not self-resolve a gap or proceed past it.
- Tests first (acceptance + integration), then implement to green.
- Cite ADRs, never plan tracks, in durable artifacts.
- Do not resolve an ADR/feature conflict yourself — stop and report.
- Do not commit, push, or propose a commit on your own; only when the user asks,
  prepare the message per the Git conventions in the `workflow` overview skill. That landing commit accepts the ADR(s) and — with
  the user's approval — deletes the prep bundle.

## Suggested order

Read the inputs → validate them (`validate-artifacts`): report any gaps to the design
session and wait for clarification, do not self-resolve → then propose your build
sequence and your `// OPEN:` resolutions, confirm with the user → implement in the
build plan's order.

## Model & effort

The recommended model and effort level for implementation, and why; where to slow
down. (Chosen here because this is a context boundary — see the `workflow`
overview skill.)
```

---

## Conventions

- **State input precedence and the conflict rule up front** — this is the single
  most important thing the handoff does; it prevents drift.
- **Locked constraints are restated facts, each ADR-cited** — the implementer
  should not have to re-derive a settled decision, nor go looking for why.
- **Recommend model + effort** — the handoff is a context boundary, so this is
  where that recommendation belongs (not at the start of the design session).
- **Validation gaps go back to design** — the implementer's first act is to validate
  the spec; gaps are reported to the design session for clarification, never
  self-resolved.
- **Include a collaborative gate** — have the implementer propose the build order
  and `// OPEN:` resolutions and confirm *before* coding.
- **Keep it compact.** Point, don't restate. If you are copying design rationale in,
  it belongs in the ADR.

---

## Quality checks before finishing

- A fresh session with zero prior context could start from this alone.
- Inputs are listed in precedence order with the conflict rule stated.
- Every locked constraint cites an ADR; none reference plan tracks.
- A justified model + effort recommendation is present.
- It points at the artifacts rather than restating them.
