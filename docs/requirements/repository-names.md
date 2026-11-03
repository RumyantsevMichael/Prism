# Repository names in a shared store

Status: Draft
Created: 2026-11-03
Approved: n/a

## Problem

One record store can already serve several repositories, but Prism tells them apart only by a repository's root commit.
A shallow clone has no reliable root commit and a fork shares the original's, so records cannot say which repository a result came from, and one repository can look like several or several like one.
Multi-repository work, reported in issue #48, also needs each machine to know where its checkouts of each repository are, and those paths differ on every machine.
Existing stores already hold records, migration-ledger entries, and verification runs from before repositories had names, and their users have a `Store` setting but no repository name.

## Goals

- Name each repository that uses a store by a short name its team picks and commits, so every clone, shallow clone, fork, worktree, and machine agrees on it.
- Keep two repositories from sharing one name in a store by accident.
- Let each machine know which of its folders are checkouts of each named repository, without sharing local paths through the store.
- Keep every store and checkout that people already use free of lost records, and tell their users exactly what to change.

## Non-goals

- Components, a component on each planned slice, and the slice boundary check.
- Running or verifying a slice in another repository's checkout, and choosing between several checkouts of one repository.
- Running the tests of dependent components when a contract scope finishes.
- Showing the workspace by repository or component in the review browser.
- A repository name for a project whose configuration names no record store.
- Sharing the list of checkouts between machines.
- Unique names across different stores.

## Design questions

- Where the list of a machine's checkouts lives so that every host on the machine can write it, since the multi-repository design names the plugin data folder, Codex gives a plugin's MCP server no plugin data folder (issue #81), and the remote-store clone moved to Prism's application folder for that reason.
- How two machines that register one name with different remotes at the same time settle which registration stands, for example by confirming the registration with the store's remote as a slice claim is confirmed.
- Which spellings of a remote count as the same remote when a checkout's remote is compared with the registered one, such as SSH and HTTPS forms of one host and path, host case, or a trailing `.git`.
- Which characters a repository name may use, given that a later increment writes a component as `<repository>/<component>`.
- How a checkout that a migration marker named by its root commit keeps skipping the migration once its repository has a name.
- What name the refusal proposes when the checkout has no origin remote, its remote has no path segment, or that segment is registered for another remote.
- Whether a refused checkout enters the machine's checkout list, and how a path that no longer holds a checkout of its repository leaves it.

<a id="1"></a>
## 1. Read the repository name from the committed configuration

Pattern: Optional feature

Disposition: Active

Requirement: Where a project's workflow configuration names a record store, Prism shall take the checkout's repository name from the `Repository` entry of the `Workspace` section of the committed `.prism/workflow.md`, beside its `Store` entry.

Rationale: A committed name is the same in every checkout, including shallow clones and forks, which a root commit cannot be, and placing it beside `Store` keeps every existing configuration valid.

Related: [shared-record-store.md§1](shared-record-store.md#1)

<a id="2"></a>
## 2. Refuse a checkout without a repository name

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a project's workflow configuration names a record store but no repository name, then Prism shall refuse every record operation, without changing the store, with an error that shows the `- Repository: <name>` line to add under `## Workspace` and proposes a name taken from the last path segment of the checkout's origin remote that the store has not registered for another remote.

Rationale: Michael decided on 3 November 2026 that a name is required whenever a store is configured, even for one repository, and an existing user who upgrades must learn the one line to add, with a name that works, before anything changes in the shared records.

Related: [§3](#3), [§7](#7)

<a id="3"></a>
## 3. Register a repository name on its first use

Pattern: Event-driven

Disposition: Active

Requirement: When a checkout uses a repository name that its record store has not registered, Prism shall register the name in the store with the scheme, host, and path of the checkout's origin remote.

Rationale: The first checkout that uses a name is the only evidence of which repository the team meant by it, and the store is where every other checkout can check it.

Related: [§4](#4), [shared-record-store.md§15](shared-record-store.md#15)

<a id="4"></a>
## 4. Refuse a name registered for another remote

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a checkout's repository name is registered in its record store with a remote that differs from the checkout's origin remote, then Prism shall refuse every record operation with an error that names the registered remote and the checkout's remote, each without user information.

Rationale: Two repositories that share a name by accident would mix their results, and naming both remotes tells the person which repository already holds the name.

Related: [§3](#3), [shared-record-store.md§15](shared-record-store.md#15)

<a id="5"></a>
## 5. Keep one remote for each name

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep at most one registered remote for each repository name in a record store, including when checkouts on different machines register one name at the same time.

Rationale: A registration that one machine believes it made and another machine replaced would let two repositories share a name after all.

Related: [§3](#3), [§4](#4), [shared-record-store.md§12](shared-record-store.md#12)

<a id="6"></a>
## 6. Record the repository name with verified code

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records a verification run or a contract defect in a checkout that has a repository name, Prism shall record that name as the run's repository.

Rationale: The name replaces the root-commit identity, which shallow clones and forks cannot supply, so readers can tell which repository a result came from.

Related: [shared-record-store.md§14](shared-record-store.md#14), [shared-record-store.md§16](shared-record-store.md#16)

<a id="7"></a>
## 7. Keep records from before repository names

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep every record, migration-ledger entry, and verification run that a record store held before its repositories had names valid and readable at its existing address, without asking anyone to edit it.

Rationale: Michael's standing rule is that renames and format changes are non-breaking or ship a migration, and existing stores already hold work keyed by the root-commit identity.

Related: [§2](#2), [shared-record-store.md§3](shared-record-store.md#3)

<a id="8"></a>
## 8. Keep removed records removed after a repository is named

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a record store holds a migration marker from before the migration ledger, then Prism shall keep skipping the migration for every checkout that the marker covered before its repository had a name.

Rationale: Such a marker names a repository by its root commit instead of listing record paths, so a checkout that stopped matching it would bring back records that people removed from the store.

Related: [shared-record-store.md§5](shared-record-store.md#5)

<a id="9"></a>
## 9. Record this machine's checkouts

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism server starts in a checkout whose workflow configuration names a record store and a repository name, Prism shall record the checkout's path for that repository on the machine.

Rationale: Work for one repository can later run from a session in another only if the machine knows where that repository's checkouts are.

Related: [§10](#10)

<a id="10"></a>
## 10. Keep checkout paths out of the store

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep each checkout's local path out of the record store.

Rationale: Paths differ on every machine and reveal local folder names to everyone who can clone the store.

Related: [§9](#9), [shared-record-store.md§15](shared-record-store.md#15)
