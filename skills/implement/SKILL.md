---
name: implement
description: Drive a feature's implementation session — validate the spec, write tests first, implement to green, verify, security-audit the diff. Invoke in a fresh session to build a track from its handoff in the plans directory.
argument-hint: '[initiative/track]'
---

# Implement a feature

This is **implementation**: a single **fresh** session that validates the spec, then builds the feature.
Run it in a new session — its independence from the design session is exactly what makes it a fair validator.
The `workflow` overview skill places this session in the flow; this is the operational playbook.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists — it overrides the default paths and stack assumptions below.
If absent, use the defaults and the project's own CLAUDE.md conventions.
The session map and lifecycle rules live in the `workflow` overview skill.

**One workflow skill per session** (the rule and its rationale live in the `workflow` overview skill).
The nuance here: if `/plan` or `/design` already ran in this session, stop and have the user run `/implement` in a fresh one — the cold read *is* the validation pass.

This session has a machine-verifiable end state — acceptance tests green, typecheck and lint clean.

Start by reading the track's `handoff.md` in the plans directory (default `/docs/plans/<initiative>/<track>/`) and the authoritative inputs it names (ADR, contracts, build plan, feature files), in the precedence it states.
On any conflict between them, stop and report — do not resolve it silently.

## 1. Validate before any code

Load `validate-artifacts`.
Do this **inline, yourself** — you must internalise the spec to build it, and as a fresh session your cold read already is the independent perspective.
Read it adversarially: try to implement each contract, try to break each invariant, hunt under-specification.
**Report the gaps and stop — do not resolve them yourself or recommend how to proceed.** Clarifying an under-specified spec or a wrong invariant is the design session's responsibility, not yours: it updates the ADR/contracts/feature files **while its context is still warm**, and you resume only when the user relays that clarification back.
(`// OPEN:` seams are the exception — those are decisions design deliberately delegated to you; resolve them in step 3.
On a large or high-stakes spec you MAY spawn extra validator subagents for adversarial breadth — passing them the artifact paths, not the contents.)
When the spec holds, say so and proceed to tests.

This pass includes a **threat-model lens** (`validate-artifacts` step 5): read the spec as an attacker and state the track's **security surface** (secrets, network, privilege/isolation, untrusted input, IPC — or `none`).
A security hole in the spec feeds back to design like any other gap; the surface you name here gates the post-code security audit in step 5 below, so record it explicitly even when it is `none`.

## 2. Tests first

Write the acceptance and integration tests from the feature files + contracts — red.
Do this **yourself by default**: the tests are your red bar and a second check on the feature files (an example you cannot transcribe into a clean test was under-specified — feed that back).
Load `write-step-definitions` for acceptance steps (the project's BDD harness is named in workflow-config).
Only when there are many feature files, fan out per file to subagents, passing each the file references.
For a **bug**, write a failing reproduction test first.

## 3. Implement to green

Build in the build plan's order.
Confirm your resolutions to the contracts' `// OPEN:` seams with the user **before** coding them.
Use subagents for parallel, independent work — give each the artifact paths and a scoped task, not inlined contents.
Keep the user guide (default `/docs/user-guide/`) and operator runbooks current in the same change.
Implement everything end to end with no pauses unless blocked.

## 4. Verify

Acceptance tests are the automated check; add **live verification** (run the system, observe) for behavior tests cannot capture — a long-running process, a UI, an external service call.
Workflow-config's Verification section says how to exercise this project.

For a track whose feature file describes **cross-process / cross-surface behavior**, live verification of the user-facing path is a **hard gate, not a suggestion**: acceptance tests drive in-process seams, so a fully-green suite can coexist with the integration between processes being **entirely absent** — green does not by itself mean the feature runs.
Demonstrate the user-facing path running end to end.
If you *cannot* (no live environment here, or a genuine external gate), say so plainly and carry the track as **not landable yet** — see the deferral classification at the Gate.

End the session by **suggesting an end-to-end scenario** — at minimum one, even when you ran live verification yourself.
Guide the user through this testing scenario — it is the user-facing path through the feature in the running system: (exact commands or the precise UI click-path) with the observation that proves each works.
Run it yourself where you can (load `verify`); hand the user the parts you cannot drive (a real service, a UI, external calls).
This is the human-confirmable proof the feature works beyond green tests.

## 5. Security-audit the diff

When step 1's threat-model lens found a **non-empty security surface**, audit the implementation before the landing gate — green tests prove behavior, not safety.
Load `security-review` against the branch diff (the actual code, not the spec — this is the code-time counterpart to step 1's paper pass, catching the bug classes that only exist once written: a secret in a log line, an unvalidated input reaching a sink, a privilege not dropped, a missing authorization check).
Findings are **your own code — fix them inline and re-run** until clean; that is not design drift.
The one exception: a finding that traces to a *design* flaw (an invariant the spec never required) feeds back to design like a validation gap rather than being patched locally.
A track whose surface was `none` skips this — but **say so explicitly**, don't drop it silently.

## Gate

**First, classify what is not done.** Every not-done item is either **gated** — blocked on a *named external* gate (hardware, code-signing, a third party) and the residual the initiative already accepts — or **unfinished** — buildable now, just not built.
*Gated* work may land; it is the honest residual a track ships with.
*Unfinished* work may **not**: it blocks the landing commit, because accepting an ADR means its core invariant was *exercised* (run), not merely unit-green.
"Ran out of context" and "the cross-process wiring isn't connected" are **unfinished**, never *gated* — do not relabel one as the other to reach the gate.
If unfinished work remains, **the track is not done**: report it and re-scope it into a follow-up track; do **not** propose the landing commit or the initiative's graduation.
(A clean way to tell them apart: could a competent engineer finish it on a dev machine today?
Then it's unfinished, and it blocks.)

The user's confirmation of correctness completes the session.
Ask for it — and put any residual-acceptance or re-scoping fork to the user — per **"How to deliver the question"** in the `workflow` overview skill.
Do not propose a commit on your own — committing is user-initiated.
When the user asks for one, prepare the message per the Git conventions in the `workflow` overview skill (or the project's own commit skill); that landing commit must also **accept the implemented ADRs** (flip each from `Status: Proposed` to `Status: Accepted` — the implementation session owns this transition, because acceptance means the decision survived being built and validated; see the ADR status lifecycle in the `workflow` overview skill).

That same landing commit **MAY delete this track's prep bundle** (the track's plan folder) if the user accepts this.

Two more steps when the track belongs to an initiative:

1. **Update the track's status.** Set `Status` in the track's `<track>.md` to `done` and flip that track's node class in the spine's Mermaid DAG (`plan.md`).
   The plan is the live status board.
   (Design already flipped this track to `in-progress` at its start; this is the `→ done` transition.
   If implementation stalls on a dependency, set `blocked` with a reason rather than leaving a stale `in-progress`.)

2. **Last track?
   Graduate, then delete the initiative.** If this is the final track, run the graduate-before-delete gate: confirm (a) every cross-cutting concern and open question in the spine has graduated to a durable home (ADR / feature file / user guide) or been explicitly killed, **and** (b) the initiative's architectural through-line — why this cluster of ADRs coheres — has a durable home (a lead/umbrella ADR or an architecture overview doc); graduate it there, **never** as a frozen initiative-summary copy of the scratch plan.
   **Then** delete the whole initiative's plan folder in the same commit.
   Nothing scratch survives by being merely "noted".
   A standalone feature just deletes its own bundle — and flips its own roadmap node `→ shipped` (Mode B) in the same commit; the anti-rot rule applies to it unchanged.
   **Keep the roadmap's state column honest.** On the **last** track, flip the initiative's roadmap node (default `/docs/roadmap.md`) `→ shipped` and remove its plan deep-link — and **a plan folder may not be deleted until its node is `shipped`**.
   One-line edit, per the roadmap's Mode B. (The `planned → in-progress` flip is owned by the first track's design session, not here.)
   **anti-rot** — a plan folder MUST NOT be deleted until its roadmap node is `shipped`, so the roadmap's state column cannot drift from reality.

