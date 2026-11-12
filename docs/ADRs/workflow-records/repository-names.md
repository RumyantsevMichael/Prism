# Name each repository that shares a record store

Status: Proposed
Created: 2026-11-03

## Requirements

No Approved requirement governs this decision yet.
The Draft [repository name requirements](../../requirements/repository-names.md) §1-§10 describe the behavior it implements, and the Draft [component requirements](../../requirements/components.md) §1 replaces their §2.
It records the first increment of the multi-repository workspace design, which Michael asked to start on 3 November 2026.

## Problem

One [record store](external-record-store.md) can serve several repositories, but Prism tells them apart only by a root commit, which a shallow clone cannot supply and a fork shares.
Two repositories can pick one name by accident, and a repository moved or renamed on its Git host gets a new remote without becoming another repository.
Later multi-repository work needs each machine to know where its checkouts of each repository are, and those paths differ on every machine.
Stores and checkouts from before names exist already hold records, ledger entries, and runs.

## Decision

A checkout that names a store MAY name its repository with a `Repository` entry beside `Store` in its committed workflow configuration, and a name MUST be 1 to 64 lowercase letters, digits, hyphens, or underscores that starts and ends with a letter or digit.
A name MUST NOT be a Windows device name, `con`, `prn`, `aux`, `nul`, `com0` to `com9`, or `lpt0` to `lpt9`, because it names the store's registration file and the store folders of the repository's artifacts, which Git for Windows refuses to check out under such a name, and a registration that a store already holds under such a name MUST accept no checkout and MUST NOT keep its remotes from registering under another name.
A store MUST register each name in its own file `repositories/<name>.json`, holding the name, the remotes it is known by, the repository's root commit when one is known, and when it was registered.
A remote MUST be stored as scheme, host, and path only, and two remotes MUST be the same remote when their lowercase host without a port and their path without surrounding slashes and a trailing `.git` are equal.
A local path or `file://` origin MUST count as no network remote.
Before a record operation of a named checkout touches the store, Prism MUST check the name: an unregistered name registers, a listed remote or a matching root commit accepts, and anything else refuses every record operation without changing the store.
A matching root commit MUST add the checkout's remote to the registration, so a repository moved on its host and its forks keep the name, unless another registration lists that remote.
A registration without a root commit MUST take the first full checkout's root commit that its remote accepts.
A refusal MUST name both remotes without user information, say how to prove a move or pick another name, and propose a name that the store would accept.
One remote MUST NOT be registered under a second name.
Registration files MUST be store sync records without a structural merge, so the first pushed registration of a name stands, and a new registration in a synced store MUST be confirmed with the store's remote before the operation continues, as a slice claim is.
A checkout that names a store but no repository MUST be refused on every record operation, registering nothing, with a refusal that shows the line to add and a proposed name that the store would accept.
Verification runs and contract-defect reports of a named checkout MUST record its name as their repository.
Records, ledger entries, and runs from before names MUST stay unchanged, and a ledger marker named by a root commit MUST keep covering that repository after it is named.
Each machine MUST list its checkouts of each named repository in `checkouts.json` in Prism's application folder, and a checkout path MUST NOT reach the store.

## Rationale

A committed name is the same in every clone, shallow clone, fork, worktree, and machine, which a root commit cannot be.
The remote check exists only to catch two repositories that pick one name, and the root commit proves that two remotes hold one history, so a move never blocks anyone while a clash still does.
A false refusal names both remotes and how to fix it, whereas a false acceptance would silently mix two repositories' results, so remote comparison keeps path case and refuses what history cannot prove.
A registration file of its own per name merges like a claim: two machines that register one name write the same file, the upstream wins, and confirmation tells the loser before it writes anything else.
The application folder is shared by every host on the machine and lies outside every project and store, which a per-machine list needs.
Codex gives a plugin's MCP server no plugin data directory ([#81](https://github.com/RumyantsevMichael/Prism/issues/81)), which is why managed store clones already moved to that folder, so a list in the plugin data directory would be missing in Codex and split between hosts.
Every store user upgrades with one committed line, chosen from a proposal that the store accepts, and components can then name a repository's root component after it in every checkout.

## Alternatives

Keeping the root commit as the identity fails for shallow clones and cannot tell a fork from the original.
Keying registrations by remote alone would refuse every repository moved on its host, and keying them by root commit alone would refuse to tell a fork from the original by name.
One shared registry file would conflict on every concurrent registration and fail the store's merge, and a structural merge of it would let two machines both believe they registered one name.
Warning an unnamed checkout for good would leave checkouts of one store without a name, so the root component of their repository would have none.
Keeping the checkout list in the store would publish local folder names to everyone who can clone it, and keeping it under a host's plugin data directory fails in Codex.

## Consequences

Every checkout of one repository agrees on its name, and readers of a run see which repository it came from.
A repository moved on its host keeps its name as soon as one full checkout with the new remote checks it.
A shallow clone with an unregistered remote is refused until it fetches its full history.
Two different services on one host that differ only by port count as one remote.
A host that treats repository paths case-insensitively can refuse a differently cased spelling of a registered remote, with both remotes named.
Two machines that register one remote under two names at the same time both keep their registrations.
Renaming a repository's registered name is not supported.
The first registration of a name in a synced store needs the store's remote to be reachable.
A list of checkouts is per machine, and a path that no longer holds its repository's checkout leaves the list when another checkout of that repository is recorded.

## Mechanism

The name check runs in the record store before migration and is cached for each project root for at most 5 seconds, like the migration check.
It reads the checkout's origin with Git and its root commit as run records do, compares them with the registration, and writes or extends the registration file atomically under a store lock.
In a synced store, a new registration waits for a sync of its own, and the check runs again against the registration the store then holds; a sync that cannot reach the remote withdraws the registration.
While that sync runs, a pending marker that sync never commits tells every other check on the machine, whatever its own sync setting, that the registration is unconfirmed, so such a check answers `repository_unconfirmed` at once instead of accepting or refusing on it, and no lock is held across the network.
The MCP server passes the check's refusal codes and the proposed name in error data.
After a checkout's first accepted check in a process, the server rewrites `checkouts.json` atomically under a lock, replacing the entry for its path and dropping entries of its store and repository whose folders no longer name them.
A server whose host names the project at start runs that check in the background, and any other server runs it on its first record tool call.

## Decision Log

2026-11-03: A registration keeps every remote its root commit proves, because Michael asked that a repository moved on its Git host not block anyone.
2026-11-03: A matching root commit never adds a remote that another name registered, because implementation review found that a fork's checkout naming the original would register one remote under two names.
2026-11-03: A pending marker replaced holding the registration lock across the confirming sync, because implementation review found that the held lock let unsynced checkouts accept unconfirmed registrations, could commit the lock file, and made record writers wait on another check's network sync.
2026-11-04: A checkout that names a store but no repository is refused instead of warned, because Michael decided on 3 November 2026 that a later release refuses it and agreed on 4 November 2026 that the components milestone is that release ([components.md§1](../../requirements/components.md#1)).
