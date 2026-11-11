# Index preparation that finishes

## Outcome

Every native index build finishes while it makes progress, publishes structure before embeddings, keeps a stopped build's work, keeps scoped calls fast, and ranks searches across indexes as well as inside one.

The architecture is recorded in [Build native indexes in stages that keep their work](../../ADRs/repository-intelligence/staged-resumable-index-builds.md).
The overview is [overview.puml](overview.puml).

## Answers to the design questions

- Storage and write pattern: each storage location keeps an append-only embedding store of fixed-size binary records, appended as the runtime returns each batch, read as a stream, and rewritten to the finished index's fragments when a build completes (§11–§14).
- Progress: a new phase, a changed count, a new file or item, or new vectors; the default stall period is 10 minutes, which is far longer than the longest step the November 2026 measurement saw, 11 seconds of graph linking (§7–§9).
- Consistency: the structure-only index and the complete index of one snapshot come from the same build's one structure, and a complete index replaces the structure-only index of its snapshot, so a caller never mixes two structures of one snapshot (§15).
- Incremental structure: the pinned code graph updates a kept database for named paths, as the probe below shows, so structure is updated for changed files only (§22–§24).
- Cross-index ranking: one reciprocal rank fusion over all candidates, with vector ranks across indexes and lexical ranks within each index, because only cosine similarity is comparable between indexes (§30).

## Decisions taken in design

Michael delegated every internal decision for this initiative, so design settled these forks and records why.

- A needed component pauses an unrelated running build instead of running beside it, because a paused build loses only its current batch once embeddings are saved as they are made, while parallel builds multiply model and index memory and still leave a call waiting when every slot is busy.
- A pause happens only when the needed component has no index at all, which is what the requirement names; an out-of-date component keeps answering from its stored index while it waits its turn.
- Concept search over a structure-only index uses the runtime's lexical mode over fragments, the mode the November 2026 measurement scored at 62 of 129, rather than today's whole-file lexical fallback.
- A scoped cross-file structural report prepares the components outside its scope with structure only, so seeing sibling components never starts their embeddings.
- A file that calls into a library is covered when every reference it could not resolve names nothing that the same index defines, which keeps a missing link inside the source visible while a library call no longer counts against coverage.
- The structure stage, the embedding store, and the incremental mirror are additive to the runtime protocol, so a runtime that never reports structure or vectors, as the test runtimes of earlier contracts do, keeps today's behavior.

## Contract

### Native runtime protocol

1. A runtime's `build` request may report, once, after it planned fragments and before it embeds any, the progress value `{ "phase": "structure", "index": <index> }`, where `<index>` is the complete index object except that no fragment carries `embedding`.
2. A progress value `{ "phase": "embedding", "current": <n>, "total": <n> }` may carry `vectors`, an array of `[<embeddingKey>, <vector>]` pairs with a 64-character lowercase hex key and 384 finite numbers, for the fragments that the runtime embedded since its previous embedding value.
3. Prism never puts `index` or `vectors` into a reported progress value, a progress record, a status, or a tool result.
4. Prism stops a build by calling `stop()` on the helper that runs the build request, when the helper has one, and does not wait for that request to end before it treats the build as stopped.
5. A `search` request may carry `"mode": "lexical"`, and the runtime then answers from the index's fragment text alone, with `cosineSimilarity: null` on every result, also for an index whose fragments carry no embedding.
6. A `build` request carries `changedFiles` and `removedFiles` as clause 23 states, and still lists every file of the snapshot in `files`.

### Running until a stall

7. A native index build has no limit on its total duration, while a `search` request keeps its 30 minute limit and fails with `resource_limit` when it reaches it.
8. A build makes progress when it reports a progress value whose `phase` differs from its previous one, whose `current`, `item`, or `file` differs from its previous one, or that carries `vectors`; a value equal to the previous one, such as a repeated heartbeat, is not progress.
9. The stall period is 10 minutes, or the whole number of minutes from 1 through 1440 in the `PRISM_INDEX_STALL_MINUTES` environment variable, while any other value of it is ignored; a runtime constructed with the option `stallMs` uses that many milliseconds instead.
10. A build that makes no progress for the stall period, counted from its start or its latest progress, is stopped as clause 4 states and fails with the failure `{ "code": "stalled", "message": "The index build made no progress for <duration> during <phase>.", "phase": "<phase>" }`, where `<phase>` is its latest reported phase or `starting` when it reported none and `<duration>` is `<n> minutes`, `1 minute`, or, below a minute, `<n> seconds`.
    - Its diagnostic is `{ "code": "stalled", "message": <the same message>, "phase": <phase>, "recovery": "Repeat the call to resume the build from its saved work." }`, its progress record ends `failed` with that diagnostic, a component's `failure` in a status or a result carries `phase`, and a repository without components reports `degraded` with that diagnostic.
    - A stalled build keeps every embedding and structure that it saved, and the next call that needs it prepares it again, because a stall is not a native limit.

### Resuming from saved embeddings

11. Each storage location keeps an embedding store `embeddings.bin` with mode `0600`, a sequence of 1568-byte records, each the 32 bytes of an embedding key followed by its 384 values as little-endian 32-bit floats, and Prism appends the records of each `vectors` value before it handles the build's next message.
12. A build passes to the runtime as `previousEmbeddings` every record of its storage location's embedding store, together with the embeddings of the previous index as today, ignoring a final record shorter than 1568 bytes and every record holding a value that is not finite; an embedding store that cannot be read counts as empty and never fails a build.
13. When a build saves a complete index, Prism replaces the embedding store atomically with one record for each distinct embedding key of that index's fragments.
14. Clauses 11 and 12 hold whether the earlier build stalled, was paused, failed, or ended with its process, in this session or in another session that shares the storage.

### Structure before embeddings

15. When a build reports `structure`, Prism stores that index for the build's snapshot with its units sidecar and writes the snapshot's generation pointer and `current.json` with `"stage": "structure"`, and a complete index's pointers carry `"stage": "complete"`, while a pointer without `stage` is complete; a complete index of a snapshot replaces its structure-only index, a structure-only index never replaces a complete index of the same snapshot, and a stored structure-only index of the content a preparation reads answers structure at once but does not end that preparation, which builds the content in full.
16. While a structure-only or complete index of a snapshot is stored, in this session or another one sharing the storage, the six structural reports, conservation analysis of a retained baseline, and the review browser's published units answer from it without waiting for embeddings: a structural report of a repository without components returns `status: "ready"` and the answering index's revision as `indexRevision`, and a component with such an index counts as `included`.
17. `get_repository_intelligence_status` and `discover_repository_intelligence` give `stage`, one of `none`, `structure`, and `complete`, for the one index of a repository without components and for each entry of `components`, and a build that embeds after it published structure stays `preparing`.
18. A concept search whose answering index holds only structure searches it with `"mode": "lexical"`.
    - In a repository without components the result's `status` is `ready`, and in a repository with components that component is `included` and its entry in `components` carries `"embeddings": "pending"`, a field that no other entry carries.
    - The result's diagnostics hold `{ "code": "embeddings_pending", "message": "Lexical results answered without embeddings for <names>; repeat the search after the build finishes for a hybrid ranking." }` directly after any `components_missing` diagnostic, where `<names>` is `the index` in a repository without components and otherwise the component identities joined by `, `, which the diagnostic also lists in `components`.
    - `capabilities.semanticSearch` and `capabilities.hybridSearch` are true only when at least one answering index is complete.
19. A context plan keeps waiting for a complete index, as today.

### Scoped calls ahead of unrelated builds

20. When a call prepares components and one of them has no stored index of any snapshot and no running build, while this process runs a build of a component that the call did not ask for, Prism pauses that build at once.
    - A paused build is stopped as clause 4 states, records no failure and no failed progress record, reports `waiting`, and is queued directly after the components that the call asked for, which start at once in the order that today's queue gives them.
    - A paused build resumes from its saved embeddings when its turn comes, and when the paused request still completes, its index may be used.
21. A component whose preparation waits carries `waitingFor` in its `components` entry of a status and of a result, and a repository without components carries it at the top of its status while its one build waits; no other entry carries it.
    - `waitingFor` is `{ "component": <identity>, "preparationId": <id>, "reason": "queue" }` while it waits in this process's queue, naming the build that runs in this process, or a build that loads beside it when no build runs.
    - `waitingFor` is `{ "component": <its own identity>, "preparationId": <id or null>, "reason": "lock" }` while another session holds its storage lock, with the preparation id of that session's live progress record in its storage, or `null` when there is none; a repository without components names its root component's identity.
    - A preparation waits while its status is `waiting`, or `preparing` with the progress phase `waiting`.

### Rebuilding what changed

22. Each storage location keeps, beside its index files, a mirror folder `mirror` of the files that its builds read, which is the `mirror` of every build request, and a manifest `mirror.json` holding `{ "schemaVersion": 1, "mirror": { <file>: <hash> }, "indexed": { <file>: <hash> } | null }`, where `mirror` names the mirror's current files and `indexed` names the files of the latest build whose structure the runtime reported or whose index it returned.
23. A build copies into the mirror only the snapshot's files whose hash differs from `mirror` or that it lacks, removes the mirror files that the snapshot lacks, reports `snapshot-copy` with the number of files it copies as `total`, and passes `changedFiles`, the sorted files whose hash differs from `indexed` or that it lacks, and `removedFiles`, the sorted files of `indexed` that the snapshot lacks.
    - When the manifest is missing, unreadable, or names a file the mirror does not hold, or `indexed` is `null`, the build empties the mirror and the runtime's state folder `runtime-state` beside it, copies every file, and passes neither list, which is a full build.
24. A runtime given `changedFiles` and `removedFiles` updates its kept code graph for those paths only, reuses the units, links, token counts, and fragments of the other files from its state folder `runtime-state`, and returns the same index that a full build of the same files returns; when its state is missing or unusable it builds in full.

### Sibling components in scoped reports

25. In a repository that declares components, `find_shared_dependencies`, `find_shared_literals`, `find_same_name_units`, and `report_module_interfaces` with `filters.paths` read the structure of every component that holds a file of the live project or of the retained baseline, and report only the groups or modules that have a member inside the paths, with their members and importers in every component they read.
26. Those reports prepare the components that hold the paths as today and every other component with a structure-only preparation, which passes `fragmentsOnly: true`, stores the result as a structure-only index, embeds nothing, and ends `ready`, while a later preparation that needs that content's embeddings builds it in full; `components` lists every component the report read in component order, and a component outside the paths that is not yet included is named by `components_missing` and leaves the result `partial`.
27. `report_cohesion_clusters` and `report_complex_units` with `filters.paths` keep reading only the components that hold the paths.

### Coverage of calls into libraries

28. A runtime may report `unresolvedByFile`, an object from each code file to the `{ "name", "kind" }` of every reference in it that the code graph could not resolve.
29. When an index carries `unresolvedByFile`, Prism counts a code file as structurally covered exactly when it parsed, no diagnostic names it other than the code graph's unresolved-reference diagnostic, and every one of its unresolved references points outside the indexed source.
    - An `imports` reference points outside the indexed source when its name does not start with `.` or `/`.
    - Any other reference points outside when its name, after its last `.`, `::`, or `#`, equals the name of no unit of a code file in the same index.
    - That coverage is what the index stores in `fileCoverage` and what statuses, reports, and analyses count, while an index without `unresolvedByFile` keeps the coverage its runtime reported.

### Ranking a search across indexes

30. When several indexes answer one concept search, Prism ranks their results together, while a single answering index keeps its own order.
    - Each result's vector rank is its position among all answered results that have a `cosineSimilarity`, from highest to lowest, ties in component order and then in its index's order.
    - Each result's lexical rank is its position among all answered results that have a `lexicalScore`, ordered by its position among its own index's results with a `lexicalScore` from highest score to lowest, then by its score divided by that index's highest score from highest to lowest, then in component order.
    - Its fused score is `w / (60 + lexical rank) + 1 / (60 + vector rank)`, leaving out a missing rank, with `w` 0.5 for a query that looks like an identifier and 0.25 otherwise, by the rule that ranks one index.
    - Results whose file, name, qualified name, or selector equals the trimmed query come first, then the rest by fused score from highest to lowest, ties in component order and then in index order, and a result without either score stays directly after the result it follows in its index.
    - Prism keeps the first `limit` results, numbers `fusedRank` from 1, and keeps each result's other scores as its index computed them.

## Assumptions

- Probed: the pinned code graph SDK updates a kept database for named paths only, adding, changing, and removing files without reindexing the others (`docs/plans/index-preparation/probes/graph-sync.mjs <runtime folder> <scratch folder>` with the bundled runtime, observed `indexAll` of 400 files in 417 ms, then `sync({ paths })` checking 3 files with 1 added, 1 modified, and 1 removed in 140 ms, and a full `sync()` afterwards finding nothing to change).
- Probed: structure is a small share of a build, about 14 seconds of graph work against 196 seconds of embedding in the November 2026 measurement of the Prism repository, and its longest graph phase, linking, took 11 seconds (`/mnt/project-files/indexing/measure-2026-11-07/summary-sorted4.json`, `stats.phases`).
- Unprobed: whether the runtime's derived data of unchanged files is reusable for every language the code graph supports; clause 24 makes a runtime without usable state build in full, so an uncovered case is slower, never wrong.
- Unprobed: how closely the fused ranking of clause 30 matches the hybrid ranking of one index on the benchmark, whose harness lives outside this repository; the ranking is deterministic and documented, and a measurement can tune it later without changing the interface.
- Unprobed: the memory of reading a large embedding store; clause 12 keeps today's limits of 100,000 fragments, and a store that cannot be read counts as empty instead of failing the build.

## Slices

| Slug | Outcome | Component | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- | --- |
| `resumable-builds` | A build runs while it makes progress, stops as stalled when it makes none, and a later build reuses every embedding it saved. | `prism` | `index-preparation.md§2`, `§3`, `§4` | | `test/server/fixtures/staged-runtime.mjs`, `test/server/index-resume.test.mjs` | required: writes and reads a cross-process store and stops processes |
| `structure-first` | Structural callers answer from a published structure while embeddings fill, and concept search answers lexically and says so. | `prism` | `index-preparation.md§1`, `§5` | `resumable-builds` | `test/server/index-structure-stage.test.mjs` | required: changes the stored index format that other sessions and the review app read |
| `scoped-calls-ahead` | A call that needs a missing component pauses an unrelated build, and a waiting component names what it waits behind. | `prism` | `index-preparation.md§6`, `§7` | `structure-first` | `test/server/index-scoped-ahead.test.mjs` | required: changes the build queue's concurrency |
| `incremental-builds` | A rebuild copies, parses, and fragments only the changed files. | `prism` | `index-preparation.md§8` | `scoped-calls-ahead` | `test/server/index-incremental.test.mjs` | required: a stale mirror would silently corrupt the index |
| `sibling-reports` | A scoped cross-file report includes the members of its groups in sibling components. | `prism` | `index-preparation.md§9` | `structure-first` | `test/server/component-sibling-reports.test.mjs` | none |
| `library-coverage` | A file whose unresolved references all point outside the indexed source counts as covered. | `prism` | `index-preparation.md§10` | | `test/server/index-library-coverage.test.mjs` | none |
| `cross-index-ranking` | A search across several indexes ranks with lexical and vector evidence. | `prism` | `index-preparation.md§11` | | `test/server/component-search-fusion.test.mjs` | none |
