# MCP review records

One slice `review.json` is authoritative for all its lanes and waves.
`review.md` is a generated human view; projection failure never rolls back accepted JSON.
The [conservation procedure](../../design/references/concept-delta.md) defines source capture, native reuse receipts, measurement, growth evidence, and text convergence.

## Read and mutate

1. Read `get_review` with `projectRoot`, `reviewPath`, and bounded pages.
2. Pin `expectedRevision` across pages and use that revision for `update_review`.
3. Create a missing record with `expectedRevision: null`, the sibling `deltaPath`, delivery worker, and coordinator actor.
4. Submit typed operations in atomic batches of at most 100.
5. After a conflict, reread before retrying.
6. If `projectionStale` is true, use `regenerate_markdown` without editing JSON or Markdown directly.

Actors name their worker ID and declared role: `coordinator`, `delivery`, or `reviewer`.
These identities enforce workflow ownership; they are not host authentication credentials.
Findings retain their original mode, lane, local ID, aliases, routing, and status history.

| Owner | Operations and constraints |
| --- | --- |
| Coordinator | `start_wave` pins mode, delta revision, snapshot, comparison, and lanes; `assign_delivery` selects delivery. |
| Assigned reviewer | `open_finding` records title, severity, affected path, evidence, closing condition, aliases, and escalation target. |
| Delivery | `set_finding_status` records `IN PROGRESS` or `FIXED` with correction evidence. |
| Fresh assigned reviewer | `set_finding_status` records `VERIFIED` or `REOPENED`; only corrected `FIXED` findings can become `VERIFIED`. |
| Delivery or reviewer | `record_assessment` records growth, convergence, private-detail attribution, or scoped unsupported checks. |
| Fresh assigned reviewer | `accept_assessment` verifies delivery evidence; reviewer-authored assessments identify the responsible reviewer directly. |
| Coordinator | `record_exchange` disqualifies a correction participant from verification of that correction. |
| Reviewer or coordinator | `open_conflict` records explicit disagreement; coordinator `resolve_conflict` records the resolution reason. |
| Assigned reviewer | `submit_lane` records `CLEAN` or `FINDINGS` bound to that lane's findings revision and inputs. |
| Coordinator | `carry_lane` reuses only a server-verified unchanged lane; `accept_wave` enforces all current prerequisites. |
| Coordinator | `import_legacy` preserves legacy Markdown bytes and history without importing historical acceptance. |

A review result binds its own lane evidence rather than the entire mutable review file revision.
Another lane's write does not by itself invalidate an unchanged lane result.
Changed evidence, unresolved disagreements, unresolved findings, and missing required lanes prevent acceptance.
Mechanical failures cannot be waived by a manual assessment.
Only `VERIFIED` findings are resolved.

## Compact worker result

```text
Mode: design-audit | implementation-review
Slice: <reporting slice>
Review: <project-relative review.json>
Lane: <assigned lane>
Wave: <wave ID>
Concept delta revision: <SHA-256>
Baseline: <B identity>
Source: <A or F identity>
Comparison: <immutable comparison ID>
Verification: <commands and evidence references>
Status: CLEAN | FINDINGS
Unresolved IDs: <IDs or NONE>
```

A worker's `CLEAN` is a lane result; aggregate acceptance comes from the MCP mutation gate.
