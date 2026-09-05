---
name: orchestrate
description: "Run a multi-slice Prism initiative through recursive design, continuous delivery contexts, independent review, and user gates."
disable-model-invocation: true
argument-hint: '[initiative]'
sdm: "0.3"
---

# Orchestrate an initiative

The orchestrator gives each activity the right context, records progress, and routes decisions.
Design owns slice boundaries and dependencies.
Delivery owns code and verification.
Fresh reviewers challenge their results.
Agents use judgment within the Approved intent and the user's authority.

## 1. Start or resume

1. Read `.prism/workflow.md` and [delegation.md](../workflow/references/delegation.md).
2. Resolve the initiative's roadmap entry, intent, and Approved requirement links.
3. If intent or Approved requirements are missing, return the missing input to `ideate` or `roadmap`.
4. Read existing `map.puml`, `state.json`, and the evidence needed for current work.
5. Inspect recorded workers and workspaces before starting replacements.
6. Resolve missing run settings with the user once, using existing authorization when available.

| Setting | Default | Alternative |
| --- | --- | --- |
| Decision autonomy | `conservative` | `broad` |
| Commit | `off` | `on` |
| Push | `off` | `on` |
| Slice continuation | `auto` | `stepwise` |
| Models | Host defaults | User-selected delivery, review, and security-review models |

Conservative autonomy requires user acceptance of splits, dependency changes, and implementation after design audit.
Broad autonomy permits these steps when Approved intent is preserved and no consequential decision remains.
Both modes require user correctness confirmation.
Neither mode authorizes requirement changes or overrides project decision rules.

- When no map exists, ask `write-map` to create one root with the initiative title and all Approved requirement references.
- After creating the initial map, use `roadmap` to mark the initiative `planned` and record the map link.
- After compaction or handoff, repeat the resume checks before continuing.
- If records disagree, inspect the actual artifacts and ask the responsible worker to resolve the disputed facts.
- Preserve older coordination files before replacing their format.
- Do not infer approval or completion from a missing record.

## 2. Explore and split

1. Select candidate leaves from the map.
2. Start one `Develop <slice>` child per selected leaf with `design` as its first activity.
3. Supply its requirements, map context, workspace, run settings, and slice findings path.
4. When delivery starts, ask `write-map` to show `in-progress` and `roadmap` to mark the initiative `in-progress`.
5. Route the design result:
   - For `FIT`, retain its compact result and continue to design audit.
   - For `SPLIT`, check requirement coverage and route acceptance under the autonomy setting.
   - For a dependency change, route acceptance under the same setting.
   - For `BLOCKED`, record the missing decision or evidence and continue independent work.
6. For an accepted proposal, ask `write-map` to apply the exact titles, children, requirements, and dependencies.
7. Repeat design for each new child until the leaves fit.

Design discovery can precede dependency implementation when enough evidence exists to reason about the dependent outcome.
A split parent remains in the map and never executes again.
Its completion follows from all descendant leaves being `done`.

- Return an unclear or inconsistent proposal to design with the problem, rather than choosing replacement boundaries.
- For a split after work starts, require design to assign existing code, artifacts, and unresolved findings to children.
- Preserve that work and its evidence until the children account for it.
- Require each child to confirm fit and pass its own review gates.

## 3. Audit and implement

1. Start a fresh `review` child in `design-audit` mode with the design artifacts and requirements, excluding the delivery conversation.
2. Follow the review procedure below until the design is `CLEAN`.
3. Complete [visual review](../workflow/references/visual-review.md).
4. Apply the implementation gate from the autonomy setting.
5. Wait for the slice's dependencies, including inherited dependencies, to complete before implementation.
6. Ask delivery to recheck fit against integrated dependency changes.
7. If design changes, repeat its audit and implementation gate.
8. Preserve the audited working tree as the review base, including untracked files and deletions.
9. Resume the same delivery child with `implement`.
10. When delivery returns verified code, start fresh `review` children in `implementation-review` mode.

With Commit on, the design checkpoint commit is the review base.
With Commit off, an immutable working-tree snapshot supplies that base.
Correction reviews compare against the same base so earlier changes remain in scope.

- If implementation outgrows the slice, return to design and the recursive split flow.
- Keep one delivery context and workspace per slice when the host permits it.
- Run concurrent delivery only in isolated workspaces.
- Keep overlapping edits sequential when isolation is unavailable.

## 4. Review and correct

One reviewer covers a normal slice.
Separate lanes can cover distinct risks such as security, lifecycle, and integration.
The [review format](../review/references/review-format.md) defines findings and compact results.

1. Assign each reviewer an exact slice, scope, writable lane findings path, canonical findings path, and review base when applicable.
2. Create missing findings files before dispatch.
3. Give each reviewer current correction evidence from canonical findings.
4. Keep reviewers independent of the delivery conversation.
5. Wait for all assigned reviewers before consolidating findings into `<initiative>/<slice>/findings.md` under the configured plans path.
6. Preserve finding identities, correction evidence, and history when merging or deduplicating results.
7. Return all unresolved findings to delivery as one correction batch.
8. After correction and affected verification, start fresh reviewers until `CLEAN`, a real blocker, or a user stop.

- Use distinct scopes for parallel lanes and one writer per lane file.
- Pass verification results and test paths without asking reviewers to rerun the complete suite.
- Preserve reviewer probes and their expected failure with the associated findings.
- If review used outdated code or correction evidence, repeat the affected review against the current result.
- Keep cross-slice findings in their reporting slice and route their correction to the affected slice or user decision.
- If corrections repeatedly fail, use a fresh delivery context or design audit to reassess the cause.

## 5. Integrate and confirm

1. Preserve the reviewed result before integrating an isolated workspace.
2. Ask delivery to verify the integrated result, including conflict resolutions and affected dependencies.
3. If integration changes reviewed behavior or leaves uncertainty, repeat affected design or implementation review.
4. Complete visual review of the changed artifacts.
5. Present verification, review results, and unfinished work for user correctness confirmation.
6. After confirmation, accept implemented Proposed ADRs under the project rules.
7. Apply the commit and push settings to slice-owned changes only.
8. Ask `write-map` to mark the leaf `done` and remove its active entry from the resume note.
9. Continue eligible leaves automatically, or ask before the next slice under stepwise continuation.
10. When every leaf is done, graduate durable information and use `roadmap` to mark the initiative `shipped`.

- With Commit on, create the design and final checkpoints without intermediate correction commits.
- Preserve unrelated working-tree changes.
- If the result changes after confirmation, repeat affected verification, review, and confirmation.
- Remove scratch coordination files only after their needed information has durable homes.

## 6. Resume note

The map owns topology, requirement coverage, dependencies, and slice status.
`state.json` is a short note for the next orchestrator, beside the map.
Its values describe current facts in plain language.

```json
{
  "settings": { "autonomy": "broad", "commit": "off", "push": "off", "continuation": "auto", "models": "host defaults" },
  "active": [
    { "slice": "download", "activity": "design audit", "workers": ["agent-7"], "workspace": "/work/reports" }
  ],
  "pending": ["User decision: report retention period"],
  "next": ["Return audit findings to the download delivery context"],
  "evidence": ["download/findings.md", "download/recovery.md"]
}
```

Paths in the note resolve from its directory unless absolute.
Empty lists mean no current item.
Evidence links retain needed results, review bases, and user decisions without copying artifacts into state.

- Update the note after meaningful results and before a pause or handoff.
- Keep only facts needed to continue safely.
- Save a compact result in the slice directory when its evidence would otherwise exist only in a conversation.
- Record pending decisions explicitly and retain their resolution when later actions depend on it.
- Let workers return their skill's result without a state patch or dispatch schema.
- Keep one orchestrator responsible for the note and map requests.

## 7. Supervision

- Prefer host completion and progress events.
- When events are unavailable, use a five-minute observation interval.
- Treat silence as missing information, not failure.
- Resume a recorded child when possible before starting a replacement.
- Give replacements the current workspace, findings, and available recovery notes.
- Use the host's child agents and permission inheritance through the delegation procedure.
- If a child needs delegation it cannot perform, broker its scoped request through a capable parent.
- If no child-start capability exists, guide the user through one delivery task and separate fresh review tasks.
- Do not create user-owned tasks as a substitute for native child agents.
- Do not narrate unchanged waits.
