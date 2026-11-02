# Share machine records through an external record store

Status: Proposed
Created: 2026-10-31

## Requirements

No Approved requirement governs this decision yet.
The Draft [shared record store requirements](../../requirements/shared-record-store.md) §1-§6 describe the behavior it implements.
It records the first increment of the multi-repository roadmap milestone, which the user approved.

## Problem

Machine records live under each checkout's `.prism` directory, so linked worktrees and other clones of one project each hold their own initiatives, roadmap, reviews, change maps, and runs.
Work started in one checkout is invisible to another, and two checkouts can advance the same initiative from diverging records.
The [machine records decision](machine-records-under-prism.md) routes all record access through one record store so that a later backend can replace the working-tree layout.

## Decision

A project MAY name a record store folder in its workflow configuration, and every checkout that names the same folder MUST read and write the same records.
Without that setting, records MUST stay under the project's `.prism` directory, and no file outside the project root may be read or written for records.
A record's `.prism` path MUST remain its address in every stored reference, tool result, and review browser link, whichever folder holds the file.
Only the record store MAY map a record address to a physical file.
The store MUST hold the same layout as `.prism`, without the leading `.prism` segment.
A configured store that does not exist, is not a folder, or resolves inside or contains the project root MUST make every record operation fail, and Prism MUST NOT create the store or fall back to `.prism`.
Containment and symbolic link checks MUST apply against the store folder when a store is set.
The workflow configuration and every human document MUST stay in the project.
When a store is configured, the project's in-repo and legacy records MUST move into it under the existing migration rules, and a differing record already in the store MUST NOT be overwritten.
Each record path MUST move into a store at most once, from whichever checkout brings it first, because committed records exist in every checkout and a later copy would bring back records removed since.
This rule MUST NOT depend on a repository identity, because shallow clones, forks, and rewritten histories make one repository look like several or several look like one.
A conflict found during a migration MUST be kept in the store's migration ledger, with both files left in place.
An unavailable store MUST hide only records from the review browser, so human documents still list.

## Rationale

Keeping the `.prism` address everywhere leaves tool inputs, outputs, stored references, and gates unchanged, so only one resolver changes behavior.
Refusing a missing or in-project store prevents a typo or a fallback from silently splitting state between checkouts.
Locks already sit beside each record, so two checkouts that write the same record serialize through the store without new locking.

## Alternatives

Rewriting stored addresses to store paths would change tool results and break gates and links that already name `.prism` paths.
Creating a missing store folder would turn a typo into a second, silent store.
Falling back to `.prism` when the store is unavailable would let checkouts diverge without notice.
A git ref or records branch keeps records out of the working tree, but cloud sessions cannot push custom refs.

## Consequences

Linked worktrees and clones on one machine share initiatives, reviews, and runs once their configuration names the same store.
Without [store sync](record-store-git-sync.md), the user syncs a store between machines by hand, because Prism does not commit, push, or pull it.
A cloud session whose store folder does not exist cannot read or write records until the store is provided.
Records in a store no longer travel with a branch or appear in its pull requests.

Known limits remain.
The first migration can race a concurrent writer of the same record in another checkout.
A change to the `Store` setting can take up to the five-second migration cache to apply in a running server.
In-repo record files left in other checkouts after the migration are ignored, and the user can delete them.

## Mechanism

[record-store-architecture.puml](record-store-architecture.puml) shows how checkouts share the store.

The workflow configuration's `Workspace` section names the store, relative to the project root or absolute.
The record store resolves that folder once per access, refuses it when it is missing, inside the project, or containing it, and maps each `.prism` record address into it.
Every server component that reads, lists, or serves records asks the record store for the physical file, and all other project paths still resolve from the project root.
Before the first record access, migration copies records from the project's `.prism` and from legacy plan locations into the store, removes each copied or identical source, and reports a differing target as a conflict.
Under the store-wide migration lock, a checkout moves only the records whose paths the migration ledger does not list yet.
The ledger is the union of the files in the store's `migrations` folder.
Each migration that moved or kept anything adds one file with a unique name, holding the time, the advisory repository identity, the moved paths, and the conflicts, so two machines never change the same ledger file and the store's Git merge never conflicts on it.
A conflicting path counts as taken, so later checkouts ignore their own copies of it.
A marker from before the ledger, named by a repository's root commit, still makes a checkout of that repository skip migration.

## Decision Log

2026-11-02: A two-machine test showed that a shallow cloud clone and a full clone got different root commits, so the move ran twice; the per-repository marker gave way to a ledger of moved record paths.
