---
name: orchestrate
description: "Run or resume an initiative: design each slice when it is next, gate the design, implement it in fresh sessions, verify it, review it when its design asks, and record progress."
disable-model-invocation: true
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

The orchestrator is the only agent that writes Prism records for the initiative, apart from the design view that the example writer writes.
Design, implementation, review, and example writer sessions get files and identifiers from it and return a status.
The [workflow](../workflow/SKILL.md) defines the terms.

## 1. Settings

Settings live in the initiative's coordination state, read with `get_coordination_state` and written once before active work with `update_coordination_state` and the current revision.
A stored value stays authoritative on resume, and `agentFlow` is fixed once work starts.

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `autonomy` | `conservative`, `broad`, `full` | `conservative` | Which gates wait for the user. |
| `agentFlow` | `multi`, `mono` | `multi` | `multi` runs design, implementation, and review in fresh child agents; `mono` runs design and implementation inline. |
| `commit` | `on`, `off` | `on` under `full`, otherwise `off` | Whether design and implementation commit their changes. |
| `push` | `on`, `off` | `off` | Whether finished slices are pushed; autonomy never turns it on. |
| `continuation` | `auto`, `stepwise` | `auto` | Whether the next slice starts without the user. |
| `models` | `host defaults` or `{delivery, review, securityReview, examples}` | `host defaults` | Models for child agents; `examples` is optional and defaults to the host's smallest model. |

- `conservative` waits for the user at every design gate and decision.
- `broad` accepts a design automatically unless it changes requirements, adds an ADR, or reports an open question.
- `full` accepts every design and resolves internal decisions, but never invents external facts or turns on push.

## 2. Start

1. Read `.prism/workflow.md`, the settings, and the pending user gates, and act on every recorded answer.
2. When the initiative has no Approved requirements or no roadmap entry, run `ideate`.
3. Read the initiative record with `get_initiative`.
4. When the record does not exist, call `update_initiative` with `expectedRevision: null` and a `create` operation for the root slice with its slug, title, outcome, and every Approved requirement of the initiative.

## 3. Run each slice

Repeat for the next leaf that is `not-started` and whose effective dependencies are done, so that each slice is designed against the code its prerequisites produced.

1. Call `update_initiative` with `set_status` `in-progress`, and call `update_coordination_state` with an `activeOperations` `start` operation for the slice with the `design` activity, its workers, and the workspace.
2. Run `design` for the slice, passing its slice folder and the parent's `slice.md`.
3. When design returns `SPLIT`:
   1. Check unique child slugs and exact requirement coverage, and return any defect to design.
   2. Ask the design gate when autonomy requires it.
   3. Call `update_initiative` with one `split` operation and the `set_dependencies` operations, and release the active operation.
4. When design returns `FIT`:
   1. When autonomy requires the design gate, write the design view through the [example writer](references/example-writer.md), in a fresh child agent with the `examples` model under `multi` flow, and ask the gate with `slice.md` and the frozen tests as artifacts.
   2. When the user asks for changes, return the note to design and repeat this step.
   3. When commits are on, commit the design.
   4. Call `update_initiative` with `accept_design`, the frozen test paths, and the review mark that design recommended or the user's answer asks for.
5. Update the active operation to the `implementation` activity, then for each step of the design, or once when it lists none, run `implement` in a fresh session with the step number and set the operation's label to the step.
6. Verify the slice through [verification](#4-verification).
7. When the design's review mark is `required`, review the slice through [review](#5-review).
8. Call `update_initiative` with `set_status` `done`, `finish` the active operation, accept the slice's Proposed ADRs, and push when push is on.
9. When continuation is `stepwise`, pause and report the finished slice.

On resume, continue an `in-progress` slice at its first missing result: design when it has no accepted design, otherwise the step after the last committed one.
When an implementer or reviewer reports a contract defect, return it to design, and accept the revised design before more implementation.
When design or implementation returns `BLOCKED`, ask the user the exact question and continue with another eligible slice meanwhile.

## 4. Verification

1. Call `verify_slice` with the initiative and slice.
2. When it returns `approval_needed`, call `wait_for_user_gate` with its gate id, then call `verify_slice` again with `approvalGate` set to that id.
3. When it returns `running`, call it again with the same arguments.
4. When it returns `declined`, stop and ask the user for the test command to use.
5. When it fails, run a fresh `implement` session with the failure output, and verify again.
6. After three failed attempts, report the slice as blocked with the last output.

A frozen test changes only through a revised design, so a run that reports changed frozen tests goes back to an implementer to restore them.

## 5. Review

1. Call `update_review` as the coordinator with a `start_wave` operation in `implementation-review` mode, one lane per review focus, a fresh reviewer identifier per lane, and the commit that implementation started from as `base`.
2. Run `review` for each lane in a fresh child agent, and use a security-focused lane with the `securityReview` model for trust-boundary changes.
3. When a lane returns `FINDINGS`, run a fresh `implement` session with the findings, verify again, and start a new wave with fresh reviewers.
4. When every lane is `CLEAN`, call `update_review` with `accept_wave`.

## 6. User gates

- Record every question to the user before asking it, through `update_coordination_state` with a `gateOperations` `ask` operation that names the kind, slice, question, artifacts, and options for a decision.
- Use `visual-review` for design gates, `decision` for choices, and `assistance` for actions the user must take.
- After asking, call `wait_for_user_gate` once with the ids just recorded, and when it returns without an answer, end the turn.
- Treat an answer recorded in the review browser as the user's answer, never ask an answered gate again, and `resolve` each gate after acting on it.

## 7. Finish or pause

- When every leaf is done:
  1. Call `update_roadmap` with a `ship` operation for the initiative.
  2. Move facts that later work needs from the initiative's slice folders into requirements, ADRs, or user documentation.
  3. When the slice folders hold uncommitted files, ask a `decision` gate before deleting them.
  4. Delete the slice folders and call `update_initiative` with a single `remove_records` operation.
- When work must pause, call `checkpoint_pause` with the initiative, the current revision, the active slice, recovery content that names the step and next action, and the state changes.
