---
name: implement
description: "Implement an accepted track through its task graph and final correctness gate."
argument-hint: '[initiative/track]'
---

# Implement a track

This is the **implementation controller** for one validated design track.
Run it in a fresh context because independence from design exposes hidden assumptions.
The controller reads the complete specification, coordinates task workers, preserves recovery state, and owns the final gate.

Project settings live in `.prism/workflow.md` at the project root.
Read that file first when it exists.
The context map and lifecycle rules live in the `workflow` overview skill.

**One workflow skill per context** applies to the controller.
If `plan` or `design` already ran in this context, stop and start `implement` in a fresh context.
Task workers do not run another workflow skill.
They implement only the task that the controller assigns.

Start with the handoff under `docs/plans/<initiative>/<track>/`.
Follow its authoritative input order.
Stop on a conflict between requirements, ADRs, contracts, feature files, or the handoff.

## 1. Read the specification cold

Read the handoff, Approved requirements, ADRs, contracts, build plan, feature files, and track orientation.
The design arrives after focused validation waves, so do not repeat specification validation.

Report a real specification gap and stop the affected task chain.
Route a missing product obligation to `write-requirements` for user approval.
Route a design gap or wrong architectural invariant to the design session.
Resume from the on-disk correction after the owning workflow resolves it.

Carry the handoff's security surface into the final review.
Determine and record it when the handoff omitted it.
`none` is a valid security surface.

## 2. Create or resume the execution ledger

Use `<plans-dir>/<initiative>/<track>/execution-ledger.md`.
This ledger is scratch execution state and is not part of the validated specification.
No durable artifact may reference the ledger or its task identifiers.

Record these items:

- The handoff and build-plan paths.
- Each task boundary, identifier, and status.
- Each task's dependencies and current workspace.
- Integration order and integrated results.
- Test and verification results.
- Local implementation rulings.
- Correction rounds and open findings.
- Task splits and their replacement dependencies.
- Gated and unfinished work.

Use `not-started`, `in-progress`, `done`, or `blocked` for task status.
Trust the ledger and the workspace state after context replacement.
Never dispatch a task that the ledger already marks `done`.

### Legacy build plans

An older build plan can contain workstreams instead of implementation tasks.
Map each workstream to one ledger task without editing the validated build plan.
Use its build order, plug points, and tests to derive dependencies and write surfaces.
Run derived tasks sequentially when the old plan does not prove safe independence.
Return to design only when a workstream lacks an independently testable completion condition or exposes a specification conflict.

## 3. Compute the task frontier

The frontier contains each `not-started` task whose dependencies are all `done`.
Recompute it after every integration batch.
Use the task graph as the authoritative dependency source.

Tasks can run concurrently only when all these conditions hold:

- The host provides isolated workspaces.
- No dependency edge exists between the tasks.
- Their declared write surfaces do not overlap.
- Their produced interfaces do not overlap.
- They do not change the same generated output, schema registry, migration state, or lock file.

Run an affected task sequentially when any condition fails.
Shared-workspace execution is always sequential.
Do not infer independence from different task names.

## 4. Dispatch task workers

Start one fresh worker for each eligible task.
Give the worker artifact paths, its task identifier, its workspace, and the project instructions.
Do not inline the specification or pass the controller's conversation history.
Task workers do not commit or push.

Each worker must:

1. Read its task and the interfaces that it consumes.
2. Ask the controller about an ambiguity before it edits code.
3. Write a failing test before production code.
4. Implement only the assigned deliverable.
5. Update required user guides and runbooks in the same task.
6. Run the task's exact verification.
7. Self-review its complete task diff.
8. Report changed files, tests, verification, and remaining concerns.

Answer worker questions from the accepted specification when possible.
Record a local implementation ruling in the ledger when the accepted specification leaves a reversible choice open.
State the choice, reason, and cost if wrong.
Resolve a declared `// OPEN:` seam without a user gate when it cannot change observable behavior or an invariant.
Replace the marker in the owning contract and record the same ruling in the ledger.
Route an externally observable or architectural choice back to design.

## 5. Review and integrate each task

Record the base state before each worker starts.
Review the worker's complete task diff against its deliverable, interfaces, tests, write surface, and completion condition.
Reject unrelated changes and undeclared interface changes.

An accepted task must satisfy both conditions:

- The implementation matches the accepted specification and task contract.
- The code, tests, documentation, and verification meet project quality rules.

Use an initial attempt and at most two scoped correction rounds.
Resume the same worker when its context remains available.
Otherwise, start a fresh worker with the task, report, and open findings.
Each correction round fixes the complete current finding list and receives one scoped controller review.

After three failed attempts, classify the cause:

- **Context problem**: give a fresh worker the task artifacts and reports.
- **Oversized task**: split it into smaller ledger tasks without changing the specification.
- **Plan defect**: record a corrected execution ruling in the ledger and continue.
- **Specification gap**: stop the affected chain and route it to the owning workflow.

A ledger task split preserves the original deliverable and completion condition.
Give each replacement task explicit dependencies, interfaces, write surfaces, tests, and completion conditions.
Do not create an initiative track only because an implementation task was too large.

Review isolated task work before integration.
Integrate accepted workspaces in topological task order.
Use build-plan document order to break ties within one frontier.
Use the host's isolated-workspace integration capability.
Never silently drop either side of a conflict.

If integration exposes a substantive conflict, discard the affected integration attempt.
Rerun that task sequentially from the integrated base.
The controller can repair a purely mechanical conflict when behavior stays unchanged.

After each integration batch, run the combined tests for every changed interface and shared consumer.
Mark a task `done` only after integration and combined verification pass.

## 6. Verify the complete track

After every task is `done`, run acceptance tests and the workflow-config verification procedure.
Add live verification for behavior that automated tests cannot prove.

Cross-process and cross-surface behavior requires live end-to-end verification.
Green in-process tests do not prove that integration exists.
If the environment cannot run a required path, classify the missing proof at the gate.

Give the user at least one exact end-to-end scenario.
Include commands or UI steps and the observation that proves each step.

## 7. Run the independent whole-track review

Start one fresh reviewer with the authoritative specification and the complete track diff.
The reviewer checks specification compliance, code quality, integration completeness, and regression risk.
When the security surface is non-empty, the same review also audits secrets, inputs, authorization, privilege, network access, and IPC.
When the security surface is `none`, record that the security audit was skipped for that reason.

If the review finds actionable issues, send the complete list through one combined fix dispatch.
Run one scoped independent re-review of that fix wave.
Stop before the correctness gate when actionable findings remain.
Do not start another unbounded review loop.

## Gate

Classify every not-done item as **gated** or **unfinished**.
**Gated** means blocked on a named external condition that the initiative already accepts.
**Unfinished** means a competent engineer can complete it in the current development environment.
Unfinished work blocks the correctness gate.
Context exhaustion and missing integration are unfinished work.

Continue buildable ledger tasks instead of creating a follow-up track.
Create a new track only when the user accepts a scope change or design finds an independent capability or incompatible architectural boundary.

Present the complete verification, final review, security result, local rulings, gated work, and unfinished work.
Ask for one correctness confirmation for the complete track.
Do not ask for correctness confirmation per task.

On confirmation, accept each implemented Proposed ADR.
Do not change Approved requirement status.
Do not propose a commit unless the user asks or the orchestrator's commit dial permits it.

The landing change can delete the preparation bundle with user approval.
When it deletes that bundle, it must also delete the execution ledger.

For an initiative track, set the track file and DAG node to `done` after correctness confirmation.
If implementation stalls on a real dependency, set the track `blocked` with a reason.

For the last track, run the graduate-before-delete gate from the `workflow` overview skill.
Graduate every open question and cross-cutting concern before deleting the initiative plan.
Set the roadmap node to `shipped` and remove its plan link before deletion.
A plan folder must not be deleted while its roadmap node is not `shipped`.
