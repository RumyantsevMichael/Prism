# Initiative record

The initiative record owns slice titles, outcomes, hierarchy, requirement assignments, dependencies, and structural status.
It lives at `<configured plans>/<initiative>/initiative.json` beside `state.json`.
`initiative.md` beside it is a generated view.
Design proposes slice outcomes and titles, while orchestration owns parent relationships and dependencies.
Agents read the record with `get_initiative` and change it with `update_initiative`, never by editing the JSON or its generated view.

## Operations

| Operation | Use |
| --- | --- |
| `create` | Create the root slice with its slug, title, outcome, and complete Approved requirement assignment. |
| `import_map` | Create the record from a legacy `map.puml`, taking outcomes from existing `slice.md` files. |
| `split` | Apply an accepted split with each child's slug, title, outcome, and requirements. |
| `set_dependencies` | Replace one slice's prerequisite slugs after the required acceptance. |
| `set_status` | Set a leaf status. |
| `update_slice` | Change an accepted slice title or outcome. |
| `regenerate_markdown` | Rewrite the generated view without changing the record. |

- Read the record and keep its revision before every update.
- Send one batch of operations with that revision as `expectedRevision`, or `null` when the record does not exist.
- If the server reports `revision_conflict`, read the record again and reapply the accepted change.
- Keep worker IDs, gates, findings, evidence, and phase metadata outside the record.

The server validates the whole candidate graph before writing, so an invalid batch changes nothing.
`get_initiative` returns the root, leaves, leaf status counts, effective dependencies, completion, design candidates, slices whose dependencies are complete, and whether every leaf is done.

## Graph invariants

Slugs use letters, digits, hyphens, and underscores, and each slug is unique within the initiative.
There is exactly one root with the complete Approved initiative requirement assignment.
Every slice has a nonempty title and requirement assignment.
Each parent's direct children cover exactly its assignment, with shared references allowed.
Only accepted splits add children.
A parent remains `split` permanently and cannot execute.
Leaf statuses are `not-started`, `in-progress`, `blocked`, `deferred`, and `done`.
A `done` status requires the slice's passing completion gate.

Dependencies point from the dependent slice to its prerequisite.
Every leaf inherits ancestor dependencies.
A dependency on a parent expands to all descendant leaves.
The expanded graph has no self-dependency or cycle.
All descendant leaves must be `done` for aggregate completion.
Blocked and deferred leaves are incomplete.

The server cannot prove approval, fit, or verification beyond the completion gate.
Orchestration checks that evidence before admitting implementation or confirming completion.
Design can start before implementation dependencies complete.
