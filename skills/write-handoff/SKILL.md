---
name: write-handoff
description: "Prepare a validated track for its implementation controller."
argument-hint: '[initiative/track]'
---

# Write handoff

The handoff is the **prompt that starts the implementation controller**.
It hands a validated specification and task graph to a fresh controller with no design conversation history.
It must identify the authoritative artifacts, locked constraints, and starting procedure.
One of three prep-bundle artifacts under the plans directory (default `docs/plans/<initiative>/<track>/`).

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

Keep it **short**: it points at the requirements, ADRs, contracts, build plan, initiative spine, and feature files.
It does not restate them.
Its job is precedence, scope, and the non-negotiables, not a re-derivation of the design.

The handoff is written at the **end of the design task**, before the user-acceptance gate.
The focused validation waves already checked these artifacts in isolated contexts.
The fresh implementation controller reads them cold and reports any remaining gap.

---

## Where it lives

`<plans-dir>/<initiative>/<track>/handoff.md`, alongside `build-plan.md` and the contracts file.

---

## Structure

```markdown
# <Feature> - implementation handoff

<One line: use this to start the fresh implementation context.>

## Authoritative inputs

Requirements own product obligations, and ADRs own architectural decisions.
Stop and report any conflict between them.
Read the remaining inputs in this order:
1. `<requirements-dir>/<...>.md` - Approved product obligations
2. `<adr-dir>/<...>` - architectural decisions and invariants
3. `<plans-dir>/<initiative>/<track>/contracts.<ext>` - the shapes
4. `<plans-dir>/<initiative>/<track>/build-plan.md` - task graph and reuse map
5. `<features-dir>/<...>.feature` - executable behavior
6. `<plans-dir>/<initiative>/plan.md` + `<track>.md` - the track's place in the initiative, as scratch orientation only
7. The project glossary - vocabulary

## Scope

What is in, and explicitly what is out (deferred / reserved seams).

## Locked design constraints

The immutable facts the controller and workers must not re-derive - each a single bullet,
each citing its ADR. These prevent design drift mid-implementation.

## Process

- Follow the project's code-style rules and conventions - these may auto-load for
  the file types being edited, so check whether they already apply before going
  looking for them.
- Reuse / mirror existing patterns named in the build plan - do not reinvent.
- The spec arrives pre-validated by the design session's focused validation waves.
  Do not repeat that pass.
  Report any remaining gap and wait for clarification.
  Do not self-resolve a gap or continue past it.
- Create or resume `execution-ledger.md` beside this handoff.
- Compute task frontiers from the build plan and dispatch fresh workers.
- Use isolated workspaces for safe parallel tasks and sequential execution otherwise.
- Tests first inside each task, then implement to green.
- Cite requirements for obligations and ADRs for decisions.
- Never cite plan tracks in durable artifacts.
- Do not resolve a requirements, ADR, or feature conflict yourself.
- Stop and report the conflict.
- Do not commit, push, or propose a commit on your own.
  When the user asks, prepare the message per the Git conventions in the `workflow` overview skill.
  The user's confirmation of correctness flips the ADR(s) to Accepted (a file
  edit, not a commit). The landing commit - with the user's approval - deletes
  the prep bundle.

## Suggested order

1. Read the inputs cold.
2. Report any specification gap.
3. Create or resume the execution ledger.
4. Compute the eligible task frontier.
5. Run and review each task.
6. Run the whole-track review and verification.

## Critical flow

Link `[Critical flow](critical-flow.puml)` only when call order across a plug point affects correctness.
The PlantUML sequence diagram owns the shown call order.
The prose still owns scope, constraints, and the reason for the flow.
Omit this section when contracts and the build plan already make the interaction clear.

## Security surface

<the surface design's validation waves determined: secrets, network,
privilege/isolation, untrusted input, IPC, or `none` - this gates the
controller's final security audit>

## Controller execution profile

- Complexity: standard | high
- Context: fresh
- Parallelism: sequential | independent
- Focus: <specific risk areas>

Explain why this profile fits and where implementation must slow down.
State which task frontiers can run concurrently and which shared surfaces force sequential work.
```

---

## Conventions

- **State input precedence and the conflict rule up front.** This is the single most important thing the handoff does, and it prevents drift.
- **Locked constraints are restated facts.** Link each product obligation to a requirement and each design constraint to an ADR.
- **Recommend a controller execution profile.**
  The handoff is a context boundary, so record the complexity, isolation, parallelism, and focus here.
- **The spec ships pre-validated.** Design completed its focused validation waves and reached a clean final verification.
  A gap the implementer still hits goes back to design, never self-resolved.
- **State the security surface.** The focused validation waves determine it, and the controller uses it in the final review.
- **Do not add task gates.** The controller resolves local `// OPEN:` choices within locked constraints and records them in the owning contract.
- **Show a critical plug-point flow when needed.** Use a linked PlantUML sequence diagram without a duplicate prose call list.
- **Keep it compact.** Point, do not restate.
  If you are copying design rationale in, it belongs in the ADR.

---

## Quality checks before finishing

- A fresh context with zero design history could start from this alone.
- Inputs are listed in precedence order with the conflict rule stated.
- Every locked product obligation links to a requirement.
- Every locked design constraint cites an ADR.
- No locked constraint references a plan track.
- A justified controller execution profile is present.
- The handoff starts one controller for the complete task graph.
- The handoff names the execution ledger and its recovery purpose.
- It points at the artifacts rather than restating them.
- A critical plug-point flow has a linked sequence diagram when call order affects correctness.
- No rendered diagram image is present.
