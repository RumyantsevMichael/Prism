# Share machine records through an external record store

Status: Proposed
Created: 2026-10-31

## Requirements

No Approved requirement governs this decision yet.
The Draft [shared record store requirements](../../requirements/shared-record-store.md) §1-§6, §17, and §18 describe the behavior it implements.
It records the first increment of the multi-repository roadmap milestone, which the user approved.

## Problem

Machine records live under each checkout's `.prism` directory, so linked worktrees and other clones of one project each hold their own initiatives, roadmap, reviews, change maps, and runs.
Work started in one checkout is invisible to another, and two checkouts can advance the same initiative from diverging records.
The [machine records decision](machine-records-under-prism.md) routes all record access through one record store so that a later backend can replace the working-tree layout.

## Decision

A project MAY name a record store folder in its workflow configuration, and every checkout that names the same folder MUST read and write the same records.
A project MAY instead name the store by its Git remote, a URL with the scheme `https`, `http`, `ssh`, `git`, or `file`, or the scp form `user@host:path`, and every other value MUST stay a folder path.
A remote store MUST live in one clone per machine at `<Prism application folder>/stores/<id>`, shared by every host, where `<id>` is the first 16 hex characters of the SHA-256 of the remote normalized to a lowercase host without user information and without a trailing `.git` or `/`.
Every checkout on the machine that names the same remote MUST use that clone, and Prism MUST create it on the first record access that finds none, so that access waits for it.
A clone MUST be made by one process at a time, within the sync Git timeout and environment, and a failed clone MUST leave no folder at the clone path.
A failed clone, or a folder at the clone path whose `origin` is another remote MUST make every record operation fail, and Prism MUST NOT change or delete that folder.
Store sync MUST default to on for a remote store, and the clone's branch MUST gain its upstream on its first sync when the remote was empty.
Prism MUST NOT delete a managed clone, rewrite its history, or put the remote's user information in any message, status, or record.
After the clone exists, a remote store MUST behave exactly as a folder store.
Without that setting, records MUST stay under the project's `.prism` directory, and no file outside the project root may be read or written for records.
A record's `.prism` path MUST remain its address in every stored reference, tool result, and review browser link, whichever folder holds the file.
Only the record store MAY map a record address to a physical file.
The store MUST hold the same layout as `.prism`, without the leading `.prism` segment.
A configured store folder that does not exist, is not a folder, or resolves inside or contains the project root MUST make every record operation fail, and Prism MUST NOT create the store or fall back to `.prism`.
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
Prism never creates a store folder that a path names, because a typo there would silently become a second store, but a remote store's clone path is derived from the remote itself, so every checkout that names the remote finds the same folder and no typo can split it.
The application folder belongs to Prism, is the same for every checkout and every host on the machine, and is never inside a project, so a clone there neither clutters a project's parent folder nor differs between machines, hosts, and cloud sessions.
It is also the folder of the review app, which is already shared by every host, and it needs nothing from the host, whereas Codex gives a plugin's MCP server no plugin data directory.
A clone renamed into place after it completes means a crashed or failed clone never looks like a store.

## Alternatives

Rewriting stored addresses to store paths would change tool results and break gates and links that already name `.prism` paths.
Creating a missing store folder would turn a typo into a second, silent store.
Falling back to `.prism` when the store is unavailable would let checkouts diverge without notice.
A git ref or records branch keeps records out of the working tree, but cloud sessions cannot push custom refs.
Cloning a remote store beside the project would bring back the stray folder and the per-machine path that the remote form removes.
Keeping a clone under each host's plugin data directory failed in Codex, which gives that directory to a plugin's hooks but not to its MCP server, and it kept two clones of one store on a machine with both hosts.
Reusing or repairing a folder already at the clone path whose origin differs could overwrite another repository's work, so Prism refuses it instead.

## Consequences

Linked worktrees and clones on one machine share initiatives, reviews, and runs once their configuration names the same store.
Without [store sync](record-store-git-sync.md), the user syncs a store between machines by hand, because Prism does not commit, push, or pull it.
A cloud session whose store folder does not exist cannot read or write records until the store is provided.
A cloud session or machine that names the store by its remote clones it on its first record access and needs read and push access to the store repository.
Claude Code and Codex on one machine share one clone of a remote store, and its locks serialize their clones and syncs.
Two Prism versions installed in different hosts can write that clone at once, so a later change to the clone's layout must stay readable by the version before it.
Uninstalling the plugin from a host leaves the clone in place, because it belongs to Prism rather than to that host.
The shared review app resolves a remote store in the clone folder that the project's most recent session reported, so it reads the clone that session writes even when another host started the app.
A token in a remote URL stays in the clone's own Git configuration, as Git keeps it, although Prism leaves it out of every message, status, and record.
Records in a store no longer travel with a branch or appear in its pull requests.

Known limits remain.
The first migration can race a concurrent writer of the same record in another checkout.
A change to the `Store` setting can take up to the five-second migration cache to apply in a running server.
In-repo record files left in other checkouts after the migration are ignored, and the user can delete them.

## Mechanism

[record-store-architecture.puml](record-store-architecture.puml) shows how checkouts share the store.

The workflow configuration's `Workspace` section names the store, relative to the project root or absolute, or by its remote.
The record store resolves that folder once per access, refuses it when it is missing, inside the project, or containing it, and maps each `.prism` record address into it.
For a remote store, the record store looks for the clone in the application folder, checks that it is the top of a Git checkout whose `origin` normalizes to the configured remote, and remembers it for the rest of the process.
When the clone is missing, it takes a file lock beside the clone path in the stores folder, looks again, moves a clone with the same origin from `<plugin data directory>/stores/<id>` where Prism 0.16 kept it, removes temporary clones of dead processes, clones into a temporary sibling with `core.longpaths` set, and renames it into place.
Each session reports its clone folder to the review app with every registration, and the app keeps it beside the project's evidence and index folders.
Every server component that reads, lists, or serves records asks the record store for the physical file, and all other project paths still resolve from the project root.
Before the first record access, migration copies records from the project's `.prism` and from legacy plan locations into the store, removes each copied or identical source, and reports a differing target as a conflict.
Under the store-wide migration lock, a checkout moves only the records whose paths the migration ledger does not list yet.
The ledger is the union of the files in the store's `migrations` folder.
Each migration that moved or kept anything adds one file with a unique name, holding the time, the advisory repository identity, the moved paths, and the conflicts, so two machines never change the same ledger file and the store's Git merge never conflicts on it.
A conflicting path counts as taken, so later checkouts ignore their own copies of it.
A marker from before the ledger, named by a repository's root commit, still makes a checkout of that repository skip migration.

## Decision Log

2026-11-02: A two-machine test showed that a shallow cloud clone and a full clone got different root commits, so the move ran twice; the per-repository marker gave way to a ledger of moved record paths.
2026-11-02: `Store` may name the store's Git remote, and Prism keeps one clone of it per machine in its plugin data directory, because a hand-made clone at an agreed path was easy to get wrong and differed between machines and cloud sessions.
2026-11-03: Clones moved from each host's plugin data directory to Prism's application folder, because Codex gives a plugin's MCP server no plugin data directory, and Prism is becoming an application that several hosts share.
