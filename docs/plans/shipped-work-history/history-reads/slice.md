# Read shipped work as history

## Outcome

Ship marks slice documents as history, and every read of a shipped initiative, also one shipped earlier, says it is history, when it shipped, and which slice documents changed after ship.

## Changes

- change `src/server/workflow/shipped-history.mjs`: `markDocument` and `unmarkedContent` for clause 11's mark, `recordShipDocuments`, which marks and records an initiative's slice documents at ship or at the first read of an earlier ship, retrying nothing when the roadmap changed meanwhile, and `shippedHistory`, which answers clause 5's object with `documents`, `changedAfterShip`, and `marked` (§5, §6, §7, §8, §10, §11, §12)
- change `src/server/workflow/roadmap.mjs`: `ship` marks and records the slice documents in its decision and returns `historyMarks` and `historyMarkProblems`, `validateRoadmap` accepts a decision's `documents`, `documentsRecordedAt`, and `documentsFrom`, and `getRoadmap` records an earlier ship's documents on first read (§9, §10, §12)
- change `src/server/workflow/initiative.mjs`: `getInitiative` adds `shippedHistory` for a shipped initiative, also when its record does not exist (§5, §7, §8, §12)
- change `src/server/mcp.mjs`: `get_coordination_state` and `get_review` add `shippedHistory`, the coordination state text carries its message, and a read that marked documents adds a text line that asks to commit them apart from the task's changes (§5, §6, §12)
- change `dist/server/workflow/shipped-history.mjs`, `dist/server/workflow/roadmap.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/workflow.md`: what shipped history is, the mark that ship writes into each slice document and that the first read writes for an earlier ship, committing those marks, and how reads report documents changed after ship (§5, §8, §10, §11, §12)
