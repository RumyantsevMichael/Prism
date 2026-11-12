# Keep descriptive artifacts in the record store

Status: Proposed
Created: 2026-11-07

## Requirements

- [Workspace artifacts](../../requirements/workspace-artifacts.md) §1-§9 and §13-§15.

## Problem

Requirements, ADRs, plans, diagrams, and the roadmap view live in each code repository, so a draft stays invisible to teammates and other sessions until its branch merges, and an artifact that applies to several repositories must live in one of them.
The [external record store](external-record-store.md) already gives every checkout of a workspace the same machine records, while the documents those records describe stay behind.

## Decision

Where a repository's workflow configuration names a record store, its descriptive artifacts MUST live in that store, and its executable artifacts, such as feature files, step definitions, frozen tests, executable contracts, and user documentation, MUST stay in its checkout.
An artifact MUST keep the project-relative path that the checkout's configured paths give it as its address in every tool input, tool result, stored reference, and review browser link, and only the store MAY map an address to a file.
Each artifact MUST belong to the whole workspace, to one repository, or to one component of a repository, and the store MUST keep each repository's and each component's artifacts in a folder of their own, so two repositories never share a location.
The store MUST map each configured artifact kind to a fixed folder in every scope, so every repository that shares a workspace artifact finds it, whatever its own configured paths are.
Within the scopes one checkout sees, which are the workspace, its repository, and that repository's components, a path MUST name at most one artifact, and an operation on a path that two of them hold MUST name the scope.
Agents MUST read and write store artifacts only through Prism's tools, and every write MUST check the version the writer read.
Prism's own reads and writes of artifacts, such as slice designs, diagrams, recovery notes, and generated views, MUST go through the same mapping and MUST NOT fall back to the checkout.
An unavailable store MUST refuse every artifact read and write with an error that names the store.
An artifact write MUST sync like a record write, and a sync MUST merge an artifact changed on both sides by Git's line merge, keeping the upstream artifact and saving the local bytes in the store when that merge conflicts.
A repository's existing descriptive artifacts MUST move into its own scope on a checkout's first access, each path at most once, and a file whose location already holds other bytes MUST stay in the checkout beside the store's copy.
Prism MUST NOT rewrite files in a code repository that name a moved artifact, and MUST report them instead.

## Rationale

Keeping the configured path as the address leaves requirement references, links, gates, and skill instructions unchanged, so only one resolver learns where artifacts live, as the record store did for records.
Tool access works in every host, while a file write outside the working folder asks for approval in some hosts and fails in sandboxed ones, and only a tool write lets Prism check versions, sync at once, and keep status changes for gates.
A folder per repository and component removes the collision of two repositories that both keep, say, a `cli` requirement, which a store-wide namespace would turn into a migration conflict.
Fixed kind folders let a workspace artifact serve repositories whose configured paths differ, and keep relative links between kinds working when a checkout kept its kinds side by side.
Git's line merge combines changes to different sentences of a one-sentence-per-line file, which a section merge would turn into conflicts, and the whole-file rule keeps every byte of a real conflict.
Reporting stale references, rather than rewriting them, leaves a code repository's history and wording to its people.

## Alternatives

Reporting the store folder so that agents use their own file tools needs no new tools, but it fails in sandboxed hosts, cannot check versions or status, and leaves sync to chance.
One namespace for the whole store makes scope a label and loses the second repository's artifact, or blocks its move, whenever two repositories use one path.
A section merge of Markdown conflicts on two edits to one section that Git merges cleanly.
Publishing accepted artifacts back into code repositories is a non-goal and would make two copies to keep in step.

## Consequences

A teammate sees a draft after the writer's next sync, and artifacts shared by several repositories have one home.
Agents that run without Prism no longer see a store repository's descriptive artifacts, which the requirements accept.
A person reviews artifact changes in the review browser, while the code pull request shows only code, tests, and the removal of the moved files.
A repository whose configured kinds were not side by side keeps its relative links byte for byte, and those that cross kinds no longer resolve in the browser.
Probe scripts kept with plans move with them, so a command that runs one names its store location.
Each read of a long artifact may take several tool calls, because a result is limited to one page.

## Mechanism

The record store's resolver maps an artifact path to its kind by the longest configured path that holds it, and to the scope folder that holds it among those the checkout sees.
Writes take the same per-file locks and atomic renames as records and schedule the debounced store sync.
The sync treats files under the artifacts folder like records when Git's merge conflicts on them, saving the local bytes and reporting them on the next tool result of every server that uses the store.
The first access of a checkout, after the record move, compares each descriptive file with the store, moves new ones, removes identical ones, keeps differing ones, writes one uniquely named ledger file, and scans tracked files for the moved paths.

## Decision Log
