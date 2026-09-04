---
name: orchestrate
description: "Run a multi-slice Prism initiative through planning, design audit, continuous delivery contexts, exhaustive review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

The orchestrator coordinates every outcome slice through `plan`, `design`, design audit, `implement`, implementation review, and user gates.
The orchestrator is the initiative control plane.
The initiative `state.md` snapshot is the durable routing record.
The session holds active child identifiers while each child is active.

- Read `.prism/workflow.md` and [delegation.md](../workflow/references/delegation.md) first.
- Before recording per-slice operations, read [operations-format.md](references/operations-format.md).
- Before a visual gate, read [visual-review.md](../workflow/references/visual-review.md).

- At the start of every orchestrator context:
  1. Read `state.md`, `plan.md`, `slices.puml`, and the active slice `findings.md`.
  2. State the restored role, phase, gate, active slice, and next action in a short checkpoint.

After context compaction, the context is fresh.

- Before taking an action after context compaction, repeat the context-start procedure.

- Do
  - Record active child identifiers in `state.md` at every transition.
  - Allow a new orchestrator to take over only after a phase boundary or explicit interruption.
- Don't
  - Implement, design, or review phase content from the control-plane context.
  - Run parallel orchestrators for one initiative.

## Coordination state

- Use this coordination snapshot under each initiative plan:

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
Design checkpoint: <commit hash or none>
Handoff: active | ready | recovery
Recovery: <reason and next recovery action or none>
Updated: <timestamp>
```

The `state.md` file contains one operations block for each slice.
A fresh review context counts as a review wave, not a child restart.
The slice `findings.md` file contains detailed review evidence.

- Update the operations block at child and phase transitions.
- Update `state.md` before and after every child transition.
- Update `state.md` before a phase-boundary handoff.
- Link to `findings.md` instead of copying detailed evidence into the operations block.
- Do not update the operations block after every wait.
- Do not delete `state.md` or `findings.md` until the initiative is shipped and its scratch plan is deleted.

## Initiative phases

### 1. Set the run contract

The run settings have these allowed values and defaults:

| Setting | Values | Default |
| --- | --- | --- |
| Decision autonomy | `conservative` or `broad` | `conservative` |
| Commit | `off` or `on` | `off` |
| Push | `off` or `on` | `off` |
| Slice continuation | `auto` or `stepwise` | `auto` |
| Model policy | `default` or `manual` | `default` (recommended) |

- Ask once for the run settings.

- When Commit is on, create exactly two checkpoint commits for each slice.
  1. Create one checkpoint after design audit.
  2. Create one checkpoint after implementation review.
- Do not create intermediate workflow commits during correction waves.

No autonomy level can change an Approved requirement or create an unsanctioned ADR.
No autonomy level can bypass plan acceptance, accept a slice split, or confirm correctness.
Conservative autonomy requires user approval after a clean design audit and visual review.
Broad autonomy can continue after a clean design audit and visual review when no consequential decision remains.
Slice continuation controls only the transition after a confirmed slice.
Slice continuation does not skip design, design audit, visual review, review, or correctness gates.

The `default` model policy has these assignments:

| Model role | Assignment |
| --- | --- |
| Planning | Host default |
| Delivery | Host default |
| Review | Host reviewer model when available, otherwise host default |
| High-risk review | Host security model when available, then host reviewer model, then host default |

- Before spawning a child, ask the user to apply the default judgment or set models manually.

A manual assignment names a model ID or `host default`.

- For the `manual` policy, ask for planning, delivery, review, and high-risk review assignments before spawning a child.
- Pass the selected model when the child-start capability accepts model selection.
- When model selection is unavailable, report the limitation and use `host default`.
- Record the model role and resolved model for every child.

The callable capabilities determine the execution mode:

| Execution mode | Callable capabilities |
| --- | --- |
| Parallel | Child-start and isolated-workspace actions exist |
| Sequential | Child-start exists without isolated workspaces |
| Manual | No child-start action exists |

A wait action alone does not enable parallel or sequential mode.

### 2. Resolve the initiative

- When an accepted initiative plan exists:
  1. Read `plan.md` and `slices.puml`.
  2. Read `state.md`, or create it when it does not exist.
- When work needs several outcomes and has no plan:
  1. Start a fresh `Plan <initiative>` agent.
  2. Assign it the `planning` model role and its resolved model or host default.
- When a new plan returns `PLAN READY`:
  1. Open one Prism artifact viewer session before presenting the plan for acceptance.
  2. Include the plan and slice graph in that session.
  3. Use a browser-opening capability for the selected browser.
  4. When no opener exists, present the URL and source artifacts.
  5. Present the slice graph for user acceptance.
  6. After the initiative plan receives acceptance, create its `state.md`.
- When the capability is self-contained:
  1. Treat it as one standalone slice without creating a dependency plan.
  2. Create its `state.md` and slice `findings.md` files before the first phase.

### 3. Select the frontier

The frontier contains every not-started slice whose dependencies are done.

- Run frontier slices concurrently only in isolated workspaces.
- Otherwise, run frontier slices sequentially.
- Recompute the frontier after every confirmed slice.
- Keep one workspace and one `Develop <slice>` task for each active slice.
- Never reuse a `Develop <slice>` task for another slice.

### 4. Deliver a slice

#### 1. Explore and fit

1. Mark the slice `in-progress` before starting the child.
2. Create or update `<configured plans>/<initiative>/<slice>/findings.md` before the first audit.
3. When this is the initiative's first active slice, mark the roadmap initiative `in-progress`.
4. Start one child named `Develop <slice>` and instruct it to run `design` in embedded mode.
5. Give it the requirements, code workspace, autonomy level, and execution profile.
6. Give it the slice record when present.
7. Give it the initiative `state.md` path and slice `findings.md` path.
8. Assign the `delivery` model role and its resolved model or host default.

- Route the compact result as follows:
  - On `FIT`, run the design audit.
  - On `SPLIT`, present the child slices and wait for explicit acceptance.
  - On `BLOCKED`, present the unresolved requirement, decision, or dependency.

Slice-scoped artifact paths are valid only with `FIT`.
A `SPLIT` or `BLOCKED` result must not leave slice-scoped artifacts attached to the rejected slice.

- After an accepted split, resume the same `Develop <slice>` agent with the first accepted child slice.
- Update the slice DAG for the remaining child slices.

#### 2. Audit the design

1. Start a fresh `Review <slice>` agent with `review` in `design-audit` mode.
2. Give it the design output paths and slice `findings.md` path.
3. Do not give it the delivery conversation.
4. Assign the `review` model role and its resolved model or host default.
5. On findings, read `findings.md` and resume `Develop <slice>` with the path and all unresolved finding IDs.
6. After each design correction batch, start a fresh scoped design audit.
7. Continue until `CLEAN`, a user stop, or a real blocker.
8. On `CLEAN`, open one Prism artifact viewer session for all recorded ADRs and diagrams.
9. Complete the visual review before the implementation gate.
10. Present `Design: <one-sentence outcome>` and this compact result:

```text
Mode: design-audit
Lane: none
Review focus: requirements, design, boundaries, contracts, security
Coverage: requirements, lifecycle, tests, artifacts, verification
Findings: <configured plans>/<initiative>/<slice>/findings.md
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

- When autonomy is conservative, ask whether to proceed to implementation.
- When autonomy is broad and no consequential decision remains, continue to implementation.

- When Commit is on and implementation is authorized, create the design checkpoint.
  1. Include only slice-owned design and coordination changes.
  2. Record its hash in `state.md` and use it as the implementation diff base.
- Keep delivery and review contexts uncommitted.
- Preserve unrelated working-tree changes.

Only the orchestrator creates the two checkpoint commits.

#### 3. Implement

- After a clean design audit and visual review, resume the same `Develop <slice>` agent and instruct it to run `implement`.
- Do not repeat design reasoning or file contents.
- Pass only the user decision when one occurred.
- Pass the slice `findings.md` path and unresolved finding IDs when correction work exists.

- When the child returns `READY FOR REVIEW`:
  - Record the verification status, paths, and security surface.
  - Record the design checkpoint hash.
  - Record each contract declaration with its canonical path, consumers, and verification command.
  - For a declaration without a contract, record its specific `NO CONTRACT NEEDED` reason.
  - Reject a claim of independent review from `Develop <slice>`.
  - Pass the implementer's verification status and test paths to reviewers.
  - Do not assign the full test suite or configured verification commands to reviewers.
  - Allow reviewers to add a minimal finding-scoped regression test through a public or system surface.
  - Limit each regression test to confirming or rejecting a suspected defect.

#### 4. Review the implementation

High-risk concerns include lifecycle, concurrency, replay, security, IPC, migration, and public boundaries.

- Use one exhaustive `Review <slice>` agent for a normal slice.
- Use independent review lanes for a high-risk slice.

The following review matrix is an example:

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

- For a normal slice:
  1. Prepare `review` in `implementation-review` mode with the recorded paths.
  2. Do not include the delivery conversation.
  3. Pass the design checkpoint hash as the diff base.
  4. Require inspection of changes from that commit.
  5. Assign the `review` model role and its resolved model or host default.
  6. Start one fresh `Review <slice>` agent with the prepared instructions.

Each high-risk lane uses the `security-review` model role with its resolved model or host default.

- For a high-risk slice:
  1. Define a review matrix before starting high-risk review lanes.
  2. Assign each lane its distinct focus and coverage.
  3. Assign each lane the matrix row as its scope and the `Focus` execution profile.
  4. Prepare `review` in `implementation-review` mode with the recorded paths for each lane.
  5. Do not include the delivery conversation.
  6. Pass the design checkpoint hash as the diff base.
  7. Require inspection of changes from that commit.
  8. Do not send identical review instructions to all lanes.
  9. Start one fresh agent for each matrix row with its prepared instructions.

- For each lane:
  - Give it its matrix row, common diff paths, and [review-format.md](../review/references/review-format.md).
  - Give it the slice `findings.md` path and require it to update that file.
  - Run lanes sequentially when they share one findings file.
  - Otherwise, serialize findings-file updates before the next lane starts.
  - Require the lane, focus, coverage, status, and findings in its report.

- Keep one active review wave for each slice.
- Consolidate all lane findings before sending one correction batch.
- Consolidate duplicate findings and check uncovered coverage.
- Use `findings.md` as the source of truth instead of passing a transient finding list.
- Pass each review probe path and expected failure with its unresolved finding.
- If the slice returns to design or splits, discard or re-evaluate unaccepted review probes.

- When a finding becomes `REOPENED` after correction, start a fresh `Develop <slice>` context in the same workspace.
- Give the replacement the current code and findings file.
- When the same finding reopens after replacement, start a fresh scoped design audit.
- If the fresh audit cannot resolve the finding, return `BLOCKED` with the exact consequential decision needed.
- After every implementation correction, start a fresh review wave with the same matrix.
- Continue until `CLEAN`, a user stop, or a real blocker.
- Do not stop after one re-review while findings remain.
- Distinguish review findings from child failures, timeouts, and recovery replacements.
- On `CLEAN`, open one Prism artifact viewer session for all changed artifacts and diagrams.
- Then continue to the slice gate.

### 5. Confirm the slice

1. Present verification, review, security results, and unfinished work.
2. Ask the user for one correctness confirmation.

- After confirmation:
  1. Mark the slice `done`.
  2. Accept implemented Proposed ADRs.
  3. Integrate its isolated workspace.
  4. When Commit is on, create the final checkpoint commit from the remaining slice-owned changes.
  5. Apply the push setting.
  6. Recompute the frontier.

- Set the handoff status to `ready` before the current orchestrator ends.

- When a new orchestrator finds `active` or `recovery`, inspect the recorded child and recovery status before starting work.
- At auto continuation, start every eligible slice that workspace safety allows.
- At stepwise continuation, ask before the next slice.
- When every slice is done:
  1. Graduate open information.
  2. Set the roadmap initiative to `shipped`.
  3. Delete its scratch plan.

## Handle broker requests

1. When a child returns a broker request, inspect the callable actions.
2. If this context has a callable child-start action:
   1. Start the requested child.
   2. Give the child only the request scope, paths, scratch destination, profile, model role, and resolved model.
   3. Return the result path and short status to the requester.
3. If this context has no callable child-start action:
   1. If a parent can delegate, return the broker request to the nearest capable parent.
   2. If no parent can delegate, use manual mode.

## Supervise children

An observation interval is a check-in schedule, not a deadline or execution limit.

- Track every active child identifier.
- Never wait with an empty identifier set.
- Treat an empty receiver or agent state as a routing failure and use broker or manual recovery.
- Interrupt only after a positive failure signal, a user request, or an explicit child blocker.
- Set an observation interval before each child's first wait and record it in `state.md`.
- Use 15 minutes for planning, design, and review children.
- Use 30 minutes for implementation children.
- Increase the interval for known long verification or a higher-risk execution profile.

- For each active child:
  1. Start or resume it with the current phase instruction.
  2. Record the observation interval in `state.md`.
  3. Wait for that interval while the child remains active.
  4. If the interval expires without a final result, inspect available status and progress.
  5. If no positive failure signal exists, check for non-destructive input.
  6. When non-destructive input is available:
     1. Send one concise status request.
     2. If the status request was sent:
        1. Wait through at most three five-minute follow-up intervals.
        2. If the child reports progress, record it and return to the normal observation interval.
        3. If the child reports a blocker, record recovery state and route the blocker without replacement.
        4. If the child stays silent after the follow-up intervals, record `unresponsive` and preserve its workspace.
        5. If the child stays silent after the follow-up intervals, request a user or parent recovery decision.
  7. Record recovery state only after failure, blocker, user interruption, or unresponsive escalation.
  8. Resume the same child when possible.
  9. After confirmed failure or an approved recovery decision, start a replacement in the same workspace.
  10. Give the replacement the current code and recorded recovery state.
  11. Keep the same model role and resolved model unless the manual policy changes them.
  12. Before replacement, record the reason, last progress, next action, and child status in `state.md`.

A wait timeout means only that no final result arrived.
It is not evidence that the child is stuck.
- Do not narrate unchanged waits.
- Do not use waits, replacements, or child failures as correction rounds.
- Do not treat review findings as child failures.
- In manual mode, tell the user to keep one delivery task open through `design` and `implement`.
- Ask the user to run `review` in `design-audit` mode in a fresh task after `FIT` and before implementation.
- Ask the user to run `review` in `implementation-review` mode in a separate task after implementation.

## Gate

This skill has no additional gate.
It ends when every slice is confirmed and the initiative is shipped, or when the user stops it.
