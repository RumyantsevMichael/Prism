# Sync the record store through Git

Status: Proposed
Created: 2026-11-01

## Requirements

No Approved requirement governs this decision yet.
It records the second increment of the multi-repository roadmap milestone, which the user approved.

## Problem

The [external record store](external-record-store.md) shares records between checkouts on one machine, but colleagues on other machines still see different initiatives.
Asking people to commit, pull, and push the store by hand would let records drift and would lose work when someone forgets.
The user chose one local writer per machine, with cloud sessions reaching the store through their own branch and a merge Action in a later increment.

## Decision

A store that is a Git checkout MAY opt into sync, and Prism MUST NOT run Git in a store that has not opted in.
With sync on, Prism MUST commit record changes after writes, merge the store's upstream, and push, without rebasing, amending, force-pushing, or changing the user's Git configuration.
At most one process MUST sync a store at a time, and a process that finds the store's sync lock held MUST skip and try again later.
A record read MUST NOT wait for the network.
Record reads and writes MUST NOT see a partially written record file while a merge updates the store.
A roadmap, initiative, or coordination state record that changed on both sides since the merge base MUST be merged by its structure, whether or not Git's line merge conflicts, and every other record kind MUST keep Git's line merge.
A structural merge MUST take each unit from the side that changed it, MUST keep the history entries of both sides, and MUST write the result with the serializer of the record's tools.
A structural merge whose unit changed differently on both sides, or whose result fails the record's own validation, MUST fall back to the whole-file rule.
Under the whole-file rule, a merge conflict on a record MUST keep the upstream version in the store and save the local version beside it, and a conflict on any other file MUST leave the store unchanged.
Every Prism server that uses the store MUST report each saved local version once, on its next tool result, so the agent whose change lost learns of it.
A sync problem MUST NOT fail a record operation, and the store MUST report the latest sync outcome for the review browser.

## Rationale

The user's design names the review app as the single writer, but per-record file locks already serialize local writes in any process.
What Git needs is a single syncer per store, so a store-wide sync lock held by whichever Prism server runs replaces a dedicated writer process.
Letting the first push win matches how a stale revision is refused, so no new conflict semantics reach the tools.
Saving the losing version keeps every byte recoverable without blocking either machine.
Every write appends to the record's history at the same place, so a line merge conflicts on unrelated changes, and a clean line merge of JSON can still be wrong or non-canonical, so these records are not trusted to it.
The rules that know a record's shape live beside its validator and serializer, so store sync stays ignorant of record shapes.

## Alternatives

A dedicated writer process would add a daemon and an inter-process protocol without making local writes safer than the existing locks do.
`git merge` in the working tree replaces files in place, so a concurrent reader could see a missing or truncated record.
Rebasing local commits rewrites history that another checkout of the same store may already hold.
Blocking record work on the network would make an offline machine unusable.

## Consequences

Colleagues share initiatives, reviews, and runs once their stores clone one remote and turn sync on.
A pending debounced sync can be lost when a process exits, and the next sync from any process commits the change because it stages everything uncommitted.
A cloud session that attached the store repository with push access pushed to its `main` branch in a test on 2 November 2026, so cloud sessions sync without a merge Action.
A session limited to its own `claude/...` branch would report `push_rejected` and keep its records in its own clone, which a merge Action could later fold in.
Concurrent changes to different initiatives, slices, or proposals of one record both survive, and only the same unit changed on both sides is saved aside.
A merged record is not a conflict and is not reported, so an agent that holds the earlier revision gets `revision_conflict` on its next write and reads again.
Two edits that are valid alone can merge into an invalid record, such as a dependency cycle, and then fall back to the whole-file rule.
A unit merges as a whole, so two edits to different fields of one initiative entry or one slice still conflict.
Other record kinds, such as slice claims, still resolve concurrent edits by Git's line merge and then by first push.
A record written or locked while a merge would replace it keeps the branch where it was, so the next attempt commits the local bytes and resolves them against the upstream as a saved conflict.
A record that stays locked through every attempt delays the merge to a later sync, which the status reports as `merge_failed`.
A leftover Git lock in the store stops syncing with `git_failed` until a person removes it, because Prism never deletes Git's locks.
Merging without the working tree requires Git 2.38 or later, and an older Git reports `merge_failed`.

## Mechanism

[record-store-architecture.puml](record-store-architecture.puml) shows the checkouts, the store, the syncer, and the remote.

The `Workspace` section's `Store sync` key turns sync on.
A write or append schedules a debounced sync, and a read starts a background sync when the last fetch is older than the pull interval.
A sync takes the store-wide sync lock, stages everything except the sync folder and ignored files, commits, fetches the upstream, merges, and pushes, and it repeats fetch, merge, and push up to three times when another machine pushed first.
The merge runs in Git's object store without touching the working tree, and a record conflict takes the upstream entry while the local blob is saved under the sync folder.
Before the merge commit is built, every record path that changed on both sides since `git merge-base` is looked up in a small registry, which names the record module that owns the path and imports it only when a merge needs it.
That module parses the base, local, and upstream versions, treating a record absent at the base as the empty record, and merges them unit by unit.
A roadmap merges each scalar, the open questions as a whole, each initiative entry by id, and the relative order of the ids that all three versions hold, where only one side's reordering is taken and an added id follows its nearest preceding id.
An initiative merges each scalar, each slice by slug, and each proposal by scope, so a split and an edit of the same slice conflict.
A coordination state merges each setting together with the person's mark of it, where a setting both sides changed differently takes the side whose mark is later, and otherwise conflicts.
Its pending gates merge by gate id and its active work by slice, in the order rule of the roadmap with the upstream's addition first after a shared predecessor, and a gate or slice that one side removed stays removed.
A gate keeps the fields it was asked with, so asked fields that differ between the sides conflict, and answers that differ keep the one with the earlier `answeredAt`, the upstream's on equal times.
Its history keeps every entry of either side once by id, ordered by time and then id, with the newest 200, its closed gates keep every gate of either side once by id, ordered by closing time and then id, with the newest 20, and its evidence keeps the upstream's paths that neither side removed followed by the local side's additions.
A merged coordination state passes coordination state validation, where the rules that a new question must meet do not apply to a merged gate, and stays within 1 MiB.
History keeps the base entries both sides still hold, then the entries one side added in time order with local first on a tie, and then its last 500 entries.
A merged record passes its kind's validation, including the initiative graph analysis, and its blob replaces Git's line merge in a temporary index, from which the merge tree is written.
A record removed on either side keeps Git's whole-file handling.
The merge step then marks the working tree as changing, takes the record lock of every changed file, and checks that each file still holds the previous commit's bytes.
Only then does it replace each file by an atomic rename and check that each holds the merged bytes, and only after both checks does the branch move.
When a check fails or a lock stays held, the branch stays at the pre-merge commit, the next attempt commits what the working tree holds, and the merge runs again, so an upstream change is never reverted silently.
Record reads and writes in every process wait, for at most ten seconds, while that mark is held by a live process, and the atomic rename means a reader that started earlier still sees a whole old or new file.
The branch and index move to the merge commit while the locks are still held, then the locks and the mark are released.
A write scheduled while a sync runs starts another sync after it, because the running sync may have committed before the write.
SSH runs in batch mode unless the user configured an SSH command, so no prompt can hold the sync lock.
Every sync writes its outcome, ahead and behind counts, and saved conflicts to a status file in the ignored sync folder, and the review index includes it.
Each server remembers the stores it synced or pulled, and on every tool result it lists record versions saved under the sync folder since the server started that it has not reported yet.

## Decision Log

2026-11-02: A two-machine test showed that the agent whose change lost was never told and that history appends make every concurrent write to one record conflict; tool results now report saved local versions.
2026-11-02: Roadmap and initiative records that changed on both sides now merge by structure, and only a unit changed differently on both sides or an invalid result falls back to the upstream version.
2026-11-02: A store cloned from an empty remote reported `ok` without pushing, because its upstream branch did not exist yet; a sync now pushes a branch whose upstream the remote lacks, a managed clone without an upstream pushes its branch with the upstream set, and status messages drop the user information of any URL.
2026-11-03: An update that takes or releases a [slice claim](slice-claims.md) syncs at once and waits for the outcome instead of the debounced sync; claim records have no structural merge, so the upstream version wins, and a claim record saved aside is reported through the claim's refusal or its holder's lost-claim notice instead of as a saved record.
2026-11-07: The review app's actions write the person's settings and history into coordination state while agents keep writing it on other machines, so coordination state now merges by structure as well.
