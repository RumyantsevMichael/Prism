# MCP-managed concept delta and conservation

A concept delta records intended changes to code, instructions, documentation, specifications, tests, and configuration.
Design owns the slice's `concept-delta.json` through `get_concept_delta` and `update_concept_delta`.
The server owns serialization, validation, revisions, locking, atomic persistence, and retained evidence.
Agents never edit managed JSON or its generated Markdown directly.
Context-budget `FIT` and conservation acceptance are separate checks.

## Capture source evidence

1. Before the first target edit, call `capture_repository_snapshot` with the absolute `projectRoot` and slice-relative `deltaPath`.
2. Preserve the returned baseline identity as **B**, including dirty and untracked source.
3. Bind governing requirements through source references in the delta.
4. After design-authored tests and scaffolds, capture **A** for design audit.
5. After implementation or corrections finish, capture **F** for implementation review.
6. Preserve B through all corrections and child assignments.

B→A measures design changes, and B→F measures the complete task.
A identifies the source accepted for implementation entry.
Snapshots retain verified text, opaque bytes, symlink identities without following links, modes, capture policy, and omissions.
Missing or corrupt affected source evidence prevents acceptance.
Registered evidence outputs are exact server-owned paths, including their temporary writes and locks; arbitrary exclusion patterns are unavailable.
Retained snapshots and receipts survive disposal of semantic index caches.
A split parent retains its provisional delta; each child needs its own delta and baseline binding.
A parent delta does not authorize child implementation.

## Author and read

1. Read the artifact with `get_concept_delta`.
2. For an absent artifact, use `update_concept_delta` with `expectedRevision: null`, nonempty `scope`, `baselineId`, `requirements`, and typed `operations`.
3. Insert, partially update, or remove entries in batches of at most 100 operations.
4. After a revision conflict, reread the artifact before retrying.
5. Before returning `FIT`, read every page at the same `expectedRevision` and confirm `valid: true` and `ready: true`.
6. Return the delta path, exact revision, and baseline identity.
7. If MCP or required semantic preparation is unavailable, return `BLOCKED` with the missing capability.

New artifacts use `schemaVersion: 2`.
Read pages default to 50 entries and permit at most 100; `nextOffset` selects the next page.
The artifact limit is 1 MiB.
Entry IDs are immutable, omitted update fields stay unchanged, and supplied arrays replace their field.
An invalid batch preserves existing artifact bytes, and a no-op preserves its revision.
`remove` removes a planned entry rather than deleting its target.
`ready` means ready for design audit, not approved for implementation.
An empty delta can be ready when a retained baseline supports a design with no target changes.

## Entries and exact references

Every entry contains `id`, `kind`, `label`, `action`, `before`, `after`, and `reason`.
`kind` is open text, including `class`, `rule`, `section`, and `configuration-option`.
All target references fall inside declared scope; reuse candidates may be outside it.

| Action | Before | After |
| --- | --- | --- |
| `KEEP` | Nonempty | Same references and unchanged content |
| `MODIFY` | Nonempty | Preserved concept identity |
| `REPLACE` | Nonempty | Replacement references |
| `DELETE` | Nonempty | Empty |
| `ADD` | Empty | Nonempty |

`REPLACE` includes renaming, moving, consolidation, and splitting.
Several sources can converge on one destination; one source can split into several destinations.
Duplicate IDs, duplicate references, and conflicting ownership of the same exact source reference are invalid.
A broad file-level `MODIFY` cannot authorize undeclared public concepts.
Private implementation details require explicit attribution to their owning planned concept during review.

References contain project-relative `path` and optional `selector`.
Typed selectors use `{ "type": "symbol|heading|text|json-pointer|yaml-key", "value": "..." }` or `{ "type": "span", "start": 0, "end": 20, "sourceHash": "..." }`.
Spans use UTF-16 source offsets and bind to one file hash.
Before and after spans may differ for `MODIFY`, but known parser identities must match.
An unresolved span identity requires an explicit review check.
A span whose future bytes are not known requires a stable typed selector or an explicit unsupported-check assessment.
Legacy string selectors remain readable and require explicit resolution evidence.
Resolution reports `resolved`, `missing`, `ambiguous`, or `unsupported` without fuzzy identity matching.

1. List every affected semantic concept, relevant concepts deliberately kept, and planned tests, contracts, documentation, and configuration.
2. Leave unsettled private implementation details to implementation.
3. Link additions and expected growth to the governing requirements.

## Semantic reuse search

1. Before accepting `ADD`, call `search_repository_concepts` with `snapshotId` set to B and a query describing the required behavior.
2. Select applicable `code`, `instruction`, `documentation`, or `configuration` domains.
3. Restrict paths and kinds only when those exclusions are justified.
4. While preparation returns `preparing`, use `get_repository_intelligence_status` with `waitMs` up to 30000 and repeat the search.
5. Read the successful receipt through `get_conservation_evidence` when its bounded summary is insufficient.
6. Record its ID in `reuseEvidence.receiptIds` and a disposition for every returned candidate.
7. Copy each candidate's ID, receipt ID, and exact snapshot-bound reference into the disposition.
8. Explain why existing concepts cannot reasonably absorb the required behavior in `reuseEvidence.justification`.
9. If successful searches return no candidates, record `emptyResultReason`.

The server generates receipt query, filters, limit, source spans and hashes, scores, model, tokenizer, runtime, index identity, coverage, and omissions.
Preparing, failed, or lexical-only searches cannot make an addition ready.
Native preparation starts automatically and retains searchable verified text when structural extraction fails.
Live searches retain their freshness checks; baseline searches cannot treat newly authored material as preexisting reuse evidence.
Similarity ranks candidates; reviewers decide search adequacy, reuse, and conceptual equivalence.
A high score cannot resolve an explicit missing symbol or determine implementation effort.
Normal responses summarize diagnostics; bounded evidence pages contain the details.

For code, search for a total retry deadline and compare it with the existing per-attempt timeout.
For instructions, search for direct answers and compare rules about short introductions and repeated questions.
For configuration, inspect the returned JSON Pointer or YAML key before treating two duration settings as equivalent.
The example uses illustrative hashes.
Replace them with the receipt and source hashes returned by the search.

```json
{
  "op": "update",
  "id": "total-retry-deadline",
  "set": {
    "requirements": [{"path": "requirements/retry.md"}],
    "reuseEvidence": {
      "receiptIds": ["1111111111111111111111111111111111111111111111111111111111111111"],
      "candidates": [{
        "receiptId": "1111111111111111111111111111111111111111111111111111111111111111",
        "candidateId": "<returned ID>",
        "reference": {"path": "config/retries.json", "selector": {"type": "span", "start": 2, "end": 24, "sourceHash": "2222222222222222222222222222222222222222222222222222222222222222"}},
        "disposition": "REJECT",
        "reason": "One attempt's timeout cannot express the lifetime of the entire retry operation."
      }],
      "justification": "The requirement introduces an independent total duration."
    }
  }
}
```

## Compare and measure

1. Call `compare_concept_delta` with the exact delta revision, B, and A or F.
2. Read all observations, measurements, growth records, and applicable diagnostics through `get_conservation_evidence`.
3. Return material deviations for design revision and audit before continuing implementation.
4. Record requirement-linked justification for every positive measured increase through MCP review assessments.
5. Review new public surface and additions even when deletions offset their net growth.

Measurements separate source size, supported code declarations, public surface, Markdown structure and source tokens, configuration keys, explicitly identified obligations, and planned transitions.
Planned transition counts are informational and do not enter growth gates.
Original source counts once; overlapping spans, embedding metadata, and fragments do not inflate measurements.
Unsupported dimensions are unknown rather than zero.
Parser, tokenizer, and metric versions bind the comparison, which retains its exact analysis records.
Markdown list items become identified obligations only through explicit source-bound classification and review.
Default growth tolerance is zero; `expectedGrowth`, requirement-linked `growthJustifications`, and `growthThresholds` are audited design inputs, and every actual positive increase still needs reviewed justification.
Comparisons preserve observed facts; review decisions cannot erase a retained deletion, scope escape, changed `KEEP`, or undeclared public concept.

## Text convergence

For each affected text section:

1. Use `refactor` for the shared [conceptual reasoning and resynthesis procedure](../../refactor/SKILL.md#3-derive-the-desired-model).
2. Supply the current requirements, original obligations, source evidence, and caller's analysis or transformation authority.
3. Prepare the selected decision, identified obligation IDs, and requirement coverage with resulting source references for a `convergence` assessment.
4. After authoring finishes, capture the final source and comparison.
5. Submit the assessment through `update_review`.
6. Have an independent reviewer assess meaning, coverage, and preservation of the existing obligations.

An assessment binds to its review wave's source, requirement, comparison, and delta revisions.
An unsupported check needs a `manual` assessment naming exact observation IDs, evidence, reason, and the assigned reviewer.
Changed private helpers need an `implementation-detail` assessment naming their owning concept.
Manual evidence cannot override missing semantic search, stale or missing source evidence, scope violations, or demonstrably retained deletion targets.
Scripted assessment fixtures test enforcement; they do not prove semantic correctness.

## Audit and implementation

1. Follow [review-format.md](../../review/references/review-format.md) to create MCP review waves with pinned required lanes.
2. For design audit, inspect B→A, plan completeness, reuse evidence, growth policy, and any convergence assessments.
3. Submit current lane results and accept the wave through `update_review`.
4. Before implementation, use `check_review_gate` and a typed coordination `start` or `update` entering `implementation`.
5. On changed source A or delta revision, return to design review.
6. For implementation review, inspect B→F and record missing deletions, extra concepts, incorrect replacements, and unmet requirements as findings.
7. Before integration or completion, require accepted current review evidence through the same gate validator.

Implementation never rewrites the accepted plan to match its output.
Coordination uses activities `design`, `implementation`, `review`, and `integration`; descriptive labels are separate.
Typed `finish` verifies completion evidence; `release` and pause remove active coordination without claiming completion.
The map writer checks current completion evidence before marking a slice done.
These gates control Prism records; they do not prevent direct filesystem edits.

## Migration

1. Read legacy version 1 deltas through MCP.
2. Use `update_concept_delta` with `migrate: true` for explicit migration that retains the original bytes as immutable evidence.
3. Use review `import_legacy` to retain original Markdown findings and history.
4. Establish new review waves with current evidence before implementation or completion.
5. If the original source was not retained before edits, report the missing original baseline instead of fabricating B from the changed tree.

Historical `CLEAN` is readable history and never current acceptance.
