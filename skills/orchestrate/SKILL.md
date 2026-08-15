---
name: orchestrate
description: "Run a multi-slice Prism initiative through planning, continuous delivery contexts, fresh review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
---

# Orchestrate an initiative

Coordinate `plan` → (`design` → `implement` → `review`) for every outcome slice.
Do not author phase content in this context.
Keep only routing state, active child identifiers, gates, and recovery status here.

Read `.prism/workflow.md` and the delegation procedure in `workflow` first.

## 1. Set the run contract

Ask once for these run settings:

- **Decision autonomy:** conservative or broad.
- **Commit:** off or on.
- **Push:** off or on.
- **Slice continuation:** auto or stepwise.

Use conservative, commit off, push off, and auto by default.
No autonomy level can change an Approved requirement, create an unsanctioned ADR, bypass plan acceptance, accept a slice split, or confirm correctness.

Detect the execution mode from callable capabilities:

- **Parallel:** child-start and isolated-workspace actions exist.
- **Sequential:** child-start exists without isolated workspaces.
- **Manual:** no child-start action exists.

A wait action alone does not enable parallel or sequential mode.

## 2. Resolve the initiative

When an accepted initiative plan exists, read `plan.md` and `slices.puml`.
When the work needs several outcomes and has no plan, start a fresh `Plan <initiative>` agent.
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
Before it starts, mark the slice `in-progress`.
When this is the initiative's first active slice, mark the roadmap initiative `in-progress`.

Handle its compact result:

- `FIT` → continue without a user gate when no consequential decision remains.
- `SPLIT` → present the child slices and wait for explicit acceptance.
- `BLOCKED` → present the unresolved requirement, decision, or dependency.

After an accepted split, resume the same `Develop <slice>` agent with the first accepted child slice.
Update the slice DAG for the remaining child slices.

### Implement

After `FIT`, resume the same `Develop <slice>` agent and instruct it to run `implement`.
Do not repeat design reasoning or file contents.
Pass only the user decision when one occurred.

When the agent returns `READY FOR REVIEW`, record its diff base, verification status, paths, and security surface.
Do not accept a claim of independent review from `Develop <slice>`.

### Review

Start a fresh `Review <slice>` agent with `review` and the recorded paths.
The reviewer receives no delivery conversation.

On `CLEAN`, continue to the slice gate.
On findings, resume `Develop <slice>` with the complete finding list.
After the fix batch, start one fresh scoped re-review.
Stop when actionable findings remain after that re-review.

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
Give it only the request scope, paths, scratch destination, and profile.
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

Do not narrate unchanged waits.
Do not use waits or replacements as correction rounds.

In manual mode, tell the user to keep one delivery task open through `design` and `implement`.
Ask the user to start a separate `review` task after implementation.

## Gate

This skill has no additional gate.
It ends when every slice is confirmed and the initiative is shipped, or when the user stops it.
