# Artifact conservation through MCP

Prism retains original, audited, and final source evidence and checks planned changes before accepting implementation or completion.
The source baseline includes dirty and untracked files, so a Git commit alone is not the baseline.
The baseline follows the ignore rules also for tracked files, so force-adding an ignored file does not change it.
A slice with an accepted design completes on a [verification run](workflow.md#verification) instead, so this procedure applies to slices designed without one.

1. Capture B with `capture_repository_snapshot` before editing and pass the slice's `initiative` and `slice` identifiers to register its evidence outputs.
2. Search reuse against B with `search_repository_concepts` and keep the returned receipt IDs.
3. Author the version 2 change map with typed `update_change_map` operations, and read it in pages with `get_change_map`.
4. Capture A, compare B→A with `compare_change_map`, and record the independent design audit in the slice's review record through `update_review`.
5. Enter implementation with typed coordination `activeOperations` for the slice.
6. After authoring finishes, capture F and compare B→F.
   When out-of-scope work from others landed after B, pass the task-start snapshot T as `startSnapshotId`.
7. Record findings, growth justification, text convergence, and scoped unsupported checks through review operations.
8. Accept current lane results and the review wave, then use `finish` to claim completion.

Lane coverage holds project-relative path prefixes, and a review wave starts only when its lanes cover every target file of the comparison.
Every change map and review tool takes the slice's `initiative` and `slice` identifiers instead of a file path.
A refused write lists its problems in the error message.

`get_conservation_evidence` pages immutable manifests, receipts, observations, and measurements.
`get_review` pages the review ledger and reports whether its generated `review.md` needs regeneration.
Pass `wave` to `get_review` to keep only the findings that wave raised, that wave, or its assessments and conflicts.
`check_review_gate` explains prerequisites; the write operations enforce the same checks.
For an unaccepted wave it also lists the assessments that can carry forward from the previous wave and a ready-to-fill skeleton for the rest.
In a correction wave it also lists, for each lane, the files whose bytes changed since the previous wave of the same mode, which the reviewer re-reads in full instead of the whole slice.
A missing semantic runtime can return lexical exploration results but cannot satisfy an addition's semantic evidence requirement.
Preparation starts automatically when a search or comparison needs native analysis.
In a repository that declares components, a baseline's analysis is prepared per component, as [Index a repository per component](repository-intelligence.md#index-a-repository-per-component) describes, and a component whose files are unchanged reuses its index.
A comparison, a change map check, or a derived change map waits with `preparing` until no component of the baseline is waiting or preparing.
The baseline's analysis then holds the units of every component whose index is ready, and holds each file of a component whose preparation failed without units and as not covered.
Its diagnostics start with `components_missing`, which names each failed component and its failure, and a changed file without coverage needs an explicit manual check.
When every component failed, no analysis is kept, as when the one index of a repository without components fails.
A later comparison or check prepares a failed component again, as a search does, and keeps the new analysis, so the component's files are covered once its preparation succeeds.
Change map readiness fails when planned additions or modifications copy a change into functions that several files already repeat, until the change map or a change map named in `consolidations` consolidates them.
Comparisons report only the analysis findings that the change adds: a new copy of a function is a failure, and new shared values, repeated key sets, complex units, cohesion splits, and unused exports need a review check.
Known failures such as a retained deletion, scope escape, or stale source cannot be waived with a manual assessment.
A merge from `main` or another slice's plans can change files outside the scope after B.
To keep these files from blocking the review, capture T with `capture_repository_snapshot` before the task's next edit.
Then pass T as `startSnapshotId` to each later `compare_change_map` call.
An out-of-scope file that T already holds as it is in F gets an `outside_scope_before_start` observation with severity `review_required`.
Each of these observations names the `startSnapshotId` that attributed it, so a different T gives different observation IDs.
The assigned reviewer compares T with earlier waves and checks each file against its upstream source, and one `manual` assessment can name all of them.
A file that T omits or excludes is not attributed, and an incomplete T is reported in the same way as an incomplete B or F.
An out-of-scope file that changed after T stays an `outside_scope` failure.
Files inside the scope keep their judgment against B, whatever T holds.
The comparison response and its retained evidence name `startSnapshotId`, or `null` without T.
`release` and `checkpoint_pause` remove active coordination without claiming completion.
Legacy version 1 change maps and Markdown findings remain readable; explicit migration preserves their content but never imports historical `CLEAN` as current acceptance.
A change map from an earlier version, including one named `concept-delta.json`, moves into the project's records with its bytes unchanged, so its revision, evidence ownership, and review bindings stay valid and an accepted review stays accepted.
The [maintained procedure](../../skills/design/references/change-map.md) describes the full schema and review responsibilities.
