# Build native indexes in stages that keep their work

Status: Accepted
Created: 2026-11-11

## Requirements

[Publish structure before embeddings](../../requirements/index-preparation.md#1) requires structural callers to stop waiting for embeddings.
[Keep a build running while it makes progress](../../requirements/index-preparation.md#2) and [Stop a build that makes no progress](../../requirements/index-preparation.md#3) replace a total time limit with a stall limit.
[Resume a stopped build](../../requirements/index-preparation.md#4) requires a retry to reuse every embedding that an earlier build saved.
[Let a scoped call go ahead of an unrelated build](../../requirements/index-preparation.md#6) requires a needed component to start without waiting for an unrelated running build.
[Rebuild only what changed](../../requirements/index-preparation.md#8) requires a rebuild whose time grows with the changed files.
[Rank a search across indexes as one search](../../requirements/index-preparation.md#11) requires a merged ranking that uses lexical and vector evidence.

## Problem

A native index build copies every file, parses every file, embeds every new fragment, and writes one index file at its end.
Nothing that a build did survives when it stops early, so a build that reaches its 30 minute limit starts again from zero and reaches it again.
Every caller waits for the whole build, although most of them read only units and line ranges, which take about 2% of a build.
One build runs at a time and is never interrupted, so a small call that needs a missing component waits behind a build that it does not need.
A search across component indexes merges by vector similarity alone, because lexical scores of different indexes are not comparable.

## Decision

A build MUST publish the structure of its snapshot, its units, relationships, coverage, and planned fragments, as soon as it has planned the fragments and before it embeds them.
A published structure MUST answer every caller that reads only structure, and a structure MUST NOT be recomputed when the embeddings of the same build arrive.
An index of a snapshot MUST record whether it holds only structure or is complete, and a complete index of a snapshot MUST replace a structure-only index of the same snapshot.
A concept search over a structure-only index MUST answer with lexical results and MUST say which indexes answered without embeddings.
A build MUST save each embedding as soon as the runtime returns it, in an append-only store of its storage location that a later build of any snapshot reads.
A reader of that store MUST ignore a record that a stopped writer left incomplete, so a stop at any moment loses at most the batch that was being written.
A build MUST NOT have a limit on its total duration.
A build that reports no new progress for the stall period MUST be stopped, keep what it saved, and fail as stalled, naming the phase it stalled in.
A repeated progress value MUST NOT count as progress.
When a call needs a component that has no index while the running build is of a component that the call does not need, the running build MUST be paused, and it MUST resume later from its saved work.
A build MUST keep a private mirror of the files it indexed and a code graph of that mirror, and a rebuild MUST copy, parse, and fragment only the files that changed since the mirror's last build.
An incremental rebuild MUST produce the same index as a full build of the same snapshot.
A rebuild MUST also re-read every unchanged file that resolves through a changed or removed file.
A rebuild MUST build in full when it cannot bound that set, when a file that the code graph reads as configuration changed, when the detected frameworks changed, or when a framework links files across the whole project.
A mirror that holds a file which neither its manifest nor the snapshot names MUST be reset before the build.
A search across several indexes MUST merge them with one reciprocal rank fusion that ranks vector evidence by similarity across all indexes and lexical evidence by each result's rank within its own index.

## Rationale

Structure is cheap and deterministic, so publishing it first removes almost all of the wait for structural callers at no extra cost.
An append-only store with fixed-size records needs no index of its own, survives a killed process, and keeps memory to the vectors that a build reuses.
Progress, not elapsed time, separates a large build from a hung one, so a stall limit lets any size of repository finish while still freeing the queue from a hang.
Pausing reuses the saved work that resuming already needs, so a paused build loses only its current batch, while running builds side by side would multiply the memory of the model and the index.
The code graph already updates a kept database for named paths, so an incremental rebuild needs no second parser.
Equality with a full build matters more than speed, so every case the sync cannot prove equal falls back to a full build.
Cosine similarity of one model is comparable between indexes and lexical scores are not, so ranks carry the lexical evidence across indexes.

## Alternatives

- **Raise the total limit.** Rejected because some repository is always larger than any fixed limit.
- **Build structure and embeddings in two runtime requests.** Rejected because one request that reports its structure first does the same with one parse, and an older test runtime that never reports structure still works.
- **Run several builds at once.** Rejected because each build holds a model and a full index in memory, and a call could still wait behind as many builds as there are slots.
- **Save embeddings only in the finished index.** Rejected because a build that stops early then saves nothing, which is the failure this decision fixes.
- **Normalize lexical scores between indexes.** Rejected because a score's scale depends on each index's term statistics, so no normalization makes them comparable.

## Consequences

- Structural reports, conservation evidence, and the review browser's code places answer within seconds of a build's start on any repository whose structure fits the native limits.
- A concept search can return lexical results for minutes after a change, and its result says so.
- The embedding store grows during a build and is rewritten to the finished index's fragments when the build completes.
- A stalled build is retried by the next call that needs it, and it resumes from its saved embeddings.
- A large build that keeps being paused by scoped calls still advances, because each run keeps the embeddings it made, but it can take longer to finish.
- The kept mirror doubles the disk space of indexed source for each storage location.
- The merged ranking across indexes is deterministic and uses both kinds of evidence, but it fuses only the candidates that each index returned.

## Mechanism

1. A build copies the changed files into its mirror and asks the runtime to build, naming the changed and removed files.
2. The runtime adds the unchanged files that resolve through the changed or removed ones, updates its code graph for all of them, reuses the derived data of the rest, plans fragments, and reports the structure.
3. Prism stores the structure as the snapshot's structure-only index and points the storage location at it.
4. The runtime embeds the fragments that have no saved embedding and reports each batch's vectors, which Prism appends to the embedding store.
5. Prism stores the complete index, points the storage location at it, and rewrites the embedding store to its fragments.
6. A watchdog stops a build that reports no new progress for the stall period, and a call that needs a missing component pauses an unrelated running build in the same way.

## Decision Log
