---
name: orchestrate
description: "Run or resume an initiative: design one contract per scope, gate it, start each planned slice, implement it in a fresh session, verify it, review it only when marked, and keep the user's gates."
disable-model-invocation: true
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

The orchestrator coordinates; it judges order, contract defects, and gates, and leaves the work to child sessions.
Design, implementation, review, and example writer sessions get identifiers and folders from it and return a short status.
Prism records progress from the orchestrator's `update_initiative` and `verify_slice` calls, so the orchestrator makes no other bookkeeping calls.
The [workflow](../workflow/SKILL.md) defines the terms.

- Don't
  - Run git, hash files, or read code while slices run; children commit their own work and Prism checks the frozen tests.
  - Keep a child's transcript; keep its status.

## 1. Settings

Settings live in the initiative's coordination state, read with `get_coordination_state` and written once before active work with `update_coordination_state` and the current revision.
A stored value stays authoritative on resume, and `agentFlow` is fixed once work starts.

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `autonomy` | `conservative`, `broad`, `full` | `conservative` | Which gates wait for the user. |
| `agentFlow` | `multi`, `mono` | `multi` | `multi` runs every child in a fresh agent; `mono` runs design and implementation inline. |
| `commit` | `on`, `off` | `on` under `full`, otherwise `off` | Whether design and implementation commit their changes. |
| `push` | `on`, `off` | `off` | Whether finished slices are pushed; autonomy never turns it on. |
| `continuation` | `auto`, `stepwise` | `auto` | Whether the next slice starts without the user. |
| `review` | `marked`, `recommended`, `all` | `marked` | Which slices get an implementation review: those the user marks at the design gate, also those design recommends, or every slice. |
| `models` | `host defaults` or `{delivery, review, securityReview, examples}` | `host defaults` | Models for child agents; `examples` is optional and defaults to the host's smallest model. |

- `conservative` waits for the user at every design gate and decision.
- `broad` accepts a design automatically unless it changes requirements, adds an ADR, or reports an open question.
- `full` accepts every design and resolves internal decisions, but never invents external facts or turns on push.

## 2. Start

1. Read `.prism/workflow.md`, the settings, and the pending user gates, and act on every recorded answer.
2. When the initiative has no Approved requirements or no roadmap entry, run `ideate`.
3. Read the initiative record with `get_initiative`.
4. When the record does not exist, call `update_initiative` with `expectedRevision: null` and a `create` operation for the root slice with its slug, title, outcome, and every Approved requirement of the initiative.

## 3. Design each scope

A scope is the root slice, or a part that a split design created; design it when its dependencies are done.

1. Run `design` for the scope in a fresh child agent, passing its slug and folder.
2. When design returns `SPLIT`, check unique slugs and exact requirement coverage, ask the design gate when autonomy requires it, and call `update_initiative` with one `split` that carries design's evidence, citing for `user_gate` the gate where the person asked for the split, and the `set_dependencies` operations.
3. When design returns `FIT`:
   1. When autonomy requires the design gate, write the design view for the scope through the [example writer](references/example-writer.md) in a fresh child agent with the `examples` model, and ask the gate with the scope's `slice.md`, its diagrams, and the frozen tests as artifacts, offering to mark slices for review.
   2. When the user asks for changes, return the note to design and repeat this step.
   3. Call `update_initiative` once with a `split` of the scope into its planned slices, their `set_dependencies` operations, and an `accept_design` operation per slice with its frozen tests and its review mark.
   4. When the plan has one slice, call `accept_design` on the scope itself instead of a split.
4. When acceptance reports a diagram problem, a claimed test file, or `contract_too_large` with its measured files, return it to design.

A slice's review mark is `required` when the user marked it, when `review` is `recommended` and design recommended it, or when `review` is `all`; otherwise it is `none`.

## 4. Run each slice

Repeat for the next leaf that is `not-started`, has an accepted design, and whose effective dependencies are done.

1. Read the slice's state with `get_initiative`.
2. Call `update_initiative` with `set_status` `in-progress`, which puts its frozen tests in place.
3. Run `implement` for the slice in one fresh session, passing the contract's `slice.md` and the slice folder.
4. When it returns `DONE`, verify the slice through [verification](#5-verification).
5. When the slice's review mark is `required`, review it through [review](#6-review), then call `update_initiative` with `set_status` `done`.
6. Accept the slice's Proposed ADRs, and push when push is on.
7. When continuation is `stepwise`, pause and report the finished slice.

- When an implementer reports a contract defect or changed dependencies:
  1. Call `update_initiative` with `restore_tests` for the scope.
  2. Return the defect to design with the scope.
  3. Accept the revised design of every unfinished slice of the scope again before more implementation.
- When design or implementation returns `BLOCKED` or a question, ask the user the exact question and continue with another eligible slice meanwhile.

On resume, continue an `in-progress` slice with a fresh implementation session before starting another slice.

## 5. Verification

1. Call `verify_slice` with the initiative and slice.
2. When it returns `approval_needed`, call `wait_for_user_gate` with its gate id, then call `verify_slice` again with `approvalGate` set to that id.
3. When it returns `running`, call it again with the same arguments.
4. When it returns `declined`, stop and ask the user for the test command to use.
5. When it fails, run a fresh `implement` session with its failing test names and log path, and verify again.
6. After three failed attempts, call `update_initiative` with `set_status` `blocked` and ask the user with the failing test names and the log path.

A passing run of a slice whose review mark is `none` marks it done and returns the `initiativeRevision` to use for the next `update_initiative` call; when its result says the slice is unchanged, call `update_initiative` with `set_status` `done`.
A run that reports changed frozen tests goes back to an implementer to restore them.

## 6. Review

1. Call `update_review` as the coordinator with a `start_wave` operation in `implementation-review` mode, one lane per review focus, a fresh reviewer identifier per lane, and, as `base`, the last commit that a child reported before the slice started, when one did.
2. Run `review` for each lane in a fresh child agent, and use a security-focused lane with the `securityReview` model for trust-boundary changes.
3. When a lane returns `FINDINGS`, run a fresh `implement` session with the findings, verify again, and start a new wave with fresh reviewers.
4. When every lane is `CLEAN`, call `update_review` with `accept_wave`.

## 7. User gates

- Record every question to the user before asking it, through `update_coordination_state` with a `gateOperations` `ask` operation that names the kind, slice, question, artifacts, and options for a decision.
- Use `visual-review` for design gates, `decision` for choices, and `assistance` for actions the user must take.
- After asking, call `wait_for_user_gate` once with the ids just recorded, and when it returns without an answer, end the turn.
- Treat an answer recorded in the review browser as the user's answer, never ask an answered gate again, and `resolve` each gate after acting on it.

## 8. Finish or pause

- When every leaf is done:
  1. Call `update_roadmap` with a `ship` operation for the initiative.
  2. Move facts that later work needs from the initiative's slice folders into requirements, ADRs, or user documentation.
  3. When the slice folders hold uncommitted files, ask a `decision` gate before deleting them.
  4. Delete the slice folders and call `update_initiative` with a single `remove_records` operation.
- When work must pause, call `checkpoint_pause` with the initiative, the current revision, the active slice, recovery content that names the next action, and the state changes.
