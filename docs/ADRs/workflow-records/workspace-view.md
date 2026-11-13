# Open a workspace, not a checkout, in the review app

Status: Proposed
Created: 2026-11-10

## Requirements

- [Workspace view in the review app](../../requirements/workspace-view.md) §1-§39.

## Problem

The review app reads every page through one checkout's folder, so a person must clone a code repository to follow a workspace, sees only the scopes of that checkout, and addresses each artifact by a path that another checkout places elsewhere and a store-only workspace does not have.
Agents likewise see only their own repository's scopes, although teammates scope requirements to other repositories of the same workspace.
Code-repository content, which stays outside the store, is visible only in a checkout or on a Git host.

## Decision

The review app's unit MUST be the workspace, one record store identified by its host and path whatever its encrypted URL's scheme or user, and a project without a store MUST be a workspace of one.
A store spelling that Git reaches without encryption, `http://` or `git://`, MUST keep its scheme in its identity, so it MUST NOT share a managed clone or a workspace with an encrypted spelling of the same store.
The app MUST name a store artifact by its store location of scope, kind, and rest in every page, link, URL, and session tab, and MUST NOT offer a repository, component, checkout, or branch as a context to switch to.
The app MUST be able to open a workspace from its store's managed clone alone, keep it in sync without an agent session, and push its own record writes through the store sync.
Agents MUST read every scope of their workspace, MUST name another scope by its label or an artifact by its location when a path is ambiguous or unmapped, and MUST change only the scopes of their own checkout.
Every listing of a workspace's artifacts MUST answer from an index that Prism refreshes per sync and per write rather than walking the store per request.
Code-repository content MUST be shown in Prism from a bare blobless clone that Prism keeps per repository remote only while a person has turned it on, with every remote branch labelled and no branch chosen, and MUST NOT depend on any Git host's pages.
Verification records MUST name each slice file by its Git blob hash and MUST NOT hold file bytes, and ship MUST record the default-branch commit that holds those blobs, so the slice's files stay visible after a squash merge or force push.
Work that no remote branch holds MUST be shown only as presence from claims and runs, never as content.
Adding or removing a workspace and turning code content on or off change only the app's own state on the machine and MUST NOT be review app actions on records.

## Rationale

A store already holds one set of records for every checkout, so the store is the only unit that every machine and every person, with or without a code checkout, shares.
Addressing by store location gives one name per artifact on every machine, which a checkout path cannot.
Blob hashes and the ship commit prove which bytes passed verification without copying code into a store that people without code access may read.
Plaintext spellings stay apart because a shared clone has one origin: a committed configuration that names an `http://` spelling would let anyone on the network path set that origin, or feed the clone commits that a later HTTPS or SSH sync pushes to the real store, and the requirement asks only that SSH and HTTPS spellings be one store.
A blobless clone keeps every branch and all history for little disk, and Git itself fetches a file when someone opens it.

## Alternatives

- Keep checkouts as contexts and add a "workspace" grouping above them: rejected because the person asked for no context selector between repositories, and a store-only workspace would still have no checkout to open.
- Store a copy of each repository's component declaration in the store: rejected because the branches, which the view labels, are the source, and a copy would drift from them.
- Give plaintext spellings the shared identity and upgrade the clone's origin to an encrypted spelling whenever one is used: rejected because commits fetched over the plaintext spelling before the upgrade would still reach the real store, and the order of accesses would decide which transport a person's records travel by.
- Link code files to the Git host: rejected because it depends on each host's URL scheme and on the reader's host account.
- Record file bytes of verified files in the run records: rejected because records would grow with code and would leak code to readers of the store.

## Consequences

- A person follows a workspace from its store URL alone, and every machine names a workspace and its artifacts the same way.
- The store's managed clone folder takes a new name derived from the store identity, so clones that 0.20 named by the full URL move once.
- A store that some checkouts name by `http://` or `git://` and others by an encrypted spelling has two clones and two workspaces on one machine, which sync only through the store itself.
- The app runs Git in the background for every open workspace and every repository with code content on, which costs network and disk on the person's machine.
- An agent reading another repository's artifact cannot change it, so a change there needs a session in that repository.
- A ship that happens before the squash merge records no ship commit, and the slice page then shows the files only while the verified commit exists.

## Mechanism

The app derives each registered checkout's workspace from the store identity its configuration names and merges added workspaces of the same identity, matching an SSH host alias by the store's root commit after cloning.
An open page's events stream drives a fetch timer that backs off while the store is unreachable, and every read comes from the managed clone, which is the last synced copy.
The artifact index lists every scope folder of the store with each artifact's version, and agents' listings and the app's pages read it.
Code clones live beside the store clones in Prism's application folder, fetch every branch with pruning on the same timer, and serve trees, files, and component declarations per branch.

## Decision Log
