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
The initiative `state.json` file is the validated durable routing record.
The `map.puml` file is a human-readable projection of that state.
The session holds active child identifiers while each child is active.

- Read `.prism/workflow.md` and [delegation.md](../workflow/references/delegation.md) first.
- Read [state-schema.md](references/state-schema.md) before creating, changing, or recovering initiative state.
- Before recording per-slice operations, read [operations-format.md](references/operations-format.md).
- Before a visual gate, read [visual-review.md](../workflow/references/visual-review.md).

- At the start of every orchestrator context:
  1. Read and validate `state.json`, `plan.md`, `map.puml`, and the active slice canonical `findings.md`.
  2. State the restored role, phase, gate, active slice, and next action in a short checkpoint.

After context compaction, the context is fresh.

- Before taking an action after context compaction, repeat the context-start procedure.

- Do
  - Record active child identifiers through validated patches to `state.json` at every transition.
  - Regenerate `map.puml` after each accepted state patch.
  - Allow a new orchestrator to take over only after a phase boundary or explicit interruption.
- Don't
  - Implement, design, or review phase content from the control-plane context.
  - Run parallel orchestrators for one initiative.

## Coordination state

The state schema defines the required `state.json` fields and validation rules.
Each worker returns an atomic state patch with its result.
The orchestrator validates the complete candidate state before it persists a patch.
The validator checks schema version, lifecycle transitions, dependency acyclicity, slice ownership, lane paths, and active-worker rules.
The orchestrator rejects an invalid patch without changing unrelated state.
The orchestrator records every accepted or rejected patch in the state audit trail.
The orchestrator records a fresh review context as a review wave, not a child restart.
The canonical slice `findings.md` file holds consolidated review evidence.

- Update state before and after every child transition.
- Update state before a phase-boundary handoff.
- Record only current routing data and compact audit records in `state.json`.
- Do not update state after an unchanged wait.
- Do not delete `state.json`, `map.puml`, or canonical findings until the initiative is shipped and its scratch plan is deleted.

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
  1. When `map.puml` is absent and legacy `slices.puml` exists, move its unchanged content to `map.puml`, update plan links, and record the migration in the state audit trail.
  2. Read `plan.md` and `map.puml`.
  3. Read and validate `state.json`.
  4. When only a legacy `state.md` exists, create `state.json` from its current routing data and preserve the legacy file as an audit artifact.
- When work needs several outcomes and has no plan:
  1. Start a fresh `Plan <initiative>` agent.
  2. Assign it the `planning` model role and its resolved model or host default.
- When a new plan returns `PLAN READY`:
  1. Open one Prism artifact viewer session before presenting the plan for acceptance.
  2. Include the plan and slice graph in that session.
  3. Use a browser-opening capability for the selected browser.
  4. When no opener exists, present the URL and source artifacts.
  5. Present the slice graph for user acceptance.
  6. After the initiative plan receives acceptance, create and validate its `state.json`.
  7. Generate `map.puml` from the saved state.
- When the capability is self-contained:
  1. Treat it as one standalone slice without creating a dependency plan.
  2. Create its `state.json`, `map.puml`, and canonical slice `findings.md` files before the first phase.

### 3. Select the frontier

The frontier contains every not-started slice whose dependencies are done.

- Run frontier slices concurrently only in isolated workspaces.
- Otherwise, run frontier slices sequentially.
- Recompute the frontier from validated state after every accepted patch.
- Exclude parent slices from the executable frontier.
- Start a leaf slice only when all required dependencies are `done`.
- Keep one workspace and one `Develop <slice>` task for each active slice.
- Never reuse a `Develop <slice>` task for another slice.

### 4. Deliver a slice

#### 1. Explore and fit

1. Validate an atomic patch that marks the leaf slice `in-progress` before starting the child.
2. Create or update `<configured plans>/<initiative>/<slice>/findings.md` before the first audit.
3. When this is the initiative's first active slice, mark the roadmap initiative `in-progress`.
4. Start one child named `Develop <slice>` and instruct it to run `design` in embedded mode.
5. Give it the requirements, code workspace, autonomy level, and execution profile.
6. Give it the slice record when present.
7. Give it the initiative `state.json` path and slice canonical `findings.md` path.
8. Assign the `delivery` model role and its resolved model or host default.

- Route the compact result as follows:
  - On `FIT`, run the design audit.
  - On `SPLIT`, validate the proposed child records and present them for explicit acceptance.
  - On `BLOCKED`, present the unresolved requirement, decision, or dependency.

Slice-scoped artifact paths are valid only with `FIT`.
A `SPLIT` or `BLOCKED` result must not leave slice-scoped artifacts attached to the rejected slice.

- After an accepted split, atomically mark the parent `split`, add its child slices, replace its executable work, and recompute the frontier.
- Generate nested parent-child states, dependency edges, and live statuses in `map.puml` from the accepted patch.
- Never schedule the parent as an executable slice after a split.
- A child can return `SPLIT` and repeat this acceptance process.
- Start an accepted child only after its required dependencies are `done`.

#### 2. Audit the design

1. Start a fresh `Review <slice>` agent with `review` in `design-audit` mode.
2. Assign it the `design-audit` lane and its exact lane findings path.
3. Give it the design output paths, initiative, reporting slice, lane, lane findings path, and canonical findings path.
4. Do not give it the delivery conversation.
5. Assign the `review` model role and its resolved model or host default.
6. Consolidate the lane findings into canonical `findings.md` before resuming delivery.
7. On findings, read canonical `findings.md` and resume `Develop <slice>` with the path and all unresolved finding IDs.
8. After each design correction batch, start a fresh scoped design audit.
9. Continue until `CLEAN`, a user stop, or a real blocker.
10. On `CLEAN`, open one Prism artifact viewer session for all recorded ADRs and diagrams.
11. Complete the visual review before the implementation gate.
12. Present `Design: <one-sentence outcome>` and this compact result:

```text
Mode: design-audit
Lane: design-audit
Review focus: requirements, design, boundaries, contracts, security
Coverage: requirements, lifecycle, tests, artifacts, verification
Findings: <exact design-audit lane findings path>
Canonical findings: <configured plans>/<initiative>/<slice>/findings.md
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
  2. Record its hash through a validated state patch and use it as the implementation diff base.
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
  2. Assign the `implementation` lane and its exact lane findings path.
  3. Do not include the delivery conversation.
  4. Pass the design checkpoint hash as the diff base.
  5. Require inspection of changes from that commit.
  6. Assign the `review` model role and its resolved model or host default.
  7. Start one fresh `Review <slice>` agent with the prepared instructions.

Each high-risk lane uses the `security-review` model role with its resolved model or host default.

- For a high-risk slice:
  1. Define a review matrix before starting high-risk review lanes.
  2. Add every lane, its reporting slice, and its lane findings path to state.
  3. Assign each lane its distinct focus and coverage.
  4. Assign each lane the matrix row as its scope and the `Focus` execution profile.
  5. Prepare `review` in `implementation-review` mode with the recorded paths for each lane.
  6. Do not include the delivery conversation.
  7. Pass the design checkpoint hash as the diff base.
  8. Require inspection of changes from that commit.
  9. Do not send identical review instructions to all lanes.
  10. Start one fresh agent for each matrix row with its prepared instructions.

- For each lane:
  - Give it its matrix row, common diff paths, and [review-format.md](../review/references/review-format.md).
  - Give it the initiative, reporting slice, lane name, exact lane findings path, and canonical findings path.
  - Require it to write only to its assigned lane findings path.
  - Require the lane, focus, coverage, status, and findings in its report.

- Keep one active review wave for each slice.
- Start independent lanes in parallel when isolated workspaces are available.
- Wait for every lane result before consolidation.
- Consolidate all lane findings into canonical `findings.md` before sending one correction batch.
- Preserve each finding's stable identifier, lane, evidence, and status history during consolidation.
- Deduplicate equivalent findings without deleting their reporting-lane evidence.
- Check uncovered coverage and route each escalation target from its reporting slice.
- Route an escalation to its affected slice when that slice can own the correction.
- Route an escalation to a user gate when it needs an initiative or requirement decision.
- Do not move the original evidence out of the reporting slice.
- Use canonical `findings.md` as the source of truth instead of passing a transient finding list.
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

An observation interval is a fallback check-in schedule, not a deadline or execution limit.

- Track every active child identifier in `state.json`.
- Never wait with an empty identifier set.
- Treat an empty receiver or agent state as a routing failure and use broker or manual recovery.
- Interrupt only after a positive failure signal, a user request, or an explicit child blocker.
- Before child start, estimate its expected execution time from its phase and execution profile.
- Record the expected completion time, next observation time, and five-minute fallback interval in state.
- Wait for completion, failure, blocker, progress, or replacement events before status observation.

- For each active child:
  1. Start or resume it with the current phase instruction.
  2. Record its expected completion time and initial five-minute fallback interval.
  3. Wait for host events until the expected completion time.
  4. When a meaningful event arrives, apply its state patch and reset the fallback interval to five minutes.
  5. When no event arrives by the expected completion time, wait five minutes before the first fallback observation.
  6. When the fallback interval expires, inspect available status and progress.
  7. When no terminal or meaningful progress event exists, set the next fallback interval to one minute longer.
  8. When non-destructive input is available, send one concise status request after the fallback observation.
  9. When a child reports progress, blocker, failure, or replacement, reset the fallback interval to five minutes and route the event.
  10. Record recovery state only after failure, blocker, user interruption, or unresponsive escalation.
  11. Resume the same child when possible.
  12. After confirmed failure or an approved recovery decision, start a replacement in the same workspace.
  13. Give the replacement the current code and recorded recovery state.
  14. Keep the same model role and resolved model unless the manual policy changes them.

A fallback observation means only that no event arrived.
It is not evidence that the child is stuck.
- Do not poll silently running children at ten-second intervals.
- Do not narrate unchanged waits.
- Do not use waits, replacements, or child failures as correction rounds.
- Do not treat review findings as child failures.
- In manual mode, tell the user to keep one delivery task open through `design` and `implement`.
- Ask the user to run `review` in `design-audit` mode in a fresh task after `FIT` and before implementation.
- Ask the user to run `review` in `implementation-review` mode in a separate task after implementation.

## Gate

This skill has no additional gate.
It ends when every slice is confirmed and the initiative is shipped, or when the user stops it.
