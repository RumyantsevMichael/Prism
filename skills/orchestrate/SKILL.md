---
name: orchestrate
description: "Run or resume an initiative: design one contract per scope, gate it, start each planned slice, implement and verify it in a fresh session, review it only when marked, and keep the user's gates. Use when the user asks, or agrees when offered, to run or resume an initiative, issue, or idea through Prism, or when a coordinating agent asks."
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

The orchestrator coordinates; it judges order, contract defects, and gates, and leaves the work to child sessions.
Design, implementation, review, and example writer sessions get identifiers and folders from it and return a short status.
Prism records progress from `update_initiative` calls and from the `verify_slice` calls of implementers, so the orchestrator makes no other bookkeeping calls.
The [workflow](../workflow/SKILL.md) defines the terms.
To run a skill in a child, start a fresh child agent whose prompt asks it to use that skill and passes the identifiers and folders below, and when no child agent can start, stop and ask the user to run the orchestration where child agents are available.

- Don't
  - Load or follow `setup`, `design`, `implement`, `review`, `triage`, or `ideate` yourself; only their child agents do.
  - Run git, hash files, or read code while slices run; children commit their own work and Prism checks the frozen tests.
  - Keep a child's transcript; keep its status.

## 1. Settings

Settings live in the initiative's coordination state, read with `get_coordination_state` and written once before active work with `update_coordination_state` and the current revision.
A stored value stays authoritative on resume.
When a Prism result carries a [person change notice](../workflow/SKILL.md#common-terms) or `keptSettings`, or a gate wait returns `changed`, apply each change at the effect point its action names before the next step, and name its author when you report it to the user.

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `autonomy` | `conservative`, `broad`, `full` | `conservative` | Which gates wait for the user. |
| `commit` | `on`, `off` | `on` under `full`, otherwise `off` | Whether design and implementation commit their changes. |
| `push` | `on`, `off` | `off` | Whether finished slices are pushed; autonomy never turns it on. |
| `continuation` | `auto`, `stepwise` | `auto` | Whether the next slice starts without the user. |
| `review` | `marked`, `recommended`, `all` | `marked` | Which slices get an implementation review: those the user marks at the design gate, also those design recommends, or every slice. |
| `models` | `host defaults` or `{delivery, review, securityReview, examples}` | `host defaults` | Models for child agents; `examples` is optional and defaults to the host's smallest model. |

- `conservative` waits for the user at every design gate and decision.
- `broad` accepts a design automatically unless it changes requirements, adds an ADR, or reports an open question.
- `full` accepts every design and resolves internal decisions, but never invents external facts or turns on push.

## 2. Start

1. Read `.prism/workflow.md`, the settings, and the pending user gates, and act on every recorded answer; when `.prism/workflow.md` is missing, or a Prism tool or child reports a setting or record that `setup` owns, run `setup` in a fresh child agent while no slice is `in-progress`, asking its blockers as gates.
2. When the initiative has no Approved requirements or no roadmap entry, run `triage` in a fresh child agent for a reported defect, and `ideate` for new intent or when triage returns `NOT_A_DEFECT`.
3. Read the initiative record with `get_initiative`.
4. When the record does not exist, call `update_initiative` with `expectedRevision: null` and a `create` operation for the root slice with its slug, title, outcome, and every Approved requirement of the initiative.

## 3. Design each scope

A scope is the root slice, or a part that a split design created; design it when its dependencies are done.

1. Call `update_initiative` with a `claim` operation for the scope, so no other agent starts it, and when Prism refuses the claim with `slice_claimed`, leave the scope to the holder it names and continue with another eligible scope or slice.
2. Run `design` for the scope in a fresh child agent, passing its slug, its folder, and any reproduction that triage returned.
3. When design returns `PROPOSED`, read the proposal with `get_initiative`.
4. When autonomy requires the design gate, or the proposal splits the scope with `user_gate` evidence, ask the gate with the scope's `slice.md`, its diagrams, and the frozen tests as artifacts, offering to mark slices for review; for a fit design, first write the design view through the [example writer](references/example-writer.md) in a fresh child agent with the `examples` model.
5. When the user asks for changes, return the note to design and repeat from step 3.
6. Call `update_initiative` with one `accept_proposal` operation for the scope, the slugs whose review mark is `required`, and, for `user_gate` evidence, the gate where the person approved the split; Prism adds the review marks that the `review` setting gives.
7. When acceptance is refused, return the refusal to design.

## 4. Run each slice

Repeat for the next leaf that is `not-started`, has an accepted design, and whose effective dependencies are done.

1. Read the slice's state with `get_initiative`.
2. Call `update_initiative` with `set_status` `in-progress`, which puts its frozen tests in place.
3. Run `implement` for the slice in one fresh child agent, passing the contract's `slice.md` and the slice folder; it verifies the slice through `verify_slice` itself.
4. When it returns `DONE`, read the slice with `get_initiative`: when its review mark is `required`, review it through [review](#5-review), then call `update_initiative` with `set_status` `done`; when it is not done otherwise, call `set_status` `done`, which refuses without a fresh passing run.
5. When the slice was the last leaf of its contract scope that was not done, call `verify_slice` with the scope as `slice` and `dependents` `true` for its dependents' run; call it again after `running`, after `approval_needed` get the user's answer as for an implementer's approval gate below and call it again with `approvalGate` and any `chatApproval`, and report a `failed` or `approval_unclear` scope to the user as blocked, with each `blocked` component.
6. Push when push is on, and in a project without a store, accept the slice's Proposed ADRs.
7. When continuation is `stepwise`, pause and report the finished slice.

- When the slice is `blocked` with contract defects, or its dependencies changed:
  1. Call `update_initiative` with `restore_tests` for the scope.
  2. Return the defects to design with the scope.
  3. Accept design's revised proposal, then start the slice again with a fresh implementation session.
- When the implementer returns `BLOCKED` on an approval gate that needs the user's chat approval, ask the user in chat whether Prism may run the exact command, then run a fresh implementation session with the gate id and their answer quoted word for word; on any other approval gate, wait for it as in [user gates](#6-user-gates), then run a fresh implementation session.
- When triage, design, or implementation returns `BLOCKED` or a question, ask the user with its blocker as the gate, never shortening it, and continue with another eligible slice meanwhile.

On resume, continue an `in-progress` slice with a fresh implementation session before starting another slice.

## 5. Review

1. Call `update_review` as the coordinator with a `start_wave` operation in `implementation-review` mode, one lane per review focus, a fresh reviewer identifier per lane, as `base`, the last commit that a child reported before the slice started, when one did, and, on the first wave, the implementer's worker id as `delivery`.
2. Run `review` for each lane in a fresh child agent, and use a security-focused lane with the `securityReview` model for trust-boundary changes.
3. When a finding names a contract clause, call `verify_slice` with `contractDefects` for those clauses and handle the slice as blocked with contract defects, unless the code only missed a sound clause, in which case clear the clause with `revise_finding` and that reason.
4. Otherwise, when a lane returns `FINDINGS`, run a fresh `implement` session with the findings of every wave so far, asking whether they share a cause in the contract, and once it returns `DONE`, set each finding it fixed `FIXED` with its summary through `update_review` as the review's `delivery` worker, then start a new wave with fresh reviewers.
5. When `start_wave` refuses a further wave, ask a `decision` gate whether to continue the review, return the slice to design, or narrow it, and pass the answered gate's id as `afterGate`.
6. When every lane is `CLEAN`, call `update_review` with `accept_wave`.

## 6. User gates

- Record every question to the user before asking it, through `update_coordination_state` with a `gateOperations` `ask` operation that names the kind, slice, question, its context, artifacts, and for a decision its options with consequences and the recommended answer, written as a [blocker](../workflow/SKILL.md#common-terms).
- Use `visual-review` for design gates, `correctness` to confirm a ship, `decision` for choices, and `assistance` for actions the user must take.
- After asking, call `wait_for_user_gate` once with the ids just recorded, and when it returns without an answer, end the turn.
- Treat an answer recorded in the review browser as the user's answer, never ask an answered gate again, and `resolve` each gate after acting on it or as soon as it no longer applies, such as when its artifacts are gone, with a reason unless the browser recorded the answer.

## 7. Finish or pause

- When every leaf is done:
  1. Run the dependents' run of each contract scope that has no `passed` entry in `get_initiative`'s `dependents`.
  2. In a project with a store, ask a [correctness gate](../workflow/SKILL.md#common-terms) once the last verification run passed and the initiative's `slice.md` files and the ADRs they link no longer change, with those files as artifacts, tell the person that only an answer in the review browser confirms a ship, wait for it, and act on a request for changes before asking again.
  3. Call `update_roadmap` with a `ship` operation for the initiative, with that gate as `afterGate` in a project with a store; when it refuses with `dependents_blocked`, run the dependents' run again of each listed scope whose `reason` is `not_run` and call `ship` again, then report each scope whose `reason` is `failed` or whose new run did not pass to the user with its `blocked` components and stop until a later dependents' run passes.
  4. When `ship` refuses with `ship_unconfirmed`, ask a new correctness gate; with `adr_pending`, wait for the approvals it names through `wait_for_user_gate` with `artifact` and ship again; and with `adr_ambiguous` or `artifact_too_large`, ask the person with its message as a [blocker](../workflow/SKILL.md#common-terms).
  5. Move facts that later work needs from the initiative's slice folders into requirements, ADRs, or user documentation.
  6. Keep the slice folders and the initiative's records, because they are the initiative's history.
- When work must pause, call `checkpoint_pause` with the initiative, the current revision, the active slice, recovery content that names the next action, and the state changes.
