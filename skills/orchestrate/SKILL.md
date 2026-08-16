---
name: orchestrate
description: "Run a multi-slice Prism initiative through planning, design audit, continuous delivery contexts, exhaustive review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
---

# Orchestrate an initiative

Coordinate `plan` → (`design` → `design-audit` → `implement` → `review`) for every outcome slice.
Do not author phase content in this context.
Keep only routing state, active child identifiers, gates, and recovery status here.

Read `.prism/workflow.md` and the delegation procedure in `workflow` first.

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
- **Design audit model:** host reviewer model when available, otherwise host default.
- **Review model:** host reviewer model when available, otherwise host default.
- **High-risk review model:** host security model when available, then host reviewer model, then host default.

When the policy is `manual`, ask for model assignments for planning, delivery, design audit, review, and high-risk review before spawning any child.
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
When the work needs several outcomes and has no plan, start a fresh `Plan <initiative>` agent.
Use this model assignment:

- Model role: `planning`
- Model: <resolved model or host default>

Present its slice graph for user acceptance.

Treat a self-contained capability as one standalone slice without creating a plan.

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
Use this model assignment:

- Model role: `delivery`
- Model: <resolved model or host default>

Before it starts, mark the slice `in-progress`.
When this is the initiative's first active slice, mark the roadmap initiative `in-progress`.

Handle its compact result:

- `FIT` → run the design audit.
- `SPLIT` → present the child slices and wait for explicit acceptance.
- `BLOCKED` → present the unresolved requirement, decision, or dependency.

After an accepted split, resume the same `Develop <slice>` agent with the first accepted child slice.
Update the slice DAG for the remaining child slices.

### Design audit

Start a fresh `Audit <slice>` agent with `design-audit` and the recorded design paths.
The auditor receives no delivery conversation.
Use this model assignment:

- Model role: `design-audit`
- Model: <resolved model or host default>

On findings, resume `Develop <slice>` with the complete finding list.
After each design correction batch, start one fresh scoped design audit.
Continue the design audit loop until `CLEAN`, a user stop, or a real blocker.
On `CLEAN`, open one Prism artifact viewer session for all recorded design artifacts and diagrams through the configured `Review browser`.
Use the complete artifact tree instead of opening one viewer session per path.
When no browser capability exists, present the review URL and source artifacts.
After visual review, present:

```text
Design: <one-sentence outcome>
Artifacts: <recorded design artifact and diagram paths>
Audit: CLEAN
Contracts: <contract paths or NO CONTRACT NEEDED reasons>
Verification: <exact command>
```

When autonomy is conservative, ask whether to proceed to implementation.
When autonomy is broad and no consequential decision remains, continue to implementation.

### Implement

After a clean design audit and visual artifact review, resume the same `Develop <slice>` agent and instruct it to run `implement`.
Do not repeat design reasoning or file contents.
Pass only the user decision when one occurred.

When the agent returns `READY FOR REVIEW`, record its diff base, verification status, paths, and security surface.
Record every contract declaration with its canonical path, consumers, and verification command, or its specific `NO CONTRACT NEEDED` reason.
Do not accept a claim of independent review from `Develop <slice>`.
Pass the implementer's verification status and test paths to reviewers.
Do not assign the full test suite or configured verification commands to reviewers.
Allow a reviewer to run only a focused probe that can confirm or reject a suspected defect.

### Review

Use one exhaustive `Review <slice>` agent for a normal slice.
Use independent review lanes for a high-risk slice with lifecycle, concurrency, replay, security, IPC, migration, or public-boundary concerns.
Start a fresh `Review <slice>` agent, or one fresh agent per review lane, with `review` and the recorded paths.
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

Give each lane its matrix row, the common diff paths, and the review output reference.
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

On findings, resume `Develop <slice>` with the complete finding list.
After every implementation correction, start a fresh review or review wave.
Repeat the same review matrix after every implementation correction.
Continue the review loop until `CLEAN`, a user stop, or a real blocker.
Do not stop after one re-review while findings remain.
Distinguish review findings from child-agent failures, timeouts, and recovery replacements.
On `CLEAN`, open one Prism artifact viewer session for all changed artifacts and diagrams through the configured `Review browser` before the final correctness gate.
Use the complete artifact tree instead of opening one viewer session per path.
When no browser capability exists, present the review URL and source artifacts.
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

For each active child:

1. Start or resume it with the current phase instruction.
2. Relay a real user question and resume the same child with the answer.
3. Continue waiting after a timeout when no positive failure signal exists.
4. Record recovery state only after failure, blocker, or user interruption.
5. Resume the same child when possible.
6. Start a replacement in the same workspace from current code and recorded recovery state.
Keep the same model role and resolved model for a replacement unless the manual policy explicitly changes them.

Do not narrate unchanged waits.
Do not use waits, replacements, or child-agent failures as correction rounds.
Do not treat review findings as child-agent failures.
Keep one active review wave per slice.

In manual mode, tell the user to keep one delivery task open through `design` and `implement`.
Ask the user to run `design-audit` in a fresh task after `FIT` and before implementation.
Ask the user to start a separate `review` task after implementation.

## Gate

This skill has no additional gate.
It ends when every slice is confirmed and the initiative is shipped, or when the user stops it.
