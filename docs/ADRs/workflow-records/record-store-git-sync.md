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
A merge conflict on a record MUST keep the upstream version in the store and save the local version beside it, and a conflict on any other file MUST leave the store unchanged.
A sync problem MUST NOT fail a record operation, and the store MUST report the latest sync outcome for the review browser.

## Rationale

The user's design names the review app as the single writer, but per-record file locks already serialize local writes in any process.
What Git needs is a single syncer per store, so a store-wide sync lock held by whichever Prism server runs replaces a dedicated writer process.
Letting the first push win matches how a stale revision is refused, so no new conflict semantics reach the tools.
Saving the losing version keeps every byte recoverable without blocking either machine.

## Alternatives

A dedicated writer process would add a daemon and an inter-process protocol without making local writes safer than the existing locks do.
`git merge` in the working tree replaces files in place, so a concurrent reader could see a missing or truncated record.
Rebasing local commits rewrites history that another checkout of the same store may already hold.
Blocking record work on the network would make an offline machine unusable.

## Consequences

Colleagues share initiatives, reviews, and runs once their stores clone one remote and turn sync on.
A pending debounced sync can be lost when a process exits, and the next sync from any process commits the change because it stages everything uncommitted.
Cloud sessions cannot sync until the later increment adds their branch and the merge Action.
Mutable records resolve concurrent edits by first push until records become append-only event files, so the later edit is saved aside rather than merged.
A record written locally while a merge replaces it keeps its local bytes, and the next sync commits them over the upstream version, which stays in history.
Merging without the working tree requires Git 2.38 or later, and an older Git reports `merge_failed`.

## Mechanism

The `Workspace` section's `Store sync` key turns sync on.
A write or append schedules a debounced sync, and a read starts a background sync when the last fetch is older than the pull interval.
A sync takes the store-wide sync lock, stages everything except the sync folder and ignored files, commits, fetches the upstream, merges, and pushes, and it repeats fetch, merge, and push up to three times when another machine pushed first.
The merge runs in Git's object store without touching the working tree, and a record conflict takes the upstream entry while the local blob is saved under the sync folder.
The merge step then marks the working tree as changing and replaces each changed file by an atomic rename under that file's record lock, only while the file still holds the previous commit's bytes.
Record reads and writes in every process wait, for at most ten seconds, while that mark is held by a live process, and the atomic rename means a reader that started earlier still sees a whole old or new file.
After the files are replaced, the branch and index move to the merge commit, and the mark is removed.
Every sync writes its outcome, ahead and behind counts, and saved conflicts to a status file in the ignored sync folder, and the review index includes it.

## Decision Log
