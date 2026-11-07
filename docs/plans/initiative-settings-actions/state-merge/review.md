# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: 53655d6ccf0a379f8ddffe64d65d161f49a3d34d
Base: 6069fce

- data-integrity: FINDINGS (reviewer-sm-integrity-1)

## implementation-review: wave-2

Verified tree: 2eef08d47d1188c7de8bb21a165aabf83c0bac40
Base: 6069fce

- data-integrity: FINDINGS (reviewer-sm-integrity-2)

## implementation-review/data-integrity/adr-fallback-rule: ADR decision still requires a whole-file fallback for every unit changed differently on both sides

- Status: VERIFIED
- Severity: medium
- Evidence: The Decision keeps 'A structural merge MUST take each unit from the side that changed it' and 'A structural merge whose unit changed differently on both sides ... MUST fall back to the whole-file rule', and the diff only adds the coordination state to the list of structurally merged kinds. Clause 26 and mergeCoordinationState deliberately resolve three such cases without a fallback: a setting changed differently on both sides takes the later person mark, a gate answered differently on both sides keeps the earlier answeredAt, and a gate or active slice removed on one side and changed on the other stays removed (probe in scratchpad probe.mjs: base gate unanswered, local answered, upstream removed -> merged pending is empty, no conflict). The added Implementation paragraph describes these cases, so the ADR's MUST lines now contradict its own description and the code.
- Condition to close: The Decision section of record-store-git-sync.md states that the coordination state resolves a setting both sides changed by the later person mark, an answer both sides recorded by the earlier answeredAt, and a gate or active slice one side removed as removed, as exceptions to the take-the-changing-side and fall-back rules, with no other change to those MUST lines for the roadmap and initiative kinds.
- Implementer evidence: 6f483d4: the ADR Decision states the three coordination state cases that do not fall back, with a decision log entry.

## implementation-review/data-integrity/state-size-limit: Merge refuses coordination states over 1 MiB although no coordination state writer or reader has that limit

- Status: VERIFIED
- Severity: low
- Evidence: mergeCoordinationState adds STATE_MAX_BYTES = 1 MiB and returns a conflict above it, but updateCoordinationState, the person-action writer, and loadState enforce no size limit, and the record store's read limit is 64 MiB (record-store.mjs RECORD_MAX_BYTES). The 1 MiB value is the initiative record's own limit (initiative.mjs RECORD_MAX_BYTES), which its writer also enforces. So a valid coordination state above 1 MiB, which every writer accepts, can never merge and always falls back to a saved conflict, and clause 27's 'the record size limit' does not exist for this kind; the ADR line 'stays within 1 MiB' and the code agree only with each other.
- Condition to close: Either the coordination state's writers enforce the same size limit the merge applies, or the merge's size check uses the limit that coordination state writing and reading already enforce, and the ADR names that same limit.
- Implementer evidence: 62a6b2c: every coordination state write goes through one serializer that refuses over 1 MiB, so any accepted state can merge (coordination-state-size.test.mjs).

## implementation-review/data-integrity/state-limit-below-caps: The 1 MiB coordination state limit is below what history and closed-gate caps admit, so valid gate answers get refused and nothing can trim them

- Status: OPEN
- Severity: medium
- Evidence: stateContents refuses a state over 1 MiB, but validation admits 200 history entries whose gate.answer after holds a note of up to 4000 characters, plus 20 closed gates each with question 4000, context 8000, options, and an answered note; history is written only by the person's actions and closed only by resolves, and validateChanges rejects history while closed cannot be changed, so no tool can shrink them. Probe through the public writers (ask, person answer with a 4000-character note, resolve, repeated): the 63rd answer is refused with artifact_too_large at 1025318 bytes with history 62, and from then on every such answer in the browser is refused for that initiative while history is far below its 200 cap; ASCII notes reach the limit too (200 x ~4.3 KB history + 20 x ~17 KB closed). Before 62a6b2c these writes succeeded (record read limit 64 MiB). Failing test: test/server/coordination-state-size-history.test.mjs.
- Condition to close: test/server/coordination-state-size-history.test.mjs passes, and the coordination state limit that writers and the merge share admits a state holding 200 maximal history entries and 20 maximal closed gates, or the history and answer limits are bounded so that such a state fits, with the ADR naming the same limit.
- Implementer evidence: none

