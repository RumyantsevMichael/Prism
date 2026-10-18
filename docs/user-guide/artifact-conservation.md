# Artifact conservation through MCP

Prism retains original, audited, and final source evidence and checks planned changes before accepting implementation or completion.
The source baseline includes dirty and untracked files, so a Git commit alone is not the baseline.
The baseline follows the ignore rules also for tracked files, so force-adding an ignored file does not change it.

1. Capture B with `capture_repository_snapshot` before editing and pass the slice `deltaPath` to register its evidence outputs.
2. Search reuse against B with `search_repository_concepts` and keep the returned receipt IDs.
3. Author the version 2 concept delta with typed MCP operations.
4. Capture A, compare B→A, and record the independent design audit in `review.json` through `update_review`.
5. Enter implementation with typed coordination `activeOperations` and the slice `reviewPath`.
6. After authoring finishes, capture F and compare B→F.
7. Record findings, growth justification, text convergence, and scoped unsupported checks through review operations.
8. Accept current lane results and the review wave, then use `finish` to claim completion.

Lane coverage holds project-relative path prefixes, and a review wave starts only when its lanes cover every target file of the comparison.
The `reviewPath` resolves from the project root and names `review.json` in the slice folder.
A refused write lists its problems in the error message.

`get_conservation_evidence` pages immutable manifests, receipts, observations, and measurements.
`get_review` pages the review ledger and reports whether its generated `review.md` needs regeneration.
`check_review_gate` explains prerequisites; the write operations enforce the same checks.
For an unaccepted wave it also lists the assessments that can carry forward from the previous wave and a ready-to-fill skeleton for the rest.
In a correction wave it also lists, for each lane, the files whose bytes changed since the previous wave of the same mode, which the reviewer re-reads in full instead of the whole slice.
A missing semantic runtime can return lexical exploration results but cannot satisfy an addition's semantic evidence requirement.
Preparation starts automatically when a search or comparison needs native analysis.
Concept delta readiness fails when planned additions or modifications copy a change into functions that several files already repeat, until the delta or a delta named in `consolidations` consolidates them.
Comparisons report only the analysis findings that the change adds: a new copy of a function is a failure, and new shared values, repeated key sets, complex units, cohesion splits, and unused exports need a review check.
Known failures such as a retained deletion, scope escape, or stale source cannot be waived with a manual assessment.
`release` and `checkpoint_pause` remove active coordination without claiming completion.
Legacy version 1 deltas and Markdown findings remain readable; explicit migration preserves their content but never imports historical `CLEAN` as current acceptance.
The [maintained procedure](../../skills/design/references/concept-delta.md) describes the full schema and review responsibilities.
