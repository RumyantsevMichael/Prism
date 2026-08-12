---
name: implement
description: "Implement a track from its validated handoff in a fresh context. Use for tests-first implementation, verification, and security review."
argument-hint: '[initiative/track]'
---

# Implement a feature

This is **implementation**: a single **fresh** context that reads the validated specification and builds the feature.
Run it in a new context because independence from design prevents design assumptions from leaking into implementation.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

**One workflow skill per context** (the rule and its rationale live in the `workflow` overview skill).
If `plan` or `design` already ran in this context, stop and have the user run `implement` in a fresh one.
The cold read is an independent comprehension check.

This session has a machine-verifiable end state: acceptance tests green, typecheck and lint clean.

Start by reading the track handoff under `docs/plans/<initiative>/<track>/` and the authoritative inputs it names.
On any conflict between them, stop and report.
Do not resolve it silently.

## 1. Read the spec cold

The spec arrives **pre-validated**: the design session looped `validate-artifacts` until a run reported no gaps, so do not repeat that pass here.
Your job is to internalize it.
Read the handoff, Approved requirements, ADRs, contracts, build plan, and feature files in the order the handoff states.
You must hold the whole spec to build it.
If you still hit a real spec gap, while reading or mid-build, **report it and stop** rather than resolving it silently.
Route a missing or wrong product obligation to `write-requirements` for user approval.
Route a design gap or wrong architectural invariant to the design session.
Resume only after the user relays the corrected durable artifact.
(`// OPEN:` seams are the exception: those are decisions design deliberately delegated to you, so resolve them in step 3.)

The handoff records the track's **security surface** (secrets, network, privilege/isolation, untrusted input, IPC, or `none`), determined by design's validation loop.
Carry it forward: it gates the post-code security audit in step 5 below.
If the handoff does not state it, determine it yourself from the spec and record it explicitly, even when it is `none`.

## 2. Tests first

Write the acceptance and integration tests from the feature files and contracts.
Confirm that their requirement links cover every active requirement in this track.
They start red.
Do this **yourself by default**: the tests are your red bar and a second check on the feature files (an example you cannot transcribe into a clean test was under-specified, so feed that back).
Load `write-step-definitions` for acceptance steps when that sibling skill is available.
The project BDD harness is named in workflow config.
Only when there are many feature files, fan out per file to child agents and pass each the file references.
For a **bug**, write a failing reproduction test first.

## 3. Implement to green

Build in the build plan's order.
Confirm your resolutions to the contracts' `// OPEN:` seams with the user **before** coding them.
Then **record each resolution in the owning contract**: replace the `// OPEN:` marker with the decision and a one-line rationale, in the same change as the code.
A resolution that lives only in the conversation is lost to every later session.
Report the recorded resolutions again at the Gate.
Use child agents for parallel independent work only when the host provides isolated workspaces.
Give each the artifact paths and a scoped task, not inlined contents.
Keep the user guide (default `docs/user-guide/`) and operator runbooks current in the same change.
Implement everything end to end with no pauses unless blocked.

## 4. Verify

Acceptance tests are the automated check.
Add **live verification** (run the system, observe) for behavior tests cannot capture: a long-running process, a UI, or an external service call.
Workflow-config's Verification section says how to exercise this project.

For a track whose feature file describes **cross-process / cross-surface behavior**, live verification of the user-facing path is a **hard gate, not a suggestion**: acceptance tests drive in-process seams, so a fully-green suite can coexist with the integration between processes being **entirely absent**.
Green does not by itself mean the feature runs.
Demonstrate the user-facing path running end to end.
If you *cannot* (no live environment here, or a genuine external gate), say so plainly and carry the track as **not landable yet**, per the deferral classification at the Gate.

End the session by **suggesting an end-to-end scenario**, at minimum one, even when you ran live verification yourself.
Guide the user through this testing scenario: it is the user-facing path through the feature in the running system.
Give the exact commands or the precise UI click-path, with the observation that proves each works.
Run the verification procedure from workflow config yourself where possible.
Hand the user the parts you cannot drive (a real service, a UI, external calls).
This is the human-confirmable proof the feature works beyond green tests.

## 5. Security-audit the diff

When the security surface carried from step 1 is **non-empty**, audit the implementation before the landing gate.
Green tests prove behavior, not safety.
Use the project's security-review instructions against the branch diff when they exist.
Otherwise, inspect the diff directly for secrets in logs, unvalidated inputs, missing authorization, excessive privilege, unsafe network access, and unsafe IPC.
This is the code-time counterpart to the design loop's paper pass, catching the bug classes that only exist once written: a secret in a log line, an unvalidated input reaching a sink, a privilege not dropped, or a missing authorization check.
Findings are **your own code, so fix them inline and re-run** until clean.
The one exception: a finding that traces to a *design* flaw (an invariant the spec never required) feeds back to design like a validation gap rather than being patched locally.
A track whose surface was `none` skips this, but **say so explicitly**, and do not drop it silently.

## Gate

**First, classify what is not done.** Every not-done item is either **gated** or **unfinished**.
**Gated** means blocked on a *named external* gate (hardware, code-signing, a third party), and it is the residual the initiative already accepts.
**Unfinished** means buildable now, just not built.
*Gated* work may land: it is the honest residual a track ships with.
*Unfinished* work may **not** land because each requirement and ADR invariant must be exercised, not only unit-green.
"Ran out of context" and "the cross-process wiring isn't connected" are **unfinished**, never *gated*.
Do not relabel one as the other to reach the gate.
If unfinished work remains, **the track is not done**: report it and re-scope it into a follow-up track.
Do **not** propose the landing commit or the initiative's graduation.
(A clean way to tell them apart: could a competent engineer finish it on a dev machine today?
Then it is unfinished, and it blocks.)

The user's confirmation of correctness completes the session.
Ask for it, and put any residual-acceptance or re-scoping fork to the user, per **"How to deliver the question"** in the `workflow` overview skill.
**On that confirmation, accept the implemented ADRs**: flip each from `Status: Proposed` to `Status: Accepted` immediately, as a file edit.
Do not defer the flip to a commit, because a lifecycle transition that waits on an optional act drifts.
The implementation task owns this transition because acceptance means the decision survived implementation and verification.
Do not change Approved requirement status because the status records product approval, not delivery.
Do not propose a commit on your own, because committing is user-initiated.
When the user asks for one, prepare the message per the workflow Git conventions and applicable project commit instructions.

That same landing commit **MAY delete this track's prep bundle** (the track's plan folder) if the user accepts this.

Two more steps when the track belongs to an initiative:

1. **Update the track's status.** Set `Status` in the track's `<track>.md` to `done` and flip that track's stereotype in `tracks.puml`.
   The plan is the live status board.
   (Design already flipped this track to `in-progress` at its start, and this is the `→ done` transition.
   If implementation stalls on a dependency, set `blocked` with a reason rather than leaving a stale `in-progress`.)

2. **Last track? Graduate, then delete the initiative.** If this is the final track, run the graduate-before-delete gate.
   Confirm two things.
   (a) Every cross-cutting concern and open question has graduated to a requirement, ADR, feature file, user guide, or tracker issue.
   An explicitly killed item also satisfies this check.
   (b) The initiative's product obligations remain linked from its Approved requirements.
   Its architectural through-line has a durable home in an ADR or architecture overview document.
   Graduate it there, **never** as a frozen initiative-summary copy of the scratch plan.
   **Then** delete the whole initiative's plan folder in the same commit.
   Nothing scratch survives by being merely "noted".
   A standalone feature just deletes its own bundle, and flips its own roadmap node `→ shipped` (Mode B) in the same commit.
   The anti-rot rule applies to it unchanged.
   **Keep the roadmap's state column honest.**
   On the **last** track, flip the roadmap node (default `docs/roadmap.md`) `→ shipped` and remove its plan link.
   And **a plan folder may not be deleted until its node is `shipped`**.
   One-line edit, per the roadmap's Mode B. (The `planned → in-progress` flip is owned by the first track's design session, not here.)
   **anti-rot**: a plan folder MUST NOT be deleted until its roadmap node is `shipped`, so the roadmap's state column cannot drift from reality.
