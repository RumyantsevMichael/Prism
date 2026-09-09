---
name: orchestrate
description: "Run or resume a Prism initiative through recursive design, implementation, independent review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

Design creates slice outcomes and architecture.
One delivery context designs and implements each atomic slice, while fresh contexts review its artifacts.
The [workflow terms](../workflow/SKILL.md#common-terms) define the shared lifecycle.

## 1. Start or resume

1. Read `.prism/workflow.md` and [delegation.md](../workflow/references/delegation.md).
2. Read the roadmap initiative, intent, and Approved requirement links.
3. If these inputs are missing, return the missing input to `ideate` or `roadmap`.
4. Read the initiative's `map.puml`, `state.json`, and linked evidence when they exist.
5. Inspect recorded workers and workspaces before resuming or replacing them.
6. Resolve missing run settings with the user, retaining existing authorization.

| Setting | Default | Effect |
| --- | --- | --- |
| Decision autonomy | `conservative` | User accepts splits, dependency changes, and implementation after design audit. |
| Decision autonomy | `broad` alternative | Orchestrator accepts these steps within Approved intent when consequential decisions are settled. |
| Commit | `off` | `on` permits design and final checkpoints for slice-owned changes. |
| Push | `off` | `on` permits pushing authorized commits. |
| Slice continuation | `auto` | `stepwise` requires user continuation after each completed slice. |
| Models | Host defaults | User-selected delivery, review, and security-review models override their roles. |

Both autonomy modes require user correctness confirmation and preserve requirement approval and project decision rules.
Missing records establish neither approval nor completion.

7. If no map exists:
   1. Use `write-map` to create one root with the initiative title and complete Approved requirement assignment.
   2. Use `roadmap` to mark the initiative `planned` and link its map.
8. If records conflict, ask the responsible worker to reconcile them against actual artifacts before dependent work.

## 2. Design recursively

1. Select candidate leaves from the map, allowing design before prerequisite implementation when evidence permits.
2. Collect all ancestor diagram and ADR paths from retained design results, including inherited paths.
3. Start or resume `Develop <slice>` with `design`, its requirements, map, workspace, settings, and ancestor paths.
4. When `slice.md` exists, supply its path as the outcome record.
5. Use `write-map` to mark the leaf `in-progress` and `roadmap` to mark the initiative `in-progress`.
6. Route the design result:
   - For `SPLIT`:
     1. Read the reported child folders and their `slice.md` files.
     2. Check unique slugs, unchanged parent title, and exact collective coverage of the parent's requirement assignment.
     3. Derive prerequisite edges from the parent design and existing map, returning architectural uncertainty to design.
     4. Obtain split and dependency acceptance under the autonomy setting.
     5. Persist only a result fact that a later context needs and that the map, slice record, diagrams, ADRs, findings, or state note does not already contain.
     6. Use `write-map` to add the accepted children and dependencies under the existing parent.
     7. Repeat this section for the new leaves.
   - For `FIT`, continue to section 3.
   - For `BLOCKED`, record the unresolved issue and continue independent work.

An accepted split parent never executes again and completes only after all descendant leaves and preserved findings pass completion gates.

- When a proposal fails coverage or conflicts with the map, return the specific defect to design.
- When evidence changes dependencies, route the change under the autonomy setting before applying it through `write-map`.
- After a late split, record preserved work and original lane paths in the resume note for the completion gate.
- When a finding spans slices, retain its reporting lane and route correction without transferring its identity or evidence.

## 3. Audit and implement

1. Run section 4 in `design-audit` mode until all assigned lanes are `CLEAN`.
2. Confirm the expected red checkpoint or explicit documentation-only exemption.
3. Complete [visual review](../workflow/references/visual-review.md) before the implementation gate.
4. Obtain implementation acceptance under the autonomy setting.
5. Wait for effective dependencies to complete, including inherited prerequisites.
6. Ask delivery to recheck fit against integrated dependency changes.
7. If fit or design changed, return to section 2 before implementation.
8. Preserve the audited tree as an immutable review base, including untracked files and deletions.
9. Resume the same delivery context with `implement` and the review base.
10. Route its result:
    - For verified code, run section 4 in `implementation-review` mode.
    - For a required redesign, return to section 2 with existing work and findings preserved.
    - For `BLOCKED`, record the unresolved issue and continue independent work.
11. When implementation review is `CLEAN`, continue to section 5.

The review base is the design checkpoint commit with Commit on, otherwise an immutable working-tree snapshot.
Every implementation correction review uses that same base.
Concurrent delivery requires isolated workspaces.

## 4. Review and correct

One reviewer covers a normal slice.
Distinct risk scopes can use separate lanes with one writer per findings file.
The [review format](../review/references/review-format.md) defines each lane record and compact result.

1. Assign fresh reviewers the mode, slice, lane focus, exact findings path, artifact paths, verification evidence, and applicable review base.
2. Exclude the delivery conversation from reviewer inputs.
3. Wait for every assigned lane to return its current result.
4. Route each lane result:
   - If evidence is outdated, repeat that lane against the current artifacts and correction evidence.
   - If findings remain:
     1. Send the lane path and unresolved IDs to the same delivery context using `design` or `implement` for their source.
     2. Route delivery's correction result:
        - For corrected artifacts, start fresh reviewers for affected lanes with original findings files and current verification evidence.
        - For `SPLIT` or required redesign, preserve lane evidence and return to section 2 before further review.
        - For `BLOCKED`, record the unresolved issue and continue independent work.
     3. Repeat correction review until all lanes are `CLEAN`, work returns to design, a blocker exists, or the user stops.
   - If a design audit reports only implementation gaps, route them to `implement` after the implementation gate.
5. If repeated corrections fail, use a replacement delivery context or a new design audit to investigate the cause.

A new design audit requires evidence that changes fit, requirements, architecture, boundaries, dependencies, or planned verification.
Reviewers receive verification results and probe paths without a request to rerun the complete suite.

## 5. Integrate and confirm

1. Preserve the reviewed result before integrating an isolated workspace.
2. Ask delivery to compare and verify the integrated tree, including conflict resolutions and affected dependencies.
3. If integration changes reviewed behavior or leaves uncertain equivalence, repeat affected review before confirmation.
4. For each split ancestor whose final unfinished descendant is this leaf:
   1. Dispatch fresh reviewers to its preserved lanes with original findings, applicable review bases, and current descendant artifacts and verification.
   2. If findings remain, route correction to the affected delivery context or unresolved decision without reactivating the parent.
   3. Repeat affected lane review until every preserved lane is `CLEAN`, or record the blocker and continue independent work.
   4. Keep aggregate completion blocked until every preserved lane is `CLEAN`.
5. Complete visual review of changed artifacts.
6. Present verification, review results, and remaining limitations for user correctness confirmation.
7. After confirmation:
   1. Accept Proposed ADRs only after all governed behavior is verified and confirmed, including behavior across relevant children.
   2. When accepting a replacement ADR, mark its original `Superseded` and link both records under project rules.
   3. Apply commit and push settings to slice-owned changes, preserving unrelated changes.
   4. When all completion gates pass:
      1. Use `write-map` to mark the leaf `done`.
      2. Remove its active resume entry.
8. If confirmed behavior changes, repeat affected verification, review, and confirmation.
9. If leaves remain, continue automatically or request continuation under the stepwise setting.
10. When all leaves are `done`, graduate durable information and use `roadmap` to mark the initiative `shipped`.

Coordination cleanup follows durable graduation and the `shipped` transition.
Corrections do not create intermediate commits.

## 6. Preserve continuity

The initiative's `state.json` records current coordination facts beside `map.puml`.
The map alone owns slice topology, requirement assignments, dependencies, and status.

```json
{
  "settings": { "autonomy": "broad", "commit": "off", "push": "off", "continuation": "auto", "models": "host defaults" },
  "active": [{ "slice": "download", "activity": "design audit", "workers": ["agent-7"], "workspace": "/work/reports" }],
  "pending": ["User decision: report retention period"],
  "next": ["Return audit findings to delivery"],
  "evidence": ["download/design-audit/findings.md", "download/recovery.md"]
}
```

Paths resolve from the note's directory unless absolute.
Empty lists mean no current item.
One orchestrator writes the note and requests map changes.

1. After meaningful results or before a pause, update the note with current workers, blockers, next actions, and evidence paths.
2. Persist conversation-only results, review bases, ancestor evidence, or dependent user decisions in the owning slice folder only when a later context needs them and no existing artifact can own them.
3. Before replacing coordination formats, preserve older files until their needed information has a durable home.
4. After compaction or handoff, repeat section 1.
5. Give replacement workers the workspace, findings, recovery record, and retained ancestor diagram and ADR paths.
6. Prefer host progress events, using five-minute observations only when events are unavailable.
7. Treat the first timeout from an explore or review worker as non-terminal.
8. Give the same worker more time before stopping or replacing it.
9. When the host ends a worker turn at a timeout, resume that worker with a larger allowance before creating a replacement.
10. Replace a worker only after explicit completion, failure, blocker, or confirmed host termination.
11. Broker child delegation through the procedure when necessary.
12. If fresh review is unavailable, ask the user to run a separate review task.

- Don't
  - Create user-owned tasks as child-agent substitutes.
