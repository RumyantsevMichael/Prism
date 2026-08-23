---
name: orchestrate
description: "Run a multi-slice Prism initiative through planning, design audit, continuous delivery contexts, exhaustive review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
---

# Orchestrate an initiative

Coordinate `plan` → (`design` → `review` in `design-audit` mode → `implement` → `review` in `implementation-review` mode) for every outcome slice.
Act as the initiative control plane.
Keep routing state in the initiative `state.md` snapshot instead of relying only on this session.
Keep active child identifiers in the session while active and record them in `state.md` at every transition.

Read `.prism/workflow.md` and [delegation.md](../workflow/references/delegation.md) first.
Read [operations-format.md](references/operations-format.md) when recording per-slice operations.
Read [visual-review.md](../workflow/references/visual-review.md) before a visual gate.

At the start of every orchestrator context, read `state.md`, `plan.md`, `slices.puml`, and the active slice `findings.md` before routing work.
After context compaction, treat the context as fresh and repeat that read before taking an action.
State the restored role, phase, gate, active slice, and next action in a short checkpoint.
Do not implement, design, or review phase content from this control-plane context.
Allow a new orchestrator to take over only after a phase boundary or an explicit interruption.
Do not run parallel orchestrators for one initiative.

Use this coordination snapshot under each initiative plan:

```text
Status: active | awaiting-user | paused | blocked | shipped
Active slice: <slice slug or none>
Phase: plan | design | design-audit | visual-design | implement | review | visual-final | correctness
Gate: <gate name or none>
Next action: <one action>
Child: <identifier and status or none>
Wait: <phase observation interval, last check, and recovery stage or none>
Last result: <short status and artifact path>
Findings: <slice findings path or none>
Verification: <status and exact command>
Handoff: active | ready | recovery
Recovery: <reason and next recovery action or none>
Updated: <timestamp>
```

Keep one operations block per slice in `state.md`.
Count a fresh review context as a review wave, not as a child restart.
Update the operations block at child and phase transitions, not after every wait.
Link to `findings.md` for detailed review evidence instead of duplicating it in the operations block.

Update `state.md` before and after every child transition and before a phase-boundary handoff.
Do not delete `state.md` or `findings.md` until the initiative is shipped and its scratch plan is deleted.

## 1. Set the run contract

Ask once for these run settings:

- **Decision autonomy:** conservative (default) or broad.
- **Commit:** off (default) or on.
- **Push:** off (default) or on.
- **Slice continuation:** auto (default) or stepwise.
- **Model policy:** default (recommended) or manual.

No autonomy level can change an Approved requirement, create an unsanctioned ADR, bypass plan acceptance, accept a slice split, or confirm correctness.

Conservative autonomy requires a user approval after a clean design audit and visual review.
Broad autonomy may continue automatically after a clean design audit and visual review when no consequential decision remains.
Slice continuation controls only the transition after a confirmed slice.
It does not skip design, design audit, visual review, review, or correctness gates.

Ask the user to choose whether to apply the default judgement or set models manually before spawning any child.
When the policy is `default`, apply this judgement:

- **Planning model:** host default.
- **Delivery model:** host default.
- **Review model:** host reviewer model when available, otherwise host default.
- **High-risk review model:** host security model when available, then host reviewer model, then host default.

When the policy is `manual`, ask for model assignments for planning, delivery, review, and high-risk review before spawning any child.
A manual assignment can name a model ID or `host default`.
Pass the selected model when the child-start capability accepts model selection.
When the capability does not accept model selection, report the limitation and use `host default`.
Record the selected model role and resolved model for every child.

Detect the execution mode from callable capabilities:

- **Parallel:** child-start and isolated-workspace actions exist.
- **Sequential:** child-start exists without isolated workspaces.
- **Manual:** no child-start action exists.

A wait action alone does not enable parallel or sequential mode.

## 2. Resolve the initiative

When an accepted initiative plan exists, read `plan.md` and `slices.puml`.
When an accepted initiative plan exists, read its `state.md` and create it when it does not exist.
When the work needs several outcomes and has no plan, start a fresh `Plan <initiative>` agent.
Use this model assignment:

- Model role: `planning`
- Model: <resolved model or host default>

Present its slice graph for user acceptance.
When a new plan returns `PLAN READY`, open one Prism artifact viewer session for the plan and slice graph before presenting them for acceptance.
Use a browser-opening capability for the selected browser and present the URL and source artifacts only when no opener exists.

Treat a self-contained capability as one standalone slice without creating a dependency plan.
Create its `state.md` and slice `findings.md` coordination files before the first phase.
Create `state.md` after the initiative plan receives acceptance.

## 3. Select the frontier

The frontier contains each not-started slice whose dependencies are done.
Run frontier slices concurrently only in isolated workspaces.
Otherwise, run them sequentially.
Recompute the frontier after every confirmed slice.

Keep one workspace and one `Develop <slice>` task per active slice.
Never reuse a `Develop <slice>` task for another slice.

## 4. Deliver a slice

### Explore and fit

Start one child agent named `Develop <slice>` and instruct it to run `design` in embedded mode.
Give it the requirements, any slice record, code workspace, autonomy level, and execution profile.
Give it the initiative `state.md` path and the slice `findings.md` path.
Use this model assignment:

- Model role: `delivery`
- Model: <resolved model or host default>

Before it starts, mark the slice `in-progress`.
Create or update `docs/plans/<initiative>/<slice>/findings.md` before the first audit.
When this is the initiative's first active slice, mark the roadmap initiative `in-progress`.

Handle its compact result:

- `FIT` → run the design audit.
- `SPLIT` → present the child slices and wait for explicit acceptance.
- `BLOCKED` → present the unresolved requirement, decision, or dependency.

Accept slice-scoped artifact paths only with `FIT`; a `SPLIT` or `BLOCKED` result must not leave such artifacts attached to the rejected slice.
After an accepted split, resume the same `Develop <slice>` agent with the first accepted child slice.
Update the slice DAG for the remaining child slices.

### Design audit

Start a fresh `Review <slice>` agent with `review` in `design-audit` mode, the design output paths, and the slice `findings.md` path.
The auditor receives no delivery conversation.
Use this model assignment:

- Model role: `review`
- Model: <resolved model or host default>

On findings, read the slice `findings.md` and resume `Develop <slice>` with its path and all unresolved finding IDs.
After each design correction batch, start one fresh scoped `review` in `design-audit` mode.
Continue the design audit loop until `CLEAN`, a user stop, or a real blocker.
On `CLEAN`, open one Prism artifact viewer session for all recorded ADRs and diagrams before the implementation gate.
After visual review, present `Design: <one-sentence outcome>` and the compact result:

```text
Mode: design-audit
Lane: none
Review focus: requirements, design, boundaries, contracts, security
Coverage: requirements, lifecycle, tests, artifacts, verification
Findings: docs/plans/<initiative>/<slice>/findings.md
Finding IDs: NONE
ADRs: <Proposed ADR paths or NONE>
Executable tests: <canonical test paths or NONE>
Feature files: <canonical feature paths or NONE>
Diagrams: <ADR diagram paths or NONE>
Red checkpoint: <exact command and expected failure reason or NONE>
Contracts: <contract paths or NO CONTRACT NEEDED reasons>
Verification: <exact command>
Status: CLEAN
```

When autonomy is conservative, ask whether to proceed to implementation.
When autonomy is broad and no consequential decision remains, continue to implementation.

### Implement

After a clean design audit and visual artifact review, resume the same `Develop <slice>` agent and instruct it to run `implement`.
Do not repeat design reasoning or file contents.
Pass only the user decision when one occurred.
Pass the slice `findings.md` path and unresolved finding IDs when correction work exists.

When the agent returns `READY FOR REVIEW`, record its diff base, verification status, paths, and security surface.
Record every contract declaration with its canonical path, consumers, and verification command, or its specific `NO CONTRACT NEEDED` reason.
Do not accept a claim of independent review from `Develop <slice>`.
Pass the implementer's verification status and test paths to reviewers.
Do not assign the full test suite or configured verification commands to reviewers.
Allow a reviewer to run only a focused probe that can confirm or reject a suspected defect.

### Review

Use one exhaustive `Review <slice>` agent for a normal slice.
Use independent review lanes for a high-risk slice with lifecycle, concurrency, replay, security, IPC, migration, or public-boundary concerns.
Start a fresh `Review <slice>` agent, or one fresh agent per review lane, with `review` in `implementation-review` mode and the recorded paths.
The reviewer receives no delivery conversation.
Define a review matrix before spawning high-risk lanes.
Do not send identical review instructions to all lanes.
Use one fresh agent for each matrix row.
Use this example:

```text
Lane: security
Review focus: grants, identity, replay, confinement
Coverage: authorization, untrusted input, protocol results

Lane: lifecycle
Review focus: authority loss, cancellation, deadlines, cleanup
Coverage: state transitions, races, ownership, terminal outcomes

Lane: integration
Review focus: requirements, contracts, compatibility, artifacts
Coverage: requirements, features, ADRs, diagrams, verification
```

Give each lane its matrix row, the common diff paths, and the [review-format.md](../review/references/review-format.md) reference.
Give each lane the slice `findings.md` path and require it to update that file.
Run lanes sequentially when they share one findings file, or serialize their file updates before the next lane starts.
Require each lane to report its lane, focus, coverage, status, and findings.
For a normal slice, use:

- Model role: `review`
- Model: <resolved model or host default>

For each high-risk review lane, use the matrix row as the lane scope and the execution profile `Focus`.

- Model role: `security-review`
- Model: <resolved model or host default>

Keep one active review wave per slice.
Consolidate all lane findings before sending one correction batch.
Consolidate duplicate findings and check uncovered coverage.

Use `findings.md` as the source of truth instead of passing a transient finding list.
When a finding has status `REOPENED` after a correction batch, start a fresh `Develop <slice>` context in the same workspace from current code and the findings file.
When the same finding reopens after that replacement, start a fresh scoped `review` in `design-audit` mode.
If the fresh audit cannot resolve the finding, return `BLOCKED` with the exact consequential decision needed.
After every implementation correction, start a fresh review wave with the same matrix.
Continue the review loop until `CLEAN`, a user stop, or a real blocker.
Do not stop after one re-review while findings remain.
Distinguish review findings from child-agent failures, timeouts, and recovery replacements.
On `CLEAN`, open one Prism artifact viewer session for all changed artifacts and diagrams before the final correctness gate.
Then continue to the slice gate.

## 5. Confirm the slice

Present verification, review, security results, and unfinished work.
Ask the user for one correctness confirmation.

After confirmation:

1. Mark the slice `done`.
2. Accept implemented Proposed ADRs.
3. Integrate its isolated workspace.
4. Apply the commit and push settings.
5. Recompute the frontier.

Set the handoff status to `ready` before the current orchestrator ends.
When a new orchestrator finds `active` or `recovery` state, inspect the recorded child and recovery status before starting work.

At auto continuation, start every eligible slice allowed by workspace safety.
At stepwise continuation, ask before the next slice.

When every slice is done, graduate open information, set the roadmap initiative to `shipped`, and delete its scratch plan.

## Broker handling

When a child returns a broker request, start the requested child only when this context has a callable child-start action.
Give it only the request scope, paths, scratch destination, profile, model role, and resolved model.
Return its result path and short status to the requester.
When this context cannot start it, return the broker request to the nearest capable parent.
Use manual mode only when no parent can delegate.

## Supervision loop

Track every active child identifier.
Never wait with an empty identifier set.
Treat empty receiver or agent state as a routing failure and use broker or manual recovery.
Interrupt only after a positive failure signal, a user request, or an explicit agent blocker.
Set an observation interval for each child before its first wait and record it in `state.md`.
Use 15 minutes as the starting interval for planning, design, and review children.
Use 30 minutes as the starting interval for implementation children.
Increase the interval when the child reports a known long-running verification or when the execution profile has higher risk.
Treat the interval as a check-in schedule, not a deadline or execution limit.

For each active child:

1. Start or resume it with the current phase instruction and record the observation interval in `state.md`.
2. Wait for the recorded observation interval while the child remains active.
3. If the interval expires without a final result, inspect the child status and latest progress when the host exposes them.
4. If no positive failure signal exists, send one concise status request to the same child when the host supports non-destructive input.
5. Wait through up to three 5-minute follow-up intervals after that request.
6. If the child reports progress, record it and return to the normal observation interval.
7. If the child reports a blocker, record recovery state and route the blocker without replacing the child.
8. If the child remains silent after the follow-up intervals, record `unresponsive`, preserve its workspace, and request a user or parent recovery decision.
9. A wait timeout means only that no final result arrived.
It is not evidence that the child is stuck.
10. Record recovery state only after failure, blocker, user interruption, or an unresponsive escalation.
11. Resume the same child when possible.
12. After a confirmed failure or an approved recovery decision, start a replacement in the same workspace from current code and recorded recovery state.
13. Keep the same model role and resolved model for a replacement unless the manual policy explicitly changes them.
14. Write the recovery reason, last progress, next action, and child status to `state.md` before a replacement starts.

Do not narrate unchanged waits.
Do not use waits, replacements, or child-agent failures as correction rounds.
Do not treat review findings as child-agent failures.
In manual mode, tell the user to keep one delivery task open through `design` and `implement`.
Ask the user to run `review` in `design-audit` mode in a fresh task after `FIT` and before implementation.
Ask the user to run `review` in `implementation-review` mode in a separate task after implementation.

## Gate

This skill has no additional gate.
It ends when every slice is confirmed and the initiative is shipped, or when the user stops it.
