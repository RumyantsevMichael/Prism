# Refactoring analysis

## Before-change discovery

1. For a retained baseline, pass its identity as `snapshotId` to `search_repository_concepts` from the first reuse search.
2. While search returns `preparing`, wait through bounded status requests and repeat the same snapshot-bound search.
3. Inspect completed candidates before selecting a transformation.
4. Preserve the same baseline through target edits, retries, and corrections.
5. If retained search is unavailable, report that limitation with the fallback source identity and coverage.

A `preparing` response supplies neither completed candidates nor successful semantic evidence.
Live files cannot replace the original baseline after target edits.
A known omission outside the affected scope limits repository coverage without implying missing affected source.
Fallback discovery does not satisfy managed semantic gates.

## Candidate signals and ranking

These signals justify investigation without prescribing a solution.

| Signal | Observable evidence |
| --- | --- |
| Semantic redundancy | Similar concepts, parallel behavior, repeated constraints, or overlapping requirements. |
| Specialization | Repeated special cases, caller-specific interfaces, narrow rules, exceptions, or overrides. |
| Shallow abstraction | An interface exposes most implementation complexity or adds indirection without hiding knowledge. |
| Information leakage | Several consumers must understand the same internal fact or domain policy. |
| Tactical accumulation | Historical exceptions, layered fallbacks, compatibility paths, or multiple mechanisms for related needs. |
| Structural complexity | Excess dependencies, public surface, repeated state, branches, reference chains, or fragmented sections. |

1. Prioritize candidates using independent evidence dimensions and the caller's scope.
2. Keep semantic overlap, duplicated knowledge, specialization, dependency overlap, interface burden, affected consumers, state duplication, and exceptions inspectable.
3. Record expected impact and confidence separately from measured facts.
4. Investigate a useful bounded subset before expanding discovery.

No universal score is required, and a similarity score cannot select a transformation.
Unexamined candidates remain unexamined rather than implicitly accepted or rejected.

## Relationship reasoning

| Relationship | Question to resolve |
| --- | --- |
| Duplicate | Do the concepts encode the same knowledge and obligations? |
| Overlapping | Which responsibilities overlap, and which remain independent? |
| Subsumed | Can an existing concept satisfy the other's obligations without new exceptions? |
| Specializations of a shared concept | Is the common policy stable while the domain distinctions remain meaningful? |
| Accidentally similar or keep distinct | Do similar words or structures hide different contracts, ownership, or lifecycles? |
| Misplaced responsibility | Which concept should own the knowledge or decision? |
| Leaking boundary | Which internal detail crosses boundaries and forces coordinated changes? |
| Shallow abstraction | Does the interface hide enough complexity to justify its consumer cost? |

Relationships explain evidence and need not use these exact labels.
A candidate can have several relationships.

HTTP, worker, and queue retry handlers can share backoff arithmetic while differing in deadlines, job ownership, and persistent scheduling.
A shared retry policy helps only if it hides common knowledge while preserving those obligations.
Other valid outcomes include retaining separate handlers, merging true duplicates, or replacing a handler with an existing sufficient concept.

For text, concise-answer rules can overlap with rules against repeated questions or long introductions.
Resynthesis can replace these rules with one direct-answer obligation only when their conditions and exceptions survive.
Text deduplication alone does not establish that preservation.

## Complexity evidence

1. Select dimensions relevant to the candidate and available deterministic tooling.
2. Reuse Prism comparison measurements where applicable, with project analyzers for additional supported dimensions.
3. Bind before and after values to the same scope, method, and tool version where available.
4. Separate observed measurements, estimates, qualitative judgments, and unknown values.
5. Explain increases as well as decreases against the desired model and preserved behavior.

| Dimension | Possible observations |
| --- | --- |
| Structural | Lines, files, functions, classes, branches, nesting, or cyclomatic complexity. |
| Dependency | Edges, fan-in, fan-out, cycles, or coupling. |
| Interface | Exports, commands, routes, configuration options, or required caller knowledge. |
| State | Variables, persistent state, transitions, or duplicated lifecycle state. |
| Conceptual | Added, removed, merged, or split concepts and semantic redundancy. |
| Text and declarations | Rules, exceptions, prohibitions, sections, tokens, duplicated statements, reference chains, or contradictory constraints. |

These are possible dimensions, not a claim that Prism implements every measurement.
Unsupported deterministic dimensions remain unknown rather than estimated counts presented as measurements.
Semantic concept counts and duplicated knowledge require identified concepts or qualified judgment.
A Markdown bullet count is not a rule count without obligation classification.
For analysis without a transformed artifact, after-values remain projections rather than observed results.

A shared policy plus three thin specializations can increase concept count while reducing duplicated knowledge and consumer burden.
Each tradeoff needs evidence.
Neither the increase nor the decrease settles the decision alone.
Managed slices retain their reviewed growth justifications and conservation gates.

## Result fields

| Field | Required content where applicable |
| --- | --- |
| Candidate | Investigated concepts and exact artifact locations, including discovery coverage. |
| Evidence | Source, semantic candidates, structural relationships, and relevant red flags. |
| Relationship | Inferred relationship, meaningful distinctions, and confidence. |
| Desired model | Knowledge ownership, retained boundaries, hidden details, and the reason this structure is preferable. |
| Transformation | Selected operation, affected scope, and whether it is proposed or applied. |
| Behavioral impact | Preserved observable obligations or a specific behavior change requiring a decision. |
| Equivalence evidence | Checks and results, obligation mappings, review evidence, or planned checks for analysis. |
| Complexity delta | Independent before/after dimensions, methods, tradeoffs, and unknown or projected values. |
| Uncertainty | Missing evidence, unresolved distinctions, coverage limits, and deferred candidates. |
| Escalation | The exact decision, affected authority, and evidence needed by the caller, or none. |

The caller can reuse this evidence in existing concept deltas, review records, or its returned result.
This table defines content, not a new serialization format or mandatory artifact.

## Review criteria

1. Check that evidence supports the inferred relationships before judging the transformation.
2. Compare the desired model with the actual result and retained domain distinctions.
3. Inspect complexity tradeoffs, knowledge ownership, interface depth, and consumer burden.
4. Check preserved behavior, equivalence evidence, and explicitly reported uncertainty.
5. For resynthesis, check original obligation coverage and resulting conditions, exceptions, and authority.
6. Verify that behavior or architecture decisions remain within the caller's authority.

Metric reductions, deduplication, extraction, and smaller units alone cannot establish conceptual improvement.
