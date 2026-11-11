# Index preparation that finishes

Status: Approved
Created: 2026-11-10
Approved: 2026-11-11

## Problem

A native index build of a large repository or component can run out of its time limit and then saves nothing, so the next attempt starts from zero and never finishes.
Every caller waits for the whole build, although the structural reports, the change map, conservation evidence, retained baselines, and the review browser's code places use only units and their line ranges, and only concept search and context planning use embeddings.
A small path-scoped call can wait behind a long build of another component, and a waiting component does not say what it waits for.
A report scoped to one component cannot see a duplicate or a shared dependency in a sibling component, because reading another component means building its full index.
Structure coverage counts a file as not covered when it calls into a library, so coverage reports almost nothing as covered.
A search across several component indexes ranks results by vector similarity alone, which the November 2026 measurement found weaker than the hybrid ranking inside one index.

## Goals

- Make every build finish while it keeps making progress, whatever the repository's size.
- Let callers that need only structure stop waiting for embeddings.
- Keep work that a stopped build already did.
- Keep small scoped calls fast while large builds run.
- Rank a search across indexes as well as a search inside one index.

## Non-goals

- Make embeddings optional: the November 2026 measurement found lexical search alone answered 62 of 129 benchmark queries against 114 for hybrid search.
- Choose a storage format, an embedding batch strategy, or a database.
- Change which files an index holds or how components are declared.
- Index sources outside the project, which [reference-search.md](reference-search.md) covers.

## Design questions

- Which storage format and write pattern lets a build save its embeddings as it makes them and stay within the host's memory?
- What counts as progress for the stop in §2, and how long may a build go without it?
- How does a structure-only index stay consistent with the embeddings that fill in later for the same snapshot?
- Can the code graph be updated for changed files only, or must structure be rebuilt in full?
- How does a cross-index ranking combine lexical and vector evidence without comparable lexical scores between indexes?

<a id="1"></a>
## 1. Publish structure before embeddings

Pattern: Event-driven

Disposition: Active

Requirement: When Prism finishes the structure of a snapshot's native index, Prism shall answer structural reports, the change map, conservation evidence, and the review browser's code places from it before that snapshot's embeddings are complete.

Rationale: These callers read units and line ranges only, and structure takes about 2% of a build on the Prism repository, so waiting for embeddings delays them for nothing.

Related: [components.md§21](components.md#21), [artifact-conservation.md§1](artifact-conservation.md#1)

<a id="2"></a>
## 2. Keep a build running while it makes progress

Pattern: State-driven

Disposition: Active

Requirement: While a native index build keeps making progress, Prism shall not stop it for its total duration.

Rationale: A fixed total limit makes a large enough repository impossible to index, while a stall is what a limit must catch.

Related: [components.md§22](components.md#22)

<a id="3"></a>
## 3. Stop a build that makes no progress

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a native index build makes no progress for the stall period, then Prism shall stop it, keep the work it saved, and report the build as stalled with the phase it stalled in.

Rationale: A build that hangs must not hold the queue, and the person needs to know where it stopped.

Related: [index-preparation.md§4](#4)

<a id="4"></a>
## 4. Resume a stopped build

Pattern: Event-driven

Disposition: Active

Requirement: When Prism builds a native index after an earlier build of the same index stopped, failed, or was interrupted, Prism shall reuse every embedding that the earlier build saved for fragment text that is unchanged.

Rationale: A retry that starts from zero repeats the work that ran out of time and fails again, which is issue #14.

Related: [index-preparation.md§3](#3)

<a id="5"></a>
## 5. Answer concept search while embeddings fill

Pattern: State-driven

Disposition: Active

Requirement: While a component's structure is published and its embeddings are not complete, Prism shall answer concept search for that component with lexical results and state in the result which components answered without embeddings.

Rationale: An answer the caller knows to be lexical is more useful than a wait, and the statement keeps a weaker ranking from reading as a full one.

Related: [components.md§26](components.md#26)

<a id="6"></a>
## 6. Let a scoped call go ahead of an unrelated build

Pattern: Event-driven

Disposition: Active

Requirement: When a tool call needs a component whose index is missing while a build of a component that the call does not need is running, Prism shall start the needed component's preparation without waiting for the running build to finish.

Rationale: A small scoped call waited about 22 minutes behind the documentation build in the November 2026 proof run.

Related: [components.md§21](components.md#21), [index-preparation.md§4](#4)

<a id="7"></a>
## 7. Say what a waiting component waits for

Pattern: State-driven

Disposition: Active

Requirement: While a component's preparation waits, Prism shall report in its status which preparation it waits behind.

Rationale: `waiting` alone gives the person and the agent no way to judge how long the wait will be.

Related: [index-preparation.md§6](#6)

<a id="8"></a>
## 8. Rebuild only what changed

Pattern: Event-driven

Disposition: Active

Requirement: When files of an indexed component change, Prism shall prepare the new index in a time that grows with the changed files rather than with the whole component.

Rationale: Every build today copies every file and recomputes the whole structure, so a one-line edit in a large component pays for a full build.

Related: [components.md§21](components.md#21)

<a id="9"></a>
## 9. Let a scoped report see sibling components

Pattern: Event-driven

Disposition: Active

Requirement: When a structural report is scoped to one component, Prism shall include in its groups the members in other components of the same repository that belong to a group with a member in the scope.

Rationale: A duplicate or shared dependency across two packages is invisible to a report scoped to either one, which is issue #120.

Related: [components.md§24](components.md#24)

<a id="10"></a>
## 10. Count a call into a library as covered

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall count a file as structurally covered when every reference that it cannot resolve points outside the indexed source.

Rationale: Treating every call into a library as a missing link reported 35 of 451 parsed files as covered, which is issue #119.

Related: n/a

<a id="11"></a>
## 11. Rank a search across indexes as one search

Pattern: Event-driven

Disposition: Active

Requirement: When Prism merges concept search results from several native indexes, Prism shall rank them using both their lexical and their vector evidence.

Rationale: Merging by vector similarity alone loses the lexical half of the hybrid ranking, which matters for exact names and for splitting a repository into more indexes.

Related: [components.md§25](components.md#25)
